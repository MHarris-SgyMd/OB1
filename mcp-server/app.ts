// The brain's MCP server as a client of its REST core (SMD-2287): the MCP
// endpoint, its public /health and its keyed mirrors, answered as
// server-portable's index.ts answered them — the same edge (mcp-edge.ts), the
// same words (render.ts) — with every operation a call to the REST core
// through rest-client, the caller's key forwarded beside this server's
// forward-scope key. It holds no store, no key list and no model: the REST
// core authenticates every caller (its whoami says who a key is and what it
// may call), runs every operation and answers every refusal, carried whole
// so its words are the ones server-portable says. `index.ts` in a comment
// below is that file, the MCP server this one replaced, retired in SMD-2287
// PR 6b (`git show 52f77d4f:server-portable/index.ts`), never this directory's.

import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Hono, type Context } from "hono";
import { presentedKeys, queryOf } from "../server-portable/auth.ts";
import { FORK_VERSION } from "../server-portable/version.ts";
import { SPECS, type Input } from "../server-portable/core/schemas.ts";
import type { ToolName } from "../server-portable/tools.ts";
import { HEALTH_DEADLINE_MS } from "../server-portable/deadlines.ts";
import type { Refusal } from "../server-portable/core/refusal.ts";
import type { LoadedOp, LoadedPlugin } from "../server-portable/core/plugins.ts";
import * as say from "../server-portable/render.ts";
import { abandonedRequestLine, labelPart, requestLabel, SSE_KEEPALIVE_MAX_MS, SSE_KEEPALIVE_MS, withSseKeepalive } from "../server-portable/sse.ts";
import { beginRequest, endsWithStream, outcomeOf as outcomeOfStatus, traceOf, withToolSpan, type RequestOutcome, type ToolSpan } from "../server-portable/telemetry.ts";
import type { CallCount } from "../server-portable/shutdown.ts";
import { atOriginHost, authReachability, edgeSettings, edgeView, forPublicDocument, forPublicResource, JWT_SHAPE, PRM_PATH, presentedKind, protectedResourceDocument, refusalAt, type EdgeSettings } from "../server-portable/oauth-edge.ts";
import { codeWord, ExchangeMisconfigured, type Exchanger } from "./exchange.ts";
import {
  BUSY_MESSAGE, challengeResponse, corsHeaders, cutByStopLine, edgeRefusal, HEALTH_METHOD_NOT_ALLOWED_HEADERS, HEALTH_PATH, JSON_RPC_BUSY_CODE, JSON_RPC_UNAUTHORIZED_CODE, MCP_METHODS,
  METHOD_NOT_ALLOWED_HEADERS, MIRROR_INPUT, MIRROR_WORDS, nameRoute, notCleared, notificationRefusedResponse, parsedBody,
  partsOf, rawPath, readBodyText, recordCall, REFUSAL_BODY_LIMIT, refusalTarget, RETRY_AFTER_SECONDS, REVOKED_MESSAGE, shownNothing,
  unauthorizedResponse, unavailableResponse, worseOutcome, type CallRecord, type MirrorTool, type RefusalTarget, type RequestParts,
} from "../server-portable/mcp-edge.ts";
import type { Answer, RestClient } from "../rest-client/index.ts";

/**
 * This server's name: what MCP clients see in `initialize`, as server-portable's
 * (`open-brain`). The door a write records is the REST core's, which runs it;
 * this server is named beside it as the request's carrier (`act`).
 */
export const SERVER_NAME = "open-brain";

/**
 * The longest a call to the REST core may take: an answer's stream is kept
 * alive that long (sse.ts's SSE_KEEPALIVE_MAX_MS), so a capture whose model
 * calls run long is answered within it, and no longer.
 */
export const REST_TIMEOUT_MS = SSE_KEEPALIVE_MAX_MS;

export interface McpDeps {
  /** The REST core's client, built with this server's forward-scope key (rest-client's forwarderKey). */
  rest: RestClient;
  /** The public origin's settings (oauth-edge.ts), read at the first request that needs them and kept, as index.ts reads them once the environment is frozen. */
  edge: () => EdgeSettings;
  /** The keepalive's timing on an answer's stream (sse.ts); the defaults unless a suite stalls a call quickly. */
  keepalive?: { intervalMs: number; maxMs: number };
  /** Where a client gone mid-call is told, one line (sse.ts's abandonedRequestLine); stderr unless a suite listens. */
  warn?: (line: string) => void;
  /** Where the REST core answers, for this server's fault lines (credentials blanked by the entry); none named unless given. */
  restUrl?: string;
  /**
   * The enabled plugins (SMD-2310), for their operations' names, schemas and
   * routes — the REST core runs them — read at the first request that needs
   * them; none unless given. A plugin the REST core runs and this server was
   * not given is no tool here.
   */
  plugins?: () => readonly LoadedPlugin[];
  /** The tool calls running, counted for the stop (SMD-2250), as index.ts counts its own: a call whose client left still runs to its end. */
  toolCalls?: CallCount & { track<T>(run: () => T | Promise<T>): Promise<T> };
  /** Set by the entry's stop when it cuts what is still in flight: a request it ends then is `cut`, said by the stop's line, not `abandoned`. */
  stop?: { cut: boolean };
  /**
   * The token exchange (exchange.ts, SMD-2286): read at the first request that
   * needs it; null or absent where this server trades no token (a stack not
   * configured, or no `mcp` client secret), and a token is then no caller.
   */
  exchanger?: () => Exchanger | null;
}

/**
 * The REST core refused this server's own forward-scope key — unknown, out of
 * scope, revoked: the server is misconfigured, whichever route asked. Said once
 * in the log in these words wherever it arrives (review pass 5 of PR 4b: four
 * routes said it four ways, one as the caller refused).
 */
export class ForwarderRefused extends Error {
  /** The operator's fix, for the log alone: a client is told the forwarder was refused, never this server's settings (review pass 6). */
  readonly hint = "set OB1_FORWARDER_KEY to a forward-scope key MCP_ACCESS_KEYS holds";
  constructor(status: number, code: string | undefined) {
    super(`the REST core refused this server's forwarder key (${status} ${codeWord(code) || "?"})`);
  }
}

/**
 * Who a request's key is, as the REST core's whoami says: its name, its scope
 * and the operations it may call — or why not. A caller `via` a token carries
 * the exchanged token in `key`'s place (credOf sends it as a bearer); the
 * token's own refusals are apart from a key's, since an OAuth client is told
 * them as OAuth answers.
 */
export type Standing =
  | { kind: "caller"; via: "key" | "token"; key: string; name: string; scope: string; operations: ReadonlySet<string> }
  | { kind: "none" } // no key, or none the core knows
  | { kind: "revoked"; name?: string }
  | { kind: "busy"; name?: string }
  | { kind: "token-invalid" } // a token the authorization server or the REST core refused: refresh or sign in
  | { kind: "token-scope" } // a token whose scopes name no key scope
  | { kind: "token-unavailable"; why: string }; // the authorization server did not answer, or the REST core has no keys to check with: `why` for the log

const REST_TOKENS_HINT = "run the REST core from this release with the auth profile and this server's OB1_PUBLIC_ORIGIN, on the mesh where it reads the authorization server's keys, so it checks the tokens this server trades for it";

