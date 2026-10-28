// The REST core's HTTP surface (SMD-2284): every operation the MCP tools
// expose, as JSON, over the same core (core/index.ts) — routes from ROUTES,
// inputs held to the tool's own zod schema, a refusal answered as its code and
// its declared facts, a fault as FAILED. Authorization is here: a key's scope
// — or the key scope an authorization server's token maps to (oauth-token.ts,
// SMD-2286) — decides which operations it may call, and the agent registry
// decides whether the key still stands. Nothing here reads the store or calls a model; that is
// the core's, as it is for the MCP server.

import { Hono, type Context } from "hono";
import { z } from "zod";
import { authenticate, canRead, CLIENT_SCOPES, queryOf, type AuthConfig, type Principal } from "../auth.ts";
import type { AgentOutcome } from "../agents.ts";
import { HEALTH_DEADLINE_MS, SPECS, type Core } from "../core/index.ts";
import { failure, refusalValue, type Refusal } from "../core/refusal.ts";
import { mayCall, scopeOf, unlocks, visibleToolNames, type ToolName } from "../tools.ts";
import { JWT_SHAPE, UNREACHABLE_RETRY_AFTER_SECONDS } from "../oauth-edge.ts";
import type { TokenCheck } from "../oauth-token.ts";
import { runHook, runOperation, type LoadedHook, type LoadedOp, type LoadedPlugin } from "../core/index.ts";
import { subscribe as subscribeJob } from "../jobs.ts";
import { labelPart, withSseKeepalive } from "../sse.ts";
import { honoPath, pathFields, readsQuery, REFUSAL_STATUS, ROUTES, type CallOptions, type Method } from "./routes.ts";

export { REFUSAL_STATUS } from "./routes.ts";
import { openApiDocument } from "./openapi.ts";
import { beginRequest, endsWithStream, knowTools, logRequest, outcomeOf, requestLine, traceOf, withToolSpan, type RequestRecord } from "../telemetry.ts";

/** The codes the REST core answers on its own, before or around an operation. */
export type TransportCode = "UNAUTHORIZED" | "REVOKED" | "BUSY" | "FORBIDDEN" | "REFUSED_INPUT" | "NO_ROUTE" | "METHOD_NOT_ALLOWED" | "FAILED" | "STORE_UNAVAILABLE";

export interface RestDeps {
  core: Core;
  /** Seeds the environment before the first read of it (root.ts's initEnv); runs on every request, a no-op once seeded. */
  init(): void;
  /** The configured keys. */
  keys(): AuthConfig;
  /**
   * The check of the authorization server's access tokens (oauth-token.ts),
   * or null where none is accepted: a stack that is not configured. Read per
   * request, as the keys are; absent, no token is accepted (SMD-2286).
   */
  tokens?(): TokenCheck | null;
  /** The agent registry's answer for a key: its stable id, a revocation, or busy (agents.ts). */
  resolve(principal: Principal): Promise<AgentOutcome>;
  /** Wraps a detached run (a job), so the stop waits for it. */
  track: CallOptions["track"];
  /** Where the one line per request goes (telemetry.ts's requestLine); telemetry.ts's request log unless a suite listens. */
  log?: (line: string) => void;
  /** The enabled plugins (root.ts's plugins), read at the first request that needs them; none when absent (SMD-2310). */
  plugins?: () => readonly LoadedPlugin[];
  /** The webhooks served and their secrets (root.ts's hooks), read at the first delivery; none when absent (SMD-2310). */
  hooks?: () => { hooks: readonly LoadedHook[]; secrets: ReadonlyMap<string, string> };
  /**
   * Where a webhook fault's one line goes — the message its anonymous sender
   * is not told — stderr unless a suite listens. Not the request line, which
   * holds no free text (telemetry.ts); that line still says the 500 and FAILED.
   */
  faultLog?: (line: string) => void;
}

/** The most a webhook delivery's body may be: 1 MiB, past which it is refused (413) before a handler reads it. */
export const HOOK_BODY_LIMIT = 1024 * 1024;

/** A request's body as bytes, read until `limit` and no further: null, the stream cancelled, past it. */
async function boundedBody(req: Request, limit: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

/**
 * An operation's call under its tool's span (telemetry.ts, PR 2b), ended with
 * how the operation ended: `ok`, a refusal with its code, or — thrown — an
 * error with the code its answer will carry, and the throw's kind and code
 * (PR 2c).
 */
function traced<O extends { ok: boolean }>(tool: string, faultCode: string, call: () => Promise<O>): Promise<O> {
  return withToolSpan(tool, async (span) => {
    try {
      const outcome = await call();
      span.end(outcome.ok ? "ok" : "refused", (outcome as { refusal?: { code?: string } }).refusal?.code);
      return outcome;
    } catch (err) {
      span.fault(err);
      span.end("error", faultCode);
      throw err;
    }
  });
}

/** The transport's refusals of a caller's key: none or a wrong one, a revoked one, the registry busy, a scope that lacks the route. */
const KEY_REFUSALS: ReadonlySet<string> = new Set(["UNAUTHORIZED", "REVOKED", "BUSY", "FORBIDDEN"]);

/** How long a caller told to retry is told to wait: the busy registry (agents.ts), and every refusal or fault answered 503. */
const RETRY_AFTER_SECONDS = 2;
const RETRY_AFTER = { "Retry-After": String(RETRY_AFTER_SECONDS) };

/** The value of an `Authorization: Bearer` header, or undefined. */
const bearerOf = (req: Request): string | undefined => req.headers.get("authorization")?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];

