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
// attributes are the line's checked values and nothing else, a point on the
// request-duration histogram labelled with some of them, and a log record
// whose body is the line's checked fields (PR 2c). All three are the API's
// no-ops, recorded and sent nowhere, until an operator names a collector
// (OTEL_EXPORTER_OTLP_ENDPOINT, or a signal's own variable), when
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

/** The SDK, once startTelemetry has set it up; `starting` while it loads, so a second call waits on the first; `generation`, so a stop during a start wins. */
let sdk: import("./otel-setup.ts").Telemetry | undefined;
let starting: Promise<boolean> | undefined;
let generation = 0;
let stopping: Promise<void> | undefined;

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

/** The span name and status a request's checked fields give, and its attributes — the line's values, under the HTTP and MCP conventions' names. */
function spanOf(c: CheckedRecord, refusedAtKey: boolean): { name: string; error: boolean; attributes: otel.Attributes } {
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
  // (review pass 6: a keyless caller could count any tool's executions). The key's refusal is the route's word,
  // not a code: a plugin may refuse with UNAUTHORIZED or BUSY of its own, and its call ran (review pass 7).
  const named = mcpMethod === "tools/call" && tool !== undefined;
  const toolCall = named && c.outcome !== "unrun" && !refusedAtKey;
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

/** The span attributes the request-duration histogram is labelled with (labelsOf): no agent, no trace, no code but a fault's. */
const METRIC_KEYS = ["http.request.method", "http.route", "http.response.status_code", "error.type", "mcp.method.name", "ob1.door", "ob1.rpc", "ob1.tool", "ob1.outcome"] as const;

/**
 * The request-duration histogram's labels, from the span's attributes, each
 * from a set the server's own words bound (review pass 3): `error.type` a
 * fault's code (`FAILED`, `STORE_UNAVAILABLE`), else what the span would say
 * without a code (its outcome, or its status) — never a refusal's code, which
 * a plugin's webhook may take from its sender, minting a series per delivery
 * until the SDK's limit swallows every new one — and no `ob1.tool` for a
 * request refused at its key, on either door: that refusal is the key's, not
 * the tool's, and counted under the tool any caller could raise any tool's
 * refusal rate. The span keeps both.
 */
function labelsOf(attributes: otel.Attributes, fields: CheckedRecord, refusedAtKey: boolean): otel.Attributes {
  const labels: otel.Attributes = {};
  for (const key of METRIC_KEYS) if (attributes[key] !== undefined) labels[key] = attributes[key];
  if (labels["error.type"] !== undefined && !(fields.code !== undefined && FAULT_CODES.has(fields.code))) {
    labels["error.type"] = fields.outcome !== undefined && fields.outcome !== "ok" ? fields.outcome : String(fields.status);
  }
  if (refusedAtKey) delete labels["ob1.tool"];
  return labels;
}

/**
 * The request-duration histogram's bounds, in seconds: the HTTP conventions'
 * advice, and on past ten seconds — a capture through a local model takes
 * several, an MCP answer's stream or a job's can take minutes — to the
 * keepalive's ceiling, 600 s, where a stream still running is `stalled`
 * (sse.ts; review pass 1).
 */
const DURATION_BOUNDS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10, 30, 60, 300, 600];

/** The histogram, made again whenever the API's meter provider is another (the SDK set up, or a suite's stopped). */
let durations: { provider: otel.MeterProvider; histogram: otel.Histogram } | undefined;
function durationHistogram(): otel.Histogram {
  const provider = otel.metrics.getMeterProvider();
  if (durations?.provider !== provider) {
    durations = {
      provider,
      histogram: provider.getMeter("ob1").createHistogram("http.server.request.duration", {
        unit: "s",
        description: "How long each request took, to its answer or its stream's end (SMD-1849)",
        advice: { explicitBucketBoundaries: DURATION_BOUNDS },
      }),
    };
  }
  return durations.histogram;
}

/**
 * A fault's kind and code, for its span — never its message, which can carry
 * a URL, a key or a thought's text (SMD-2310's note; 2b review pass 5): an
 * Error's `name` where it is spelled as one (`TypeError`, `PostgresError`),
 * what was thrown where it was no Error (`string`), and a code it carries
 * where that is spelled as one — a Postgres error's SQLSTATE, which Bun's SQL
 * keeps in `errno` (`23505`; its `code` is the driver's own,
 * `ERR_POSTGRES_SERVER_ERROR`, for every server error), else its `code`: a
 * network error's (`ECONNREFUSED`), the driver's, a status.
 */
