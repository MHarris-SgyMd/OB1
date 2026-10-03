// The REST core's HTTP surface (SMD-2284): every operation the MCP tools
// expose, as JSON, over the same core (core/index.ts) — routes from ROUTES,
// inputs held to the tool's own zod schema, a refusal answered as its code and
// its declared facts, a fault as FAILED. Authorization is here: a key's scope
// decides which operations it may call, and the agent registry decides whether
// the key still stands. Nothing here reads the store or calls a model; that is
// the core's, as it is for the MCP server.

import { Hono, type Context } from "hono";
import { z } from "zod";
import { authenticate, canRead, SCOPES, type AuthConfig, type Principal } from "../auth.ts";
import type { AgentOutcome } from "../agents.ts";
import { SPECS, type Core } from "../core/index.ts";
import { failure, refusalValue, type Refusal } from "../core/refusal.ts";
import { TOOLS, UNLOCKS, visibleToolNames, type ToolName } from "../tools.ts";
import { subscribe as subscribeJob } from "../jobs.ts";
import { labelPart, withSseKeepalive } from "../sse.ts";
import { honoPath, pathFields, readsQuery, REFUSAL_STATUS, ROUTES, type CallOptions, type Method } from "./routes.ts";

export { REFUSAL_STATUS } from "./routes.ts";
import { openApiDocument } from "./openapi.ts";

/** The codes the REST core answers on its own, before or around an operation. */
export type TransportCode = "UNAUTHORIZED" | "REVOKED" | "BUSY" | "FORBIDDEN" | "REFUSED_INPUT" | "NO_ROUTE" | "METHOD_NOT_ALLOWED" | "FAILED" | "STORE_UNAVAILABLE";

export interface RestDeps {
  core: Core;
  /** Seeds the environment before the first read of it (root.ts's initEnv); runs on every request, a no-op once seeded. */
  init(): void;
  /** The configured keys. */
  keys(): AuthConfig;
  /** The agent registry's answer for a key: its stable id, a revocation, or busy (agents.ts). */
  resolve(principal: Principal): Promise<AgentOutcome>;
  /** Wraps a detached run (a job), so the stop waits for it. */
  track: CallOptions["track"];
  /** Where the one line per request goes; console.log unless a suite listens. */
  log?: (line: string) => void;
}

/** How long a caller told to retry is told to wait: the busy registry (agents.ts), and every refusal or fault answered 503. */
const RETRY_AFTER_SECONDS = 2;
const RETRY_AFTER = { "Retry-After": String(RETRY_AFTER_SECONDS) };

/**
 * The keys a request presents, from its headers alone: `x-brain-key`,
 * `x-access-key` or `Authorization: Bearer`. Never `?key=` — the MCP server
 * keeps that form for URL-only connectors; here nothing needs it, and a key in
 * a URL reaches access logs and history.
 */
export function headerKeys(req: Request): string[] {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
  const forms = [req.headers.get("x-brain-key"), req.headers.get("x-access-key"), bearer];
  return [...new Set(forms.filter((k): k is string => Boolean(k)))];
}

const scopeOf = (name: ToolName) => TOOLS.find((t) => t.name === name)!.scope;
/** Whether a key's scope unlocks a tool's group (tools.ts's UNLOCKS, the one statement of the hierarchy). */
export const mayCall = (principal: Principal, name: ToolName): boolean => UNLOCKS[principal.scope].includes(scopeOf(name));