/**
 * The keys a request presents, from its headers alone: `x-brain-key`,
 * `x-access-key` or `Authorization: Bearer`. Never `?key=` — the MCP server
 * keeps that form for URL-only connectors; here nothing needs it, and a key in
 * a URL reaches access logs and history.
 */
export function headerKeys(req: Request): string[] {
  const forms = [req.headers.get("x-brain-key"), req.headers.get("x-access-key"), bearerOf(req)];
  return [...new Set(forms.filter((k): k is string => Boolean(k)))];
}

/**
 * The forwarder slot (SMD-2284, the ADR's decision 7): when the MCP server
 * forwards a client's key, it sends its own key here, and the REST core records
 * it as who carried the request (`act`). Only a forward-scope key is taken — a
 * key that grants nothing (auth.ts) — so a client holding two keys cannot stamp
 * one as the other's carrier. Its own header, apart from the caller's three, so
 * a forwarder is never read as a caller and a caller's key never as a forwarder.
 */
export const FORWARDER_HEADER = "x-brain-forwarder";

/** Each field's JSON-schema type, for reading it from a query string: "number", "integer", "boolean", "array", or anything else as text. */
function queryTypes(shape: Record<string, z.ZodType>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [field, schema] of Object.entries(shape)) {
    const js = z.toJSONSchema(schema as z.ZodType, { io: "input", unrepresentable: "any" }) as { type?: string };
    out.set(field, js.type ?? "string");
  }
  return out;
}

/**
 * A query string as a tool's input: a number or a boolean read from its text
 * when it is one (else left as text, for the schema to refuse), an array field
 * from every value it is given, and any other field from one value — given
 * twice, it is refused. The schema then holds the result as it holds a body.
 */
export function inputFromQuery(name: ToolName, params: URLSearchParams): { input: Record<string, unknown> } | { problem: string } {
  return inputFromQueryShape(SPECS[name].inputSchema, params);
}

/** inputFromQuery over an input's shape: a core tool's, or a plugin operation's (SMD-2310). */
function inputFromQueryShape(shape: Record<string, z.ZodType>, params: URLSearchParams): { input: Record<string, unknown> } | { problem: string } {
  const types = queryTypes(shape);
  // No prototype: a `__proto__` key is a key like any other, which the strict
  // schema then refuses, rather than an assignment that drops it unseen.
  const input: Record<string, unknown> = Object.create(null);
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    const type = types.get(key);
    if (type === "array") { input[key] = values; continue; }
    if (values.length > 1) return { problem: `${labelPart(key)} is given more than once` };
    const v = values[0];
    // A number as JavaScript prints one too (`1e-7`, `1e+21`), so a client's String(n) reads back as n.
    if ((type === "number" || type === "integer") && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(v)) input[key] = Number(v);
    else if (type === "boolean" && (v === "true" || v === "false")) input[key] = v === "true";
    else input[key] = v;
  }
  return { input };
}

/** The issues of a refused input, each its field's path and zod's message — never the value it was given. */
const issuesOf = (error: z.ZodError) => error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));

/**
 * The methods each path answers, for a 405's `Allow`: a request whose path is
 * a route's and whose method is not (a PUT, a GET on a POST route) is told
 * which it may send, not that nothing is there.
 */
const ROUTE_METHODS: [RegExp, Method | "GET"][] = [
  ...Object.values(ROUTES).map((r) => [new RegExp(`^${r.path.replace(/\{[a-z_]+\}/g, "[^/]+")}$`), r.method] as [RegExp, Method]),
  [/^\/v1\/whoami$/, "GET"], [/^\/v1\/plugins$/, "GET"], [/^\/v1\/jobs\/[^/]+\/stream$/, "GET"], [/^\/health$/, "GET"], [/^\/openapi\.json$/, "GET"],
];
const allowedOn = (path: string, plugins: readonly [RegExp, Method][]): string[] => {
  const methods = new Set<string>([...ROUTE_METHODS, ...plugins].filter(([re]) => re.test(path)).map(([, m]) => m));
  if (methods.has("GET")) methods.add("HEAD");
  return [...methods].sort();
};

/**
 * `template`: a plugin operation's route, for the request line — its Hono route is the one catch-all parameter.
 * `carrier`: the forwarder slot's forward-scope key, or null for none — checked once, by the first middleware (carrierOf).
 */
type RestEnv = { Variables: { template?: string; carrier?: Principal | null } };