/** What a caller's calls on the REST core carry: its key, or the exchanged token as a bearer. */
export const credOf = (caller: Extract<Standing, { kind: "caller" }>): { key: string } | { token: string } => (caller.via === "token" ? { token: caller.key } : { key: caller.key });

/**
 * A stack with a public origin, where a bearer of a JWT's shape is an OAuth
 * token: its exchange (null where this server trades none, or not on this
 * route), the origin, and which of that origin's requests take one: the MCP
 * endpoint exactly `/mcp` (forPublicResource, the default), the keyed routes
 * the proxy hands this server under it at the origin's `Host` (atOriginHost:
 * a scan's job links, the mirrors). With no route — no origin, so no OAuth —
 * such a bearer is a key, as server-portable reads it (review pass 2: a
 * dotted raw key sent as a bearer was refused on a stack with no OAuth).
 */
export type TokenRoute = { exchanger: Exchanger | null; origin: string; admits?: (req: Request, origin: string) => boolean };

/**
 * A traded token refused, by the authorization server (an expired, revoked or
 * foreign subject token) or by the REST core: 401 `invalid_token`, so the
 * client refreshes or signs in again (RFC 6750 §3.1), naming the document.
 */
export function tokenRefusedResponse(origin: string, target: RefusalTarget): Response {
  return edgeRefusal(401, { "WWW-Authenticate": `Bearer resource_metadata="${origin}${PRM_PATH}", error="invalid_token", error_description="the token is not valid here; refresh it or sign in again"` }, target, JSON_RPC_UNAUTHORIZED_CODE, "Unauthorized: the OAuth token is not valid here; refresh it or sign in again.");
}

/**
 * A token whose scopes name no access key's (none of the brain's, or
 * brain:read with brain:capture and no brain:write): 403 `insufficient_scope`,
 * naming `scope="brain:read"`, the least that reaches an operation. An MCP
 * client steps up to its scope joined with the challenge's (the SDK's
 * scope-challenge handling): with no scope named, that join is the token's
 * own, so a token with no brain scope only refreshed into the same 403 and
 * never asked the user to sign in again (review pass 1, measured on MCP SDK
 * v2). For read with capture the join adds nothing: its client refreshes,
 * and is mended only if the refresh widens to the grant's scope (review
 * pass 2).
 */
export function tokenScopeResponse(origin: string, target: RefusalTarget): Response {
  return edgeRefusal(403, { "WWW-Authenticate": `Bearer resource_metadata="${origin}${PRM_PATH}", error="insufficient_scope", scope="brain:read", error_description="this token's scopes reach no operation: brain:write, brain:read or brain:capture"` }, target, JSON_RPC_UNAUTHORIZED_CODE, "Forbidden: the OAuth token's scopes reach no operation; sign in for brain:write, brain:read or brain:capture.");
}

/**
 * A token refused, answered as OAuth answers it, at /mcp and at the keyed
 * routes alike: 401 `invalid_token`, 403 `insufficient_scope`, or 503 with
 * Retry-After — and a 503 in place of the 401 while the authorization server
 * fails its health check, since the refresh a 401 starts cannot finish and a
 * client then falls back to an interactive sign-in (review pass 2, measured
 * on MCP SDK v2: an expired token with the server away opened one). The
 * probe is cached 30 s; a check it has to make can run past a keyed route's
 * deadline, once per 30 s.
 */
export async function tokenRefusal(kind: "token-invalid" | "token-scope" | "token-unavailable", origin: string, target: RefusalTarget, reachable: () => Promise<boolean>): Promise<{ response: Response; code: string }> {
  if (kind === "token-unavailable" || (kind === "token-invalid" && !(await reachable()))) return { response: unavailableResponse(target), code: "AUTH_UNREACHABLE" };
  if (kind === "token-scope") return { response: tokenScopeResponse(origin, target), code: "FORBIDDEN" };
  return { response: tokenRefusedResponse(origin, target), code: "UNAUTHORIZED" };
}

/** The `Authorization: Bearer` value, read as auth.ts presentedKeys reads it. */
const bearerOf = (req: Request): string | undefined => req.headers.get("authorization")?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];

/**
 * The keys a request presents to send on as keys (auth.ts presentedKeys),
 * less, on a stack with OAuth (`tokens`), a bearer of a JWT's shape that no
 * key form also carries: an OAuth token beside an empty `?key=` or an unknown
 * key is still a token, never a key (review pass 1). A dotted value in
 * `x-brain-key`, `x-access-key` or `?key=` stays a key: an operator's raw
 * `MCP_ACCESS_KEY` may have dots, and the REST core takes it (review pass 2:
 * every form of it was refused).
 */
export function keysToSend(req: Request, tokens: boolean): string[] {
  const keys = presentedKeys(req);
  if (!tokens) return keys;
  const bearer = bearerOf(req);
  if (!bearer || !JWT_SHAPE.test(bearer)) return keys;
  const inForm = [req.headers.get("x-brain-key"), req.headers.get("x-access-key"), queryOf(req.url).get("key")].includes(bearer);
  return inForm ? keys : keys.filter((key) => key !== bearer);
}

/**
 * The caller, as server-portable finds one: each key the request presents —
 * `x-brain-key`, `x-access-key`, `?key=`, `Bearer` (auth.ts presentedKeys) — in
 * turn, the first the REST core knows deciding. A key it does not know (401
 * UNAUTHORIZED) passes to the next; one it knows but has revoked, or cannot
 * confirm while its registry is busy, decides as it stands. The forwarder slot
 * this server fills is its own: refused there, the server is misconfigured,
 * and the request is a fault, never a caller's refusal.
 */
