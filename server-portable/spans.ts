// A span around one piece of the servers' work, and what may be said of a
// fault on it (SMD-1849 PR 2d): a provider call (embed.ts providerCall,
// preflight's probes), a store operation (store.ts createStore), a job's body
// (jobs.ts startJob) and a webhook's deferred work (core/plugins.ts runHook),
// beside telemetry.ts's request and tool spans.
//
// This module imports nothing. embed.ts and store.ts are imported by db/'s
// workers and evals/, which install no package of server-portable/'s, so the
// OpenTelemetry API cannot come in through them (jobs.ts, beside them, keeps
// to the same rule): here a span is nothing — `fn` runs, and nothing is
// recorded — until a process installs the API's spans (useTracing), as
// telemetry.ts does when a server, or preflight under --deep, loads it
// (tracing.ts). Even then each is the API's no-op, recorded and sent nowhere,
// until startTelemetry sets the SDK up.
//
// What a span says is what its caller hands it, from sets the code bounds —
// an operation's name, a model's and an endpoint's host from the operator's
// settings, a status, a fault's kind and code — never a URL, a key, an
// argument, a thought's text or a fault's message.

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
      // Not a DOMException's legacy number (an AbortError's 20, a TimeoutError's 23): its name says it (review pass 1).
      : typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < 1_000_000 && !(typeof DOMException !== "undefined" && err instanceof DOMException) ? String(raw) : undefined;
  } catch {}
  return code === undefined ? { kind } : { kind, code };
}

/** How a piece of work ended, as its span says it: a tool call can also refuse; the stop's cut ends any. */
export type SpanOutcome = "ok" | "refused" | "error" | "cut";

/** What a span or a point may carry: values its caller has held to a set. */
export type SpanAttributes = Record<string, string | number | boolean | undefined>;

/** One piece of work's span, while it runs: ended once, with how it ended. */
export interface WorkSpan {
  /**
   * Ends the span, once; later calls do nothing. An `error` or a `cut` is the
   * span's error, its `error.type` the one given — a value its caller holds
   * to a set — else the outcome.
   */
  end(outcome: SpanOutcome, errorType?: string): void;
  /** Marks what the work threw, by its kind and code alone (faultOf), before it ends. */
  fault(err: unknown): void;
  /** Adds what the work learnt as it ran (a provider's token counts), before it ends. */
  set(attributes: SpanAttributes): void;
}

/** What a histogram is made with: its unit, its description and its bucket bounds. */
export interface HistogramSpec {
  unit: string;
  description: string;
  bounds: number[];
}

/** How a span starts, and what it does as it ends. */
export interface SpanRequest {
  /** `client` for a call out of the process (a provider, the database); `internal` (the default) for the rest. */
  kind?: "internal" | "client";
  attributes?: SpanAttributes;
  /**
   * Starts a trace of its own, linked to the span current where it starts,
   * rather than that span's child — for work that outlives what started it
   * (a job's body, run on after its tool call has answered).
   */
  root?: boolean;
  /** The `error.type` a throw gives, where the work's own words name one (a provider's status); else the fault's code, else its kind. */
  errorType?: (err: unknown) => string | undefined;
  /** What an `error.type` adds to the span and its point beside itself (a SQLSTATE's `db.response.status_code`). */
  failed?: (errorType: string) => SpanAttributes;
  /** One point on this histogram as the span ends: its seconds, these labels, and its `error.type` where it failed. */
  metric?: { name: string; spec: HistogramSpec; labels: SpanAttributes };
}

/** What makes spans: nothing, until a serving process installs the OpenTelemetry API's (useTracing). */
export interface Tracing {
  run<T>(name: string, request: SpanRequest, fn: (span: WorkSpan) => Promise<T>): Promise<T>;
}

/** What a span is where none is made: nothing, and the work runs. */
export const NO_SPAN: WorkSpan = { end() {}, fault() {}, set() {} };
const UNTRACED: Tracing = { run: async (_name, _request, fn) => fn(NO_SPAN) };
/** Whether spans are made at all: a process that installed none builds no name or labels for them. */
const untraced = () => tracing === UNTRACED;
let tracing: Tracing = UNTRACED;

/** Installs what makes spans: telemetry.ts's, the OpenTelemetry API's (tracing.ts); undefined puts back none. */
export function useTracing(next: Tracing | undefined): void {
  tracing = next ?? UNTRACED;
}

/**
 * Runs `fn` under a span of its own, current while it runs, so what `fn`
 * starts is its child: `fn` may end it with how the work ended; one that
 * throws first ends it as an error, the throw marked on it (faultOf), and one
 * that returns without ending it ends it `ok`. A span still open when the
 * server stops is ended `cut` (telemetry.ts cutOpenRequests).
 */
export function withSpan<T>(name: string, request: SpanRequest, fn: (span: WorkSpan) => Promise<T>): Promise<T> {
  return tracing.run(name, request, fn);
}

/** A model's name as an operator writes one (`text-embedding-3-small`, `qwen3:8b`, `openai/gpt-4o-mini`); `?` for anything else. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

/**
 * A provider call's duration, in seconds, under the GenAI conventions' name:
 * their advised bounds, on to 327.68 s, past the 120 s a call is given by
 * default (OB1_LLM_TIMEOUT).
 */
