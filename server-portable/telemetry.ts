// What the servers say about their requests (SMD-1849): one JSON line per
// request, on every route of both servers (the keyless liveness probe aside),
// built here and nowhere else, so what may be said is decided once.
//
// The brain is personal data, and a connector carries its key in `?key=`; so a
// line never holds the URL, its query string, a header, a key, a body, an
// argument, a thought's text or a search's — the query log (migration 034) is
// where search text lives, behind its own switch and retention, and this does
// not keep a second copy. What it holds is the allow-list below, each value
// checked against its own rule as the line is written, so a caller's string
// that reaches a field by mistake is `?`, not the string.
//
// Lines go to stdout, which compose's log rotation bounds (deploy/compose.yaml,
// x-logging). Each request is also an OpenTelemetry span (PR 2b), whose
// attributes are the line's checked values and nothing else; the spans are
// the API's no-ops, recorded and sent nowhere, until an operator names a
// collector (OTEL_EXPORTER_OTLP_ENDPOINT or its traces variable), when
// startTelemetry loads the SDK (otel-setup.ts). Nothing here sends anything
// anywhere on its own.

import * as otel from "@opentelemetry/api";
import type { FlushResult } from "./shutdown.ts";
import { TOOLS } from "./tools.ts";
import { labelPart } from "./sse.ts";

/** Which server answered: the MCP server, or the REST core. */
export type Door = "mcp" | "api";

/**
 * How a request ended — on every line of both doors, so one question ("what
 * did not end ok") is one filter. An MCP tool call is a 200 whatever the tool
 * said, so a request that asked for a tool says the tool's end:
 * - `ok`: the tool answered;
 * - `refused`: it answered with a refusal as a value (a code, as render.ts
 *   says it), or the request was refused at its key — any request, whatever
 *   its method and status;
 * - `error`: the tool threw and its reply is the fault, or the route itself
 *   threw or had no answer (a 500);
 * - `unrun`: a tool call that never ran to an end — the transport refused the
 *   request (a 4xx, or a 5xx of its own), the SDK its input, the key's scope
 *   does not register the tool, or it was sent as a notification (no `id`),
 *   which the transport answers 202 and never runs;
 * - `abandoned`: the client left before a stream ended (an MCP answer, either
 *   job stream) or before any other answer was handed over — the call
 *   itself runs on to its end, which this line does not say;
 * - `cut`: the server's stop closed it while its client was still there, on
 *   either server (one already gone is `abandoned`);
 * - `stalled`: a stream still running at the keepalive's ceiling (sse.ts);
 *   the line is written then, and its own end writes none.
 * A batch's line says its worst call's: error, then refused, unrun, ok. Any
 * other request — an `initialize`, a `tools/list`, a mirror, every REST
 * request — says its answer's (outcomeOf), unless the middleware or the
 * handler says otherwise: a keyed mirror that shows a caller nothing is
 * `refused` (the handler's RequestTrace.outcome: for a key missing, wrong or
 * out of scope, and for one the registry did not clear, with REVOKED or BUSY
 * where it said which), and a mirror's fault answered 200 is `error`; or
 * `abandoned`, `cut` or, for a job stream, `stalled`.
 */
export type RequestOutcome = "ok" | "refused" | "error" | "unrun" | "abandoned" | "cut" | "stalled";

/** The codes a fault is answered with — `failure()`'s, and capture's retryable one — as against a refusal's. */
const FAULT_CODES: ReadonlySet<string> = new Set(["FAILED", "STORE_UNAVAILABLE"]);

/**
 * A request's outcome from its status and its answer's code, for one that
 * called no tool: `error` for a fault — a 5xx whose code is a fault's, or that
 * has none — `refused` for any other 4xx or 5xx (a 503 BUSY is a refusal for
 * now, as the MCP server says it), and `ok` for anything else.
 */
export function outcomeOf(status: number, code?: string): RequestOutcome {
  if (status < 400) return "ok";
  return status >= 500 && (code === undefined || FAULT_CODES.has(code)) ? "error" : "refused";
}

