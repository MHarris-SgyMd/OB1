import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { agents, closeStore, db, env, initEnv, plugins, serveHere, type Env } from "./root.ts";
import { authenticateRequest, CLIENT_SCOPES, presentedKeys, routable, type Principal } from "./auth.ts";
import { FORK_VERSION } from "./version.ts";
import { createCallCount, drainBoundFrom, drainOnSignal, isStoppable, type Stoppable } from "./shutdown.ts";
import { atEndpoint, subscribe as subscribeJob, markRunningLost } from "./jobs.ts";
import { createCore, mendIntervalFrom, runOperation, SPECS, type Input, type Outcome, type RefusalCode } from "./core/index.ts";
import { mayCall, unlocks, type ToolName } from "./tools.ts";
import { HEALTH_DEADLINE_MS } from "./core/reads.ts";
import * as say from "./render.ts";
import { abandonedRequestLine, labelPart, requestLabel, SSE_KEEPALIVE_MAX_MS, SSE_KEEPALIVE_MS, withSseKeepalive } from "./sse.ts";
import { beginRequest, cutOpenRequests, endsWithStream, flushTelemetry, outcomeOf, startTelemetry, traceOf, withToolSpan, type RequestOutcome, type ToolSpan } from "./telemetry.ts";
import { authReachability, edgeSettings, edgeView, forPublicDocument, PRM_PATH, protectedResourceDocument, refusalAt, type EdgeSettings } from "./oauth-edge.ts";
import { BUSY_MESSAGE, challengeResponse, corsHeaders, cutByStopLine, HEALTH_METHOD_NOT_ALLOWED_HEADERS, HEALTH_PATH, JSON_RPC_BUSY_CODE, MCP_METHODS, METHOD_NOT_ALLOWED_HEADERS, MIRROR_INPUT, MIRROR_WORDS, nameRoute, notCleared, noteLegacyRoute, notificationRefusedResponse, parsedBody, partsOf, rawPath, readBodyText, recordCall, REFUSAL_BODY_LIMIT, refusalTarget, RETRY_AFTER_SECONDS, REVOKED_MESSAGE, shownNothing, unauthorizedResponse, unavailableResponse, worseOutcome, type CallRecord, type RequestParts } from "./mcp-edge.ts";

// What the suites import from the module they drive; each now lives beside the
// core or the renderer it belongs to (SMD-2283).
export { parseFilter, withActorFilter } from "./core/filter.ts";
export { actorLine, demotedLine, currentNote, currentSearchHint, ingestedNotice, INGESTED_NOTICE, minTrustHint } from "./render.ts";
export { HEALTH_DEADLINE_MS, BRAIN_INFO_TOOL_DEADLINE_MS } from "./core/reads.ts";
export { abandonedRequestLine, requestLabel, SSE_KEEPALIVE_MAX_MS, SSE_KEEPALIVE_MS, stalledRequestLine, withSseKeepalive } from "./sse.ts";
// The HTTP edge's names this module exported before they moved to mcp-edge.ts (SMD-2287 PR 2), the suites reading some.
export { cutByStopLine, legacyRouteLine, recordCall, REFUSAL_BODY_LIMIT, type CallRecord, type RequestParts } from "./mcp-edge.ts";

// The core (SMD-2283): every tool's logic over the store and the model
// provider, as functions of a principal and a typed input (core/index.ts). Built
// once, at import; it reads the environment and the store through root.ts's
// two lazy readers, so the environment seeded before the first read applies.
// The model provider is anything speaking the OpenAI
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

/**
 * The keepalive's timing on an MCP answer's stream (sse.ts): its frame
 * interval, at whose ticks the ceiling is checked, and the ceiling — the
 * defaults, but where test-server [21] stalls a call in a fraction of a second.
 */
type KeepaliveTiming = { intervalMs: number; maxMs: number };
let keepaliveTiming: KeepaliveTiming = { intervalMs: SSE_KEEPALIVE_MS, maxMs: SSE_KEEPALIVE_MAX_MS };
/** Sets the timing for the calls that follow; returns the one it replaced. */
export function useKeepaliveTiming(next: KeepaliveTiming): KeepaliveTiming {
  const previous = keepaliveTiming;
  keepaliveTiming = next;
  return previous;
}
/**
 * `endpoint`: the path the request came to, with no trailing slash — the job
 * handle's links go under it. `record`: where each tool call says how it ended,
 * for the request's line.
 */