export function createRestApp(deps: RestDeps): Hono<RestEnv> {
  const app = new Hono<RestEnv>();
  const write = (r: RequestRecord) => (deps.log ? deps.log(requestLine(r)) : logRequest(r));
  const faultLog = deps.faultLog ?? ((line: string) => console.error(line));

  // The enabled plugins' operations (SMD-2310), read at the first request that
  // needs them — the environment is seeded by then — and the document with
  // them; their tool names join the core's in the request line.
  type PluginRoute = { op: LoadedOp; method: Method; pattern: RegExp; fields: string[] };
  let pluginRouteList: PluginRoute[] | null = null;
  const pluginRoutes = (): PluginRoute[] =>
    (pluginRouteList ??= (deps.plugins?.() ?? []).flatMap((pl) => pl.operations).map((op) => (knowTools([op.tool]), {
      op,
      method: op.method,
      // A manifest's path is lower-case words, hyphens and {field} (plugins.ts), so nothing in it needs escaping.
      pattern: new RegExp(`^${op.path.replace(/\{[a-z_]+\}/g, "([^/]+)")}$`),
      fields: pathFields(op.path),
    })));
  let doc: Record<string, unknown> | null = null;

  // One JSON line per request (SMD-1849, telemetry.ts): the method, the
  // route's template — never the path it was given (an id), the query string,
  // a key or a body — the operation it runs, the key's name once it has
  // authenticated, the status, how it ended (its status's outcome, or
  // `abandoned` for a client gone before the answer — a body read the client
  // cut off is a throw, and onError's 500, which no one receives and is no
  // fault of the server's), an error answer's code and the time — to the
  // answer, or for the job stream, which ends its own record, to the
  // stream's end. The record (telemetry.ts's RequestTrace) is made here,
  // first, so every answer below is counted, and the handlers fill in what
  // they learn (notFound makes one for a path this middleware never sees) —
  // but the liveness probe, a GET or HEAD of /health that presents no key,
  // gets none: the container's healthcheck asks every 30 s, and half the log
  // was its 200 (SMD-2284 PR 3 review pass 1). Decided as it arrives, so
  // nothing (PR 2b's span included) starts for it; the route answers it 200
  // every time, and an environment that will not seed is a 500 the
  // healthcheck itself reports. A keyed /health is a request like any other
  // (SMD-2287).
  app.use("*", async (c, next) => {
    if ((c.req.method === "GET" || c.req.method === "HEAD") && c.req.path === "/health" && headerKeys(c.req.raw).length === 0) {
      deps.init();
      return next();
    }
    // The record first, so an environment that will not seed (init throws,
    // onError's 500) is still a line; a throw that is not an Error, which
    // Hono passes up rather than to onError, ends it as one. A request whose
    // forwarder slot holds a forward-scope key continues its traceparent: the
    // MCP server's tool call, of which this is the operation (SMD-2287 PR 4c).
    const carrier = carrierOf(c.req.raw);
    if (carrier !== undefined) c.set("carrier", carrier);
    const trace = beginRequest("api", c.req.raw, write, { trustParent: carrier != null });
    try {
      deps.init();
      // Under the request's span, so the operation's span is its child (PR 2b).
      await trace.run(next);
    } catch (err) {
      // An Error goes on to onError, whose 500 says FAILED; a non-Error escapes, with no body. Either's kind is on the span.
      trace.fault(err);
      trace.end({ status: 500, outcome: "error", code: err instanceof Error ? "FAILED" : undefined });
      throw err;
    }
    if (trace.deferred || trace.ended) return;
    // A plugin operation's or a hook's route is the template its handler set ("-" for none it takes), not the catch-all route's.
    const template = c.get("template");
    trace.route ??= template !== undefined ? (template === "-" ? undefined : template) : c.req.routePath === "*" || c.req.routePath === "/*" ? undefined : c.req.routePath;
    // An error answer's code is the one set as it was answered (answerError, or the hook route from its handler's checked JSON), never read back from the answer (PR 2c).
    const at = performance.now();
    const gone = trace.clientGone;
    const code = gone ? undefined : trace.code;
    const outcome = gone ? "abandoned" : trace.outcome ?? outcomeOf(c.res.status, code);
    trace.end({ status: c.res.status, outcome, code }, at);
  });

  // Liveness, for the container's healthcheck: no key, no store, no answer
  // about the brain. Internal only — the public /health is the MCP server's,
  // which reads its keyed record here (SMD-2287): a key that may read
  // brain_info, which the registry clears within HEALTH_DEADLINE_MS, is
  // answered the brain's record on the health surface (brain-info.ts's
  // statements capped to fit the deadline). Any other key — a wrong one, one
  // whose scope lacks the tool, a revoked one, one the registry is busy on or
  // does not answer for in time — is answered liveness as no key is: this
  // route shows nothing, and refuses no one. The rules were server-portable
  // index.ts's /health's (retired in SMD-2287 PR 6b). The forwarder slot is not read here (the middleware
  // reads it for the span's parent alone): the record is the caller's key's to
  // see, whoever carried it.
  app.get("/health", async (c) => {
    const keys = headerKeys(c.req.raw);
    if (keys.length === 0) return c.json({ status: "ok" });
    const trace = traceOf(c.req.raw);
    if (trace) {
      trace.route = "/health";
      trace.tool = "brain_info";
    }
    /** Shown liveness, nothing about the brain; the line says it refused, with the registry's word where it gave one. */
    const shown = (word?: "REVOKED" | "BUSY") => {
      if (trace) {
        trace.outcome = "refused";
        trace.refusedAtKey = true;
        if (word) trace.code = word;
      }
      return c.json({ status: "ok" });
    };
    let principal: Principal | null = null;
    for (const key of keys) {
      principal = authenticate(key, deps.keys(), { admit: CLIENT_SCOPES });
      if (principal) break;
    }
    if (!principal || !mayCall(principal, "brain_info")) return shown();
    if (trace) trace.agent = principal.name;
    // A HEAD has no body to carry the record: liveness, and no read for nothing.
    if (c.req.method === "HEAD") return c.body(null, 200, { "content-type": "application/json" });
    // The read and the registry's word start together, under one deadline, as
    // index.ts's /health started them: a registry that has not answered by then
    // could still say revoked, so the key is shown nothing.
    const info = deps.core.brainInfo("health");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const identity = await Promise.race([
      deps.resolve(principal).catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HEALTH_DEADLINE_MS); }),
    ]);
    clearTimeout(timer);
    if (!identity || identity.status !== "ok") return shown(identity?.status === "revoked" ? "REVOKED" : identity?.status === "busy" ? "BUSY" : undefined);
    return c.json(await info);
  });
  // The document names where its paths are, as the caller reached it: `/api`
  // through the proxy's opt-in route, the root on the mesh — so a client
  // generated from it calls this server, not the origin's root, which is the
  // MCP server's (review pass 1).
  app.get("/openapi.json", (c) => c.json({ ...(doc ??= openApiDocument(pluginRoutes().map((r) => r.op))), servers: [{ url: linkBase(c) || "/" }] }));

  /**
   * An error answer: its JSON, and its code on the request's record for the
   * line — set here, as it is answered, so the middleware never clones and
   * reads an answer back (PR 2c). A refused HEAD's line has its GET's code.
   */
  const answerError = (c: Context, body: object, status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 422 | 500 | 501 | 503, headers: Record<string, string> = {}) => {
    const trace = traceOf(c.req.raw);
    const code = (body as { code?: unknown }).code;
    if (trace && typeof code === "string") trace.code = code;
    return c.json(body, status, headers);
  };
  const refuse = (c: Context, status: 400 | 401 | 403 | 404 | 405 | 503, body: { code: TransportCode } & Record<string, unknown>, headers: Record<string, string> = {}) => {
    // The route's own refusal of the caller's key — none, a wrong one, revoked, busy, or one whose scope lacks the
    // route — is the key's, not the tool's: its point labels no tool (telemetry.ts labelsOf; PR 2c review pass 4).
    // Only the transport refuses here; an operation's or a plugin's refusal answers through answerError.
    if (KEY_REFUSALS.has(body.code)) {
      const trace = traceOf(c.req.raw);
      if (trace) trace.refusedAtKey = true;
    }
    return answerError(c, body, status, headers);
  };
  /**
   * A HEAD answers what the GET would say before it looks anything up — the
   * caller's standing and, on an operation, its input as the schema holds it
   * — with the GET's content type and no body, and never runs the operation:
   * a fetch would write an action-log row for a probe, a stream would
   * subscribe for no one. So a HEAD for a thought or a job that is not there
   * is still a 200, and so is one whose `since` or `after` the operation itself
   * would refuse (REFUSED_SINCE, REFUSED_CURSOR). Bun adds `content-length: 0`.
   */
  const headOnly = (c: Context, type = "application/json") => c.req.method === "HEAD" ? c.body(null, 200, { "content-type": type }) : null;

  /**
   * The forward-scope key the forwarder slot holds — null for none, or a slot
   * that holds no such key — checked by its digest once, before the request's
   * span starts, so the span continues the forwarder's trace (SMD-2287 PR 4c),
   * and `caller` reads it from there. Only a key's holder passes: any other
   * caller's traceparent is linked, not continued. The registry's word on the
   * key is not asked here (a revoked forwarder is refused below all the same).
   * Undefined where the keys cannot be read: no trust, and `caller` reads them
   * itself, its throw onError's. Before the middleware's own init, so it seeds
   * the environment itself (review pass 2: an in-process REST core's first
   * forwarded request was linked); init's throw is the middleware's 500.
   */
  function carrierOf(req: Request): Principal | null | undefined {
    const forwarded = req.headers.get(FORWARDER_HEADER);
    if (!forwarded) return null;
    try {
      deps.init();
      return authenticate(forwarded, deps.keys(), { admit: ["forward"] });
    } catch {
      return undefined;
    }
  }

  /**
   * The caller, or the answer that refuses it: a key that authenticates (a
   * caller's scope — a forwarder key alone is unknown here) or, configured, the
   * authorization server's token (SMD-2286), then the registry's word on it — revoked is refused for good, busy
   * for now — with its stable agent id set for the audit row. A request that
   * carries the forwarder slot is refused unless the slot holds a forward-scope
   * key the registry stands by (the refusal says `credential: "forwarder"`), and
   * otherwise names its carrier as `act`; the client's key still decides what
   * the request may do.
   */
  async function caller(c: Context): Promise<Principal | Response> {
    const keys = deps.keys();
    let principal: Principal | null = null;
    for (const key of headerKeys(c.req.raw)) {
      principal = authenticate(key, keys, { admit: CLIENT_SCOPES });
      if (principal) break;
    }
    // No key matched: a bearer of a JWT's shape is the authorization server's
    // token, checked where the stack is configured (oauth-token.ts). A token
    // that is not one this server accepts is refused as a token
    // (`credential: "token"`, RFC 6750's invalid_token, or insufficient_scope
    // for a valid one whose scopes name no key scope); with no keys to check
    // it against, it is answered as the MCP server answers a token while the
    // authorization server is down: 503, retry in 30 s. Unconfigured, it is an
    // unknown key, as before.
    const bearer = bearerOf(c.req.raw);
    const check = !principal && bearer !== undefined && JWT_SHAPE.test(bearer) ? deps.tokens?.() ?? null : null;
    const byToken = check !== null;
    if (check) {
      const checked = await check(bearer!);
      if (checked.status === "unavailable") return refuse(c, 503, { code: "BUSY", retryable: true, credential: "token" }, { "Retry-After": String(UNREACHABLE_RETRY_AFTER_SECONDS) });
      if (checked.status === "invalid") return refuse(c, 401, { code: "UNAUTHORIZED", credential: "token" }, { "WWW-Authenticate": 'Bearer error="invalid_token"' });
      // A valid token whose scopes name no key scope (none of the brain's, or read with capture and no write) reaches no operation: RFC 6750's insufficient_scope.
      if (checked.status === "scope") return refuse(c, 403, { code: "FORBIDDEN", credential: "token" }, { "WWW-Authenticate": 'Bearer error="insufficient_scope"' });
      principal = checked.principal;
    }
    if (!principal) return refuse(c, 401, { code: "UNAUTHORIZED" }, { "WWW-Authenticate": "Bearer" });
    const trace = traceOf(c.req.raw);
    if (trace) trace.agent = principal.name;
    // Present at all, even empty, the forwarder slot must hold a forwarder's
    // key: a slot the caller filled is never ignored (an empty one is no
    // carrier named). Its digest is checked before either key reaches the
    // registry, so a request refused for a forwarder that is no forward key
    // registers no one; one refused as a revoked or busy forwarder has resolved
    // the caller first (a valid key; it is granted nothing).
    const forwarded = c.req.raw.headers.get(FORWARDER_HEADER);
    const checked = c.get("carrier");
    const carrier = forwarded === null ? null : checked !== undefined ? checked : authenticate(forwarded, keys, { admit: ["forward"] });
    if (forwarded !== null && !carrier) return refuse(c, 401, { code: "UNAUTHORIZED", credential: "forwarder" }, { "WWW-Authenticate": "Bearer" });
    const identity = await deps.resolve(principal);
    // Named to a forwarder, whose own line names the key as index.ts's did (SMD-2287 PR 4b): the caller presented it,
    // and the forwarder's key matched its digest above. Its own revocation is read after the caller's (PR 3a's lock
    // order), so a revoked forwarder holding a revoked caller's key is told that key's name — its label, no more.
    const named = carrier ? { name: principal.name } : {};
    // A token's principal revoked in the registry says so as a token's refusal: no sign-in clears it, since its digest is fixed (oauth-token.ts).
    if (identity.status === "revoked") return refuse(c, 401, { code: "REVOKED", ...named, ...(byToken ? { credential: "token" } : {}) }, { "WWW-Authenticate": "Bearer" });
    if (identity.status === "busy") return refuse(c, 503, { code: "BUSY", retryable: true, ...named }, RETRY_AFTER);
    principal.agentId = identity.agentId;
    principal.agentUnresolved = identity.unresolved;
    if (carrier) {
      // After the caller's, not beside it: a lookup started for the carrier
      // while the registry is locked holds one more connection waiting on the
      // lock, and the forwarder's answer is the agent cache's for its TTL in
      // any case (SMD-2287 PR 3a review pass 2, not taken).
      const carried = await deps.resolve(carrier);
      // The caller, resolved, named beside the forwarder's busy registry, for the forwarder's line (SMD-2287 PR 4b review
      // pass 5); a revoked forwarder is the server's misconfiguration, whose line names no caller.
      if (carried.status === "revoked") return refuse(c, 401, { code: "REVOKED", credential: "forwarder" }, { "WWW-Authenticate": "Bearer" });
      if (carried.status === "busy") return refuse(c, 503, { code: "BUSY", retryable: true, credential: "forwarder", name: principal.name }, RETRY_AFTER);
      // An exchanged token names its own carrier, signed (`act`, oauth-token.ts): that stands, and the slot's key, still
      // checked above, only says the forwarder's traceparent may be continued.
      principal.act ??= { name: carrier.name, ...(carried.agentId ? { agentId: carried.agentId } : {}) };
    }
    return principal;
  }

  // The enabled plugins (SMD-2310), for the operator GUI's nav (SMD-2280):
  // each plugin's name, title and description, its pages (a path under the
  // plugin's and a label), and the operations of it this key may call. Any
  // caller's key; a disabled plugin is not listed, nor one the key can call nothing of. Before the operations'
  // route below, which takes every other path under /v1/plugins.
  app.get("/v1/plugins", async (c) => {
    const named = traceOf(c.req.raw);
    if (named) named.route = c.req.routePath;
    const p = await caller(c);
    if (p instanceof Response) return p;
    if (c.req.method === "HEAD") return c.body(null, 200, { "content-type": "application/json" });
    // A plugin none of whose operations the key may call is not listed: its pages would be a nav entry to nothing the key can use.
    return c.json({
      plugins: (deps.plugins?.() ?? [])
        .map((pl) => ({ pl, operations: pl.operations.filter((op) => unlocks(p, op.scope)).map((op) => op.tool) }))
        .filter(({ operations }) => operations.length > 0)
        .map(({ pl, operations }) => ({ name: pl.name, title: pl.title, description: pl.description, pages: pl.pages, operations })),
    });
  });

  // Who is calling: the key's name, its scope, its stable agent id, the
  // operations it may call, and — forwarded — who carried it (`act`): what the
  // MCP server's tools/list and the GUI's sign-in read once SMD-2287 and
  // SMD-2280 are clients.
  app.get("/v1/whoami", async (c) => {
    const named = traceOf(c.req.raw);
    if (named) named.route = c.req.routePath;
    const p = await caller(c);
    if (p instanceof Response) return p;
    return c.json({ name: p.name, scope: p.scope, ...(p.agentId ? { agentId: p.agentId } : {}), operations: [...visibleToolNames(p), ...pluginRoutes().filter((r) => unlocks(p, r.op.scope)).map((r) => r.op.tool)].sort(), ...(p.act ? { act: p.act } : {}) });
  });

  // A job's event stream (SMD-2273): its progress and its end as SSE, kept
  // alive while it runs. Its owner alone reads it, as the poll (job_status).
  app.get("/v1/jobs/:job_id/stream", async (c) => {
    // Named as it starts, so a refusal or a stop's cut before the stream opens says which route and operation.
    const named = traceOf(c.req.raw);
    if (named) {
      named.route = c.req.routePath;
      named.tool = "job_status";
    }
    const p = await caller(c);
    if (p instanceof Response) return p;
    if (!mayCall(p, "job_status")) return refuse(c, 403, { code: "FORBIDDEN", needs: scopeOf("job_status") });
    // A HEAD would subscribe and keep a stream alive that no one reads.
    const head = headOnly(c, "text/event-stream");
    if (head) return head;
    const id = c.req.param("job_id");
    const stream = await subscribeJob(p, id);
    if (!stream) {
      const r: Refusal = { code: "NOT_FOUND", retryable: false, id };
      return answerError(c, { ...refusalValue(r), ...wholeFor(p, r) }, 404);
    }
    const response = new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    // Its line is written where the stream ends — the job's end, the client
    // gone, the keepalive's ceiling — not as it opens (telemetry.ts
    // endsWithStream); the middleware leaves the record to it.
    const ends = named ? endsWithStream(named, c.req.raw.signal) : {};
    return withSseKeepalive(response, { signal: c.req.raw.signal, label: `api jobs/${labelPart(id)}/stream`, ...ends });
  });

  /**
   * An operation's input, held to its schema, or the answer that refuses it:
   * the path's fields, then the query string or the body — and only the one
   * the route reads: input sent the other way is refused, not dropped (a
   * DELETE's body `detach_citations` would otherwise be ignored).
   */
  async function inputFor(c: Context, method: Method, shape: Record<string, z.ZodType>, path: Record<string, string>): Promise<{ input: unknown } | Response> {
    let rest: Record<string, unknown>;
    const query = queryOf(c.req.url);
    if (readsQuery(method)) {
      // Bun hands a GET's handler no body, whatever was sent: the headers
      // that announced one are what is left of it (review pass 2).
      // Any length but zero counts: Bun joins a repeated Content-Length
      // into "11, 11", which is no number (review pass 3).
      const length = c.req.header("content-length");
      const announced = c.req.method !== "DELETE" && ((length !== undefined && !/^\s*0+\s*$/.test(length)) || c.req.header("transfer-encoding") !== undefined);
      if (announced || (await c.req.text()).trim() !== "") return refuse(c, 400, { code: "REFUSED_INPUT", issues: [{ path: "", message: `${method} reads its input from the query string, not a body` }] });
      const read = inputFromQueryShape(shape, query);
      if ("problem" in read) return refuse(c, 400, { code: "REFUSED_INPUT", issues: [{ path: "", message: read.problem }] });
      rest = read.input;
    } else {
      if (query.size > 0) return refuse(c, 400, { code: "REFUSED_INPUT", issues: [{ path: "", message: `${method} reads its input from a JSON body, not the query string` }] });
      const text = await c.req.text();
      let body: unknown = {};
      try {
        body = text.trim() === "" ? {} : JSON.parse(text);
      } catch {
        return refuse(c, 400, { code: "REFUSED_INPUT", issues: [{ path: "", message: "the body is not JSON" }] });
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) return refuse(c, 400, { code: "REFUSED_INPUT", issues: [{ path: "", message: "the body is not a JSON object" }] });
      rest = body as Record<string, unknown>;
    }
    for (const f of Object.keys(path)) {
      if (f in rest) return refuse(c, 400, { code: "REFUSED_INPUT", issues: [{ path: f, message: `${f} comes from the path` }] });
    }
    // Awaited, so a plugin's async refinement runs as the MCP SDK's validation runs it (SMD-2287 PR 4a review pass 3).
    const parsed = await z.object(shape).strict().safeParseAsync({ ...rest, ...path });
    if (!parsed.success) return refuse(c, 400, { code: "REFUSED_INPUT", issues: issuesOf(parsed.error) });
    return { input: parsed.data };
  }

  for (const name of Object.keys(ROUTES) as ToolName[]) {
    const route = ROUTES[name];
    const fields = pathFields(route.path);
    app.on(route.method, honoPath(route.path), async (c) => {
      const trace = traceOf(c.req.raw);
      if (trace) {
        trace.tool = name;
        trace.route = c.req.routePath;
      }
      const p = await caller(c);
      if (p instanceof Response) return p;
      if (!mayCall(p, name)) return refuse(c, 403, { code: "FORBIDDEN", needs: scopeOf(name) });
      const read = await inputFor(c, route.method, SPECS[name].inputSchema, Object.fromEntries(fields.map((f) => [f, c.req.param(f)!])));
      if (read instanceof Response) return read;
      const head = headOnly(c);
      if (head) return head;

      let outcome;
      try {
        outcome = await traced(name, route.fault ?? "FAILED", () => route.call(deps.core, p, read.input as never, { track: deps.track }));
      } catch (err) {
        // A fault: FAILED with what was thrown, as the MCP tool's text says it
        // to the same key; no `retryable` until SMD-2461 classifies faults —
        // but capture's, the transient the session hook retries, as the tool
        // gives it (SMD-1978).
        if (route.fault) return answerError(c, { code: route.fault, retryable: true, message: failure(err).message }, 503, RETRY_AFTER);
        return answerError(c, failure(err), 500);
      }
      if (outcome.ok) return answered(c, name, route.ok, outcome.value, p);
      const r = outcome.refusal as Refusal;
      const status = REFUSAL_STATUS[r.code];
      return answerError(c, { ...refusalValue(r), ...wholeFor(p, r) }, status, status === 503 ? RETRY_AFTER : {});
    });
  }

  // The enabled plugins' operations (SMD-2310), under /v1/plugins/<name>: one
  // route that finds the operation, since which plugins are enabled is read
  // from the environment at the first request and Hono takes no route after
  // its first match. Then as a core route: the caller, the gate (a plugin
  // operation's group, by the rule mayCall applies — tools.ts's unlocks), the
  // input held to its schema, and its answer — a value its output schema
  // holds, a refusal at its status, a fault as FAILED.
  // Matched by a parameter that takes a line break too: Hono's `*` does not, so a path field holding one fell to the
  // 405 that names the very method it was sent with (SMD-2287 PR 4a review pass 2).
  app.on(["GET", "POST", "PATCH", "DELETE"], "/v1/plugins/:rest{[\\s\\S]+}", async (c) => {
    const method = (c.req.method === "HEAD" ? "GET" : c.req.method) as Method;
    const found = pluginRoutes().find((r) => r.method === method && r.pattern.test(c.req.path));
    if (!found) {
      // No operation's route: the request line says so as any unrouted one does, not the catch-all route's template.
      c.set("template", "-");
      return c.notFound();
    }
    const { op } = found;
    c.set("template", honoPath(op.path));
    // Named as it starts, so a refusal or a stop's cut says which route and operation.
    const named = traceOf(c.req.raw);
    if (named) {
      named.route = honoPath(op.path);
      named.tool = op.tool;
    }
    const p = await caller(c);
    if (p instanceof Response) return p;
    if (!unlocks(p, op.scope)) return refuse(c, 403, { code: "FORBIDDEN", needs: op.scope });
    const values = found.pattern.exec(c.req.path)!.slice(1);
    const path: Record<string, string> = {};
    for (const [i, field] of found.fields.entries()) {
      try {
        path[field] = decodeURIComponent(values[i]);
      } catch {
        return refuse(c, 400, { code: "REFUSED_INPUT", issues: [{ path: field, message: `${field} is not a well-formed path segment` }] });
      }
    }
    const read = await inputFor(c, op.method, op.shape, path);
    if (read instanceof Response) return read;
    const head = headOnly(c);
    if (head) return head;
    let outcome;
    try {
      outcome = await traced(op.tool, "FAILED", () => runOperation(op, { core: deps.core, principal: p, track: deps.track }, read.input));
    } catch (err) {
      return answerError(c, failure(err), 500);
    }
    if (outcome.ok) return c.json(outcome.value, 200);
    // Forwarded, the refusal whole beside its facts, its status in it, as a core refusal's (SMD-2287): the carrier
    // words it as server-portable does (render.ts renderPlugin), and tells it from a refusal of the key mid-call.
    const { status, ...facts } = outcome.refusal;
    return answerError(c, { ...facts, ...wholeFor(p, outcome.refusal) }, status);
  });

  // The enabled plugins' webhooks (SMD-2310): a POST to /hooks/<plugin>/<name>
  // for a plugin OB1_HOOKS names, with no key — the sender holds none — so the
  // handler verifies the delivery against its secret. Its body is counted as
  // it arrives and cut at HOOK_BODY_LIMIT, and handed over as the bytes sent
  // (a signature is over them) and as text; the handler runs as
  // `hook:<plugin>`, a capture-only caller. Off, or a name it does not serve,
  // the path is NO_ROUTE, as any unrouted one.
  app.all("/hooks/:plugin/:hook", async (c) => {
    // Reached through a prefix another route strips — compose.api-public.yaml's
    // /api, whose router sends X-Forwarded-Prefix — not through
    // compose.hooks-public.yaml, which keeps the path: the operator who named
    // /api did not open /hooks, so it is no route here (final review).
    if (c.req.header("x-forwarded-prefix") !== undefined) {
      c.set("template", "-");
      return refuse(c, 404, { code: "NO_ROUTE" });
    }
    const served = deps.hooks?.();
    const hook = served?.hooks.find((h) => h.plugin === c.req.param("plugin") && h.name === c.req.param("hook"));
    if (!hook || !served) {
      c.set("template", "-");
      return refuse(c, 404, { code: "NO_ROUTE" });
    }
    c.set("template", hook.path);
    if (c.req.method !== "POST") return refuse(c, 405, { code: "METHOD_NOT_ALLOWED" }, { Allow: "POST" });
    // No secret, nothing to verify a delivery against: refused here, whatever the handler would do (PR 4 review pass 1).
    const secret = served.secrets.get(hook.plugin);
    if (!secret) return answerError(c, { code: "HOOK_NOT_CONFIGURED", retryable: false }, 503);
    const tooLarge = () => answerError(c, { code: "TOO_LARGE", retryable: false, limit: HOOK_BODY_LIMIT }, 413);
    if (Number(c.req.header("content-length") ?? "0") > HOOK_BODY_LIMIT) return tooLarge();
    // Read with a running count and cut at the limit: a chunked body declares
    // no length, and reading it whole first let an anonymous sender fill the
    // server's memory (PR 4 review pass 1). Kept as bytes — a signature is
    // over what was sent, which decoding would change (a BOM, invalid UTF-8).
    let body: Uint8Array | null;
    try {
      body = await boundedBody(c.req.raw, HOOK_BODY_LIMIT);
    } catch {
      // The sender went away mid-body: nothing to answer it with, and nothing of why.
      return answerError(c, { code: "REFUSED_INPUT", retryable: false }, 400);
    }
    if (body === null) return tooLarge();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
    const query: Record<string, string> = {};
    for (const [k, v] of queryOf(c.req.url)) query[k] = v;
    let answer;
    try {
      answer = await runHook(hook, {
        core: deps.core,
        secret,
        track: deps.track,
        // Work the handler deferred: its failure the same one line as a fault — after the answer for its work, before the 500 for a failed handler's discards.
        deferredFault: (message) => faultLog(`api hook ${hook.path} deferred fault: ${message}`),
      }, { headers, query, body, text: new TextDecoder().decode(body) });
    } catch (err) {
      // The sender is anonymous: it is told FAILED and nothing of why; the
      // operator's stderr has the message, one line, bounded, and the
      // request's span the throw's kind and code alone (PR 2c).
      faultLog(`api hook ${hook.path} fault: ${String(failure(err).message).replace(/\s+/g, " ").slice(0, 300)}`);
      traceOf(c.req.raw)?.fault(err);
      return answerError(c, { code: "FAILED", retryable: false }, 500);
    }
    const { status, text } = answer;
    // A delivery the plugin accepted is its verified sender's, not held to the anonymous budget (telemetry.ts, review pass 3).
    if (status < 400) {
      const accepted = traceOf(c.req.raw);
      if (accepted) accepted.hookAccepted = true;
    }
    if (status === 204 || text === null) return c.body(null, 204);
    // A handler's own refusal: its code for the line, from the JSON text runHook checked.
    if (status >= 400) {
      let said: unknown;
      try {
        said = (JSON.parse(text) as { code?: unknown } | null)?.code;
      } catch {}
      const named = traceOf(c.req.raw);
      if (named && typeof said === "string") named.code = said;
    }
    // The JSON text runHook checked before the work started, not the body read again (review pass 3).
    return c.body(text, status, { "content-type": "application/json" });
  });

  // A path a route serves, sent with another method, is a 405 naming the
  // ones it takes; any other path is NO_ROUTE.
  app.notFound((c) => {
    const allow = allowedOn(c.req.path, pluginRoutes().map((r) => [r.pattern, r.method]));
    const answer = allow.length
      ? refuse(c, 405, { code: "METHOD_NOT_ALLOWED" }, { Allow: allow.join(", ") })
      : refuse(c, 404, { code: "NO_ROUTE" });
    // A path the `*` middleware never matched (one holding an encoded line
    // break) reaches here with no record: its line is written here, so such a
    // probe is seen like any other (review pass 3).
    if (!traceOf(c.req.raw)) beginRequest("api", c.req.raw, write).end({ status: answer.status, outcome: "refused", code: allow.length ? "METHOD_NOT_ALLOWED" : "NO_ROUTE" });
    return answer;
  });
  // What escapes a route — a throw outside an operation's own catch — is a
  // JSON fault like any other, not a text 500 and a stack on stderr.
  app.onError((err, c) => {
    traceOf(c.req.raw)?.fault(err);
    return answerError(c, failure(err), 500);
  });
  return app;
}

