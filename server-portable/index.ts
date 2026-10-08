
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { agents, closeStore, db, env, initEnv, serveHere, type Env } from "./root.ts";
import { authenticateRequest, CLIENT_SCOPES, routable, type Principal } from "./auth.ts";
import { FORK_VERSION } from "./version.ts";
import { createCallCount, drainBoundFrom, drainOnSignal, isStoppable, type Stoppable } from "./shutdown.ts";
import { atEndpoint, subscribe as subscribeJob, markRunningLost } from "./jobs.ts";
import { createCore, SPECS, type Input, type Outcome, type RefusalCode } from "./core/index.ts";
import { mayCall, type ToolName } from "./tools.ts";
import { HEALTH_DEADLINE_MS } from "./core/reads.ts";
import * as say from "./render.ts";
import { abandonedRequestLine, labelPart, requestLabel, withSseKeepalive } from "./sse.ts";
import { authReachability, challengeHeader, edgeSettings, edgeView, forPublicDocument, PRM_PATH, protectedResourceDocument, refusalAt, UNREACHABLE_RETRY_AFTER_SECONDS, type EdgeSettings } from "./oauth-edge.ts";

// What the suites import from the module they drive; each now lives beside the
// core or the renderer it belongs to (SMD-2283).
export { parseFilter, withActorFilter } from "./core/filter.ts";
export { actorLine, demotedLine, currentNote, currentSearchHint, ingestedNotice, INGESTED_NOTICE, minTrustHint } from "./render.ts";
export { HEALTH_DEADLINE_MS, BRAIN_INFO_TOOL_DEADLINE_MS } from "./core/reads.ts";
export { abandonedRequestLine, requestLabel, SSE_KEEPALIVE_MAX_MS, SSE_KEEPALIVE_MS, stalledRequestLine, withSseKeepalive } from "./sse.ts";