/** One request, as its line says it: these keys and no other, in this order. */
export interface RequestRecord {
  door: Door;
  /** The HTTP method. */
  method: string;
  /** The route as a template, never the path it was given: the REST core's (`/v1/thoughts/:id`), or an MCP server mirror's (`/jobs/:id/stream`). */
  route?: string;
  /** The MCP server's JSON-RPC method (`tools/call`), or `batch` for a body of several messages. */
  rpc?: string;
  /** The tool: an MCP tool call's, the operation a REST route runs, or the tool a mirror mirrors. */
  tool?: string;
  /** The configured name of the key that authenticated — never the key. */
  agent?: string;
  status: number;
  outcome?: RequestOutcome;
  /** A refusal's or a fault's code (`NOT_FOUND`, `FAILED`), the MCP server's from the tool's reply or the key, the REST core's from its error answer. */
  code?: string;
  /** Milliseconds from the request's arrival to its end: a stream's end (an MCP answer, a job stream); any other answer's handing over. */
  ms: number;
  /** The bytes of the answer's body, where the server counted them: a stream's (an MCP answer, either job stream). */
  bytes?: number;
  /** The W3C trace id the request's span has — a continued `traceparent`'s, or its own — or, with no collector set, an incoming `traceparent`'s. */
  trace?: string;
}

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"]);
/**
 * The JSON-RPC methods an MCP client sends this server (the 2025-06-18
 * schema's, client to server), and `batch`, which the MCP server writes for a
 * body of several messages; any other is `other`.
 */
const RPC_METHODS = new Set([
  "batch", "initialize", "ping", "tools/list", "tools/call", "resources/list", "resources/templates/list", "resources/read",
  "resources/subscribe", "resources/unsubscribe", "prompts/list", "prompts/get", "completion/complete", "logging/setLevel",
  "notifications/initialized", "notifications/cancelled", "notifications/progress", "notifications/roots/list_changed",
]);
const TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((t) => t.name));
/** The enabled plugins' tool names (SMD-2310), known beside the core's once a server loads them (knowTools). */
const PLUGIN_TOOLS = new Set<string>();

/** Adds the tools a server serves beyond the core's — its enabled plugins' operations — to the names a line may hold. */
export function knowTools(names: Iterable<string>): void {
  for (const name of names) PLUGIN_TOOLS.add(name);
}
const OUTCOMES: ReadonlySet<string> = new Set<RequestOutcome>(["ok", "refused", "error", "unrun", "abandoned", "cut", "stalled"]);
/** A route template — the REST core's path pattern, or an MCP server mirror's — segments of letters, digits, `_`, `-`, `.` and `:name`. */
const ROUTE = /^(?:\/[A-Za-z0-9_.:-]+)+$|^\/$/;
/** A refusal's or a fault's code: the core's enum spelling. */
const CODE = /^[A-Z][A-Z0-9_]{0,47}$/;
/** A W3C trace id: 32 lower-case hex digits, not all zero. */
const TRACE_ID = /^(?!0{32})[0-9a-f]{32}$/;

const count = (n: number | undefined): number | undefined => (n === undefined || !Number.isFinite(n) || n < 0 ? undefined : Math.round(n));

const known = (v: string | undefined, set: ReadonlySet<string>, other = "?") => (v === undefined ? undefined : set.has(v) ? v : other);
const spelled = (v: string | undefined, rule: RegExp) => (v === undefined ? undefined : rule.test(v) ? v : "?");
/** A tool's name held to the manifest's and the enabled plugins' (`?` for any other). */
const toolName = (v: string | undefined) => (v !== undefined && PLUGIN_TOOLS.has(v) ? v : known(v, TOOL_NAMES));

/** A record's fields, each held to its rule: what a line, and a span, may say of a request. */
type CheckedRecord = ReturnType<typeof checked>;

/**
 * A record's fields in RequestRecord's order, each held to its rule — a
 * method, an RPC method, a tool and an outcome to their known sets, a route,
 * a code and a trace id to their spellings, the agent's name to printable
 * ASCII of at most 64 characters, numbers to non-negative integers; what
 * fails its rule is `?` (a trace id that fails is left out), and an absent
 * field is undefined. The line and the span read these, never the record's
 * own strings, which a caller may have put there (the tool a body names, the
 * method a request says).
 */