const PROVIDER_DURATION: HistogramSpec = {
  unit: "s",
  description: "How long each call to an embedding or chat provider took (SMD-1849)",
  bounds: [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92, 163.84, 327.68],
};

/** The host and port a call goes to, from its endpoint's base: never its userinfo, its path or its query. */
function serverOf(base: string): SpanAttributes {
  try {
    const url = new URL(base);
    const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : undefined;
    // An IPv6 host without the brackets a URL keeps it in, as the conventions spell an address.
    return { "server.address": url.hostname.replace(/^\[(.*)\]$/, "$1"), "server.port": port };
  } catch {
    return {};
  }
}

/**
 * Runs one call to an embedding or chat provider under a client span, as the
 * GenAI conventions name one — `embeddings <model>`, `chat <model>` — with
 * the model, the endpoint's host and port (usageOf adds its token counts);
 * and makes one point on `gen_ai.client.operation.duration`, labelled with
 * the same, `extra` (preflight's `ob1.probe`), and how the call failed
 * (`errorType`, else the fault's code or kind). No base's userinfo or path, no
 * text sent or answered.
 */
export function withProviderSpan<T>(
  operation: "embeddings" | "chat",
  model: unknown,
  base: string,
  fn: (span: WorkSpan) => Promise<T>,
  errorType?: (err: unknown) => string | undefined,
  extra: SpanAttributes = {},
): Promise<T> {
  if (untraced()) return UNTRACED.run(operation, {}, fn);
  const name = typeof model === "string" && MODEL.test(model) ? model : "?";
  const labels: SpanAttributes = { "gen_ai.operation.name": operation, "gen_ai.request.model": name, ...serverOf(base), ...extra };
  return withSpan(`${operation} ${name}`, {
    kind: "client",
    attributes: labels,
    errorType,
    metric: { name: "gen_ai.client.operation.duration", spec: PROVIDER_DURATION, labels },
  }, fn);
}

/**
 * A provider's HTTP status as an `error.type`: 300 to 599 as itself, any other
 * `_OTHER` — a runtime takes any three digits, and a provider would mint a
 * series with each (review pass 3). providerCall's and preflight's probes'.
 */
export function statusType(status: number): string {
  return status >= 300 && status <= 599 ? String(status) : "_OTHER";
}

/**
 * A token count a provider answered with, where it is a count an OTLP integer
 * holds: a safe integer — `1e308` is an integer to JavaScript, and an export
 * holding it is refused whole by a collector reading int64 (review pass 3).
 */
const tokens = (n: unknown) => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined);

/** The token counts an OpenAI-shaped answer's `usage` holds, as the GenAI conventions name them. */
export function usageOf(answer: unknown): SpanAttributes {
  try {
    const usage = typeof answer === "object" && answer !== null ? (answer as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage : undefined;
    if (typeof usage !== "object" || usage === null) return {};
    return { "gen_ai.usage.input_tokens": tokens(usage.prompt_tokens), "gen_ai.usage.output_tokens": tokens(usage.completion_tokens) };
  } catch {
    return {};
  }
}

/**
 * A store operation's duration, in seconds, under the database conventions'
 * name: finer than their advised bounds where a search spends its time (a
 * p99 between 10 and 50 ms had one bucket), and on past their 10 s to a
 * minute, for a pool's wait or a slow hybrid search (review pass 3) — set now,
 * since a histogram's bounds cannot change under a quantile that reads it.
 * Twenty buckets a label set, against the conventions' ten.
 */
const STORE_DURATION: HistogramSpec = {
  unit: "s",
  description: "How long each store operation took, from its call to its answer, the pool's wait included (SMD-1849)",
  bounds: [0.0005, 0.001, 0.0025, 0.005, 0.0075, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 10, 30, 60],
};

/**
 * A SQLSTATE: a class Postgres defines — two digits, or HV, P0, XX, F0 — and
 * three digits or capitals; so a system error's five-letter code (`EPIPE`,
 * `EBUSY`) is not one.
 */
const SQLSTATE = /^(?:[0-9][0-9A-Z]|HV|P0|XX|F0)[0-9A-Z]{3}$/;

/**
 * Runs one store operation under a client span — named by the operation, the
 * method the core called (`matchThoughts`), as the database conventions name
 * a span with no query summary — and makes one point on
 * `db.client.operation.duration`. A fault's SQLSTATE is its `error.type` and
 * its `db.response.status_code`; any other fault's code or kind is its
 * `error.type`. No query text, no parameter.
 */
export function withStoreSpan<T>(operation: string, store: string, fn: () => Promise<T>): Promise<T> {
  if (untraced()) return UNTRACED.run(operation, {}, () => fn());
  const labels: SpanAttributes = { "db.system.name": "postgresql", "db.operation.name": operation, "ob1.store": store };
  return withSpan(operation, {
    kind: "client",
    attributes: labels,
    failed: (type) => (SQLSTATE.test(type) ? { "db.response.status_code": type } : {}),
    metric: { name: "db.client.operation.duration", spec: STORE_DURATION, labels },
  }, () => fn());
}