function buildServer(principal: Principal, endpoint = "", record: CallRecord = {}): McpServer {
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

  // One tool call's end: on the request's record, for its line — how the
  // call ended, and the code an error reply's structuredContent already
  // carries (an enum spelling, telemetry.ts holds it to that; a success's
  // value may hold a field of that name, which is not one) — and on the
  // call's own span (PR 2b). Calls are counted, and a batch's line keeps its
  // worst call's (worseOutcome).
  const ended = (reply: say.Reply, outcome: "ok" | "refused" | "error", span: ToolSpan): say.Reply => {
    const code = reply.isError && typeof reply.structuredContent.code === "string" ? reply.structuredContent.code : undefined;
    recordCall(record, outcome, code);
    span.end(outcome, code);
    return reply;
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
    // How the call ended (ended, above): the reply's isError is a refusal
    // from `run` (render.ts) and the fault from `fault`.
    register(name, SPECS[name], (input) => withToolSpan(name, async (span) => {
      try {
        const reply = await run(input);
        return ended(reply, reply.isError ? "refused" : "ok", span);
      } catch (err: unknown) {
        // Its kind and code on the call's span, never its message (PR 2c).
        span.fault(err);
        // A fault reply that itself throws is still this call's end: an
        // error, counted, and the SDK says the throw (not `unrun`).
        try {
          return ended(fault(err, input), "error", span);
        } catch (faultErr: unknown) {
          recordCall(record, "error", undefined);
          throw faultErr;
        }
      }
    }));
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
  // first page, and `after` =
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
  // Postgres (SMD-1844 closed the host port). Read-only, aggregated in SQL.
  // Gated like the other read tools.
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

  // The operator's reset of a capture-only key's settled or moved label
  // (migration 086, SMD-2744): a write key's tool, the operator gate the
  // database's (the key's registry kind), so a write key not classified
  // operator sees it and is refused.
  registerOp("reset_capture_stamp",
    async (input) => say.renderResetCaptureStamp(await core.resetCaptureStamp(principal, input)),
    (err) => say.failed(err, { lead: "reset_capture_stamp failed: ", hint: say.resetHint }));

  // Tool 12 & 13: the write half of worker_status (SMD-2132), and Tool 14,
  // run_worker's dry-run preview (SMD-2272) — core/workers.ts. Write-scoped,
  // like update/delete: none is registered for a read or capture key. The two
  // mutating actions stamp the calling key into the action log, one row per
  // affected thought; the preview mutates nothing and writes none. A fault keeps
  // the tool's lead, `<tool> failed:`, FAILED beside it. The keyed REST mirror
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

  // The enabled plugins' operations (SMD-2310), each a tool named
  // `<plugin>_<operation>` behind the gate a core tool of its group is
  // (tools.ts's unlocks) — absent from a key's tools/list where it does not
  // hold — with the SDK holding the input to the operation's schema and the
  // answer to its output schema. The REST core serves the same operations
  // (rest/app.ts), over the same runOperation.
  const registerPlugin = server.registerTool as unknown as (name: string, spec: unknown, handler: (input: unknown) => Promise<say.Reply>) => unknown;
  for (const op of plugins().flatMap((p) => p.operations)) {
    if (!unlocks(principal, op.scope)) continue;
    // Its end on the record and its span as a core tool's (PR 2b: a plugin
    // call told the record nothing, so its line read `unrun`).
    registerPlugin(op.tool, { title: op.title, description: op.description, annotations: op.annotations, inputSchema: op.input, outputSchema: op.output }, (input) => withToolSpan(op.tool, async (span) => {
      try {
        const reply = say.renderPlugin(await runOperation(op, { core, principal, track: toolCalls.track }, input));
        return ended(reply, reply.isError ? "refused" : "ok", span);
      } catch (err: unknown) {
        span.fault(err);
        return ended(say.failed(err), "error", span);
      }
    }));
  }

  return server;
}

// --- Hono App with Auth + CORS ---

/**
 * The public origin's settings (oauth-edge.ts), read once: the environment is
 * frozen at the first request (root.ts initEnv), so these cannot change after.
 */
let edge: EdgeSettings | null = null;
function edgeHere(): EdgeSettings {
  return (edge ??= edgeSettings(env()));
}

const app = new Hono<{ Bindings: Env }>();

// Every request's record (SMD-1849, telemetry.ts's RequestTrace), made first,
// so every route below is counted — the MCP endpoint, the keyed mirrors, the
// job routes, the preflight, the discovery 404s and notFound's 405s (and
// notFound makes one for a path this middleware never sees). A route whose
// answer outlives its handler (the MCP endpoint, a job stream) marks it
// deferred and ends it itself; every other is ended here, with its answer's
// status, outcome and code — or `abandoned` for a client already gone, or
// what the handler said of it (a mirror that showed its caller nothing: `refused`).
// An answer's code is the one its handler set (a worker action's refusal),
// never read back from its body (PR 2c). One request gets no record at all: the liveness probe — a GET or
// HEAD at a health path that presents no key, which the health route answers
// `ok` (a 200, unless the environment will not seed, a 500 the healthcheck itself sees) — sent every 30 s by the image's HEALTHCHECK; decided
// as it arrives, so nothing (PR 2b's span included) starts for it. A wrong or
// out-of-scope key there is logged `refused`, as at any mirror: a key that
// does not answer is a guess worth seeing (review pass 2). A route's thrown
// Error is Hono's 500, logged as any answer is here; the catch is for a throw
// that is not an Error, which Hono passes up.
app.use("*", async (c, next) => {
  const probe = (c.req.method === "GET" || c.req.method === "HEAD") && HEALTH_PATH.test(c.req.path)
    && !c.req.path.startsWith("/.well-known/") && presentedKeys(c.req.raw).length === 0;
  if (probe) return next();
  const trace = beginRequest("mcp", c.req.raw);
  try {
    // Under the request's span, so each tool call's span is its child (PR 2b).
    await trace.run(next);
  } catch (err) {
    trace.fault(err);
    trace.end({ status: 500, outcome: "error" });
    throw err;
  }
  if (trace.deferred || trace.ended) return;
  const at = performance.now();
  const gone = trace.clientGone;
  const code = gone ? undefined : trace.code;
  const outcome = gone ? "abandoned" : trace.outcome ?? outcomeOf(c.res.status, code);
  trace.end({ status: c.res.status, outcome, code }, at);
});

// Must run before anything reads env(). c.env is undefined under Bun, so
// initEnv reads process.env (it carried Workers' bindings, a target retired in
// SMD-3152).
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
// it is served once it has. On the compose stack /mcp is mcp-server/'s since SMD-2287 PR 5b, which trades a token;
// the proxy routes nothing to this server since SMD-2532, and a token is still refused here.
// A `Host` the URL cannot parse falls through too (oauth-edge.ts atOrigin).
app.get(PRM_PATH, async (c, next) => {
  const { origin } = edgeHere();
  if (!origin || !forPublicDocument(c.req.raw, origin) || !(await authReachability().reachable())) return next();
  return c.json(protectedResourceDocument(origin), 200, { ...corsHeaders, "Cache-Control": "no-store" });
});
app.all("/.well-known/*", (c) => c.text("Not Found", 404, corsHeaders));

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
app.get("*", async (c, next) => {
  if (!HEALTH_PATH.test(c.req.path)) return next();
  const trace = nameRoute(c, "/health", "brain_info");
  const principal = authenticateRequest(c.req.raw, {
    MCP_ACCESS_KEYS: env().MCP_ACCESS_KEYS,
    MCP_ACCESS_KEY: env().MCP_ACCESS_KEY,
  }, { admit: CLIENT_SCOPES });
  // The keyed body is brain_info's record, so the key needs what that tool needs.
  if (!principal || !mayCall(principal, "brain_info")) return shownNothing(c, trace);
  if (trace) trace.agent = principal.name;
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
  if (!identity || identity.status !== "ok") return notCleared(c, trace, identity);
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
  const trace = nameRoute(c, "/worker-status", "worker_status");
  const principal = authenticateRequest(c.req.raw, {
    MCP_ACCESS_KEYS: env().MCP_ACCESS_KEYS,
    MCP_ACCESS_KEY: env().MCP_ACCESS_KEY,
  }, { admit: CLIENT_SCOPES });
  if (!principal || !mayCall(principal, "worker_status")) return shownNothing(c, trace);
  if (trace) trace.agent = principal.name;
  if (c.req.method === "HEAD") return c.text("ok", 200, corsHeaders);
  // The same identity gate as /health: a revoked or unresolved key is shown nothing.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const identity = await Promise.race([
    agents().resolve(db(), principal),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HEALTH_DEADLINE_MS); }),
  ]);
  clearTimeout(timer);
  if (!identity || identity.status !== "ok") return notCleared(c, trace, identity);
  noteLegacyRoute(c.req.raw, principal.name);
  try {
    // The operation answers an object (a tool result is one); this route has always answered the bare rows.
    const status = await core.workerStatus(principal, {});
    return c.json(status.ok ? status.value.pools : [], 200, corsHeaders);
  } catch (e) {
    // A store failure: a reason, not a bare 500.
    // Its line says `error`, whatever the 200 (review pass 4: it read `ok`); its span the throw's kind and code (PR 2c).
    if (trace) { trace.outcome = "error"; trace.code = "FAILED"; trace.fault(e); }
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
// refusals-as-values are the tool's, as a 400 carrying the same code, and a
// store failure is a 200 body as the read mirror's.
const WORKER_RETRY_PATH = /(^|\/)worker-retry-failed\/?$/;
const WORKER_RELEASE_PATH = /(^|\/)worker-release-leases\/?$/;
const WORKER_RUN_PATH = /(^|\/)worker-run\/?$/;
app.post("*", async (c, next) => {
  const isRetry = WORKER_RETRY_PATH.test(c.req.path);
  const isRelease = WORKER_RELEASE_PATH.test(c.req.path);
  const isRun = WORKER_RUN_PATH.test(c.req.path);
  if (!isRetry && !isRelease && !isRun) return next();
  const tool = isRetry ? "retry_failed" : isRelease ? "release_stale_leases" : "run_worker";
  const trace = nameRoute(c, isRetry ? "/worker-retry-failed" : isRelease ? "/worker-release-leases" : "/worker-run", tool);
  const principal = authenticateRequest(c.req.raw, {
    MCP_ACCESS_KEYS: env().MCP_ACCESS_KEYS,
    MCP_ACCESS_KEY: env().MCP_ACCESS_KEY,
  }, { admit: CLIENT_SCOPES });
  if (!principal || !mayCall(principal, tool)) return shownNothing(c, trace);
  if (trace) trace.agent = principal.name;
  // The same identity gate as /worker-status: a revoked or unresolved key does nothing.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const identity = await Promise.race([
    agents().resolve(db(), principal),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HEALTH_DEADLINE_MS); }),
  ]);
  clearTimeout(timer);
  if (!identity || identity.status !== "ok") return notCleared(c, trace, identity);
  noteLegacyRoute(c.req.raw, principal.name);
  const body = await c.req.json().catch(() => null);
  const args: Record<string, unknown> = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  // The MCP tools' own operations (core/workers.ts): the same refusals, said
  // here as a 400 carrying the code, and the same action-log rows, one per
  // affected thought, stamped with the resolved agent id (SMD-2132). A dry run
  // mutates nothing, so it writes none.
  const caller: Principal = { ...principal, agentId: identity.agentId };
  // Each table words every code its operation refuses with (core/workers.ts), and no other; a refusal's code goes on the record for the line as it is answered (PR 2c).
  const said = <T extends object, C extends RefusalCode>(o: Outcome<T, C>, words: Record<NoInfer<C>, string>) => {
    if (o.ok) return c.json(o.value, 200, corsHeaders);
    if (trace) trace.code = o.refusal.code;
    return c.json({ error: words[o.refusal.code as C], code: o.refusal.code }, 400, corsHeaders);
  };
  // The body made each operation's input, and its refusals worded, as mcp-edge.ts's tables say — the MCP server as a REST client reads the same (SMD-2287).
  try {
    if (isRetry) return said(await core.retryFailed(caller, MIRROR_INPUT.retry_failed(args)), MIRROR_WORDS.retry_failed);
    if (isRun) return said(await core.runWorker(caller, MIRROR_INPUT.run_worker(args)), MIRROR_WORDS.run_worker);
    return said(await core.releaseStaleLeases(caller, MIRROR_INPUT.release_stale_leases(args)), MIRROR_WORDS.release_stale_leases);
  } catch (e) {
    // A store failure: a reason, not a bare 500 (parity with /worker-status).
    if (trace) { trace.outcome = "error"; trace.code = "FAILED"; trace.fault(e); }
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
  const trace = nameRoute(c, streamMatch ? "/jobs/:id/stream" : "/jobs/:id", "job_status");
  const principal = authenticateRequest(c.req.raw, {
    MCP_ACCESS_KEYS: env().MCP_ACCESS_KEYS,
    MCP_ACCESS_KEY: env().MCP_ACCESS_KEY,
  }, { admit: CLIENT_SCOPES });
  if (!principal || !mayCall(principal, "job_status")) return shownNothing(c, trace);
  if (trace) trace.agent = principal.name;
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
  if (!identity || identity.status !== "ok") return notCleared(c, trace, identity);
  noteLegacyRoute(c.req.raw, principal.name);
  if (streamMatch) {
    const stream = await subscribeJob(principal, id);
    if (!stream) return c.json({ error: "not found" }, 404, corsHeaders);
    const response = new Response(stream, { status: 200, headers: { ...corsHeaders, "content-type": "text/event-stream", "cache-control": "no-cache" } });
    // Kept alive by the same wrapper as the MCP stream (SMD-1864): the job's
    // events may be minutes apart, and a silent stream is reaped otherwise.
    // Its line is written where the stream ends, as the REST core's job stream's is.
    const ends = trace ? endsWithStream(trace, c.req.raw.signal) : {};
    return withSseKeepalive(response, { signal: c.req.raw.signal, label: `jobs/${labelPart(id)}/stream`, ...ends });
  }
  const job = await core.jobStatus(principal, { job_id: id });
  if (!job.ok) return c.json({ error: "not found" }, 404, corsHeaders);
  return c.json(job.value, 200, corsHeaders);
});