function checked(r: RequestRecord) {
  return {
    door: r.door === "api" ? "api" as const : "mcp" as const,
    method: known(r.method, METHODS),
    route: spelled(r.route, ROUTE),
    rpc: known(r.rpc, RPC_METHODS, "other"),
    tool: toolName(r.tool),
    agent: r.agent === undefined ? undefined : labelPart(r.agent),
    status: count(r.status) ?? 0,
    outcome: known(r.outcome, OUTCOMES) as RequestOutcome | "?" | undefined,
    code: spelled(r.code, CODE),
    ms: count(r.ms) ?? 0,
    bytes: count(r.bytes),
    trace: r.trace !== undefined && TRACE_ID.test(r.trace) ? r.trace : undefined,
  };
}

/** The line for a request: JSON with `ts` first, then its checked fields (an absent one left out). */
export function requestLine(r: RequestRecord, now: Date = new Date()): string {
  return JSON.stringify({ ts: now.toISOString(), ...checked(r) });
}

let sink: (line: string) => void = (line) => console.log(line);

/** Writes the request's line. */
export function logRequest(r: RequestRecord): void {
  sink(requestLine(r));
}

/** Where request lines go — stdout unless a suite listens; returns the sink it replaced. */
export function useRequestLog(next: (line: string) => void): (line: string) => void {
  const previous = sink;
  sink = next;
  return previous;
}

/** What a request's record is told on its way: every RequestRecord field but the door, the method, the time and the trace id, which the record keeps itself. */
export type RequestFields = Partial<Omit<RequestRecord, "door" | "method" | "ms" | "trace">>;

/**
 * The tracer every span here comes from: the API's no-op until otel-setup.ts
 * registers a provider. Read each time: a suite's shutdown (trace.disable())
 * replaces the API's proxy, so a tracer held from before would miss the next
 * provider.
 */
const tracer = () => otel.trace.getTracer("ob1");

/**
 * A request's `traceparent` for the W3C propagator, and nothing else: the
 * propagator would also carry a client's `tracestate` — its text — on every
 * span to the collector (review pass 1).
 */
const HEADERS: otel.TextMapGetter<Headers> = { get: (h, key) => (key === "traceparent" ? h.get(key) ?? undefined : undefined), keys: () => ["traceparent"] };

/** Whether a caller's `traceparent` is continued: only where the operator says its proxy sets it. */
const trustsTraceparent = () => process.env.OB1_OTEL_TRUST_TRACEPARENT === "1";

/**
 * A trusted incoming `traceparent`'s trace id, for the line when no collector is set,
 * read as the W3C propagator reads one: version `ff` invalid, version `00`
 * exactly four fields, a later version more; no id of all zeros.
 */
function incomingTrace(header: string | null): string | undefined {
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}(-.*)?$/.exec(header ?? "");
  if (!m || m[1] === "ff" || (m[1] === "00" && m[4] !== undefined) || /^0+$/.test(m[2]) || /^0+$/.test(m[3])) return undefined;
  return m[2];
}

/** The codes a request is refused with at its key, before any tool runs. */
const KEY_REFUSALS: ReadonlySet<string> = new Set(["UNAUTHORIZED", "REVOKED", "BUSY", "AUTH_UNREACHABLE"]);

