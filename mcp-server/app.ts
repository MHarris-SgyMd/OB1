// The brain's MCP server as a client of its REST core (SMD-2287): the MCP
// endpoint, its public /health and its keyed mirrors, answered as
// server-portable's index.ts answers them — the same edge (mcp-edge.ts), the
// same words (render.ts) — with every operation a call to the REST core
// through rest-client, the caller's key forwarded beside this server's
// forward-scope key. It holds no store, no key list and no model: the REST
// core authenticates every caller (its whoami says who a key is and what it
// may call), runs every operation and answers every refusal, carried whole
// so its words are the ones server-portable says.

import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Hono, type Context } from "hono";
import { presentedKeys } from "../server-portable/auth.ts";
import { FORK_VERSION } from "../server-portable/version.ts";
import { SPECS, type Input } from "../server-portable/core/schemas.ts";
import type { ToolName } from "../server-portable/tools.ts";
import { HEALTH_DEADLINE_MS } from "../server-portable/deadlines.ts";
import type { Refusal } from "../server-portable/core/refusal.ts";
import type { LoadedOp, LoadedPlugin } from "../server-portable/core/plugins.ts";
import * as say from "../server-portable/render.ts";
import { abandonedRequestLine, labelPart, requestLabel, SSE_KEEPALIVE_MAX_MS, SSE_KEEPALIVE_MS, withSseKeepalive } from "../server-portable/sse.ts";
import { authReachability, edgeSettings, edgeView, forPublicDocument, PRM_PATH, protectedResourceDocument, refusalAt, type EdgeSettings } from "../server-portable/oauth-edge.ts";
import {
  BUSY_MESSAGE, challengeResponse, corsHeaders, HEALTH_METHOD_NOT_ALLOWED_HEADERS, HEALTH_PATH, JSON_RPC_BUSY_CODE, MCP_METHODS,
  METHOD_NOT_ALLOWED_HEADERS, MIRROR_INPUT, MIRROR_WORDS, noteLegacyRoute, notificationRefusedResponse, rawPath, readBodyText,
  REFUSAL_BODY_LIMIT, refusalTarget, RETRY_AFTER_SECONDS, REVOKED_MESSAGE, unauthorizedResponse, unavailableResponse, type MirrorTool,
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
}

/** Who a request's key is, as the REST core's whoami says: its name, its scope and the operations it may call — or why not. */
export type Standing =
  | { kind: "caller"; key: string; name: string; scope: string; operations: ReadonlySet<string> }
  | { kind: "none" } // no key, or none the core knows
  | { kind: "revoked" }
  | { kind: "busy" };

/**
 * The caller, as server-portable finds one: each key the request presents —
 * `x-brain-key`, `x-access-key`, `?key=`, `Bearer` (auth.ts presentedKeys) — in
 * turn, the first the REST core knows deciding. A key it does not know (401
 * UNAUTHORIZED) passes to the next; one it knows but has revoked, or cannot
 * confirm while its registry is busy, decides as it stands. The forwarder slot
 * this server fills is its own: refused there, the server is misconfigured,
 * and the request is a fault, never a caller's refusal.
 */
export async function standingOf(rest: RestClient, req: Request, signal?: AbortSignal): Promise<Standing> {
  for (const key of presentedKeys(req)) {
    const a = await rest.call("whoami" as never, {} as never, { key, signal });
    const body = (a.body ?? {}) as { code?: string; credential?: string; name?: string; scope?: string; operations?: string[] };
    // This server's own key in the forwarder slot: busy is the registry's, as for a caller's key (review pass 3: it read
    // as a misconfiguration); refused, the server is misconfigured.
    if (body.credential === "forwarder" && a.status === 503) return { kind: "busy" };
    if (body.credential === "forwarder") throw new Error(`the REST core refused this server's forwarder key (${a.status} ${body.code ?? "?"}): set OB1_FORWARDER_KEY to a forward-scope key MCP_ACCESS_KEYS holds`);
    if (a.status === 200) return { kind: "caller", key, name: String(body.name), scope: String(body.scope), operations: new Set(body.operations ?? []) };
    if (a.status === 401 && body.code === "REVOKED") return { kind: "revoked" };
    if (a.status === 503) return { kind: "busy" };
    if (a.status !== 401) throw new Error(`the REST core answered whoami ${a.status} ${body.code ?? ""}`.trim());
  }
  return { kind: "none" };
}