// requestLabel and abandonedRequestLine live in sse.ts, beside the keepalive,
// so the vendored MCP servers' copies of it log a client that leaves the same
// way (SMD-2001).

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
  // The request's record (SMD-1849, telemetry.ts), which the server's first
  // middleware made: this route ends it itself, once, when the request ends —
  // answered, refused at the key, left by its client, cut by the stop,
  // stalled, or thrown — so the middleware leaves it. Filled in as the route
  // learns: `status` the answer's, once there is one (0 before; 408 for a
  // client gone before the route ran); the JSON-RPC method and tool once the
  // body is read (`parts`); the key's name once it authenticates; `call` how
  // the tools ended, filled in by buildServer's registerOp. A tool call asked
  // for that never ran to an end — the transport or the SDK refused it, or
  // the key's scope does not register it — counts as `unrun`, and a batch
  // says its worst.
  // The first middleware made it: a POST is never the liveness probe.
  const trace = traceOf(c.req.raw)!;
  trace.deferred = true;
  let parts: RequestParts = { toolCalls: 0 };
  const read = (bodyText: string | null) => {
    parts = partsOf(parsedBody(bodyText));
    trace.rpc = parts.rpc;
    trace.tool = parts.tool;
  };
  const call: CallRecord = {};
  const finish = (end?: RequestOutcome, code?: string, bytes?: number) => {
    if (trace.ended) return;
    const ran = (call.ended ?? 0) < parts.toolCalls ? worseOutcome(call.outcome, "unrun") : call.outcome;
    const outcome = end ?? ran ?? outcomeOf(trace.status);
    trace.end({ outcome, code: code ?? (outcome === call.outcome ? call.code : undefined), bytes });
  };
  /** Refused before any tool ran: the key, the registry; the answer's status and why. */
  const refused = (response: Response, code: string): Response => {
    trace.status = response.status;
    trace.refusedAtKey = true;
    finish("refused", code);
    return response;
  };

  // Beside it, the human line for a client that closes the connection before
  // the response is complete, named by method and tool, never by content (the
  // root URL's line, noteLegacyRoute's, is once per key name). Registered
  // first, so a client that leaves during the key check, the registry resolve
  // or the body read is logged too (a listener added to a signal already
  // aborted never fires — so that case is checked by hand); the label is
  // filled in once the body is read. The signal aborts when the client goes,
  // not when a complete response's socket is later reaped (measured), and
  // `settled` keeps the line to the former anyway.
  const signal = c.req.raw.signal;
  let label = "?";
  let settled = false;
  const abandoned = () => {
    if (settled) return;
    // Once: a client that leaves reaches here by the abort and, on a stream,
    // by the body's cancel as well.
    settled = true;
    console.warn((cutByStop ? cutByStopLine : abandonedRequestLine)(label, performance.now() - trace.started));
    finish(cutByStop ? "cut" : "abandoned");
  };
  signal.addEventListener("abort", abandoned, { once: true });
  if (signal.aborted) {
    // Gone before the route ran: the line, and nothing else — no key check, no
    // registry resolve, no tool run for a client that will never read it. The
    // status reaches no one; 408 is the nearest name for what happened.
    trace.status = 408;
    abandoned();
    return c.body(null, 408);
  }

  // A throw from here on — the store, the transport — is Hono's 500; the
  // line says so before it goes.
  try {
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
      read(bodyText);
      settled = true;
      if (answer.kind === "challenge") return refused(challengeResponse(answer.origin, answer.refusedToken, target), "UNAUTHORIZED");
      if (answer.kind === "unavailable") return refused(unavailableResponse(target), "AUTH_UNREACHABLE");
      // A notification (no id) gets no JSON-RPC body: 202, since no key never
      // changes on a retry (SMD-2106). A request keeps the 200 envelope.
      return refused(target.expectsReply ? unauthorizedResponse(target.id) : notificationRefusedResponse(), "UNAUTHORIZED");
    }
    // Named from here on, so a line written during the registry's answer —
    // the client gone, a throw — says whose key it was.
    trace.agent = principal.name;

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
      read(bodyText);
      settled = true;
      // Revoked never changes on a retry, so a notification gets a bare 202; busy
      // can, so it gets 503 + Retry-After (and a busy REQUEST keeps the 200
      // envelope but gains Retry-After too). A request stays the 200 envelope,
      // answering its id (SMD-2106).
      if (identity.status === "revoked") {
        return refused(target.expectsReply ? unauthorizedResponse(target.id, REVOKED_MESSAGE) : notificationRefusedResponse(), "REVOKED");
      }
      return refused(target.expectsReply
        ? unauthorizedResponse(target.id, BUSY_MESSAGE, JSON_RPC_BUSY_CODE, { retryAfter: RETRY_AFTER_SECONDS })
        : notificationRefusedResponse({ retryAfter: RETRY_AFTER_SECONDS }), "BUSY");
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
    read(rawBody);

    // Repeated slashes collapsed: a path that came as `//mcp` (a proxy that
    // does not clean paths, or none) made the link `//mcp/jobs/<id>`, which a
    // client resolves as another host (review pass 2).
    const server = buildServer(principal, rawPath(c.req.raw).replace(/\/{2,}/g, "/").replace(/\/+$/, ""), call);
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
      trace.status = 500;
      finish("error");
      return c.json({ error: "No response from MCP transport" }, 500, corsHeaders);
    }
    response.headers.delete("mcp-session-id");
    for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
    trace.status = response.status;
    // Kept alive for as long as the tool runs, up to SSE_KEEPALIVE_MAX_MS from the
    // route's entry (SMD-1864, sse.ts); a stall settles the request too, so the
    // reap that follows it is not a second line blaming the client. The line is
    // written at the stream's end, with the bytes the transport wrote.
    return withSseKeepalive(response, {
      signal, label, startedAt: trace.started, ...keepaliveTiming,
      onEnd: (bytes) => { settled = true; finish(undefined, undefined, bytes); },
      onStall: () => { settled = true; finish("stalled"); },
      // The body let go of with no abort (a runtime whose signal never aborts): the client is gone.
      onCancel: abandoned,
    });
  } catch (err) {
    settled = true;
    trace.status = 500;
    // Its kind on the request's span, as the REST core's onError puts it there (PR 2c review pass 3).
    trace.fault(err);
    finish("error");
    throw err;
  }
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
app.notFound((c) => {
  // A path the `*` middleware never matched (one holding an encoded line
  // break) reaches here with no record: its line is written here, so such a
  // probe is seen like any other (review pass 3).
  if (!traceOf(c.req.raw)) beginRequest("mcp", c.req.raw).end({ status: 405, outcome: "refused" });
  return c.text("Method Not Allowed", 405, HEALTH_PATH.test(c.req.path) ? HEALTH_METHOD_NOT_ALLOWED_HEADERS : METHOD_NOT_ALLOWED_HEADERS);
});