/** The span name and status a request's checked fields give, and its attributes — the line's values, under the HTTP and MCP conventions' names. */
function spanOf(c: CheckedRecord): { name: string; error: boolean; attributes: otel.Attributes } {
  // A status the client was handed: none for one gone first, or cut by the
  // stop — a 408, a REST body read's 500, a 0 are the line's names for that,
  // not answers anyone received.
  const answered = c.status > 0 && c.outcome !== "abandoned" && c.outcome !== "cut";
  const error = (answered && c.status >= 500) || c.outcome === "error" || c.outcome === "stalled" || c.outcome === "cut";
  const method = c.method === "?" ? "_OTHER" : c.method;
  const route = c.route === "?" ? undefined : c.route;
  const tool = c.tool === "?" ? undefined : c.tool;
  const mcpMethod = c.rpc === "batch" || c.rpc === "other" ? undefined : c.rpc;
  // A tools/call names its tool; it is an execution only where the call ran — not refused at its key, not unrun
  // (review pass 6: a keyless caller could count any tool's executions).
  const named = mcpMethod === "tools/call" && tool !== undefined;
  const toolCall = named && c.outcome !== "unrun" && !(c.code !== undefined && KEY_REFUSALS.has(c.code));
  const name = mcpMethod !== undefined ? (named ? `${mcpMethod} ${tool}` : mcpMethod)
    : `${method === "_OTHER" ? "HTTP" : method}${route !== undefined ? ` ${route}` : ""}`;
  return {
    name,
    error,
    attributes: {
      "http.request.method": method,
      "http.route": route,
      "http.response.status_code": answered ? c.status : undefined,
      "http.response.body.size": c.bytes,
      "mcp.method.name": mcpMethod,
      // A tool call's, under the MCP conventions' names too: the operation's
      // name here alone, not on the call's own span, so a backend counting
      // tool executions counts a single MCP call once (review pass 2); a REST
      // operation's and a batch's calls carry none.
      "gen_ai.operation.name": toolCall ? "execute_tool" : undefined,
      "gen_ai.tool.name": toolCall ? tool : undefined,
      "ob1.door": c.door,
      // Only what mcp.method.name cannot say: a batch, or a method outside the schema's.
      "ob1.rpc": mcpMethod === undefined ? c.rpc : undefined,
      "ob1.tool": tool,
      "ob1.agent": c.agent,
      "ob1.outcome": c.outcome,
      "ob1.code": c.code,
      "error.type": error ? c.code ?? (c.outcome !== undefined && c.outcome !== "ok" ? c.outcome : String(c.status)) : undefined,
    },
  };
}

/** The records not yet ended, so the stop can end each (cutOpenRequests). */
const OPEN = new Set<RequestTrace>();
/** Each request's record, by the Request object both a server's middleware and its handlers hold. */
const RECORDS = new WeakMap<Request, RequestTrace>();

/**
 * One request, from its arrival to its line (SMD-1849 PR 2a): the one record
 * a server's first middleware makes for every request it is handed but the
 * keyless liveness probe (notFound makes one for a path it never sees), filled
 * in by the handler that serves it — the route, the tool, the key's name —
 * and ended exactly once, where the request ends. The middleware ends it when
 * the handler returns; a handler whose answer outlives it (a stream) marks it
 * `deferred` and ends it itself, at the stream's end. A second `end` does
 * nothing, so every request has one line and no more. The record is the
 * request's span too (PR 2b): started with it, its handlers run under it
 * (`run`), and ended with the line, from the line's checked values.
 */
export class RequestTrace {
  /** When the request arrived (performance.now()). */
  readonly started = performance.now();
  route?: string;
  rpc?: string;
  tool?: string;
  agent?: string;
  /** The answer's status, once there is one (0 before). */
  status = 0;
  /**
   * How the request ended, when its handler knows better than the answer's
   * status says — a keyed mirror whose key the registry did not clear answers
   * `ok`, a 200, and is `refused` — with its code; the middleware takes these
   * over the status's.
   */
  outcome?: RequestOutcome;
  code?: string;
  /** Set by a handler whose answer outlives it: the middleware leaves the end to it. */
  deferred = false;
  private done = false;
  /** The request's server span, and the context its handlers run in (run). */
  private readonly span: otel.Span;
  private readonly context: otel.Context;
  /** The trace id an incoming `traceparent` names, for the line when the span has none of its own. */
  private readonly incoming?: string;

