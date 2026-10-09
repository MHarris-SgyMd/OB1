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
// x-logging). Nothing here sends anything anywhere.

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
}

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
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
const OUTCOMES: ReadonlySet<string> = new Set<RequestOutcome>(["ok", "refused", "error", "unrun", "abandoned", "cut", "stalled"]);
/** A route template — the REST core's path pattern, or an MCP server mirror's — segments of letters, digits, `_`, `-`, `.` and `:name`. */
const ROUTE = /^(?:\/[A-Za-z0-9_.:-]+)+$|^\/$/;
/** A refusal's or a fault's code: the core's enum spelling. */
const CODE = /^[A-Z][A-Z0-9_]{0,47}$/;

const count = (n: number | undefined): number | undefined => (n === undefined || !Number.isFinite(n) || n < 0 ? undefined : Math.round(n));

/**
 * The line for a request: JSON with `ts` first, then the record's fields in
 * RequestRecord's order, each held to its rule — a method, an RPC method, a
 * tool and an outcome to their known sets, a route and a code to their
 * spellings, the agent's name to printable ASCII of at most 64 characters,
 * numbers to non-negative integers; what fails its rule is `?`, and an absent
 * field is left out.
 */
export function requestLine(r: RequestRecord, now: Date = new Date()): string {
  const known = (v: string | undefined, set: ReadonlySet<string>, other = "?") => (v === undefined ? undefined : set.has(v) ? v : other);
  const spelled = (v: string | undefined, rule: RegExp) => (v === undefined ? undefined : rule.test(v) ? v : "?");
  const line = {
    ts: now.toISOString(),
    door: r.door === "api" ? "api" : "mcp",
    method: known(r.method, METHODS),
    route: spelled(r.route, ROUTE),
    rpc: known(r.rpc, RPC_METHODS, "other"),
    tool: known(r.tool, TOOL_NAMES),
    agent: r.agent === undefined ? undefined : labelPart(r.agent),
    status: count(r.status) ?? 0,
    outcome: known(r.outcome, OUTCOMES),
    code: spelled(r.code, CODE),
    ms: count(r.ms) ?? 0,
    bytes: count(r.bytes),
  };
  return JSON.stringify(line);
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

/** What a request's record is told on its way: every RequestRecord field but the door, the method and the time, which the record keeps itself. */
export type RequestFields = Partial<Omit<RequestRecord, "door" | "method" | "ms">>;

/** The records not yet ended, so the stop can end each (cutOpenRequests). */
const OPEN = new Set<RequestTrace>();
/** Each request's record, by the Request object both a server's middleware and its handlers hold. */
const RECORDS = new WeakMap<Request, RequestTrace>();

/**
 * One request, from its arrival to its line (SMD-1849 PR 2a): the one record
 * a server's first middleware makes for every request it is handed, filled
 * in by the handler that serves it — the route, the tool, the key's name —
 * and ended exactly once, where the request ends. The middleware ends it when
 * the handler returns; a handler whose answer outlives it (a stream) marks it
 * `deferred` and ends it itself, at the stream's end. A second `end` does
 * nothing, so every request has one line and no more. PR 2b's span reads the
 * same record.
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

  constructor(readonly door: Door, readonly method: string, private readonly write: (r: RequestRecord) => void, private readonly signal?: AbortSignal) {
    OPEN.add(this);
  }

  /** Whether the client is gone: its request's signal aborted. */
  get clientGone(): boolean {
    return this.signal?.aborted === true;
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
    this.write({ door: this.door, method: this.method, route, rpc, tool, agent, status, outcome, code, ...fields, ms: at - this.started });
  }
}

/** A request's record, made as a server's first middleware receives it; `write` is where its line goes (logRequest unless a suite says). */
export function beginRequest(door: Door, req: Request, write: (r: RequestRecord) => void = logRequest): RequestTrace {
  const trace = new RequestTrace(door, req.method, write, req.signal);
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
