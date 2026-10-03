// The REST core's HTTP surface (SMD-2284): every operation the MCP tools
// expose, as JSON, over the same core (core/index.ts) — routes from ROUTES,
// inputs held to the tool's own zod schema, a refusal answered as its code and
// its declared facts, a fault as FAILED. Authorization is here: a key's scope
// decides which operations it may call, and the agent registry decides whether
// the key still stands. Nothing here reads the store or calls a model; that is
// the core's, as it is for the MCP server.

import { Hono, type Context } from "hono";
import { z } from "zod";
import { authenticate, SCOPES, type AuthConfig, type Principal } from "../auth.ts";
import type { AgentOutcome } from "../agents.ts";
import { SPECS, type Core } from "../core/index.ts";
import { failure, refusalValue, type Refusal, type RefusalCode } from "../core/refusal.ts";
import { TOOLS, UNLOCKS, visibleToolNames, type ToolName } from "../tools.ts";
import { subscribe as subscribeJob } from "../jobs.ts";
import { labelPart, withSseKeepalive } from "../sse.ts";
import { honoPath, pathFields, readsQuery, ROUTES, type CallOptions } from "./routes.ts";
import { openApiDocument } from "./openapi.ts";

/**
 * The HTTP status each refusal answers with — one per code, so a new refusal
 * does not compile until it has one. 400 a shape the caller can fix, 403 a
 * rule the caller may not pass, 404 nothing there, 409 the state changed or
 * conflicts, 422 a reference to nothing, 501 a mode not built, 503 retry.
 */
export const REFUSAL_STATUS: Record<RefusalCode, 400 | 403 | 404 | 409 | 422 | 501 | 503> = {
  NOT_FOUND: 404,
  REFUSED_FILTER: 400,
  REFUSED_EGRESS: 403,
  REFUSED_SINCE: 400,
  REFUSED_CURSOR: 400,
  REFUSED_SUPERSEDES_SHAPE: 400,
  REFUSED_DERIVED_FROM_SHAPE: 400,
  REFUSED_METADATA_SHAPE: 400,
  SUPERSEDES_UNJUDGED: 503,
  REFUSED_SUPERSEDES_OWNERSHIP: 403,
  REFUSED_SUPERSEDES_UNKNOWN: 422,
  DERIVED_FROM_MISSING: 422,
  // Never answered as a refusal: the row is saved, so it is a creation (below).
  EMBEDDING_NOT_ATTACHED: 503,
  REFUSED_NOTHING_TO_UPDATE: 400,
  REFUSED_STALE_READ: 409,
  REFUSED_DUPLICATE_CONTENT: 409,
  REFUSED_WOULD_CYCLE: 409,
  REFUSED_CITED: 409,
  REFUSED: 422,
  REFUSED_EMPTY_WORK_TYPE: 400,
  REFUSED_LIVE_LEASE_NEEDS_WORKER: 400,
  RUN_WORKER_DRAIN_NOT_AVAILABLE: 501,
};

/** The codes the REST core answers on its own, before or around an operation. */
export type TransportCode = "UNAUTHORIZED" | "REVOKED" | "BUSY" | "FORBIDDEN" | "REFUSED_INPUT" | "NO_ROUTE" | "FAILED";

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

/** How long a refused-for-now key is told to wait (the busy registry, agents.ts). */
const RETRY_AFTER_SECONDS = 2;

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
  const input: Record<string, unknown> = {};
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

  const refuse = (c: Context, status: 400 | 401 | 403 | 404 | 503, body: { code: TransportCode } & Record<string, unknown>, headers: Record<string, string> = {}) =>
    c.json(body, status, headers);

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
    if (identity.status === "busy") return refuse(c, 503, { code: "BUSY", retryable: true }, { "Retry-After": String(RETRY_AFTER_SECONDS) });
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

      // The input: the path's fields, then the query string or the body.
      let rest: Record<string, unknown>;
      if (readsQuery(route.method)) {
        const read = inputFromQuery(name, new URL(c.req.url).searchParams);
        if ("problem" in read) return refuse(c, 400, { code: "REFUSED_INPUT", issues: [{ path: "", message: read.problem }] });
        rest = read.input;
      } else {
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

      let outcome;
      try {
        outcome = await route.call(deps.core, p, parsed.data as never, { track: deps.track });
      } catch (err) {
        // A fault: FAILED with what was thrown, as the MCP tool's text says it
        // to the same key; no `retryable` until SMD-2461 classifies faults.
        return c.json(failure(err), 500);
      }
      if (outcome.ok) return answered(c, name, route.ok, outcome.value);
      const r = outcome.refusal as Refusal;
      // Saved, but its vector did not attach (the PostgREST two-step): the row
      // is there, so the answer is the creation, flagged — a client that read a
      // refusal as "not written" would capture again.
      if (r.code === "EMBEDDING_NOT_ATTACHED") return c.json({ id: r.id, embeddingAttached: false }, 201, { Location: `/v1/thoughts/${r.id}` });
      return c.json(refusalValue(r), REFUSAL_STATUS[r.code]);
    });
  }

  app.notFound((c) => c.json({ code: "NO_ROUTE" satisfies TransportCode }, 404));
  return app;
}

/** A success as JSON: the operation's value, with a creation's Location, and a job's links on this server's own routes. */
function answered(c: Context, name: ToolName, status: 200 | 201 | 202, value: object): Response {
  if (name === "capture_thought") {
    const id = (value as { id: string }).id;
    return c.json({ ...value, embeddingAttached: true }, 201, { Location: `/v1/thoughts/${id}` });
  }
  if (name === "scan_thoughts") {
    const { jobId } = value as { jobId: string };
    return c.json({ ...value, poll: `/v1/jobs/${jobId}`, stream: `/v1/jobs/${jobId}/stream` }, 202, { Location: `/v1/jobs/${jobId}` });
  }
  return c.json(value, status);
}