export function faultOf(err: unknown): { kind: string; code?: string } {
  // Each read in a guard of its own: what was thrown can throw as it is read (a Proxy, a getter), and this runs in
  // the catch that ends a call — a throw out of it would leave the call unended and its line `unrun` (review pass 1);
  // a code that throws leaves the kind that did not (review pass 2).
  let kind = "?";
  try {
    const name = err instanceof Error ? (err as { name?: unknown }).name : undefined;
    kind = err instanceof Error ? (typeof name === "string" && /^[A-Z][A-Za-z0-9]{0,63}$/.test(name) ? name : "?") : err === null ? "null" : typeof err;
  } catch {}
  let code: string | undefined;
  try {
    const { errno, code: raw } = typeof err === "object" && err !== null ? (err as { errno?: unknown; code?: unknown }) : {};
    code = typeof errno === "string" && /^[0-9A-Z]{5}$/.test(errno) ? errno
      : typeof raw === "string" && /^[A-Z0-9][A-Z0-9_]{1,47}$/.test(raw) ? raw
      : typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < 1_000_000 ? String(raw) : undefined;
  } catch {}
  return code === undefined ? { kind } : { kind, code };
}

/** A fault on a span: an `exception` event with its kind and code (faultOf), and nothing of its message or stack. */
function markFault(span: otel.Span, err: unknown): void {
  const { kind, code } = faultOf(err);
  span.addEvent("exception", code === undefined ? { "exception.type": kind } : { "exception.type": kind, "ob1.fault.code": code });
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
  /** Set where the request was refused at its key, before any tool could run (the MCP route's refusal, a keyed mirror's, the REST core's). */
  refusedAtKey = false;
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

  /** Marks a fault on the request's span, by its kind and code alone (faultOf) — a webhook's, whose request has no tool span (PR 2c). */
  fault(err: unknown): void {
    if (!this.done) markFault(this.span, err);
  }

  /**
   * Writes the line, once, with what the record holds and what `fields` adds;
   * later calls do nothing. `at` is when the request ended (performance.now()),
   * now unless the caller noted it before work of its own, so `ms` is the
   * request's time, not the log's.
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
      // The span, the histogram's point and the log record whatever the line's sink does.
      const fields = checked(record);
      const span = spanOf(fields, this.refusedAtKey);
      this.span.updateName(span.name);
      this.span.setAttributes(span.attributes);
      if (span.error) this.span.setStatus({ code: otel.SpanStatusCode.ERROR });
      this.span.end(at);
      // Never the request's undoing: an SDK that throws here loses its point and its record, not the request (PR 2c).
      try {
        durationHistogram().record(Math.max(0, at - this.started) / 1000, labelsOf(span.attributes, fields, this.refusedAtKey));
        if (sdk) {
          const body: Record<string, string | number> = {};
          for (const [key, value] of Object.entries(fields)) if (value !== undefined) body[key] = value;
          sdk.emit({ body, severity: span.error ? "ERROR" : fields.outcome === undefined || fields.outcome === "ok" ? "INFO" : "WARN", context: this.context, at });
        }
      } catch {}
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
  /** Marks what the call threw on its span, by its kind and code alone (faultOf), before it ends (PR 2c). */
  fault(err: unknown): void;
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
    fault: (err) => {
      if (!done) markFault(span, err);
    },
  };
  OPEN_TOOLS.add(handle);
  try {
    const value = await otel.context.with(otel.trace.setSpan(parent, span), () => fn(handle));
    handle.end("ok");
    return value;
  } catch (err) {
    handle.fault(err);
    handle.end("error");
    throw err;
  }
}

/** The exporter and protocol values the OpenTelemetry SDKs name, which a line may echo; any other is not shown. */
const KNOWN_SETTINGS: ReadonlySet<string> = new Set(["otlp", "none", "console", "prometheus", "zipkin", "jaeger", "logging", "grpc", "http/protobuf", "http/json"]);

/** Each signal: its name, what a line calls what it sends, and its part of the variables' names. */
const SIGNALS = [["traces", "spans", "TRACES"], ["metrics", "metrics", "METRICS"], ["logs", "log records", "LOGS"]] as const;