export async function standingOf(rest: RestClient, req: Request, signal?: AbortSignal, onUnknown?: (key: string) => void, token?: TokenRoute | null): Promise<Standing> {
  // On a stack with a public origin, a bearer of a JWT's shape with no key
  // form beside it is an OAuth client's token (oauth-edge.ts presentedKind),
  // and is never sent to the REST core as a key: that is the passthrough the
  // MCP spec forbids. It is traded at the public resource of a stack that
  // trades (SMD-2286), and anywhere else is no caller (at any other Host,
  // hosts reach the brain with keys).
  if (token && presentedKind(req) === "token") {
    if (!token.exchanger || !(token.admits ?? forPublicResource)(req, token.origin)) return { kind: "none" };
    const traded = await token.exchanger.exchange(bearerOf(req) ?? "");
    if (traded.status === "invalid") return { kind: "token-invalid" };
    if (traded.status === "scope") return { kind: "token-scope" };
    if (traded.status === "unavailable") return { kind: "token-unavailable", why: `the authorization server did not trade it: ${traded.why}` };
    const a = await rest.call("whoami" as never, {} as never, { token: traded.token, signal });
    const body = (a.body ?? {}) as { code?: string; credential?: string; name?: string; scope?: string; operations?: string[] };
    const named = typeof body.name === "string" ? { name: body.name } : {};
    if (body.credential === "forwarder" && a.status === 503) return { kind: "busy", ...named };
    if (body.credential === "forwarder") throw new ForwarderRefused(a.status, body.code);
    if (a.status === 200) return { kind: "caller", via: "token", key: traded.token, name: String(body.name), scope: String(body.scope), operations: new Set(body.operations ?? []) };
    // A subject the registry revoked: refused as a revoked key is, a JSON-RPC refusal, not a 401 that would send the client to a sign-in no token escapes.
    if (a.status === 401 && body.code === "REVOKED") return { kind: "revoked", ...named };
    // A token the authorization server minted for this REST core a moment ago (or kept, until 5 s before it lapses),
    // refused there: the REST core checks none (its auth profile off, older than SMD-2286 PR 1) or checks another
    // origin's, or cannot match the server's keys — this stack's misconfiguration, never the client's to refresh out
    // of (review passes 2 and 3: a 401 sent the client round sign-in for ever, nothing logged).
    if (a.status === 401) throw new ExchangeMisconfigured(`the REST core refused a token traded for it a moment ago (whoami 401${body.credential === "token" ? "" : ", checking no token"})`, REST_TOKENS_HINT);
    if (a.status === 403) return { kind: "token-scope" };
    if (a.status === 503 && body.credential === "token") return { kind: "token-unavailable", why: "the REST core could not read the authorization server's keys" };
    if (a.status === 503) return { kind: "busy", ...named };
    throw new Error(`the REST core answered whoami for a token ${a.status} ${codeWord(body.code)}`.trim());
  }
  for (const key of keysToSend(req, token != null)) {
    const a = await rest.call("whoami" as never, {} as never, { key, signal });
    const body = (a.body ?? {}) as { code?: string; credential?: string; name?: string; scope?: string; operations?: string[] };
    // This server's own key in the forwarder slot: busy is the registry's, as for a caller's key (review pass 3: it read
    // as a misconfiguration); refused, the server is misconfigured.
    // A caller's key the registry revoked or is busy on is named, as the REST core names it to a forwarder, for the line.
    const named = typeof body.name === "string" ? { name: body.name } : {};
    if (body.credential === "forwarder" && a.status === 503) return { kind: "busy", ...named };
    if (body.credential === "forwarder") throw new ForwarderRefused(a.status, body.code);
    if (a.status === 200) return { kind: "caller", via: "key", key, name: String(body.name), scope: String(body.scope), operations: new Set(body.operations ?? []) };
    if (a.status === 401 && body.code === "REVOKED") return { kind: "revoked", ...named };
    if (a.status === 503) return { kind: "busy", ...named };
    if (a.status !== 401) throw new Error(`the REST core answered whoami ${a.status} ${codeWord(body.code)}`.trim());
    // A key the REST core does not know: the next decides, if one does.
    onUnknown?.(key);
  }
  return { kind: "none" };
}

/** An operation's answer from the REST core, as render.ts reads an outcome: its value, its refusal whole, or a fault. */
type Outcome = { ok: true; value: unknown } | { ok: false; refusal: Refusal } | { fault: Error };

/**
 * A REST answer as the outcome the in-process core would have handed
 * render.ts: a success's value whatever its fields — a plugin's may name one
 * `refusal`; a refusal the forwarder slot carried whole; a fault — FAILED or
 * capture's STORE_UNAVAILABLE — as the error its message names, so the tool's
 * fault words say it as they always have. Anything else (a refusal of the
 * key mid-call, an input the client answered itself) is a fault naming its
 * code. No success carries a refusal since SMD-3153 took the 201 that did.
 */
export function outcomeOf(a: Answer): Outcome {
  if (a.ok) return { ok: true, value: a.body };
  const body = (a.body ?? {}) as { refusal?: Refusal; code?: string; message?: string; credential?: string; issues?: { path: string; message: string }[] };
  if (body.refusal && typeof body.refusal === "object") return { ok: false, refusal: body.refusal };
  // This server's forwarder refused mid-call: its misconfiguration, whichever operation asked (review pass 5). Busy is the registry's (turned).
  if (body.credential === "forwarder" && a.status !== 503) return { fault: new ForwarderRefused(a.status, body.code) };
  if ((body.code === "FAILED" || body.code === "STORE_UNAVAILABLE") && typeof body.message === "string") return { fault: new Error(body.message) };
  if (body.code === "REFUSED_INPUT" && body.issues?.length) return { fault: new Error(body.issues.map((i) => `${i.path || "input"}: ${i.message}`).join("; ")) };
  return { fault: new Error(`the REST core answered ${a.status}${codeWord(body.code) ? ` ${codeWord(body.code)}` : ""}`) };
}

/** Two calls of one request under one JSON-RPC id: which arguments are whose cannot be told (review pass 3). */
export const AMBIGUOUS = Symbol("two calls share an id");
/**
 * Each tools/call's arguments as its client sent them, by the request's
 * JSON-RPC id (JSON-written), from a body of one message or a batch: none
 * given is `{}`, as the SDK reads it (review pass 3: a call with no arguments
 * fell back to the SDK's parse, and a step ran twice); an id two calls share
 * is AMBIGUOUS, never the first one's (review pass 3: both ran with it).
 */
export type RawArguments = ReadonlyMap<string, Record<string, unknown> | typeof AMBIGUOUS>;
export function argumentsById(body: string | null): RawArguments {
  const out = new Map<string, Record<string, unknown> | typeof AMBIGUOUS>();
  let parsed: unknown;
  // Leading byte-order marks dropped, as the SDK's decoder drops them (review pass 4: two made this parse fail where the SDK's did not).
  try { parsed = body ? JSON.parse(body.replace(/^\uFEFF+/, "")) : null; } catch { return out; }
  for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
    const msg = m as { id?: unknown; method?: unknown; params?: { arguments?: unknown } } | null;
    if (msg?.method !== "tools/call" || msg.id === undefined) continue;
    // None given is {}, as the SDK reads it; a null the SDK refuses before any handler runs, so it is no call's.
    const args = msg.params?.arguments === undefined ? {} : msg.params.arguments;
    if (typeof args !== "object" || Array.isArray(args)) continue;
    const key = JSON.stringify(msg.id);
    out.set(key, out.has(key) ? AMBIGUOUS : args as Record<string, unknown>);
  }
  return out;
}

/**
 * How each tool says its answer (render.ts), and its fault — server-portable
 * index.ts's registrations, the call made over REST — in index.ts's order,
 * which tools/list keeps.
 */
type Words = {
  render: (o: never, input: never) => say.Reply;
  fault: (err: unknown, input: never) => say.Reply;
};
const readFault = (hint?: (input: never) => ((msg: string) => string) | undefined) =>
  (err: unknown, input: never) => say.failed(err, { hint: hint?.(input) });
