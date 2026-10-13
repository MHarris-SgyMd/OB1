// The MCP endpoint's HTTP edge (SMD-2287 PR 2): what server-portable's
// index.ts answers around the SDK's transport — the methods it serves and its
// CORS headers, the JSON-RPC refusal envelopes and a notification's bare
// 202/503 (SMD-2106), the public origin's challenge and its 503 (SMD-2382), the
// bounded read of a refused body (SMD-2309), a request's parts and its calls'
// record for its line (SMD-1849), the stop's cut line (SMD-2250), the old root
// URL's line (SMD-2306), and the keyed mirrors' answers to a caller they show
// nothing. Moved out of index.ts as it was, so the MCP server as a REST client
// (mcp-server/, SMD-2287) answers at its edge as this one does. HTTP alone: no
// store, no provider, no environment.

import type { Context } from "hono";
import { challengeHeader, UNREACHABLE_RETRY_AFTER_SECONDS } from "./oauth-edge.ts";
import { traceOf, type RequestOutcome, type RequestTrace } from "./telemetry.ts";
import type { ToolName } from "./tools.ts";
import type { Input } from "./core/schemas.ts";
import type { ReleaseLeasesCode, RetryFailedCode, RunWorkerCode } from "./core/workers.ts";

/**
 * What a request's tool calls tell its line (telemetry.ts): how many ran to
 * an end, and the worst of how they ended, with that call's refusal or fault
 * code — one call, or a JSON-RPC batch's several, which the SDK's transport
 * still accepts.
 */
export type CallRecord = { ended?: number; outcome?: RequestOutcome; code?: string };

/** How a tool call ended, worst first: a batch's line says its worst call's. */
const OUTCOME_RANK: Partial<Record<RequestOutcome, number>> = { error: 3, refused: 2, unrun: 1, ok: 0 };
/** The worse of two outcomes (an absent one is better than any). */
export function worseOutcome(a: RequestOutcome | undefined, b: RequestOutcome | undefined): RequestOutcome | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return (OUTCOME_RANK[b] ?? -1) > (OUTCOME_RANK[a] ?? -1) ? b : a;
}

/** One call's end, on its request's record: counted, and kept with its code when it is worse than what the record holds — the first of equals stays. */
export function recordCall(record: CallRecord, outcome: RequestOutcome, code: string | undefined): void {
  record.ended = (record.ended ?? 0) + 1;
  if (outcome === record.outcome || worseOutcome(outcome, record.outcome) !== outcome) return;
  record.outcome = outcome;
  record.code = code;
}

// The methods the MCP endpoint serves. The transport is offered POST only: it is
// built per request and is sessionless, so there is no server stream for a GET
// to open and no session for a DELETE to end. One list registers the handler
// and names the 405's `Allow`, so the two cannot drift. FORK.md change 75.
export const MCP_METHODS = ["POST"];
export const ALLOWED_METHODS = [...MCP_METHODS, "OPTIONS"].join(", ");
// A health path serves GET and HEAD (index.ts's /health route) AND the MCP
// methods, since the MCP handler is registered at every path. Derived from the
// same list.
export const HEALTH_ALLOWED_METHODS = ["GET", "HEAD", ...MCP_METHODS, "OPTIONS"].join(", ");