/** An operation's answer from the REST core, as render.ts reads an outcome: its value, its refusal whole, or a fault. */
type Outcome = { ok: true; value: unknown } | { ok: false; refusal: Refusal } | { fault: Error };

/**
 * A REST answer as the outcome the in-process core would have handed
 * render.ts: a success's value; a refusal the forwarder slot carried whole
 * (a save whose vector did not attach among them, a 201 beside its
 * `refusal`); a fault — FAILED or capture's STORE_UNAVAILABLE — as the error
 * its message names, so the tool's fault words say it as they always have.
 * Anything else (a refusal of the key mid-call, an input the client
 * answered itself) is a fault naming its code.
 */
export function outcomeOf(a: Answer): Outcome {
  const body = (a.body ?? {}) as { refusal?: Refusal; code?: string; message?: string; issues?: { path: string; message: string }[] };
  if (body.refusal && typeof body.refusal === "object") return { ok: false, refusal: body.refusal };
  if (a.ok) return { ok: true, value: a.body };
  if ((body.code === "FAILED" || body.code === "STORE_UNAVAILABLE") && typeof body.message === "string") return { fault: new Error(body.message) };
  if (body.code === "REFUSED_INPUT" && body.issues?.length) return { fault: new Error(body.issues.map((i) => `${i.path || "input"}: ${i.message}`).join("; ")) };
  return { fault: new Error(`the REST core answered ${a.status}${body.code ? ` ${body.code}` : ""}`) };
}

/**
 * A plugin operation's answer from the REST core as runOperation's outcome:
 * a success's value whatever its fields — a plugin may name one `refusal` —
 * else as a core operation's (outcomeOf): its refusal the forwarder slot
 * carried whole, a fault, or a fault naming the code.
 */
export function pluginOutcomeOf(a: Answer): Outcome {
  return a.ok ? { ok: true, value: a.body } : outcomeOf(a);
}

/** Each tools/call's arguments as its client sent them, by the request's JSON-RPC id (JSON-written): a body of one message or a batch. */
export type RawArguments = ReadonlyMap<string, Record<string, unknown>>;
export function argumentsById(body: string | null): RawArguments {
  const out = new Map<string, Record<string, unknown>>();
  let parsed: unknown;
  try { parsed = body ? JSON.parse(body) : null; } catch { return out; }
  for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
    const msg = m as { id?: unknown; method?: unknown; params?: { arguments?: unknown } } | null;
    const args = msg?.params?.arguments;
    if (msg?.method !== "tools/call" || msg.id === undefined || args === null || typeof args !== "object" || Array.isArray(args)) continue;
    const key = JSON.stringify(msg.id);
    if (!out.has(key)) out.set(key, args as Record<string, unknown>);
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
  retry_failed: { render: (o) => say.renderRetryFailed(o), fault: writeFault("retry_failed failed: ") },
  release_stale_leases: { render: (o) => say.renderReleaseStaleLeases(o), fault: writeFault("release_stale_leases failed: ") },
  run_worker: { render: (o) => say.renderRunWorker(o), fault: writeFault("run_worker failed: ") },
  job_status: { render: (o) => say.renderJobStatus(o), fault: readFault() },
  scan_thoughts: { render: (o) => say.renderJobHandle(o), fault: readFault() },
};