/** Each field's JSON-schema type, for reading it from a query string: "number", "integer", "boolean", "array", or anything else as text. */
function queryTypes(name: ToolName): Map<string, string> {
  const out = new Map<string, string>();
  for (const [field, schema] of Object.entries(SPECS[name].inputSchema)) {
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
  const types = queryTypes(name);
  // No prototype: a `__proto__` key is a key like any other, which the strict
  // schema then refuses, rather than an assignment that drops it unseen.
  const input: Record<string, unknown> = Object.create(null);
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    const type = types.get(key);
    if (type === "array") { input[key] = values; continue; }
    if (values.length > 1) return { problem: `${labelPart(key)} is given more than once` };
    const v = values[0];
    if ((type === "number" || type === "integer") && /^-?\d+(?:\.\d+)?$/.test(v)) input[key] = Number(v);
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
  [/^\/v1\/whoami$/, "GET"], [/^\/v1\/jobs\/[^/]+\/stream$/, "GET"], [/^\/health$/, "GET"], [/^\/openapi\.json$/, "GET"],
];
const allowedOn = (path: string): string[] => {
  const methods = new Set<string>(ROUTE_METHODS.filter(([re]) => re.test(path)).map(([, m]) => m));
  if (methods.has("GET")) methods.add("HEAD");
  return [...methods].sort();
};

export function createRestApp(deps: RestDeps): Hono {
  const app = new Hono();
  const log = deps.log ?? ((line: string) => console.log(line));
  const doc = openApiDocument();

  // One line per request: the method, the route's template — never the path
  // it was given (an id), the query string, a key or a body — the status and
  // the time. Registered first, so every answer below is counted.
  app.use("*", async (c, next) => {
    deps.init();
    const started = performance.now();
    await next();
    const template = c.req.routePath === "*" || c.req.routePath === "/*" ? "-" : c.req.routePath;
    log(`api ${c.req.method} ${template} ${c.res.status} ${Math.round(performance.now() - started)}ms`);
  });

  // Liveness, for the container's healthcheck: no key, no store, no answer
  // about the brain. Internal only — the public /health is the MCP server's.
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/openapi.json", (c) => c.json(doc));

  const refuse = (c: Context, status: 400 | 401 | 403 | 404 | 405 | 503, body: { code: TransportCode } & Record<string, unknown>, headers: Record<string, string> = {}) =>
    c.json(body, status, headers);
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
   * The caller, or the answer that refuses it: a key that authenticates (any
   * scope), then the registry's word on it — revoked is refused for good, busy
   * for now — with its stable agent id set for the audit row.
   */
  async function caller(c: Context): Promise<Principal | Response> {
    const keys = deps.keys();
    let principal: Principal | null = null;
    for (const key of headerKeys(c.req.raw)) {
      principal = authenticate(key, keys, { admit: SCOPES });
      if (principal) break;
    }
    if (!principal) return refuse(c, 401, { code: "UNAUTHORIZED" }, { "WWW-Authenticate": "Bearer" });
    const identity = await deps.resolve(principal);
    if (identity.status === "revoked") return refuse(c, 401, { code: "REVOKED" }, { "WWW-Authenticate": "Bearer" });
    if (identity.status === "busy") return refuse(c, 503, { code: "BUSY", retryable: true }, RETRY_AFTER);
    principal.agentId = identity.agentId;
    principal.agentUnresolved = identity.unresolved;
    return principal;
  }

  // Who is calling: the key's name, its scope, its stable agent id, and the
  // operations it may call — what the MCP server's tools/list and the GUI's
  // sign-in read once SMD-2287 and SMD-2280 are clients (no `act` until a
  // forwarder, SMD-2284's PR 4).
  app.get("/v1/whoami", async (c) => {
    const p = await caller(c);
    if (p instanceof Response) return p;
    return c.json({ name: p.name, scope: p.scope, ...(p.agentId ? { agentId: p.agentId } : {}), operations: visibleToolNames(p) });
  });

  // A job's event stream (SMD-2273): its progress and its end as SSE, kept
  // alive while it runs. Its owner alone reads it, as the poll (job_status).
  app.get("/v1/jobs/:job_id/stream", async (c) => {
    const p = await caller(c);
    if (p instanceof Response) return p;
    if (!mayCall(p, "job_status")) return refuse(c, 403, { code: "FORBIDDEN", needs: scopeOf("job_status") });
    // A HEAD would subscribe and keep a stream alive that no one reads.
    const head = headOnly(c, "text/event-stream");
    if (head) return head;
    const id = c.req.param("job_id");
    const stream = await subscribeJob(p, id);
    if (!stream) return c.json(refusalValue({ code: "NOT_FOUND", retryable: false, id }), 404);
    const response = new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    return withSseKeepalive(response, { signal: c.req.raw.signal, label: `api jobs/${labelPart(id)}/stream` });
  });

  for (const name of Object.keys(ROUTES) as ToolName[]) {
    const route = ROUTES[name];
    const fields = pathFields(route.path);
    const schema = z.object(SPECS[name].inputSchema).strict();
    app.on(route.method, honoPath(route.path), async (c) => {
      const p = await caller(c);
      if (p instanceof Response) return p;
      if (!mayCall(p, name)) return refuse(c, 403, { code: "FORBIDDEN", needs: scopeOf(name) });

      // The input: the path's fields, then the query string or the body — and
      // only the one the route reads: input sent the other way is refused, not
      // dropped (a DELETE's body `detach_citations` would otherwise be ignored).
      let rest: Record<string, unknown>;
      const query = new URL(c.req.url).searchParams;
      if (readsQuery(route.method)) {
        // Bun hands a GET's handler no body, whatever was sent: the headers
        // that announced one are what is left of it (review pass 2).
        // Any length but zero counts: Bun joins a repeated Content-Length
        // into "11, 11", which is no number (review pass 3).
        const length = c.req.header("content-length");
        const announced = c.req.method !== "DELETE" && ((length !== undefined && !/^\s*0+\s*$/.test(length)) || c.req.header("transfer-encoding") !== undefined);
        if (announced || (await c.req.text()).trim() !== "") return refuse(c, 400, { code: "REFUSED_INPUT", issues: [{ path: "", message: `${route.method} reads its input from the query string, not a body` }] });
        const read = inputFromQuery(name, query);
        if ("problem" in read) return refuse(c, 400, { code: "REFUSED_INPUT", issues: [{ path: "", message: read.problem }] });
        rest = read.input;
      } else {
        if (query.size > 0) return refuse(c, 400, { code: "REFUSED_INPUT", issues: [{ path: "", message: `${route.method} reads its input from a JSON body, not the query string` }] });
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
      for (const f of fields) {
        if (f in rest) return refuse(c, 400, { code: "REFUSED_INPUT", issues: [{ path: f, message: `${f} comes from the path` }] });
      }
      const parsed = schema.safeParse({ ...rest, ...Object.fromEntries(fields.map((f) => [f, c.req.param(f)])) });
      if (!parsed.success) return refuse(c, 400, { code: "REFUSED_INPUT", issues: issuesOf(parsed.error) });
      const head = headOnly(c);
      if (head) return head;

      let outcome;
      try {
        outcome = await route.call(deps.core, p, parsed.data as never, { track: deps.track });
      } catch (err) {
        // A fault: FAILED with what was thrown, as the MCP tool's text says it
        // to the same key; no `retryable` until SMD-2461 classifies faults —
        // but capture's, the transient the session hook retries, as the tool
        // gives it (SMD-1978).
        if (route.fault) return c.json({ code: route.fault, retryable: true, message: failure(err).message }, 503, RETRY_AFTER);
        return c.json(failure(err), 500);
      }
      if (outcome.ok) return answered(c, name, route.ok, outcome.value, p);
      const r = outcome.refusal as Refusal;
      // Saved, but its vector did not attach (the PostgREST two-step): the row
      // is there, so the answer is the creation, flagged — a client that read a
      // refusal as "not written" would capture again.
      if (r.code === "EMBEDDING_NOT_ATTACHED") return c.json({ id: r.id, embeddingAttached: false }, 201, { Location: `${linkBase(c)}/v1/thoughts/${r.id}` });
      const status = REFUSAL_STATUS[r.code];
      return c.json(refusalValue(r), status, status === 503 ? RETRY_AFTER : {});
    });
  }

  // A path a route serves, sent with another method, is a 405 naming the
  // ones it takes; any other path is NO_ROUTE.
  app.notFound((c) => {
    const allow = allowedOn(c.req.path);
    return allow.length
      ? refuse(c, 405, { code: "METHOD_NOT_ALLOWED" }, { Allow: allow.join(", ") })
      : refuse(c, 404, { code: "NO_ROUTE" });
  });
  // What escapes a route — a throw outside an operation's own catch — is a
  // JSON fault like any other, not a text 500 and a stack on stderr.
  app.onError((err, c) => c.json(failure(err), 500));
  return app;
}

/**
 * What a key that cannot read is told of its capture: the fields the MCP tool
 * gives it (render.ts's capture value) — the id, whether its embedding was
 * made, its chunks and context failures — and not the provider's address,
 * the egress gate's reasons or the extractor's tags (the maintainer's call,
 * SMD-2284 review pass 1). A reader is told the whole value.
 */
type Captured = Extract<Awaited<ReturnType<Core["capture"]>>, { ok: true }>["value"];
const capturedFor = (p: Principal, v: Captured): object =>
  canRead(p) ? v : { id: v.id, ...(v.existed === undefined ? {} : { existed: v.existed }), embeddingCall: v.embeddings.allowed, chunks: v.chunks, contextFailures: v.contextFailures };

/**
 * Where this server's routes sit in the URL its caller used: "" on the mesh,
 * `/api` through the proxy's opt-in route, which strips that prefix and names
 * it in `X-Forwarded-Prefix` (Traefik's stripPrefix sets it, replacing any the
 * client sent). A value that is not a plain path prefix is ignored, so a
 * header can move a link within this server's own paths and no further.
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
    // not learn (whether the text was already a thought).
    return c.json({ ...capturedFor(p, v), embeddingAttached: v.embeddings.allowed }, 201, { Location: `${linkBase(c)}/v1/thoughts/${v.id}` });
  }
  if (name === "scan_thoughts") {
    const { jobId } = value as { jobId: string };
    const base = linkBase(c);
    return c.json({ ...value, poll: `${base}/v1/jobs/${jobId}`, stream: `${base}/v1/jobs/${jobId}/stream` }, 202, { Location: `${base}/v1/jobs/${jobId}` });
  }
  return c.json(value, status);
}