const writeFault = (lead: string, hint?: (msg: string) => string) => (err: unknown) => say.failed(err, { lead, hint });
const WORDS: Record<ToolName, Words> = {
  search: { render: (o) => say.renderSearch(o), fault: readFault() },
  fetch: { render: (o) => say.renderFetch(o), fault: readFault() },
  search_thoughts: { render: (o, input: Input<"search_thoughts">) => say.renderSearchThoughts(o, input.prefer_current), fault: readFault((input: Input<"search_thoughts">) => say.searchHint(input)) },
  search_thoughts_keyword: { render: (o) => say.renderSearchThoughtsKeyword(o), fault: readFault((input: Input<"search_thoughts_keyword">) => say.searchHint(input)) },
  list_thoughts: { render: (o) => say.renderListThoughts(o), fault: readFault() },
  list_supersession_proposals: { render: (o) => say.renderSupersessionProposals(o), fault: readFault(() => say.proposalsHint) },
  thought_stats: { render: (o) => say.renderThoughtStats(o), fault: readFault() },
  thought_changes: { render: (o) => say.renderThoughtChanges(o), fault: readFault(() => say.changesHint) },
  list_thought_ids: { render: (o) => say.renderThoughtIds(o), fault: readFault() },
  list_logged_searches: { render: (o) => say.renderLoggedSearches(o), fault: readFault(() => say.loggedSearchesHint) },
  worker_status: { render: (o) => say.renderWorkerStatus(o), fault: readFault() },
  // brain_info's record is never a refusal: the reply renders the value itself.
  brain_info: { render: (o) => say.renderBrainInfoReply((o as { value: never }).value), fault: readFault() },
  // capture's fault is STORE_UNAVAILABLE, the transient the session hook keeps and retries (SMD-1978).
  capture_thought: { render: (o) => say.renderCapture(o), fault: (err) => say.storeUnavailable(err) },
  update_thought: { render: (o) => say.renderUpdate(o), fault: writeFault("update_thought failed: ") },
  delete_thought: { render: (o) => say.renderDelete(o), fault: writeFault("delete_thought failed: ") },
  reset_capture_stamp: { render: (o) => say.renderResetCaptureStamp(o), fault: writeFault("reset_capture_stamp failed: ", say.resetHint) },
  review_supersession_proposal: { render: (o) => say.renderReviewProposal(o), fault: writeFault("review_supersession_proposal failed: ", say.reviewHint) },
  retry_failed: { render: (o) => say.renderRetryFailed(o), fault: writeFault("retry_failed failed: ") },
  release_stale_leases: { render: (o) => say.renderReleaseStaleLeases(o), fault: writeFault("release_stale_leases failed: ") },
  run_worker: { render: (o) => say.renderRunWorker(o), fault: writeFault("run_worker failed: ") },
  job_status: { render: (o) => say.renderJobStatus(o), fault: readFault() },
  scan_thoughts: { render: (o) => say.renderJobHandle(o), fault: readFault() },
};

/**
 * The MCP server for one request: the tools the caller's operations name,
 * each validated by the SDK against the tool's own schema (core/schemas.ts,
 * or a plugin's manifest), called on the REST core with the caller's key, and
 * its answer said by render.ts. `endpoint`: the path the request came to, no
 * trailing slash — a scan's job links go under it, as server-portable's do.
 * `ops`: the enabled plugins' operations. `raw`: each call's arguments as its
 * client sent them (argumentsById), which a plugin tool sends on.
 */
function buildServer(rest: RestClient, caller: Extract<Standing, { kind: "caller" }>, endpoint: string, ops: readonly LoadedOp[], raw: RawArguments, record: CallRecord, track: <T>(run: () => Promise<T>) => Promise<T>, tell: (err: unknown) => void): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: FORK_VERSION });
  const registerTool = server.registerTool.bind(server) as unknown as (name: string, spec: unknown, handler: (input: never, ctx: { mcpReq?: { id?: unknown } }) => Promise<say.Reply>) => unknown;
  // Each call counted while it runs, past its client leaving, for the stop (index.ts's registerTool, SMD-2250), and
  // under its own span, the request's child (index.ts's registerOp, PR 4c): what it sends the REST core carries that
  // span's traceparent, so the operation's spans are its children, one trace.
  const register = (name: string, spec: unknown, handler: (input: never, ctx: { mcpReq?: { id?: unknown } }, span: ToolSpan) => Promise<say.Reply>) =>
    registerTool(name, spec, (input, ctx) => track(() => withToolSpan(name, (span) => handler(input, ctx, span))));
  // One call's end on the request's record, for its line, and on its span: how it ended, and the code an error reply carries (index.ts's ended).
  const ended = (reply: say.Reply, outcome: "ok" | "refused" | "error", span: ToolSpan): say.Reply => {
    const code = reply.isError && typeof reply.structuredContent.code === "string" ? reply.structuredContent.code : undefined;
    recordCall(record, outcome, code);
    span.end(outcome, code);
    return reply;
  };
  /**
   * A fault's reply as the call's end — and a fault reply that itself throws is still an error, counted (index.ts's
   * registerOp); this server's forwarder refused mid-call said in the log too, as on every route (review pass 6). The
   * fault's kind on the call's span, never its message (PR 2c); a call this server refused before sending has none.
   */
  const faulted = (err: unknown, say_: () => say.Reply, span: ToolSpan): say.Reply => {
    if (err instanceof ForwarderRefused) tell(err);
    if (err !== null) span.fault(err);
    try {
      return ended(say_(), "error", span);
    } catch (err) {
      recordCall(record, "error", undefined);
      throw err;
    }
  };
  for (const name of Object.keys(WORDS) as ToolName[]) {
    if (!caller.operations.has(name)) continue;
    const words = WORDS[name];
    register(name, SPECS[name], async (input: never, _ctx, span) => {
      // The call and its rendering under one catch, as index.ts's registerOp runs
      // them: a reply that cannot be said is the tool's fault, its code the
      // session hook reads (review pass 1: a throw past it reached the SDK as an
      // uncoded error).
      try {
        let outcome = outcomeOf(await rest.call(name as never, input, credOf(caller)));
        if ("fault" in outcome) return faulted(outcome.fault, () => words.fault((outcome as { fault: Error }).fault, input), span);
        if (name === "scan_thoughts" && outcome.ok) {
          // The handle's links under this server's endpoint, as atEndpoint puts them (jobs.ts): its /jobs routes, not the REST core's /v1/jobs.
          const handle = outcome.value as { jobId: string };
          outcome = { ok: true, value: { ...handle, poll: `${endpoint}/jobs/${handle.jobId}`, stream: `${endpoint}/jobs/${handle.jobId}/stream` } };
        }
        const reply = words.render(outcome as never, input);
        return ended(reply, reply.isError ? "refused" : "ok", span);
      } catch (err) {
        return faulted(err, () => words.fault(err, input), span);
      }
    });
  }
  // The enabled plugins' operations (SMD-2310), after the core's as index.ts
  // registers them: a tool `<plugin>_<operation>` where whoami names it, held
  // by the SDK to the manifest's schemas, called on the REST core by its route
  // and said by render.ts's renderPlugin. What it sends is its client's
  // arguments, not the SDK's parse of them, so the value is the REST core's one
  // parse as index.ts's is its SDK's (review pass 2: a preprocess, an overwrite
  // or a codec ran on its own output); the SDK's validation runs the steps too.
  for (const op of ops) {
    if (!caller.operations.has(op.tool)) continue;
    register(op.tool, { title: op.title, description: op.description, annotations: op.annotations, inputSchema: op.input, outputSchema: op.output }, async (_input: never, ctx, span) => {
      try {
        const id = JSON.stringify(ctx?.mcpReq?.id);
        const given = raw.get(id);
        if (given === AMBIGUOUS) return faulted(null, () => say.failed(new Error(`two calls in this request share the JSON-RPC id ${id}: each call needs an id of its own`)), span);
        // Never the SDK's parse in its place, which the REST core would parse again (review pass 4: a body the SDK read and this server did not).
        if (!given) return faulted(null, () => say.failed(new Error(`this server could not read the arguments of call ${id} from its request`)), span);
        const sent = Object.fromEntries(Object.entries(given).filter(([field]) => Object.hasOwn(op.shape, field)));
        const outcome = outcomeOf(await rest.callPath(op.method, op.path, sent, credOf(caller)));
        if ("fault" in outcome) return faulted(outcome.fault, () => say.failed(outcome.fault), span);
        const reply = say.renderPlugin(outcome as never);
        return ended(reply, reply.isError ? "refused" : "ok", span);
      } catch (err) {
        return faulted(err, () => say.failed(err), span);
      }
    });
  }
  return server;
}