/** Words as a sentence lists them: `a`, `a and b`, `a, b and c`. */
const listed = (words: readonly string[], last: "and" | "or") => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} ${last} ${words[words.length - 1]}`);

/** Where each signal goes, by startTelemetry's reading of the environment: each signal's URL, the lines that say why one goes nowhere, and where the others go. */
export interface TelemetryPlan {
  urls: Partial<Record<"traces" | "metrics" | "logs", string>>;
  lines: string[];
  goes: { variable: string; origin: string; words: string[] }[];
}

/**
 * Where each signal goes (PR 2c): to its own endpoint
 * (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, …_METRICS_…, …_LOGS_…) as given, else
 * to OTEL_EXPORTER_OTLP_ENDPOINT with the signal's path (`/v1/traces`), as the
 * SDK's variables say; nowhere with neither. A signal named somewhere goes
 * nowhere under OTEL_SDK_DISABLED=true or its own exporter's `none`
 * (OTEL_TRACES_EXPORTER, OTEL_METRICS_EXPORTER, OTEL_LOGS_EXPORTER), where
 * the URL it would be sent to is no http(s) URL, or where the shared endpoint
 * has a query string or a fragment, which the signal's path would follow —
 * each said in a line, by the variable's name, never its value. Only `otlp`
 * and `none` of an exporter's values are read (a list that names `none` is
 * off), and only OTLP/HTTP JSON is sent: any other exporter or protocol asked
 * for is said, and the signal goes as OTLP/HTTP JSON (review pass 1). Each
 * value is read trimmed, a blank one as unset, and an endpoint with
 * whitespace inside is no URL (review pass 2).
 */
export function planTelemetry(env: Record<string, string | undefined> = process.env): TelemetryPlan {
  const plan: TelemetryPlan = { urls: {}, lines: [], goes: [] };
  // A value is read trimmed, and one that is blank is unset (review pass 2: a trailing space after a path was sent to `/%20/…`).
  const read = (name: string) => env[name]?.trim() || undefined;
  const named = SIGNALS.flatMap(([signal, word, part]) => {
    const own = `OTEL_EXPORTER_OTLP_${part}_ENDPOINT`;
    const variable = read(own) ? own : read("OTEL_EXPORTER_OTLP_ENDPOINT") ? "OTEL_EXPORTER_OTLP_ENDPOINT" : undefined;
    return variable === undefined ? [] : [{ signal, word, part, variable }];
  });
  if (named.length === 0) return plan;
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") {
    const variables = [...new Set(named.map((n) => n.variable))];
    plan.lines.push(`telemetry: ${listed(variables, "and")} ${variables.length === 1 ? "is" : "are"} set, but OTEL_SDK_DISABLED=true: no ${listed(named.map((n) => n.word), "or")} are sent (SMD-1849)`);
    return plan;
  }
  const nowhere = new Map<string, string[]>();
  const unread = new Map<string, string[]>();
  const somewhere = new Map<string, { variable: string; origin: string; words: string[] }>();
  const add = (map: Map<string, string[]>, key: string, word: string) => map.set(key, [...(map.get(key) ?? []), word]);
  // A value echoed only where it is a setting the SDKs know (`console`, `grpc`, a list of them): another may be a
  // secret pasted into the wrong variable, and is named by its variable alone (review passes 3–4).
  const quoted = (value: string) => (value.toLowerCase().split(",").every((v) => KNOWN_SETTINGS.has(v.trim())) ? JSON.stringify(value) : "(a value not shown)");
  for (const { signal, word, part, variable } of named) {
    const endpoint = read(variable)!;
    const shared = variable === "OTEL_EXPORTER_OTLP_ENDPOINT";
    // The URL the exporter is handed, checked itself: a base the parser forgives can make one it does not (review pass 1).
    const target = shared ? `${endpoint.replace(/\/?$/, "/")}v1/${signal}` : endpoint;
    let url: URL | undefined;
    try {
      url = new URL(target);
    } catch {}
    // An exporter is a list (`otlp,console`): one that names `none` is off, as the SDK's own reading has it (review pass 2).
    const exporterValue = read(`OTEL_${part}_EXPORTER`);
    const exporters = (exporterValue ?? "").toLowerCase().split(",").map((e) => e.trim()).filter((e) => e !== "");
    const why = exporters.includes("none") ? `${variable} is set, but OTEL_${part}_EXPORTER=none`
      : url === undefined || (url.protocol !== "http:" && url.protocol !== "https:") || /\s/.test(endpoint) ? `${variable} is not an http(s) URL`
      : shared && /[?#]/.test(endpoint) ? `${variable} has a query string or a fragment, which the signal's path would follow` : undefined;
    // No URL is always a why (no http(s) URL), so past this a URL is there.
    if (why !== undefined || url === undefined) {
      add(nowhere, why!, word);
      continue;
    }
    if (exporters.some((e) => e !== "otlp")) add(unread, `OTEL_${part}_EXPORTER ${quoted(exporterValue!)} is not read (only otlp or none)`, word);
    const protocolVariable = read(`OTEL_EXPORTER_OTLP_${part}_PROTOCOL`) ? `OTEL_EXPORTER_OTLP_${part}_PROTOCOL` : "OTEL_EXPORTER_OTLP_PROTOCOL";
    const protocol = read(protocolVariable);
    if (protocol && protocol.toLowerCase() !== "http/json") add(unread, `${protocolVariable} ${quoted(protocol)} is not read`, word);
    plan.urls[signal] = target;
    const key = `${variable} ${url.origin}`;
    const goes = somewhere.get(key) ?? { variable, origin: url.origin, words: [] };
    goes.words.push(word);
    somewhere.set(key, goes);
  }
  for (const [why, words] of nowhere) plan.lines.push(`telemetry: ${why}: no ${listed(words, "or")} are sent (SMD-1849)`);
  for (const [what, words] of unread) plan.lines.push(`telemetry: ${what}: ${listed(words, "and")} go as OTLP/HTTP JSON (SMD-1849)`);
  plan.goes = [...somewhere.values()];
  return plan;
}