// The core (SMD-2283): every tool's logic over the store and the model
// provider, as functions of a principal and a typed input (core/index.ts). Built
// once, at import; it reads the environment and the store through root.ts's
// two lazy readers, so Cloudflare Workers bindings — which arrive per
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
/** `endpoint`: the path the request came to, with no trailing slash — the job handle's links go under it. */
function buildServer(principal: Principal, endpoint = ""): McpServer {
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

  // A tool whose logic is in core/ (SMD-2283): registered only where the key's
  // scope unlocks the tool's group in the manifest (tools.ts's mayCall, the gate
  // the REST core asks too, SMD-1931) — a tool a key may not use is absent from
  // its tools/list, not refused — with the SDK validating the input against the tool's spec,
  // `run` calling the operation and rendering its outcome (render.ts), and
  // `fault` saying what an operation throws (review pass 6: sixteen copies of
  // that body before).
  const registerOp = <K extends ToolName>(name: K, run: (input: Input<K>) => Promise<say.Reply>, fault: (err: unknown, input: Input<K>) => say.Reply): void => {
    if (!mayCall(principal, name)) return;
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
  // words in render.ts, behind the manifest's gate like every tool (each is in
  // the read group); a fault is `Error: <message>` with the tool's hint where it
  // has one, FAILED beside it.
  const readTool = <K extends ToolName>(name: K, run: (input: Input<K>) => Promise<say.Reply>, hint?: (input: Input<K>) => ((msg: string) => string) | undefined): void =>
    registerOp(name, run, (err, input) => say.failed(err, { hint: hint?.(input) }));

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
    (input) => say.searchHint(input));

  /**
   * Tool 1b: Exact keyword search. Migration 012, SMD-944.
   *
   * A separate tool rather than a `mode` on search_thoughts. The two have
   * different cost models, different result shapes and different failure modes,
   * and an LLM choosing between two clearly-described tools does better than one
   * choosing between two meanings of one tool. The description leads with WHEN to
   * reach for it, because that is the only part the model reads before deciding.
   */
  readTool("search_thoughts_keyword", async (input) => say.renderSearchThoughtsKeyword(await core.searchThoughtsKeyword(principal, input)), (input) => say.searchHint(input));

  // Tool 2: List Recent
  readTool("list_thoughts", async (input) => say.renderListThoughts(await core.listThoughts(principal, input)));

  // Tool 2b: the supersession review queue (migration 029, SMD-1294)
  readTool("list_supersession_proposals", async (input) => say.renderSupersessionProposals(await core.listSupersessionProposals(principal, input)), () => say.proposalsHint);

  // Tool 3: Stats
  readTool("thought_stats", async (input) => say.renderThoughtStats(await core.thoughtStats(principal, input)));

  // Tool 3b: the change feed (migration 052, SMD-1296) — what moved since a
  // time or a cursor, for an agent that returns after a break. Gated like the
  // other read tools (a read or a write key sees it, a capture-only key does
  // not). The store calls one SQL function that chooses the page
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
  registerOp("capture_thought",
    async (input) => say.renderCapture(await core.capture(principal, input)),
    (err) => say.storeUnavailable(err));

  /**
   * Both are writes, so both are gated on scope exactly as capture_thought is —
   * a read-scoped key does not merely get a permission error, the tools are
   * never registered and do not appear in tools/list. A fault keeps the tool's
   * own lead, `update_thought failed:`, FAILED beside it.
   */
  registerOp("update_thought",
    async (input) => say.renderUpdate(await core.updateThought(principal, input)),
    (err) => say.failed(err, { lead: "update_thought failed: " }));

  registerOp("delete_thought",
    async (input) => say.renderDelete(await core.deleteThought(principal, input)),
    (err) => say.failed(err, { lead: "delete_thought failed: " }));

  // Tool 12 & 13: the write half of worker_status (SMD-2132), and Tool 14,
  // run_worker's dry-run preview (SMD-2272) — core/workers.ts. Write-scoped,
  // like update/delete: none is registered for a read or capture key. The two
  // mutating actions stamp the calling key into the action log, one row per
  // affected thought; the preview mutates nothing and writes none. A fault keeps
  // the tool's lead, `<tool> failed:`, FAILED beside it — on a PostgREST
  // (Workers) deploy the store throws the SQL-only reason, which is permanent,
  // not the transient STORE_UNAVAILABLE capture's implies. The keyed REST mirror
  // is the app.post guard below, over the same operations.
  registerOp("retry_failed",
    async (input) => say.renderRetryFailed(await core.retryFailed(principal, input)),
    (err) => say.failed(err, { lead: "retry_failed failed: " }));

  registerOp("release_stale_leases",
    async (input) => say.renderReleaseStaleLeases(await core.releaseStaleLeases(principal, input)),
    (err) => say.failed(err, { lead: "release_stale_leases failed: " }));

  registerOp("run_worker",
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
  readTool("scan_thoughts", async (input) => {
    const o = await core.scanThoughts(principal, input, { track: toolCalls.track });
    return say.renderJobHandle(o.ok ? { ...o, value: atEndpoint(o.value, endpoint) } : o);
  });

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
  // without this. The headers the fork means such a client to read are
  // exposed: Retry-After, the busy refusal's retry delay (SMD-2106);
  // Deprecation and Link, which the proxy's legacy route adds to the server's
  // answer (SMD-2306) while its headers middleware leaves this one alone, so
  // this must name them; and WWW-Authenticate, the challenge at the public
  // origin that names the protected-resource document a client signs in from
  // (SMD-2382). On a response that carries none of them this says nothing.
  "Access-Control-Expose-Headers": "Retry-After, Deprecation, Link, WWW-Authenticate",
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
 * The most of a keyless request's body read for its refusal's JSON-RPC id:
 * the one cost a caller who has shown no key sets (SMD-2309 review:
 * unbounded, a 100 MB body cost 0.6 s and hundreds of MB, measured). A request
 * MCP clients send is a few KB. A refusal to a key that matched (revoked,
 * busy) reads the whole body, as the accepted path does: a long capture's id
 * must come back, or the client waits out its timeout (review pass 2).
 */
export const REFUSAL_BODY_LIMIT = 64 * 1024;

/**
 * Read a refused request's body as text, at most `limit` bytes. This CONSUMES
 * the body: both callers return a refusal right after, so nothing downstream
 * needs it. Returns null on read failure, and for a body past the limit
 * (declared, or read so far), which the refusal then answers with `id: null`
 * as it does a body it cannot parse. No bodyless-method branch: a request
 * without a body reads as "", and its id is null. Decoded as it is read, so a
 * character split across chunks survives and no Buffer is needed (Workers).
 */
async function readBodyText(req: Request, limit = Infinity): Promise<string | null> {
  try {
    if (Number(req.headers.get("content-length")) > limit) return null;
    if (!req.body) return "";
    const reader = req.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    return null;
  }
}

/**
 * Best-effort extraction of the JSON-RPC `id` from a parsed request body.
 * Null when the body is missing, not JSON, or not a JSON-RPC shape with an
 * id. Per the JSON-RPC 2.0 spec, id may be a string, number, or null — we
 * preserve any of those; anything else becomes null.
 */
function jsonRpcIdOf(parsed: unknown): string | number | null {
  if (parsed && typeof parsed === "object" && "id" in parsed) {
    const id = (parsed as { id: unknown }).id;
    if (typeof id === "string" || typeof id === "number" || id === null) return id;
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
  let parsed: unknown;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    return { expectsReply: true, id: null };
  }
  const id = jsonRpcIdOf(parsed);
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

/**
 * The public origin's settings (oauth-edge.ts), read once: the environment is
 * frozen at the first request (root.ts initEnv), so these cannot change after.
 */
let edge: EdgeSettings | null = null;
function edgeHere(): EdgeSettings {
  return (edge ??= edgeSettings(env()));
}

/**
 * The refusal at the public resource while the authorization server answers
 * (SMD-2382): HTTP 401 with the challenge that names the protected-resource
 * document, the status RFC 9728 and the MCP authorization spec start a
 * sign-in from. A request keeps the JSON-RPC envelope in the body, so a client
 * that reads only the body still sees -32001; a notification gets none, as
 * notificationRefusedResponse says why.
 */
function challengeResponse(origin: string, refusedToken: boolean, target: RefusalTarget): Response {
  return edgeRefusal(401, { "WWW-Authenticate": challengeHeader(origin, refusedToken) }, target, JSON_RPC_UNAUTHORIZED_CODE, UNAUTHORIZED_MESSAGE);
}

/**
 * An OAuth token at the public resource of a stack configured with a sound
 * origin, while the authorization server does not answer: 503 with
 * Retry-After, never a 401, which would send the client back through a
 * sign-in that cannot finish either.
 */
const UNREACHABLE_MESSAGE =
  "Temporarily unavailable: this server cannot reach the authorization server, so no OAuth token can be checked. Retry later; an access key still works.";
function unavailableResponse(target: RefusalTarget): Response {
  return edgeRefusal(503, { "Retry-After": String(UNREACHABLE_RETRY_AFTER_SECONDS) }, target, JSON_RPC_BUSY_CODE, UNREACHABLE_MESSAGE);
}

/** The edge's two refusals: the status and headers given, the JSON-RPC envelope for a request, no body for a notification. */
type RefusalTarget = { expectsReply: boolean; id: string | number | null };
function edgeRefusal(status: number, extra: Record<string, string>, target: RefusalTarget, code: number, message: string): Response {
  const headers: Record<string, string> = { ...corsHeaders, ...extra };
  if (!target.expectsReply) return new Response(null, { status, headers });
  headers["Content-Type"] = "application/json";
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: target.id }), { status, headers });
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
//
// The one such route (SMD-2382): the public `/mcp`'s protected-resource
// document, served only while the stack is configured (COMPOSE_PROFILES names
// auth, OB1_PUBLIC_ORIGIN is sound), the request's Host is the origin's and the
// authorization server answers (oauth-edge.ts). Anything else falls through to
// the 404 — at any Host but the origin's, on a stack not configured or with an
// unsound origin, and while the authorization server is down. Asked without a
// key, as claude.ai asks it, so a `?key=` connector at /mcp of a configured
// stack is asked to sign in; its key still authenticates first (auth.ts), so
// it is served once it has (the auth profile is a preview until SMD-2286).
// A `Host` the URL cannot parse falls through too (oauth-edge.ts atOrigin).
app.get(PRM_PATH, async (c, next) => {
  const { origin } = edgeHere();
  if (!origin || !forPublicDocument(c.req.raw, origin) || !(await authReachability().reachable())) return next();
  return c.json(protectedResourceDocument(origin), 200, { ...corsHeaders, "Cache-Control": "no-store" });
});
app.all("/.well-known/*", (c) => c.text("Not Found", 404, corsHeaders));

/**
 * The request's path as it came, still percent-encoded. Hono's c.req.path is
 * decoded, so a `%22` or a `%20` in it would reach a log line or a job link
 * as a raw quote or space (SMD-2306 review pass 1).
 */
const rawPath = (req: Request): string => new URL(req.url).pathname;

/**
 * The root URL's compatibility window (SMD-2306). The proxy's legacy route
 * marks what it forwards with this header and its /mcp and health routes
 * delete it, so it is present only on a request that came to the old root URL
 * through the stack's proxy; a server with no proxy in front never sees it,
 * and its root is still the right URL. Every keyed route below calls
 * noteLegacyRoute once its key has passed (the MCP endpoint, /health under a
 * prefix, /worker-status, the worker actions, /jobs), so a script on the root
 * is named as an MCP client is. Logged once per key name per process: the
 * names are the configured keys', so the set is bounded by the configuration.
 * The path is the raw one, quoted and cut at 200 characters, so a client
 * cannot write its own text into the line.
 */
const LEGACY_ROUTE_HEADER = "x-ob1-legacy-route";
const legacyNamesLogged = new Set<string>();
export function legacyRouteLine(name: string, method: string, path: string): string {
  const shown = JSON.stringify(path.length > 200 ? `${path.slice(0, 200)}…` : path);
  return `key "${name}" reached the brain at the old root URL (${method} ${shown}) through the proxy's legacy route — move its client to /mcp; the root stops answering at v2.0.0 (SMD-2306; deploy/README.md, "Moving a client to /mcp")`;
}
function noteLegacyRoute(req: Request, name: string): void {
  if (req.headers.get(LEGACY_ROUTE_HEADER) !== "1" || legacyNamesLogged.has(name)) return;
  // The line first, so a throw here leaves the name unsaid. rawPath cannot
  // throw through the entry, which hands on only URLs that parse (auth.ts routable).
  const line = legacyRouteLine(name, req.method, rawPath(req));
  legacyNamesLogged.add(name);
  console.warn(line);
}

// Liveness for platform probes (Kubernetes httpGet, load-balancer target checks,
// uptime monitors), which can only GET and expect 2xx — the MCP endpoint answers
// GET with 405 (below). Without a key, like /.well-known/*: it says the process
// is serving and nothing else — no key, a wrong key, a capture-only key and a
// revoked one all get the literal `ok`, so nothing about the deployment reaches
// an unauthenticated probe. With a read or a write key it answers what the
// brain is, as JSON — brain_info's record (SMD-2041), and beside it `oauth`,
// the edge's own view (SMD-2382), for deploy/smoke.sh and an operator's curl —
// still a 200, since the process is serving: a database that
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
  }, { admit: CLIENT_SCOPES });
  // The keyed body is brain_info's record, so the key needs what that tool needs.
  if (!principal || !mayCall(principal, "brain_info")) return c.text("ok", 200, corsHeaders);
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
  // Beside the record, the edge's own view (SMD-2382; oauth-edge.ts edgeView),
  // started with the read: its probe, at most 2 s and once per 30 s, ends
  // inside the read's deadline.
  const oauth = edgeView(edgeHere(), () => authReachability().reachable());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const identity = await Promise.race([
    agents().resolve(db(), principal), // one lookup in flight per key (agents.ts)
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HEALTH_DEADLINE_MS); }),
  ]);
  clearTimeout(timer);
  if (!identity || identity.status !== "ok") return c.text("ok", 200, corsHeaders);
  noteLegacyRoute(c.req.raw, principal.name);
  return c.json({ ...(await info), oauth: await oauth }, 200, corsHeaders);
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
  }, { admit: CLIENT_SCOPES });
  if (!principal || !mayCall(principal, "worker_status")) return c.text("ok", 200, corsHeaders);
  if (c.req.method === "HEAD") return c.text("ok", 200, corsHeaders);
  // The same identity gate as /health: a revoked or unresolved key is shown nothing.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const identity = await Promise.race([
    agents().resolve(db(), principal),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HEALTH_DEADLINE_MS); }),
  ]);
  clearTimeout(timer);
  if (!identity || identity.status !== "ok") return c.text("ok", 200, corsHeaders);
  noteLegacyRoute(c.req.raw, principal.name);
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
// there. Gated as the tool each mirrors (mayCall: write scope today) — stricter than /worker-status's read mirror; a
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
  }, { admit: CLIENT_SCOPES });
  if (!principal || !mayCall(principal, isRetry ? "retry_failed" : isRelease ? "release_stale_leases" : "run_worker")) return c.text("ok", 200, corsHeaders);
  // The same identity gate as /worker-status: a revoked or unresolved key does nothing.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const identity = await Promise.race([
    agents().resolve(db(), principal),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HEALTH_DEADLINE_MS); }),
  ]);
  clearTimeout(timer);
  if (!identity || identity.status !== "ok") return c.text("ok", 200, corsHeaders);
  noteLegacyRoute(c.req.raw, principal.name);
  const body = await c.req.json().catch(() => null);
  const args: Record<string, unknown> = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  // The MCP tools' own operations (core/workers.ts): the same refusals, said
  // here as a 400 carrying the code, and the same action-log rows, one per
  // affected thought, stamped with the resolved agent id (SMD-2132). A dry run
  // mutates nothing, so it writes none.
  const caller: Principal = { ...principal, agentId: identity.agentId };
  // Each table words every code its operation refuses with (core/workers.ts), and no other.
  const said = <T extends object, C extends RefusalCode>(o: Outcome<T, C>, words: Record<NoInfer<C>, string>) => o.ok
    ? c.json(o.value, 200, corsHeaders)
    : c.json({ error: words[o.refusal.code as C], code: o.refusal.code }, 400, corsHeaders);
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
// scan_thoughts returns { jobId, poll: "<endpoint>/jobs/<id>", stream: "<endpoint>/jobs/<id>/stream" }
// at once (`/mcp/jobs/<id>` behind the proxy, SMD-2306); these routes serve the follow-up for a REST/curl client (an MCP
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
  }, { admit: CLIENT_SCOPES });
  if (!principal || !mayCall(principal, "job_status")) return c.text("ok", 200, corsHeaders);
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
  noteLegacyRoute(c.req.raw, principal.name);
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