export function createMcpApp(deps: McpDeps): Hono {
  const app = new Hono();
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const keepalive = deps.keepalive ?? { intervalMs: SSE_KEEPALIVE_MS, maxMs: SSE_KEEPALIVE_MAX_MS };
  let edge: EdgeSettings | null = null;
  const edgeHere = (): EdgeSettings => (edge ??= deps.edge());
  let pluginOps: readonly LoadedOp[] | null = null;
  const opsHere = (): readonly LoadedOp[] => (pluginOps ??= (deps.plugins?.() ?? []).flatMap((p) => p.operations));
  /**
   * Each operation whoami names that this server has no tool for — a plugin
   * the REST core runs and this server was not given, or a core tool of a
   * newer REST core, which the name cannot tell apart — said once: the caller
   * sees no tool, so the log is where the mismatch shows (review passes 1, 2).
   */
  const untooled = new Set<string>();
  const noteUntooled = (operations: ReadonlySet<string>) => {
    for (const name of operations) {
      if (untooled.has(name) || name in WORDS || opsHere().some((op) => op.tool === name)) continue;
      untooled.add(name);
      warn(`mcp-server: the REST core runs ${name}, which is no tool here: run this server from the REST core's build, with its OB1_PLUGINS`);
    }
  };

  // Every request's record (SMD-1849, telemetry.ts's RequestTrace), made first
  // and ended here, as index.ts's first middleware makes and ends it — the MCP
  // endpoint and a job stream mark it deferred and end it themselves — save
  // the liveness probe's: a GET or HEAD at a health path with no key, which
  // gets no record at all. A route's throw is Hono's 500 (onError, below).
  app.use("*", async (c, next) => {
    const probe = (c.req.method === "GET" || c.req.method === "HEAD") && HEALTH_PATH.test(c.req.path)
      && !c.req.path.startsWith("/.well-known/") && presentedKeys(c.req.raw).length === 0;
    if (probe) return next();
    const trace = beginRequest("mcp", c.req.raw);
    try {
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
    const outcome = gone ? "abandoned" : trace.outcome ?? outcomeOfStatus(c.res.status, code);
    trace.end({ status: c.res.status, outcome, code }, at);
  });

  // CORS preflight — required for browser/Electron-based clients (Claude Desktop, claude.ai).
  app.options("*", (c) => c.text("ok", 200, corsHeaders));

  // OAuth discovery: the protected-resource document only while the stack is
  // configured, the request is for the public origin and the authorization
  // server answers (oauth-edge.ts); every other /.well-known path a 404 —
  // index.ts's routes, in its order.
  app.get(PRM_PATH, async (c, next) => {
    const { origin } = edgeHere();
    if (!origin || !forPublicDocument(c.req.raw, origin) || !(await authReachability().reachable())) return next();
    return c.json(protectedResourceDocument(origin), 200, { ...corsHeaders, "Cache-Control": "no-store" });
  });
  app.all("/.well-known/*", (c) => c.text("Not Found", 404, corsHeaders));

  /**
   * A fault — finding the caller (this server's forwarder refused, the REST
   * core away) or a route's throw — said at most once a minute per message,
   * the REST core's address beside it: /health and the mirrors show `ok` for
   * it, and the endpoint a 500, so the log is where it is seen, and seen again
   * if it comes back (review passes 2 to 4).
   */
  const lastSaid = new Map<string, number>();
  const sayOnce = (err: unknown, lead = "the caller could not be found") => {
    // This server's forwarder refused, or its token exchange, is one misconfiguration, said in one line whichever
    // route met it (review pass 6; SMD-2286 PR 2 review pass 1: the exchange's said no fix).
    const misconfigured = err instanceof ForwarderRefused || err instanceof ExchangeMisconfigured;
    const said = misconfigured ? "this server is misconfigured" : lead;
    const hint = misconfigured ? `: ${err.hint}` : "";
    const line = `mcp-server: ${said}${deps.restUrl ? ` (REST core at ${deps.restUrl})` : ""}: ${(err as Error)?.message ?? String(err)}${hint}`;
    const now = Date.now();
    if (now - (lastSaid.get(line) ?? -Infinity) < 60_000) return;
    lastSaid.set(line, now);
    warn(line);
  };
  /** The registry busy on a key between its check and the call: shown `ok`, as index.ts shows a busy key at every keyed route (review pass 3). */
  const busyNow = (a: Answer) => a.status === 503 && (a.body as { code?: string } | null)?.code === "BUSY";
  /** The registry's word on a key it turned between its check and the call — busy, or revoked — or none (review pass 3 of PR 4b: a revoked one read as a fault). */
  const turned = (a: Answer): { status: "busy" | "revoked" } | null =>
    busyNow(a) ? { status: "busy" } : a.status === 401 && (a.body as { code?: string; credential?: string } | null)?.code === "REVOKED" && (a.body as { credential?: string }).credential !== "forwarder" ? { status: "revoked" } : null;
  /**
   * The caller of a keyed mirror or /health, its key's standing within
   * HEALTH_DEADLINE_MS, as index.ts races the registry against it: a
   * standing not had by then — the registry's tables locked — is none, and
   * the route shows `ok` (review pass 1: it waited out the REST timeout).
   * With `tokens`, an OAuth token is traded too, at the origin's Host, so a
   * token client's job links and mirrors answer it as they answer its key
   * (review pass 1 of SMD-2286 PR 2: a scan's job link refused the client
   * that started it). A token refused there is answered as at /mcp, never
   * shown `ok`, which a poller would read for ever without refreshing
   * (review pass 2). /health asks without: the REST core's record is a key's
   * (rest/app.ts). A token whose trade or standing is not had within the
   * deadline is 503, retry (review pass 3: with the authorization server
   * silent, a poll read `ok` two times in three); a key's is shown nothing,
   * as index.ts shows it.
   */
  type Found = Standing | { kind: "fault"; err: unknown } | { kind: "late" };
  const keyedTokenRoute = (tokens: boolean): TokenRoute | null => {
    const origin = edgeHere().origin;
    return origin ? { exchanger: tokens ? deps.exchanger?.() ?? null : null, origin, admits: atOriginHost } : null;
  };
  /** Whether this request's token is traded at a keyed route: a lone JWT-shaped bearer, at the origin's Host, on a stack that trades. */
  const tradesHere = (req: Request): boolean => {
    const route = keyedTokenRoute(true);
    return route?.exchanger != null && presentedKind(req) === "token" && atOriginHost(req, route.origin);
  };
  /** A refused token's answer, at /mcp and the keyed routes: an unanswered trade said in the log first. */
  const answerToken = (standing: Extract<Standing, { kind: "token-invalid" | "token-scope" | "token-unavailable" }>, target: RefusalTarget) => {
    if (standing.kind === "token-unavailable") sayOnce(new Error(standing.why), "an OAuth token could not be checked");
    return tokenRefusal(standing.kind, edgeHere().origin!, target, () => authReachability().reachable());
  };
  const standingInTime = async (req: Request, budget: AbortSignal, onUnknown?: (key: string) => void, tokens = true): Promise<Found> => {
    if (budget.aborted) return { kind: "late" };
    let onAbort: () => void = () => {};
    const standing = await Promise.race([
      standingOf(deps.rest, req, budget, onUnknown, keyedTokenRoute(tokens)).catch((err): Found => {
        // The deadline's own abort is the registry's silence, shown nothing; any other throw is this server's fault (review pass 1 of PR 4b).
        if (budget.aborted) return { kind: "late" };
        sayOnce(err);
        return { kind: "fault", err };
      }),
      new Promise<Found>((resolve) => {
        onAbort = () => resolve({ kind: "late" });
        budget.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    budget.removeEventListener("abort", onAbort);
    return standing;
  };
  /**
   * A keyed route's caller — one whose key the REST core knows, stands by,
   * and lets call the route's tool — or the route's answer to one it does not
   * have: `ok`, a 200 that shows nothing. Its line, as index.ts's: the route
   * as a template and its tool (nameRoute), the key's name once known, and
   * `refused` for a caller shown nothing — REVOKED or BUSY where the registry
   * said which (mcp-edge.ts shownNothing, notCleared).
   */
  type Caller = Extract<Standing, { kind: "caller" }>;
  const keyedCaller = async (c: Context, route: string, tool: ToolName, budget: AbortSignal = AbortSignal.timeout(HEALTH_DEADLINE_MS), onUnknown?: (key: string) => void, tokens = true): Promise<Caller | Response> => {
    const trace = nameRoute(c, route, tool);
    const standing = await standingInTime(c.req.raw, budget, onUnknown, tokens);
    if (standing.kind === "caller" && standing.operations.has(tool)) {
      if (trace) trace.agent = standing.name;
      return standing;
    }
    if (standing.kind === "revoked" || standing.kind === "busy") {
      if (trace && standing.name) trace.agent = standing.name;
      return notCleared(c, trace, { status: standing.kind });
    }
    const tokenRefused = (response: Response, code: string) => {
      if (trace) { trace.outcome = "refused"; trace.refusedAtKey = true; trace.code = code; }
      return response;
    };
    if (standing.kind === "late" && tokens && tradesHere(c.req.raw)) {
      sayOnce(new Error(`no standing within ${HEALTH_DEADLINE_MS} ms (the trade, or the REST core's whoami)`), "an OAuth token could not be checked");
      return tokenRefused(unavailableResponse({ expectsReply: false, id: null }), "AUTH_UNREACHABLE");
    }
    if (standing.kind === "token-invalid" || standing.kind === "token-scope" || standing.kind === "token-unavailable") {
      const { response, code } = await answerToken(standing, { expectsReply: false, id: null });
      return tokenRefused(response, code);
    }
    // The REST core away, this server's forwarder refused, a whoami that threw: shown `ok` as before, its line
    // `error` FAILED, not a key refused (review pass 1 of PR 4b: an outage read as every key turned away).
    if (standing.kind === "fault") {
      if (trace) { trace.outcome = "error"; trace.code = "FAILED"; trace.fault(standing.err); }
      return c.text("ok", 200, corsHeaders);
    }
    return shownNothing(c, trace);
  };
  /**
   * A keyed HEAD: no body to carry an answer, so liveness at once, asking the REST core nothing, a probe never
   * waiting on the registry (review passes 1 and 2 of PR 4b: asking whoami first, a locked registry held it 1.8 s);
   * its line `ok`, the route named and no key, where index.ts matched the key's hash. Liveness alone: its line and its
   * point, its span and record unsent, so a monitor's probes spend none of the budget for requests no key was accepted
   * for (PR 4c review pass 1).
   */
  const headAtOnce = (c: Context, route: string, tool: ToolName) => {
    const trace = traceOf(c.req.raw);
    if (trace) trace.liveness = true;
    nameRoute(c, route, tool);
    return c.text("ok", 200, corsHeaders);
  };
  /** A route that faulted: its line `error` FAILED, its kind on the span; a mirror's 200 {error} answer as index.ts's, or (`shownOk`) liveness. */
  const faultedAt = (c: Context, err: unknown, shownOk = false) => {
    if (err instanceof ForwarderRefused) sayOnce(err);
    const trace = traceOf(c.req.raw);
    if (trace) { trace.outcome = "error"; trace.code = "FAILED"; trace.fault(err); }
    return shownOk ? c.text("ok", 200, corsHeaders) : c.json({ error: (err as Error).message }, 200, corsHeaders);
  };

  // /health: liveness, and with a key that may read it, what the brain is
  // (index.ts's route). The record is the REST core's keyed /health — the
  // health surface, under its deadline, the registry's word on the key
  // included — with this server's view of the public origin beside it.
  app.get("*", async (c, next) => {
    if (!HEALTH_PATH.test(c.req.path)) return next();
    if (presentedKeys(c.req.raw).length === 0) return c.text("ok", 200, corsHeaders);
    if (c.req.method === "HEAD") return headAtOnce(c, "/health", "brain_info");
    // The first key the REST core knows decides, as index.ts authenticated the
    // first that matched: a capture or revoked key before a read key is `ok`,
    // not the record (review pass 1).
    // One deadline for the key's standing and the record together, as index.ts
    // started both under one: the record's call is cut at what is left of it,
    // and the route answers `ok` (review pass 2: one after the other, a keyed
    // probe could wait twice the deadline).
    const budget = AbortSignal.timeout(HEALTH_DEADLINE_MS);
    // The record asked beside the key's standing, as index.ts starts its read with the registry's check: one after the
    // other, a slow registry and a slow read each inside the deadline ran past it together (review passes 3 and 4 of PR
    // 4b). A key's record is asked once every key before it is found unknown — the first that could decide, as index.ts
    // reads the first key that matches, never one more (review pass 5: each valid key asked cost a read and a lookup).
    // The REST core's registry runs one lookup per key at a time (agents.ts), so a read shares its key's whoami lookup;
    // the edge's view starts beside them, for any key presented — index.ts starts it once a key matches its hash, at
    // once; its probe is cached 30 s.
    type Read = { a: Answer | null; fault: unknown };
    const early = new AbortController();
    const signal = AbortSignal.any([budget, early.signal]);
    // The record is a key's: a token is shown liveness, never traded here and never read with as a key (standingOf
    // passes over one; review pass 1 of SMD-2286 PR 2: the client's own token went to the REST core as a key).
    const keys = keysToSend(c.req.raw, edgeHere().origin !== null);
    const reads = new Map<string, Promise<Read>>();
    const ask = (key: string | undefined) => {
      if (key === undefined || reads.has(key)) return;
      reads.set(key, deps.rest.call("health" as never, {} as never, { key, signal }).then((a): Read => ({ a, fault: null }), (fault): Read => ({ a: null, fault })));
    };
    ask(keys[0]);
    const oauth = edgeView(edgeHere(), () => authReachability().reachable());
    const caller = await keyedCaller(c, "/health", "brain_info", budget, (key) => ask(keys[keys.indexOf(key) + 1]), false);
    if (caller instanceof Response) {
      early.abort();
      return caller;
    }
    ask(caller.key); // defensive: the deciding key's record is asked by now, every key before it unknown
    const { a, fault } = await reads.get(caller.key)!;
    early.abort();
    // The deadline's own abort is the registry's silence: liveness, `refused` (index.ts's notCleared). Any other throw,
    // or an answer that is no record and no liveness, is this server's fault: liveness all the same, its line `error`
    // FAILED (review pass 2 of PR 4b: the REST core gone between the two calls read as the key refused).
    // The caller was found; its record was not (review pass 3: the default lead sent the operator after the key).
    const recordFault = (err: unknown) => {
      sayOnce(err, "/health's record could not be read");
      return faultedAt(c, err, true);
    };
    if (budget.aborted) return notCleared(c, traceOf(c.req.raw), null);
    if (fault !== null || !a?.ok) return recordFault(fault ?? new Error(`the REST core answered /health ${a?.status}`));
    const body = a.body as Record<string, unknown> | null;
    // Liveness where the record was asked: the registry did not clear the key in time (index.ts's notCleared).
    if (!body || (Object.keys(body).length === 1 && body.status === "ok")) return notCleared(c, traceOf(c.req.raw), null);
    // An answer that is no object is no record (review pass 3: a string's characters were served as its fields).
    if (typeof body !== "object" || Array.isArray(body)) return recordFault(new Error("the REST core answered /health with no record"));
    return c.json({ ...body, oauth: await oauth }, 200, corsHeaders);
  });

  // The worker-queue status as a keyed GET (SMD-2131), the worker_status tool's REST mirror.
  const WORKER_STATUS_PATH = /(^|\/)worker-status\/?$/;
  app.get("*", async (c, next) => {
    if (!WORKER_STATUS_PATH.test(c.req.path)) return next();
    if (c.req.method === "HEAD" && presentedKeys(c.req.raw).length > 0) return headAtOnce(c, "/worker-status", "worker_status");
    const caller = await keyedCaller(c, "/worker-status", "worker_status");
    if (caller instanceof Response) return caller;
    try {
      const answered = await deps.rest.call("worker_status", {}, credOf(caller));
      const word = turned(answered);
      if (word) return notCleared(c, traceOf(c.req.raw), word);
      const o = outcomeOf(answered);
      if ("fault" in o) return faultedAt(c, o.fault);
      // The operation answers an object (a tool result is one); this route has always answered the bare rows.
      return c.json(o.ok ? (o.value as { pools: unknown }).pools : [], 200, corsHeaders);
    } catch (e) {
      return faultedAt(c, e);
    }
  });

  // The worker-queue actions as keyed POSTs (SMD-2132, SMD-2272), each its tool's REST mirror.
  const MIRRORS: [RegExp, MirrorTool, string][] = [
    [/(^|\/)worker-retry-failed\/?$/, "retry_failed", "/worker-retry-failed"],
    [/(^|\/)worker-release-leases\/?$/, "release_stale_leases", "/worker-release-leases"],
    [/(^|\/)worker-run\/?$/, "run_worker", "/worker-run"],
  ];
  app.post("*", async (c, next) => {
    const mirror = MIRRORS.find(([re]) => re.test(c.req.path));
    if (!mirror) return next();
    const [, tool, route] = mirror;
    const caller = await keyedCaller(c, route, tool);
    if (caller instanceof Response) return caller;
    const body = await c.req.json().catch(() => null);
    const args: Record<string, unknown> = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    try {
      const answered = await deps.rest.call(tool, MIRROR_INPUT[tool](args) as never, credOf(caller));
      const word = turned(answered);
      if (word) return notCleared(c, traceOf(c.req.raw), word);
      const o = outcomeOf(answered);
      if ("fault" in o) return faultedAt(c, o.fault);
      if (o.ok) return c.json(o.value as object, 200, corsHeaders);
      // A refusal's code on the record for the line, as it is answered (index.ts's).
      const trace = traceOf(c.req.raw);
      if (trace) trace.code = o.refusal.code;
      const words = MIRROR_WORDS[tool] as Record<string, string>;
      return c.json({ error: words[o.refusal.code], code: o.refusal.code }, 400, corsHeaders);
    } catch (e) {
      return faultedAt(c, e);
    }
  });

  // A job's poll and stream as keyed GETs (SMD-2273): the handle's links, on the REST core's job routes.
  const JOBS_STREAM_PATH = /(^|\/)jobs\/([^/]+)\/stream\/?$/;
  const JOBS_PATH = /(^|\/)jobs\/([^/]+)\/?$/;
  app.get("*", async (c, next) => {
    const streamMatch = JOBS_STREAM_PATH.exec(c.req.path);
    const pollMatch = streamMatch ? null : JOBS_PATH.exec(c.req.path);
    if (!streamMatch && !pollMatch) return next();
    const id = (streamMatch ?? pollMatch)![2];
    const route = streamMatch ? "/jobs/:id/stream" : "/jobs/:id";
    if (c.req.method === "HEAD" && presentedKeys(c.req.raw).length > 0) return headAtOnce(c, route, "job_status");
    const caller = await keyedCaller(c, route, "job_status");
    if (caller instanceof Response) return caller;
    if (streamMatch) {
      const upstream = await deps.rest.stream(id, { ...credOf(caller), signal: c.req.raw.signal });
      if (upstream.status !== 200 || !upstream.body) {
        // A 401's code read, its body consumed by the read; any other's let go unread (review pass 4 of PR 4b: a clone
        // after the cancel threw, and every 401 at the stream was a 500).
        const refusal = upstream.status === 401 ? (await upstream.json().catch(() => null)) as { code?: string; credential?: string } | null : null;
        if (upstream.status !== 401) void upstream.body?.cancel().catch(() => {});
        // Not there for this key: index.ts's 404. A fault — the durable job
        // store away — is Hono's 500, as index.ts's throw is; a key the REST
        // core no longer stands by is shown `ok` (review pass 2: all three read
        // "not found", which a poller gives up on).
        if (upstream.status === 404) return c.json({ error: "not found" }, 404, corsHeaders);
        if (upstream.status >= 500 && upstream.status !== 503) throw new Error(`the REST core answered the job stream ${upstream.status}`);
        // This server's forwarder refused or revoked there: its misconfiguration, a 500 said once, as at the poll (review pass 5 of PR 4b).
        if (refusal?.credential === "forwarder") throw new ForwarderRefused(401, refusal.code);
        return notCleared(c, traceOf(c.req.raw), upstream.status === 503 ? { status: "busy" } : refusal?.code === "REVOKED" ? { status: "revoked" } : null);
      }
      const response = new Response(upstream.body, { status: 200, headers: { ...corsHeaders, "content-type": "text/event-stream", "cache-control": "no-cache" } });
      // Its line written where the stream ends, with its bytes, as index.ts's job stream's is.
      const trace = traceOf(c.req.raw);
      const ends = trace ? endsWithStream(trace, c.req.raw.signal) : {};
      return withSseKeepalive(response, { signal: c.req.raw.signal, label: `jobs/${labelPart(id)}/stream`, ...ends });
    }
    const answered = await deps.rest.call("job_status", { job_id: id }, credOf(caller));
    const word = turned(answered);
    if (word) return notCleared(c, traceOf(c.req.raw), word);
    const o = outcomeOf(answered);
    if ("fault" in o) throw o.fault;
    if (!o.ok) return c.json({ error: "not found" }, 404, corsHeaders);
    return c.json(o.value as object, 200, corsHeaders);
  });

  // The MCP endpoint, POST at every path (index.ts's route): the caller's
  // standing first — refused as server-portable refuses, the edge's envelopes
  // and a notification's bare answer — then the SDK's transport over a server
  // whose tools are the caller's operations. Its record, which the first
  // middleware made, it ends itself, once, when the request ends — answered
  // (with the bytes the transport wrote), refused at the key, left by its
  // client, cut by the stop, stalled, or thrown — as index.ts's route does:
  // the JSON-RPC method and tool once the body is read, the key's name once
  // known, and how the tools ended; a tool call asked for that never ran to an
  // end is `unrun`, and a batch says its worst.
  app.on(MCP_METHODS, "*", async (c) => {
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
      const outcome = end ?? ran ?? outcomeOfStatus(trace.status);
      trace.end({ outcome, code: code ?? (outcome === call.outcome ? call.code : undefined), bytes });
    };
    /** Refused before any tool ran: the key, the registry; the answer's status and why. */
    const refused = (response: Response, code: string): Response => {
      trace.status = response.status;
      trace.refusedAtKey = true;
      finish("refused", code);
      return response;
    };
    const signal = c.req.raw.signal;
    let label = "?";
    let settled = false;
    const abandoned = () => {
      if (settled) return;
      settled = true;
      const cut = deps.stop?.cut === true;
      warn((cut ? cutByStopLine : abandonedRequestLine)(label, performance.now() - trace.started));
      finish(cut ? "cut" : "abandoned");
    };
    signal.addEventListener("abort", abandoned, { once: true });
    if (signal.aborted) {
      // Gone before the route ran: the line and nothing else; 408 is the nearest name for what happened.
      trace.status = 408;
      abandoned();
      return c.body(null, 408);
    }
    // Anything that throws from here — the REST core away, this server's
    // forwarder refused, the transport — is Hono's 500, the request settled
    // and its line written first (index.ts's catch; review passes 1 and 2).
    try {
      return await answer();
    } catch (err) {
      settled = true;
      trace.status = 500;
      trace.fault(err);
      finish("error");
      throw err;
    }
    async function answer(): Promise<Response> {
      const origin = edgeHere().origin;
      const standing = await standingOf(deps.rest, c.req.raw, signal, undefined, origin ? { exchanger: deps.exchanger?.() ?? null, origin } : null);
      // A traded token refused (SMD-2286): RFC 6750's answers at the public resource, the protected-resource document named.
      if (standing.kind === "token-invalid" || standing.kind === "token-scope" || standing.kind === "token-unavailable") {
        const bodyText = await readBodyText(c.req.raw, REFUSAL_BODY_LIMIT);
        const target = refusalTarget(bodyText);
        read(bodyText);
        settled = true;
        const { response, code } = await answerToken(standing, target);
        return refused(response, code);
      }
      if (standing.kind === "none") {
        const edgeAnswer = await refusalAt(edgeHere(), c.req.raw, () => authReachability().reachable());
        const bodyText = await readBodyText(c.req.raw, REFUSAL_BODY_LIMIT);
        const target = refusalTarget(bodyText);
        read(bodyText);
        settled = true;
        if (edgeAnswer.kind === "challenge") return refused(challengeResponse(edgeAnswer.origin, edgeAnswer.refusedToken, target), "UNAUTHORIZED");
        if (edgeAnswer.kind === "unavailable") return refused(unavailableResponse(target), "AUTH_UNREACHABLE");
        return refused(target.expectsReply ? unauthorizedResponse(target.id) : notificationRefusedResponse(), "UNAUTHORIZED");
      }
      if (standing.kind === "revoked" || standing.kind === "busy") {
        if (standing.name) trace.agent = standing.name;
        const bodyText = await readBodyText(c.req.raw);
        const target = refusalTarget(bodyText);
        read(bodyText);
        settled = true;
        if (standing.kind === "revoked") return refused(target.expectsReply ? unauthorizedResponse(target.id, REVOKED_MESSAGE) : notificationRefusedResponse(), "REVOKED");
        return refused(target.expectsReply
          ? unauthorizedResponse(target.id, BUSY_MESSAGE, JSON_RPC_BUSY_CODE, { retryAfter: RETRY_AFTER_SECONDS })
          : notificationRefusedResponse({ retryAfter: RETRY_AFTER_SECONDS }), "BUSY");
      }
      // Named from here on, so a line written later — the client gone, a throw — says whose key it was.
      trace.agent = standing.name;
      noteUntooled(standing.operations);
      // The body read once and handed to the transport rebuilt: v2's transport reads the raw stream (SMD-2278).
      const rawBody = await c.req.text().catch(() => null);
      label = requestLabel(rawBody);
      read(rawBody);
      const track = deps.toolCalls ? <T>(run: () => Promise<T>) => deps.toolCalls!.track(run) : <T>(run: () => Promise<T>) => run();
      const server = buildServer(deps.rest, standing, rawPath(c.req.raw).replace(/\/{2,}/g, "/").replace(/\/+$/, ""), opsHere(), argumentsById(rawBody), call, track, (err) => sayOnce(err));
      const transport = new WebStandardStreamableHTTPServerTransport();
      await server.connect(transport);
      const response = await transport.handleRequest(new Request(c.req.raw.url, { method: c.req.raw.method, headers: c.req.raw.headers, body: rawBody ?? undefined }));
      if (!response) {
        settled = true;
        trace.status = 500;
        finish("error");
        return c.json({ error: "No response from MCP transport" }, 500, corsHeaders);
      }
      response.headers.delete("mcp-session-id");
      for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
      trace.status = response.status;
      // The line is written at the stream's end, with the bytes the transport wrote; a stall settles the request too.
      return withSseKeepalive(response, {
        signal, label, startedAt: trace.started, ...keepalive,
        onEnd: (bytes) => { settled = true; finish(undefined, undefined, bytes); },
        onStall: () => { settled = true; finish("stalled"); },
        onCancel: abandoned,
      });
    }
  });

  // A throw from a route — the REST core away, this server's forwarder refused, a job store's fault — is a 500, as
  // Hono's default answers it, and one line naming the route at most once a minute, not a stack trace per request;
  // none for a client already gone, whose abandoned line says it (review passes 3 and 4).
  app.onError((err, c) => {
    if (!c.req.raw.signal.aborted) sayOnce(err, `${c.req.method} ${HEALTH_PATH.test(c.req.path) ? "/health" : "a route"} failed`);
    return c.text("Internal Server Error", 500);
  });

  // Whatever no route above matched: 405 with `Allow` (index.ts's notFound) — and a line for a path the first middleware never saw (one holding an encoded line break), as index.ts wrote it.
  app.notFound((c) => {
    if (!traceOf(c.req.raw)) beginRequest("mcp", c.req.raw).end({ status: 405, outcome: "refused" });
    return c.text("Method Not Allowed", 405, HEALTH_PATH.test(c.req.path) ? HEALTH_METHOD_NOT_ALLOWED_HEADERS : METHOD_NOT_ALLOWED_HEADERS);
  });
  return app;
}

/** The public origin's settings from an environment (oauth-edge.ts), for the entry. */
export const edgeFrom = (env: { COMPOSE_PROFILES?: string; OB1_PUBLIC_ORIGIN?: string }): EdgeSettings => edgeSettings(env);