/**
 * The MCP server for one request: the tools the caller's operations name,
 * each validated by the SDK against the tool's own schema (core/schemas.ts),
 * called on the REST core with the caller's key, and its answer said by
 * render.ts. `endpoint`: the path the request came to, no trailing slash —
 * a scan's job links go under it, as server-portable's do.
 */
function buildServer(rest: RestClient, caller: Extract<Standing, { kind: "caller" }>, endpoint: string, ops: readonly LoadedOp[], raw: RawArguments): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: FORK_VERSION });
  const register = server.registerTool.bind(server) as unknown as (name: string, spec: unknown, handler: (input: never, ctx: { mcpReq?: { id?: unknown } }) => Promise<say.Reply>) => unknown;
  for (const name of Object.keys(WORDS) as ToolName[]) {
    if (!caller.operations.has(name)) continue;
    const words = WORDS[name];
    register(name, SPECS[name], async (input: never) => {
      // The call and its rendering under one catch, as index.ts's registerOp runs
      // them: a reply that cannot be said is the tool's fault, its code the
      // session hook reads (review pass 1: a throw past it reached the SDK as an
      // uncoded error).
      try {
        let outcome = outcomeOf(await rest.call(name as never, input, { key: caller.key }));
        if ("fault" in outcome) return words.fault(outcome.fault, input);
        if (name === "scan_thoughts" && outcome.ok) {
          // The handle's links under this server's endpoint, as atEndpoint puts them (jobs.ts): its /jobs routes, not the REST core's /v1/jobs.
          const handle = outcome.value as { jobId: string };
          outcome = { ok: true, value: { ...handle, poll: `${endpoint}/jobs/${handle.jobId}`, stream: `${endpoint}/jobs/${handle.jobId}/stream` } };
        }
        return words.render(outcome as never, input);
      } catch (err) {
        return words.fault(err, input);
      }
    });
  }
  // The enabled plugins' operations (SMD-2310), after the core's as index.ts
  // registers them: each a tool named `<plugin>_<operation>` where whoami
  // names it among the caller's operations, the SDK holding its input and its
  // answer to the manifest's schemas, called on the REST core by its route and
  // said by render.ts's renderPlugin — a fault as index.ts says a plugin's.
  // The input sent is the one the client sent, its fields the operation's, not
  // the SDK's parse of it: the REST core parses it once, as index.ts's SDK does,
  // so a step of the schema runs once (review pass 2: a preprocess, an
  // overwrite or a codec ran twice, or refused its own output).
  for (const op of ops) {
    if (!caller.operations.has(op.tool)) continue;
    register(op.tool, { title: op.title, description: op.description, annotations: op.annotations, inputSchema: op.input, outputSchema: op.output }, async (input: never, ctx) => {
      try {
        const given = raw.get(JSON.stringify(ctx?.mcpReq?.id));
        const sent = given ? Object.fromEntries(Object.entries(given).filter(([field]) => Object.hasOwn(op.shape, field))) : input as Record<string, unknown>;
        const outcome = pluginOutcomeOf(await rest.callPath(op.method, op.path, sent, { key: caller.key }));
        return "fault" in outcome ? say.failed(outcome.fault) : say.renderPlugin(outcome as never);
      } catch (err) {
        return say.failed(err);
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
   * the REST core runs and this server was not given — said once: the caller
   * sees no tool, so the log is where the mismatch shows (review pass 1).
   */
  const untooled = new Set<string>();
  const noteUntooled = (operations: ReadonlySet<string>) => {
    for (const name of operations) {
      if (untooled.has(name) || name in WORDS || opsHere().some((op) => op.tool === name)) continue;
      untooled.add(name);
      // A plugin the REST core runs and this server was not given, or a core tool of a newer REST core: the name cannot say which.
      warn(`mcp-server: the REST core runs ${name}, which is no tool here: run this server from the REST core's build, with its OB1_PLUGINS`);
    }
  };

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
    const line = `mcp-server: ${lead}${deps.restUrl ? ` (REST core at ${deps.restUrl})` : ""}: ${(err as Error)?.message ?? String(err)}`;
    const now = Date.now();
    if (now - (lastSaid.get(line) ?? -Infinity) < 60_000) return;
    lastSaid.set(line, now);
    warn(line);
  };
  /** The registry busy on a key between its check and the call: shown `ok`, as index.ts shows a busy key at every keyed route (review pass 3). */
  const busyNow = (a: Answer) => a.status === 503 && (a.body as { code?: string } | null)?.code === "BUSY";
  /**
   * The caller of a keyed mirror or /health, its key's standing within
   * HEALTH_DEADLINE_MS, as index.ts races the registry against it: a
   * standing not had by then — the registry's tables locked — is none, and
   * the route shows `ok` (review pass 1: it waited out the REST timeout).
   */
  const standingInTime = async (req: Request, budget: AbortSignal): Promise<Standing> => {
    if (budget.aborted) return { kind: "none" };
    let onAbort: () => void = () => {};
    const standing = await Promise.race([
      standingOf(deps.rest, req, budget).catch((err): Standing => {
        if (!budget.aborted) sayOnce(err);
        return { kind: "none" };
      }),
      new Promise<Standing>((resolve) => {
        onAbort = () => resolve({ kind: "none" });
        budget.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    budget.removeEventListener("abort", onAbort);
    return standing;
  };
  // A keyed mirror's caller: one whose key the REST core knows, stands by,
  // and lets call the mirror's tool — else null, and the mirror shows `ok`.
  const mirrorCaller = async (c: Context, tool: ToolName, budget: AbortSignal = AbortSignal.timeout(HEALTH_DEADLINE_MS)) => {
    const standing = await standingInTime(c.req.raw, budget);
    return standing.kind === "caller" && standing.operations.has(tool) ? standing : null;
  };

  // /health: liveness, and with a key that may read it, what the brain is
  // (index.ts's route). The record is the REST core's keyed /health — the
  // health surface, under its deadline, the registry's word on the key
  // included — with this server's view of the public origin beside it.
  app.get("*", async (c, next) => {
    if (!HEALTH_PATH.test(c.req.path)) return next();
    const keys = presentedKeys(c.req.raw);
    if (keys.length === 0 || c.req.method === "HEAD") return c.text("ok", 200, corsHeaders);
    // The first key the REST core knows decides, as index.ts authenticates the
    // first that matches: a capture or revoked key before a read key is `ok`,
    // not the record (review pass 1).
    // One deadline for the key's standing and the record together, as index.ts
    // starts both under one: the record's call is cut at what is left of it,
    // and the route answers `ok` (review pass 2: one after the other, a keyed
    // probe could wait twice the deadline).
    const budget = AbortSignal.timeout(HEALTH_DEADLINE_MS);
    const caller = await mirrorCaller(c, "brain_info", budget);
    if (!caller) return c.text("ok", 200, corsHeaders);
    const oauth = edgeView(edgeHere(), () => authReachability().reachable());
    const a = await deps.rest.call("health" as never, {} as never, { key: caller.key, signal: budget }).catch(() => null);
    const body = a?.ok ? (a.body as Record<string, unknown> | null) : null;
    if (!body || (Object.keys(body).length === 1 && body.status === "ok")) return c.text("ok", 200, corsHeaders);
    noteLegacyRoute(c.req.raw, caller.name);
    return c.json({ ...body, oauth: await oauth }, 200, corsHeaders);
  });

  // The worker-queue status as a keyed GET (SMD-2131), the worker_status tool's REST mirror.
  const WORKER_STATUS_PATH = /(^|\/)worker-status\/?$/;
  app.get("*", async (c, next) => {
    if (!WORKER_STATUS_PATH.test(c.req.path)) return next();
    const caller = await mirrorCaller(c, "worker_status");
    if (!caller) return c.text("ok", 200, corsHeaders);
    if (c.req.method === "HEAD") return c.text("ok", 200, corsHeaders);
    noteLegacyRoute(c.req.raw, caller.name);
    try {
      const answered = await deps.rest.call("worker_status", {}, { key: caller.key });
      if (busyNow(answered)) return c.text("ok", 200, corsHeaders);
      const o = outcomeOf(answered);
      if ("fault" in o) return c.json({ error: o.fault.message }, 200, corsHeaders);
      // The operation answers an object (a tool result is one); this route has always answered the bare rows.
      return c.json(o.ok ? (o.value as { pools: unknown }).pools : [], 200, corsHeaders);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 200, corsHeaders);
    }
  });

  // The worker-queue actions as keyed POSTs (SMD-2132, SMD-2272), each its tool's REST mirror.
  const MIRRORS: [RegExp, MirrorTool][] = [
    [/(^|\/)worker-retry-failed\/?$/, "retry_failed"],
    [/(^|\/)worker-release-leases\/?$/, "release_stale_leases"],
    [/(^|\/)worker-run\/?$/, "run_worker"],
  ];
  app.post("*", async (c, next) => {
    const tool = MIRRORS.find(([re]) => re.test(c.req.path))?.[1];
    if (!tool) return next();
    const caller = await mirrorCaller(c, tool);
    if (!caller) return c.text("ok", 200, corsHeaders);
    noteLegacyRoute(c.req.raw, caller.name);
    const body = await c.req.json().catch(() => null);
    const args: Record<string, unknown> = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    try {
      const answered = await deps.rest.call(tool, MIRROR_INPUT[tool](args) as never, { key: caller.key });
      if (busyNow(answered)) return c.text("ok", 200, corsHeaders);
      const o = outcomeOf(answered);
      if ("fault" in o) return c.json({ error: o.fault.message }, 200, corsHeaders);
      if (o.ok) return c.json(o.value as object, 200, corsHeaders);
      const words = MIRROR_WORDS[tool] as Record<string, string>;
      return c.json({ error: words[o.refusal.code], code: o.refusal.code }, 400, corsHeaders);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 200, corsHeaders);
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
    const caller = await mirrorCaller(c, "job_status");
    if (!caller) return c.text("ok", 200, corsHeaders);
    if (c.req.method === "HEAD") return c.text("ok", 200, corsHeaders);
    noteLegacyRoute(c.req.raw, caller.name);
    if (streamMatch) {
      const upstream = await deps.rest.stream(id, { key: caller.key, signal: c.req.raw.signal });
      if (upstream.status !== 200 || !upstream.body) {
        void upstream.body?.cancel().catch(() => {});
        // Not there for this key: index.ts's 404. A fault — the durable job
        // store away — is Hono's 500, as index.ts's throw is; a key the REST
        // core no longer stands by is shown `ok` (review pass 2: all three read
        // "not found", which a poller gives up on).
        if (upstream.status === 404) return c.json({ error: "not found" }, 404, corsHeaders);
        if (upstream.status >= 500 && upstream.status !== 503) throw new Error(`the REST core answered the job stream ${upstream.status}`);
        return c.text("ok", 200, corsHeaders);
      }
      const response = new Response(upstream.body, { status: 200, headers: { ...corsHeaders, "content-type": "text/event-stream", "cache-control": "no-cache" } });
      return withSseKeepalive(response, { signal: c.req.raw.signal, label: `jobs/${labelPart(id)}/stream` });
    }
    const answered = await deps.rest.call("job_status", { job_id: id }, { key: caller.key });
    if (busyNow(answered)) return c.text("ok", 200, corsHeaders);
    const o = outcomeOf(answered);
    if ("fault" in o) throw o.fault;
    if (!o.ok) return c.json({ error: "not found" }, 404, corsHeaders);
    return c.json(o.value as object, 200, corsHeaders);
  });

  // The MCP endpoint, POST at every path (index.ts's route): the caller's
  // standing first — refused as server-portable refuses, the edge's envelopes
  // and a notification's bare answer — then the SDK's transport over a server
  // whose tools are the caller's operations.
  app.on(MCP_METHODS, "*", async (c) => {
    const signal = c.req.raw.signal;
    const started = performance.now();
    let label = "?";
    let settled = false;
    const abandoned = () => {
      if (settled) return;
      settled = true;
      warn(abandonedRequestLine(label, performance.now() - started));
    };
    signal.addEventListener("abort", abandoned, { once: true });
    if (signal.aborted) {
      abandoned();
      return c.body(null, 408);
    }
    // Anything that throws from here — the REST core away, this server's
    // forwarder refused, the transport — is Hono's 500, the request settled
    // first so a client gone after is no abandoned line (index.ts's catch;
    // review passes 1 and 2).
    try {
      return await answer();
    } catch (err) {
      settled = true;
      throw err;
    }
    async function answer(): Promise<Response> {
      const standing = await standingOf(deps.rest, c.req.raw, signal);
      if (standing.kind === "none") {
        const edgeAnswer = await refusalAt(edgeHere(), c.req.raw, () => authReachability().reachable());
        const target = refusalTarget(await readBodyText(c.req.raw, REFUSAL_BODY_LIMIT));
        settled = true;
        if (edgeAnswer.kind === "challenge") return challengeResponse(edgeAnswer.origin, edgeAnswer.refusedToken, target);
        if (edgeAnswer.kind === "unavailable") return unavailableResponse(target);
        return target.expectsReply ? unauthorizedResponse(target.id) : notificationRefusedResponse();
      }
      if (standing.kind === "revoked" || standing.kind === "busy") {
        const target = refusalTarget(await readBodyText(c.req.raw));
        settled = true;
        if (standing.kind === "revoked") return target.expectsReply ? unauthorizedResponse(target.id, REVOKED_MESSAGE) : notificationRefusedResponse();
        return target.expectsReply
          ? unauthorizedResponse(target.id, BUSY_MESSAGE, JSON_RPC_BUSY_CODE, { retryAfter: RETRY_AFTER_SECONDS })
          : notificationRefusedResponse({ retryAfter: RETRY_AFTER_SECONDS });
      }
      noteLegacyRoute(c.req.raw, standing.name);
      noteUntooled(standing.operations);
      // The body read once and handed to the transport rebuilt: v2's transport reads the raw stream (SMD-2278).
      const rawBody = await c.req.text().catch(() => null);
      label = requestLabel(rawBody);
      const server = buildServer(deps.rest, standing, rawPath(c.req.raw).replace(/\/{2,}/g, "/").replace(/\/+$/, ""), opsHere(), argumentsById(rawBody));
      const transport = new WebStandardStreamableHTTPServerTransport();
      await server.connect(transport);
      const response = await transport.handleRequest(new Request(c.req.raw.url, { method: c.req.raw.method, headers: c.req.raw.headers, body: rawBody ?? undefined }));
      if (!response) {
        settled = true;
        return c.json({ error: "No response from MCP transport" }, 500, corsHeaders);
      }
      response.headers.delete("mcp-session-id");
      for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
      return withSseKeepalive(response, {
        signal, label, startedAt: started, ...keepalive,
        onEnd: () => { settled = true; },
        onStall: () => { settled = true; },
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

  // Whatever no route above matched: 405 with `Allow` (index.ts's notFound).
  app.notFound((c) => c.text("Method Not Allowed", 405, HEALTH_PATH.test(c.req.path) ? HEALTH_METHOD_NOT_ALLOWED_HEADERS : METHOD_NOT_ALLOWED_HEADERS));
  return app;
}

/** The public origin's settings from an environment (oauth-edge.ts), for the entry. */
export const edgeFrom = (env: { COMPOSE_PROFILES?: string; OB1_PUBLIC_ORIGIN?: string }): EdgeSettings => edgeSettings(env);