/**
 * A refusal whole, for a request a forwarder carried (SMD-2287): the MCP
 * server words it as it always has — the caller's input quoted back, the
 * store's or the egress gate's words — and those are what the facts leave out
 * (refusalValue). It is the refusal as the operation made it for this caller,
 * the existence-oracle rule applied, which render.ts has always been handed in
 * process: the carrier is the renderer, and it bounds and picks from it as
 * before (a citing statement cut at 120 characters; a write key's own registry
 * kind, or its name, not said in full). A caller with no carrier gets the
 * facts alone.
 */
const wholeFor = <R = Refusal>(p: Principal, r: R): { refusal?: R } => (p.act ? { refusal: r } : {});

/**
 * What a key that cannot read is told of its capture: the fields the MCP tool
 * gives it (render.ts's capture value) — the id, whether its embedding was
 * made, its chunks and context failures, and the word for a provider that did
 * not answer it (SMD-2888) — and not the provider's address, the egress
 * gate's reasons or the extractor's tags (the maintainer's call, SMD-2284
 * review pass 1). A reader is told the whole value.
 */
type Captured = Extract<Awaited<ReturnType<Core["capture"]>>, { ok: true }>["value"];
const capturedFor = (p: Principal, v: Captured): object =>
  canRead(p) ? v : { id: v.id, ...(v.existed === undefined ? {} : { existed: v.existed }), embeddingCall: v.embeddings.allowed, chunks: v.chunks, contextFailures: v.contextFailures, ...(v.vectorFailed ? { vectorFailed: v.vectorFailed.reason } : {}) };