// requestLabel and abandonedRequestLine live in sse.ts, beside the keepalive,
// so the vendored MCP servers' copies of it log a client that leaves the same
// way (SMD-2001).

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
  // The one thing this server logs per request (SMD-1849 has the rest; the
  // root URL's line, noteLegacyRoute's, is once per key name): a
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
  // Every caller's scope: this is the one server that registers a tool group for a
  // capture-only key. A consumer that does not say admits read and write alone,
  // and none admits a forwarder's, which grants nothing (SMD-2284).
  const principal = authenticateRequest(c.req.raw, {
    MCP_ACCESS_KEYS: env().MCP_ACCESS_KEYS,
    MCP_ACCESS_KEY: env().MCP_ACCESS_KEY,
  }, { admit: CLIENT_SCOPES });

  if (!principal) {
    // Return a JSON-RPC 2.0 error envelope (HTTP 200) instead of a bare
    // HTTP 401 so strict MCP hosts treat this as an application-level
    // error rather than a transport fault and keep the connection alive.
    // Best-effort echo of the inbound request id keeps the response
    // correlated; malformed/missing bodies fall back to id: null.
    // At the public resource of a configured stack, a keyless request or an
    // OAuth token is answered for OAuth (SMD-2382, oauth-edge.ts): the
    // challenge while the authorization server answers, a 503 for a token while
    // it does not. Asked before the body is read, so the probe's wait (at most
    // its timeout, once per window) comes before the read, not inside it.
    const answer = await refusalAt(edgeHere(), c.req.raw, () => authReachability().reachable());
    const bodyText = await readBodyText(c.req.raw, REFUSAL_BODY_LIMIT);
    const target = refusalTarget(bodyText);
    settled = true;
    if (answer.kind === "challenge") return challengeResponse(answer.origin, answer.refusedToken, target);
    if (answer.kind === "unavailable") return unavailableResponse(target);
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
  noteLegacyRoute(c.req.raw, principal.name);

  // The label, read once from the request body. v2's transport reads the raw
  // Request stream (v1's @hono/mcp read Hono's cached body, so a double-read was
  // harmless), so we cache the text here and hand a reconstructed Request to the
  // transport below — otherwise its parse sees an empty stream and every call
  // returns -32700 (SMD-2278). A body that cannot be read (the client gone
  // mid-upload) is `?` here and the transport's 400 there, as before.
  const rawBody = await c.req.text().catch(() => null);
  label = requestLabel(rawBody);

  // Repeated slashes collapsed: a path that came as `//mcp` (a proxy that
  // does not clean paths, or none) made the link `//mcp/jobs/<id>`, which a
  // client resolves as another host (review pass 2).
  const server = buildServer(principal, rawPath(c.req.raw).replace(/\/{2,}/g, "/").replace(/\/+$/, ""));
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
  // route's entry (SMD-1864, sse.ts); a stall settles the request too, so the
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
  serveHere(SERVER_NAME); // builds the store now and wires the durable job store for this server (root.ts)
  const grace = drainBoundFrom(process.env.OB1_STOP_GRACE);
  if (grace.problem) console.warn(grace.problem);
  drainOnSignal({
    drainBoundMs: grace.drainBoundMs,
    server: () => bunServer,
    calls: toolCalls,
    close: closeStore,
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
  // No `idleTimeout`: a tool call outlives the default by the keepalive (sse.ts),
  // and the default is the right reaper for a dead socket (SMD-1864).
  // An empty PORT is unset, not port 0 (a random port, silently) — `||`, the rule the vendored servers' tails share (SMD-1799).
  port: Number((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.PORT || 8000),
  fetch: (...[req, ...rest]: Parameters<typeof app.fetch>) => {
    if (SERVES_ON_BUN && !bunServer && isStoppable(rest[0])) bunServer = rest[0];
    // A request whose URL will not parse, rebuilt so it is routed and refused, not a 500 (SMD-2535).
    return app.fetch(routable(req), ...rest);
  },
};