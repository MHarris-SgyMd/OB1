// What the servers say about their requests (SMD-1849): one JSON line per
// request to the MCP server's endpoint and per request to the REST core,
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
 * - `abandoned`: the client left before the MCP server's response was
 *   complete, or before the REST core handed its answer over — the call
 *   itself runs on to its end, which this line does not say;
 * - `cut`: the server's stop closed it;
 * - `stalled`: still running at the keepalive's ceiling (sse.ts); the line is
 *   written then, and the call's own end writes none.
 * A batch's line says its worst call's: error, then refused, unrun, ok. Any
 * other request — an `initialize`, a `tools/list`, every REST request — says
 * its answer's (outcomeOf), or `abandoned`.
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
  /** The REST core's route template (`/v1/thoughts/:id`), never the path it was given. */
  route?: string;
  /** The MCP server's JSON-RPC method (`tools/call`), or `batch` for a body of several messages. */
  rpc?: string;
  /** The tool: an MCP tool call's, or the operation a REST route runs. */
  tool?: string;
  /** The configured name of the key that authenticated — never the key. */
  agent?: string;
  status: number;
  outcome?: RequestOutcome;
  /** A refusal's or a fault's code (`NOT_FOUND`, `FAILED`), the MCP server's from the tool's reply or the key, the REST core's from its error answer. */
  code?: string;
  /** Milliseconds from the request's arrival to its end: an MCP stream's end; the REST core's answer, whose job stream is timed to its opening, not its end. */
  ms: number;
  /** The bytes of the answer's body, where the server counted them (an MCP stream). */
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
/** A route template: the REST core's own path pattern, segments of letters, digits, `_`, `-`, `.` and `:name`. */
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