/**
 * Where this server's routes sit in the URL its caller used: "" on the mesh,
 * `/api` through the proxy's opt-in route, whose stripPrefix adds it as
 * `X-Forwarded-Prefix` — after the entrypoint has dropped any the client sent,
 * an untrusted forwarded header (Traefik's default; measured through the
 * stack). A caller on the mesh may send its own; it shapes only that caller's
 * links. A value that is not a plain path of one to four segments is ignored,
 * so a link stays on this origin.
 */
export function linkBase(c: Context): string {
  const prefix = c.req.header("x-forwarded-prefix")?.trim() ?? "";
  return /^(?:\/[A-Za-z0-9_-]+){1,4}$/.test(prefix) ? prefix : "";
}

/** A success as JSON: the operation's value, with a creation's Location, and a job's links on this server's own routes. */
function answered(c: Context, name: ToolName, status: 200 | 201 | 202, value: object, p: Principal): Response {
  if (name === "capture_thought") {
    const v = value as Captured;
    // Attached: this capture wrote its vector with the row — the embedding
    // call was made (the egress gate allowed it) and, on a re-capture, its
    // vector refreshed the row's (review pass 2: this said true either way).
    // A refused call writes none: a new row has no vector, and a re-capture's
    // row keeps the one it had (073's upsert) — so false says what this
    // capture did, not what the row holds, which a key that cannot read may
    // not learn (whether the text was already a thought). Carried by a
    // forwarder, the value is whole whatever the key's scope, as a refusal is
    // (wholeFor): the MCP server words it with render.ts, which picks from it
    // what a key that cannot read is told — the trimmed value had no tags, so
    // a capture key's capture threw there (SMD-2287 PR 3a review pass 1).
    return c.json({ ...(p.act ? v : capturedFor(p, v)), embeddingAttached: v.embeddings.allowed && !v.vectorFailed }, 201, { Location: `${linkBase(c)}/v1/thoughts/${v.id}` });
  }
  if (name === "scan_thoughts") {
    const { jobId } = value as { jobId: string };
    const base = linkBase(c);
    return c.json({ ...value, poll: `${base}/v1/jobs/${jobId}`, stream: `${base}/v1/jobs/${jobId}/stream` }, 202, { Location: `${base}/v1/jobs/${jobId}` });
  }
  return c.json(value, status);
}