  constructor(readonly door: Door, readonly method: string, private readonly write: (r: RequestRecord) => void, private readonly signal: AbortSignal, headers: Headers) {
    OPEN.add(this);
    // A caller's traceparent is its own choice: continued, it would pick this
    // request's trace — joining any trace it knows, colliding with another
    // request's line, deciding the ratio sampler — so by default the request
    // starts its own trace and links the caller's, as OpenTelemetry advises
    // for a public endpoint; an operator whose proxy sets the header trusts it
    // (OB1_OTEL_TRUST_TRACEPARENT=1) and it is continued (review pass 6).
    const remote = otel.propagation.extract(otel.ROOT_CONTEXT, headers, HEADERS);
    const trusted = trustsTraceparent();
    const parent = trusted ? remote : otel.ROOT_CONTEXT;
    const caller = trusted ? undefined : otel.trace.getSpanContext(remote);
    this.incoming = trusted ? incomingTrace(headers.get("traceparent")) : undefined;
    const name = METHODS.has(method) ? method : "?";
    this.span = tracer().startSpan(name === "?" ? "HTTP" : name, {
      kind: otel.SpanKind.SERVER,
      startTime: this.started,
      attributes: { "http.request.method": name === "?" ? "_OTHER" : name, "ob1.door": door },
      links: caller && otel.isSpanContextValid(caller) ? [{ context: caller }] : undefined,
    }, parent);
    this.context = otel.trace.setSpan(parent, this.span);
  }

  /** The request's trace id: its span's, or, where no collector is set, a trusted incoming `traceparent`'s. */
  get traceId(): string | undefined {
    const own = this.span.spanContext();
    return otel.isSpanContextValid(own) ? own.traceId : this.incoming;
  }

  /** Runs `fn` with the request's span current, so a tool's span (withToolSpan) is its child. */
  run<T>(fn: () => T): T {
    return otel.context.with(this.context, fn);
  }

  /** Whether the client is gone: its request's signal aborted. */
  get clientGone(): boolean {
    return this.signal.aborted;
  }

  /** Whether the line is written. */
  get ended(): boolean {
    return this.done;
  }

  /**
   * Writes the line, once, with what the record holds and what `fields` adds;
   * later calls do nothing. `at` is when the request ended (performance.now()),
   * now unless the caller noted it before work of its own — the middleware's
   * read of an error answer's code — so `ms` is the request's time, not the log's.
   */
  end(fields: RequestFields = {}, at: number = performance.now()): void {
    if (this.done) return;
    this.done = true;
    OPEN.delete(this);
    const { route, rpc, tool, agent, status, outcome, code } = this;
    const record: RequestRecord = { door: this.door, method: this.method, route, rpc, tool, agent, status, outcome, code, ...fields, ms: at - this.started, trace: this.traceId };
    try {
      this.write(record);
    } finally {
      // The span ends whatever the line's sink does.
      const span = spanOf(checked(record));
      this.span.updateName(span.name);
      this.span.setAttributes(span.attributes);
      if (span.error) this.span.setStatus({ code: otel.SpanStatusCode.ERROR });
      this.span.end(at);
    }
  }
}

/**
 * One tool call's span, a child of its request's (PR 2b): `execute_tool
 * <tool>`, its tool's name held to the manifest's (`gen_ai.tool.name`), ended
 * once with how the call ended — the outcomes a call can have — and its code.
 * Its name is held to the manifest's tools and the enabled plugins'.
 */
export interface ToolSpan {
  end(outcome: "ok" | "refused" | "error" | "cut", code?: string): void;
}

/** The tool calls' spans not yet ended, so the stop's cut ends them with their requests (cutOpenRequests). */
const OPEN_TOOLS = new Set<ToolSpan>();

/**
 * Runs one tool call under its own span, current while it runs (so what the
 * call starts is its child): `fn` ends it with how the call ended; one that
 * throws first ends it as an error, and one that returns without ending it
 * ends it `ok`.
 */