/**
 * Sets up the OpenTelemetry SDK where an operator names a collector — on Bun
 * only: a server calls it where it serves on Bun, and Workers' bundle aliases
 * otel-setup.ts to a stub (wrangler.toml). Each signal goes where
 * planTelemetry says, and what goes nowhere is said, by planTelemetry's lines.
 * Says where the rest go — the variable and the endpoint's origin alone, so a
 * credential in it stays out of the log — or that its SDK could not be loaded
 * or set up, by the error's name alone (a message can carry the URL). A
 * request that arrives before the SDK has loaded (tens of milliseconds) has a
 * no-op span; one that also ends before has no point and no log record, and
 * one that ends after has both, with no trace id, as its line has none (review
 * pass 3). `load` is otel-setup.ts but for a suite. Returns whether it set one
 * up.
 */
export function startTelemetry(
  serviceName: string,
  log: (line: string) => void = (line) => console.warn(line),
  load: () => Promise<Pick<typeof import("./otel-setup.ts"), "setUpTelemetry">> = () => import("./otel-setup.ts"),
): Promise<boolean> {
  if (starting) return starting;
  const plan = planTelemetry();
  for (const line of plan.lines) log(line);
  if (plan.goes.length === 0) return Promise.resolve(false);
  const own = generation;
  // After a stop still in progress, so this start's SDK is never the one it shuts down (review pass 7).
  starting = (stopping ?? Promise.resolve()).then(load).then(async ({ setUpTelemetry }) => {
    const set = setUpTelemetry(serviceName, { report: { warn: log }, urls: plan.urls });
    // A stop came while this loaded: this start is not the SDK's, and goes before the stop returns (review passes 6–7).
    if (own !== generation) {
      await set.shutdown();
      return undefined;
    }
    sdk = set;
    return set;
  }).catch((err: unknown) => {
    // The import's failure or the setup's, a server that serves either way (review pass 4: a throw in the setup killed it).
    log(`telemetry: not started (${err instanceof Error ? err.name : "error"}): no ${listed(plan.goes.flatMap((g) => g.words), "or")} are sent (SMD-1849)`);
    return undefined;
  }).then((set) => {
    // Said outside the guard, of this start's own SDK: a sink that throws here leaves it running, and is not read as a failed start (review pass 5).
    if (set) {
      try {
        for (const goes of plan.goes) log(`telemetry: ${labelPart(set.serviceName)}'s ${listed(goes.words, "and")} go to ${goes.origin} over OTLP/HTTP (${goes.variable}, SMD-1849)`);
      } catch {}
    }
    return set !== undefined;
  });
  return starting;
}

/**
 * Shuts the SDK down and forgets its start, so a suite can start it again;
 * spans are no-ops after. A start still loading is waited for, its own SDK
 * shut down before this returns, and a start made meanwhile waits for this.
 */
export async function stopTelemetry(): Promise<void> {
  generation += 1;
  const loading = starting;
  starting = undefined;
  const stop = (async () => {
    await loading;
    await sdk?.shutdown();
    sdk = undefined;
  })();
  stopping = stop;
  try {
    await stop;
  } finally {
    if (stopping === stop) stopping = undefined;
  }
}

/**
 * Sends what each signal still holds — the spans and log records batched, the
 * metrics' last reading — and waits for what is on its way: how that ended,
 * or undefined with no collector set. A server's stop runs it beside closing
 * its pool, under the pool's bound, and says which (shutdown.ts).
 */
export async function flushTelemetry(): Promise<FlushResult | undefined> {
  return sdk?.flush();
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
 * still in flight at its bound, and again just before its flush on every
 * path, for a record the runtime no longer counts (a client gone while its
 * handler waits). Each keeps the status its answer had, or 0 where there was
 * none yet. One whose client was already gone is `abandoned`, as the
 * middleware would have said had its handler returned first.
 */
export function cutOpenRequests(): void {
  // A tool call still running is cut with it: its span ends too, so the export carries it (review pass 1).
  for (const call of [...OPEN_TOOLS]) call.end("cut");
  // Each ended alone: a sink that throws on one leaves the rest to end, and the stop to flush and exit (review pass 3).
  for (const trace of [...OPEN]) {
    try {
      trace.end({ outcome: trace.clientGone ? "abandoned" : "cut" });
    } catch {}
  }
}