// Stopping on SIGTERM, what is in flight finished (SMD-2250; shutdown.ts says
// why the image needs it). Bun serves the default export below itself and
// hands the server to no one but the fetch handler, as its second argument, so
// the first request passes it on; before that nothing can be in flight. Only
// when this module is Bun's entry: never in a suite that imports the module.
const SERVES_ON_BUN = typeof Bun !== "undefined" && import.meta.main === true;
let bunServer: Stoppable | undefined;
/** Set once the stop closes what is still in flight at its bound, so the route's close line names the stop, not the client. */
let cutByStop = false;
if (SERVES_ON_BUN) {
  serveHere(SERVER_NAME); // builds the store now and wires the durable job store for this server (root.ts)
  // Spans to a collector, where one is named (OTEL_EXPORTER_OTLP_ENDPOINT; telemetry.ts).
  void startTelemetry(SERVER_NAME);
  const grace = drainBoundFrom(process.env.OB1_STOP_GRACE);
  if (grace.problem) console.warn(grace.problem);
  // The vector mender (SMD-2889): rows saved without a vector get one once the
  // provider answers and the gate allows. The REST core (api.ts) starts one
  // too; a tick acts only under the store's leader lock, so one acts at a
  // time. Not a tracked call: a stop never waits on a re-embed, and a row it
  // cuts short stays vectorless for the next start.
  const mend = mendIntervalFrom(process.env.OB1_VECTOR_MEND_INTERVAL);
  if (mend.problem) console.warn(mend.problem);
  const mender = mend.intervalS > 0 ? core.startVectorMender({ intervalS: mend.intervalS }) : undefined;
  drainOnSignal({
    drainBoundMs: grace.drainBoundMs,
    server: () => bunServer,
    calls: toolCalls,
    close: closeStore,
    // The telemetry still batched goes beside the pool's close, under its bound, said on its own.
    flush: flushTelemetry,
    // A record the runtime no longer counts but that is still open — a mirror whose client left while it waits on the
    // registry — ends before that flush, on every path, though no cut came: a drained stop runs no onCut (PR 2c review pass 3).
    // The mender stops beside it, before the pool closes: no further row starts.
    endOpen: () => {
      mender?.stop();
      cutOpenRequests();
    },
    onCut: () => {
      cutByStop = true;
      // Every request still open gets its line — `cut`, or `abandoned` for a
      // client already gone — before the process exits: the MCP endpoint's, the mirrors', the job streams'. This runs
      // before the stop closes the sockets, so the MCP route's own abort
      // handler, which follows, finds its record ended (it ends once).
      cutOpenRequests();
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
  // Bun reads `fetch` and `port`; the suites call `fetch`. Node uses @hono/node-server.
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