export async function withToolSpan<T>(tool: string, fn: (span: ToolSpan) => Promise<T>): Promise<T> {
  const name = toolName(tool) ?? "?";
  const parent = otel.context.active();
  const span = tracer().startSpan(`execute_tool ${name}`, {
    kind: otel.SpanKind.INTERNAL,
    attributes: { "gen_ai.tool.name": name },
  }, parent);
  let done = false;
  const handle: ToolSpan = {
    end: (outcome, code) => {
      if (done) return;
      done = true;
      OPEN_TOOLS.delete(handle);
      const checkedCode = spelled(code, CODE);
      span.setAttributes({ "ob1.outcome": outcome, "ob1.code": checkedCode });
      // A fault, or a call the stop cut off, as a request's span says either.
      if (outcome === "error" || outcome === "cut") span.setAttributes({ "error.type": checkedCode ?? outcome }).setStatus({ code: otel.SpanStatusCode.ERROR });
      span.end();
    },
  };
  OPEN_TOOLS.add(handle);
  try {
    const value = await otel.context.with(otel.trace.setSpan(parent, span), () => fn(handle));
    handle.end("ok");
    return value;
  } catch (err) {
    handle.end("error");
    throw err;
  }
}

/** The SDK, once startTelemetry has set it up; `starting` while it loads, so a second call waits on the first; `generation`, so a stop during a start wins. */
let tracing: import("./otel-setup.ts").Tracing | undefined;
let starting: Promise<boolean> | undefined;
let generation = 0;

/**
 * Sets up the OpenTelemetry SDK where an operator names a collector — on Bun
 * only: a server calls it where it serves on Bun, and Workers' bundle aliases
 * otel-setup.ts to a stub (wrangler.toml). The endpoint is
 * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, else OTEL_EXPORTER_OTLP_ENDPOINT, and
 * must be an http(s) URL; OTEL_SDK_DISABLED=true or OTEL_TRACES_EXPORTER=none
 * turns it off, as the SDK's own variables do elsewhere. Says where the spans
 * go — the variable and the endpoint's origin alone, so a credential in it
 * stays out of the log — or why none are sent, or that its SDK could not be
 * loaded or set up, by the error's name alone (a message can carry the URL).
 * A request that arrives before the SDK has loaded (tens of milliseconds) has
 * a no-op span. `load` is otel-setup.ts but for a suite. Returns whether it
 * set one up.
 */
export function startTelemetry(
  serviceName: string,
  log: (line: string) => void = (line) => console.warn(line),
  load: () => Promise<Pick<typeof import("./otel-setup.ts"), "setUpTracing">> = () => import("./otel-setup.ts"),
): Promise<boolean> {
  if (starting) return starting;
  const variable = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ? "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT" : "OTEL_EXPORTER_OTLP_ENDPOINT";
  const endpoint = process.env[variable];
  if (!endpoint) return Promise.resolve(false);
  const off = process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true" ? "OTEL_SDK_DISABLED=true"
    : process.env.OTEL_TRACES_EXPORTER?.trim().toLowerCase() === "none" ? "OTEL_TRACES_EXPORTER=none" : undefined;
  if (off) {
    log(`telemetry: ${variable} is set, but ${off}: no spans are sent (SMD-1849)`);
    return Promise.resolve(false);
  }
  let origin: string | undefined;
  try {
    const url = new URL(endpoint);
    if (url.protocol === "http:" || url.protocol === "https:") origin = url.origin;
  } catch {}
  if (!origin) {
    log(`telemetry: ${variable} is not an http(s) URL: no spans are sent (SMD-1849)`);
    return Promise.resolve(false);
  }
  const where = origin;
  const own = generation;
  starting = Promise.resolve().then(load).then(({ setUpTracing }) => {
    const set = setUpTracing(serviceName, { report: { origin: where, warn: log } });
    // A stop came while this loaded: this start is not the SDK's, and goes (review pass 6).
    if (own !== generation) {
      void set.shutdown();
      return undefined;
    }
    tracing = set;
    return set;
  }).catch((err: unknown) => {
    // The import's failure or the setup's, a server that serves either way (review pass 4: a throw in the setup killed it).
    log(`telemetry: not started (${err instanceof Error ? err.name : "error"}): no spans are sent (SMD-1849)`);
    return undefined;
  }).then((set) => {
    // Said outside the guard, of this start's own SDK: a sink that throws here leaves it running, and is not read as a failed start (review pass 5).
    if (set) {
      try {
        log(`telemetry: ${labelPart(set.serviceName)}'s spans go to ${where} over OTLP/HTTP (${variable}, SMD-1849)`);
      } catch {}
    }
    return set !== undefined;
  });
  return starting;
}