// The CORS list is a different question — what a browser may send so it can
// hear our answer — so it keeps GET and DELETE: a browser-hosted SDK client
// given a session id by its constructor sends DELETE from terminateSession()
// and accepts the 405 it gets here; a preflight that hid DELETE would turn that
// into a network error instead.
export const corsHeaders = {
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
export const METHOD_NOT_ALLOWED_HEADERS = { ...corsHeaders, Allow: ALLOWED_METHODS };
export const HEALTH_METHOD_NOT_ALLOWED_HEADERS = { ...corsHeaders, Allow: HEALTH_ALLOWED_METHODS };

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
export const JSON_RPC_UNAUTHORIZED_CODE = -32001;

// A request refused for now, to be retried: the agent registry could not
// confirm the key in time (agents.ts's `busy`). Its own code, in the same
// implementation-defined range, so a client can tell "retry" from "denied".
export const JSON_RPC_BUSY_CODE = -32003;

// How long a client should wait before retrying a refusal that can change —
// the busy case (a registry lock; agents.ts retries within its own deadline).
// Advisory, as `Retry-After` is: it names "a few seconds" as BUSY_MESSAGE says.
export const RETRY_AFTER_SECONDS = 2;
export const UNAUTHORIZED_MESSAGE = "Unauthorized: missing or invalid authentication.";

/**
 * A key the environment still accepts but the registry has revoked.
 *
 * Worded differently from the generic failure on purpose. "Missing or invalid"
 * sends the holder of a revoked key looking for a typo; naming the revocation
 * tells them the key was valid and has been withdrawn, which is the one fact
 * that changes what they do next. It leaks nothing an attacker could use —
 * they already hold the key and already know it stopped working.
 */
export const REVOKED_MESSAGE =
  "Unauthorized: this access key has been revoked. Its history is retained; request a new key.";

/**
 * The registry's lookup timed out on a lock (a migration; a transaction
 * holding a stale key's row) or failed to serialize, through its retries, and
 * has not confirmed the key. Says what to do — retry — and nothing about
 * the key, which may be valid or revoked.
 */
export const BUSY_MESSAGE =
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
export async function readBodyText(req: Request, limit = Infinity): Promise<string | null> {
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
export function refusalTarget(bodyText: string | null): { expectsReply: boolean; id: string | number | null } {
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
export function unauthorizedResponse(
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
export function notificationRefusedResponse(opts: { retryAfter?: number } = {}): Response {
  const headers: Record<string, string> = { ...corsHeaders };
  if (opts.retryAfter !== undefined) headers["Retry-After"] = String(opts.retryAfter);
  return new Response(null, { status: opts.retryAfter !== undefined ? 503 : 202, headers });
}

/**
 * The refusal at the public resource while the authorization server answers
 * (SMD-2382): HTTP 401 with the challenge that names the protected-resource
 * document, the status RFC 9728 and the MCP authorization spec start a
 * sign-in from. A request keeps the JSON-RPC envelope in the body, so a client
 * that reads only the body still sees -32001; a notification gets none, as
 * notificationRefusedResponse says why.
 */
export function challengeResponse(origin: string, refusedToken: boolean, target: RefusalTarget): Response {
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
export function unavailableResponse(target: RefusalTarget): Response {
  return edgeRefusal(503, { "Retry-After": String(UNREACHABLE_RETRY_AFTER_SECONDS) }, target, JSON_RPC_BUSY_CODE, UNREACHABLE_MESSAGE);
}

/** The edge's two refusals: the status and headers given, the JSON-RPC envelope for a request, no body for a notification. */
export type RefusalTarget = { expectsReply: boolean; id: string | number | null };
export function edgeRefusal(status: number, extra: Record<string, string>, target: RefusalTarget, code: number, message: string): Response {
  const headers: Record<string, string> = { ...corsHeaders, ...extra };
  if (!target.expectsReply) return new Response(null, { status, headers });
  headers["Content-Type"] = "application/json";
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: target.id }), { status, headers });
}

/**
 * The request's path as it came, still percent-encoded. Hono's c.req.path is
 * decoded, so a `%22` or a `%20` in it would reach a log line or a job link
 * as a raw quote or space (SMD-2306 review pass 1).
 */
export const rawPath = (req: Request): string => new URL(req.url).pathname;

/**
 * The root URL's compatibility window (SMD-2306). The proxy's legacy route
 * marks what it forwards with this header and its /mcp and health routes
 * delete it, so it is present only on a request that came to the old root URL
 * through the stack's proxy; a server with no proxy in front never sees it,
 * and its root is still the right URL. Every keyed route in index.ts calls
 * noteLegacyRoute once its key has passed (the MCP endpoint, /health under a
 * prefix, /worker-status, the worker actions, /jobs), so a script on the root
 * is named as an MCP client is. Logged once per key name per process: the
 * names are the configured keys', so the set is bounded by the configuration.
 * The path is the raw one, quoted and cut at 200 characters, so a client
 * cannot write its own text into the line.
 */
export const LEGACY_ROUTE_HEADER = "x-ob1-legacy-route";
const legacyNamesLogged = new Set<string>();
export function legacyRouteLine(name: string, method: string, path: string): string {
  const shown = JSON.stringify(path.length > 200 ? `${path.slice(0, 200)}…` : path);
  return `key "${name}" reached the brain at the old root URL (${method} ${shown}) through the proxy's legacy route — move its client to /mcp; the root stops answering at v2.0.0 (SMD-2306; deploy/README.md, "Moving a client to /mcp")`;
}
export function noteLegacyRoute(req: Request, name: string): void {
  if (req.headers.get(LEGACY_ROUTE_HEADER) !== "1" || legacyNamesLogged.has(name)) return;
  // The line first, so a throw here leaves the name unsaid. rawPath cannot
  // throw through the entry, which hands on only URLs that parse (auth.ts routable).
  const line = legacyRouteLine(name, req.method, rawPath(req));
  legacyNamesLogged.add(name);
  console.warn(line);
}

/**
 * A keyed mirror whose key the registry did not clear — revoked, busy, or no
 * answer before the deadline — is shown `ok`, as a caller with no key is; its
 * line says `refused`, with REVOKED or BUSY where the registry said which
 * (review pass 3: it read `ok` with the key's name, so a revoked key at a
 * mirror never showed among what did not end ok).
 */
export function notCleared(c: Context, trace: RequestTrace | undefined, identity: { status: string } | null): Response {
  if (trace) {
    trace.outcome = "refused";
    trace.refusedAtKey = true;
    trace.code = identity?.status === "revoked" ? "REVOKED" : identity?.status === "busy" ? "BUSY" : undefined;
  }
  return c.text("ok", 200, corsHeaders);
}

/**
 * A keyed mirror's answer to a caller with no key, a wrong one, or one whose
 * scope lacks the mirror's tool: `ok`, a 200 that shows nothing — and its
 * line says `refused`, by no key's name.
 */
export function shownNothing(c: Context, trace: RequestTrace | undefined): Response {
  if (trace) {
    trace.outcome = "refused";
    trace.refusedAtKey = true;
  }
  return c.text("ok", 200, corsHeaders);
}

/**
 * A keyed mirror's name for its request's line (telemetry.ts): the route, as
 * a template — never the path, which may carry a prefix or an id — and the
 * tool it mirrors; the handler adds the key's name once it authenticates.
 */
export function nameRoute(c: { req: { raw: Request } }, route: string, tool: ToolName) {
  const trace = traceOf(c.req.raw);
  if (trace) {
    trace.route = route;
    trace.tool = tool;
  }
  return trace;
}

/**
 * A health path: `health` as the last path segment under any prefix a proxy
 * leaves on the request, with at most one trailing slash — index.ts's
 * /health route says why so broad, and why a test rather than a route pattern.
 */
export const HEALTH_PATH = /(^|\/)health\/?$/;

/** A request body read as JSON, for its line's parts; null when it is not JSON. */
export type ParsedBody = { value: unknown } | null;
export function parsedBody(bodyText: string | null): ParsedBody {
  try {
    return { value: JSON.parse(bodyText ?? "") };
  } catch {
    return null;
  }
}

/** What the request's JSON line (telemetry.ts) reads from its body. */
export type RequestParts = { rpc?: string; tool?: string; toolCalls: number };

/**
 * The JSON-RPC method and, for a tool call, the tool's name, as the caller
 * sent them, for the request's JSON line, which holds each to its known set
 * (telemetry.ts) — and how many tool calls the body asks for, so a call that
 * never ran is told from one that did. A batch of more than one message is
 * `batch`, naming no tool: its messages may be several calls, each ending its
 * own way (CallRecord). `tool` is read from a tool call alone, not from any
 * message whose params carry a name (a `prompts/get`). Unreadable, neither.
 */
export function partsOf(body: ParsedBody): RequestParts {
  if (!body) return { toolCalls: 0 };
  const messages: unknown[] = Array.isArray(body.value) ? body.value : [body.value];
  const isCall = (m: unknown) => (m as { method?: unknown } | null)?.method === "tools/call";
  const toolCalls = messages.filter(isCall).length;
  if (messages.length > 1) return { rpc: "batch", toolCalls };
  const msg = (messages[0] ?? {}) as { method?: unknown; params?: { name?: unknown } };
  if (typeof msg.method !== "string") return { toolCalls: 0 };
  return isCall(msg) && typeof msg.params?.name === "string" ? { rpc: msg.method, tool: msg.params.name, toolCalls } : { rpc: msg.method, toolCalls };
}

/**
 * The close sse.ts's abandonedRequestLine says, when the server's own stop
 * made it: the request was still running when the stop closed it — at the
 * drain bound, or on a second signal (shutdown.ts) — and the process exits
 * next, so the call does not run to its end (review pass 1 of SMD-2250 —
 * before, this was logged as the client leaving).
 */
export function cutByStopLine(label: string, elapsedMs: number): string {
  return `request cut off by the server's stop after ${(elapsedMs / 1000).toFixed(1)} s: ${label} — still running when the stop closed it, and the process exits now; a capture may or may not have landed (SMD-2250)`;
}

/** The keyed worker mirrors, each the REST mirror of its tool (SMD-2132, SMD-2272). */
export type MirrorTool = "retry_failed" | "run_worker" | "release_stale_leases";

/**
 * A worker mirror's refusal, in words: each table words every code its
 * operation refuses with (core/workers.ts), and no other, answered as a 400
 * beside the code. One table for every server that answers the mirrors, so
 * the MCP server as a REST client says them as this one does (SMD-2287).
 */
export const MIRROR_WORDS: { retry_failed: Record<RetryFailedCode, string>; run_worker: Record<RunWorkerCode, string>; release_stale_leases: Record<ReleaseLeasesCode, string> } = {
  retry_failed: {
    REFUSED_EMPTY_WORK_TYPE: "work_type is required — pass the exact workType worker_status reports.",
  },
  run_worker: {
    REFUSED_EMPTY_WORK_TYPE: "work_type is required — pass the exact workType worker_status reports for the pool to drain.",
    RUN_WORKER_DRAIN_NOT_AVAILABLE: "the executing drain is not yet available — the server does not run the bulk LLM passes; the drain will land on a callable worker core (SMD-2304). Send dry_run: true to preview what a pass would claim.",
  },
  release_stale_leases: {
    REFUSED_EMPTY_WORK_TYPE: "work_type was given but blank — omit it to reap across all pools, or pass a real workType.",
    REFUSED_LIVE_LEASE_NEEDS_WORKER: "include_live requires worker_id — releasing a live lease risks the holder double-processing.",
  },
};

const named = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * A worker mirror's JSON body as its operation's input: a work type that is
 * no string is empty (the operation refuses it), a dry run is `true` alone,
 * a `limit` a positive integer or left out, and a lease's ids made text.
 */
export const MIRROR_INPUT = {
  retry_failed: (args: Record<string, unknown>) => ({ work_type: named(args.work_type) }),
  run_worker: (args: Record<string, unknown>) => {
    // limit is accepted from the body when it is a positive integer, else omitted.
    const limit = typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0 ? args.limit : undefined;
    return { work_type: named(args.work_type), dry_run: args.dry_run === true, limit };
  },
  release_stale_leases: (args: Record<string, unknown>) => ({
    work_type: args.work_type === undefined ? undefined : String(args.work_type),
    worker_id: args.worker_id === undefined ? undefined : String(args.worker_id),
    include_live: args.include_live === true,
  }),
} satisfies { [K in MirrorTool]: (args: Record<string, unknown>) => Input<K> };