/** Shuts the SDK down and forgets its start, so a suite can start it again; spans are no-ops after. A start still loading is waited for, and shuts its own SDK down. */
export async function stopTelemetry(): Promise<void> {
  generation += 1;
  const loading = starting;
  starting = undefined;
  await loading;
  await tracing?.shutdown();
  tracing = undefined;
}

/**
 * Sends the spans still batched and waits for those on their way: how that
 * ended, or undefined with no collector set. A server's stop runs it beside
 * closing its pool, under the pool's bound, and says which (shutdown.ts).
 */
export async function flushTelemetry(): Promise<FlushResult | undefined> {
  return tracing?.flush();
}

/** A request's record, made as a server's first middleware receives it; `write` is where its line goes (logRequest unless a suite says). */
export function beginRequest(door: Door, req: Request, write: (r: RequestRecord) => void = logRequest): RequestTrace {
  const trace = new RequestTrace(door, req.method, write, req.signal, req.headers);
  RECORDS.set(req, trace);
  return trace;
}

/**
 * How many records are open: a request in flight, or one whose end never
 * came — the suites hold it to where it started once their requests are done.
 */
export function openRequestCount(): number {
  return OPEN.size;
}

/** The record the middleware made for this request, if one did. */
export function traceOf(req: Request): RequestTrace | undefined {
  return RECORDS.get(req);
}

/** What a stream's keepalive (sse.ts withSseKeepalive) is handed to end a record with. */
export type StreamEnds = { onEnd: (bytes?: number) => void; onStall: () => void; onCancel: () => void };

/**
 * Ties a request's record to the event stream that answers it, for a handler
 * whose answer outlives it (a job stream): the record is deferred — the
 * middleware leaves it — and ended where the stream ends, whichever comes
 * first: `ok` with its bytes when the stream closes, `stalled` at the
 * keepalive's ceiling, or `abandoned` when the client is gone — already gone
 * as the handler gets here (a listener added to an aborted signal never
 * fires, so that is checked by hand), gone later (the signal), or the body
 * let go of with no abort (sse.ts's onCancel, how a runtime that never aborts
 * the signal says it).
 */
export function endsWithStream(trace: RequestTrace, signal: AbortSignal): StreamEnds {
  trace.deferred = true;
  trace.status = 200;
  const gone = () => trace.end({ outcome: "abandoned" });
  if (signal.aborted) gone();
  else signal.addEventListener("abort", gone, { once: true });
  return {
    onEnd: (bytes) => trace.end({ outcome: "ok", bytes }),
    onStall: () => trace.end({ outcome: "stalled" }),
    onCancel: gone,
  };
}

/**
 * Ends every record still open as `cut`: the stop's, when it closes what is
 * still in flight at its bound and the process exits next. Each keeps the
 * status its answer had, or 0 where there was none yet. One whose client was
 * already gone is `abandoned`, as the middleware would have said had its
 * handler returned first.
 */
export function cutOpenRequests(): void {
  // A tool call still running is cut with it: its span ends too, so the export carries it (review pass 1).
  for (const call of [...OPEN_TOOLS]) call.end("cut");
  for (const trace of [...OPEN]) trace.end({ outcome: trace.clientGone ? "abandoned" : "cut" });
}

/**
 * An error answer's code, for its line, where its JSON carries one: every
 * REST core 4xx and 5xx (`refuse`, a refusal's value, `failure`), and the
 * MCP server's worker actions' refusals (its /jobs 404 says only `not
 * found`, and has none), read from a copy so the answer
 * itself is untouched. A success, or a body that is not JSON or carries no
 * code, gives none; requestLine holds what it gives to the enum spelling. A
 * refused HEAD's line has its GET's code: Hono answers a HEAD as its GET and
 * drops the body after the middleware has read it.
 */
export async function errorCode(res: Response): Promise<string | undefined> {
  if (res.status < 400 || !/^application\/json\b/i.test(res.headers.get("content-type") ?? "")) return undefined;
  const body = await res.clone().json().catch(() => null) as { code?: unknown } | null;
  return typeof body?.code === "string" ? body.code : undefined;
}
