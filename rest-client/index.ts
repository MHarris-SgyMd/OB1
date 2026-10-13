// The REST core's client (SMD-2287): openapi-fetch over the types
// openapi-typescript generated from the REST core's own OpenAPI document
// (generate.ts). The MCP server calls the brain through it, and so will the
// operator GUI (SMD-2280). Typed requests come from the document, and so does
// every operation's method and path (operations.ts); a success's value is
// typed as an object alone until the document spells the core's values out,
// so a caller that needs more holds it to the type it renders.

import createClient, { type Client } from "openapi-fetch";
import type { operations, paths } from "./schema.d.ts";
import { OPERATIONS, type OperationId } from "./operations.ts";

export { OPERATIONS, type OperationId };
export type { operations, paths };

/** The header the REST core reads a carrier's forward-scope key from (SMD-2284): who carried the request, granting nothing. */
export const FORWARDER_HEADER = "x-brain-forwarder";

export interface RestClientOptions {
  /** Where the REST core answers: `http://api.ob1.internal:8000` on the mesh, `<origin>/api` through the proxy's opt-in route. */
  baseUrl: string;
  /** What sends a request: globalThis.fetch unless given (a suite hands it the REST app's own). */
  fetch?: (request: Request) => Promise<Response>;
  /** This caller's forward-scope key, sent in the forwarder slot beside the caller's key on every call: the MCP server's own. */
  forwarderKey?: string;
  /** Headers each request adds as it is sent — the calling span's `traceparent`. */
  headers?: () => Record<string, string>;
  /** The longest a call may take, in milliseconds, after which it is aborted; none unless given. */
  timeoutMs?: number;
}

/** What one call sends beside its input: the caller's key, and a signal that ends the call early. */
export interface CallInit {
  key?: string;
  signal?: AbortSignal;
}

/**
 * An answer: its status, its headers, and its body — JSON parsed, or the text
 * as sent, or null for none. `sent` is false for the one answer the client
 * gives itself: an input a URL cannot carry (refusedHere).
 */
export type Answer = { status: number; ok: boolean; headers: Headers; body: unknown; sent: boolean };

/** The operations `call` takes: every one but the job's event stream, which answers a stream, not a body (`stream`). */
export type CallableOperation = Exclude<OperationId, "job_stream">;

type Op<K extends OperationId> = K extends keyof operations ? operations[K] : never;
/** A part of an operation's request, `{}` where it has none (openapi-typescript writes that `never`). */
type Part<T> = [T] extends [never] ? {} : [T] extends [undefined] ? {} : NonNullable<T>;
type BodyOf<K extends OperationId> = NonNullable<Op<K>["requestBody"]> extends { content: { "application/json": infer B } } ? B : never;
/** An operation's input as one object — its path's fields, its query's and its body's — as the MCP tool takes it. */
export type InputOf<K extends OperationId> = Part<Op<K>["parameters"]["path"]> & Part<Op<K>["parameters"]["query"]> & Part<BodyOf<K>>;

/** Whether text survives percent-encoding — not when it holds a lone surrogate, on which encodeURIComponent throws. */
function encodable(text: string): boolean {
  try {
    encodeURIComponent(text);
    return true;
  } catch {
    return false;
  }
}

/** The `{field}` names a path fills, in order. */
const fieldsOf = (path: string): string[] => [...path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);

/**
 * Why a path field's value cannot travel in a URL path, or null when it can.
 * Not a string, or empty, it leaves `{field}` or an empty segment behind; `.`
 * and `..` are dot segments, which the URL parser removes however they are
 * encoded, so the request would reach another route (a job named `.` read as
 * GET /v1/jobs/stream, review pass 1).
 */
function unfitForPath(value: unknown): string | null {
  if (typeof value !== "string") return `is ${value === null ? "null" : typeof value}, not a string`;
  if (value === "" || value === "." || value === "..") return `is ${JSON.stringify(value)}, which a URL path cannot carry`;
  if (!encodable(value)) return "holds a lone surrogate, which a URL cannot carry";
  return null;
}

/** A query value a URL cannot carry: text with a lone surrogate, which percent-encoding throws on. */
const unfitForQuery = (value: unknown): boolean =>
  Array.isArray(value) ? value.some(unfitForQuery) : typeof value === "string" && !encodable(value);

/**
 * The answer for an input a URL cannot carry, given here, nothing sent: the
 * REST core's own refusal of an input (REFUSED_INPUT, naming the field), so a
 * caller words it as it would the core's.
 */
const refusedHere = (field: string, message: string): Answer => ({
  status: 400, ok: false, sent: false, headers: new Headers({ "content-type": "application/json" }),
  body: { code: "REFUSED_INPUT", issues: [{ path: field, message: `${field} ${message}` }] },
});

/** A request's signal: the caller's, the timeout's, both, or none. */
function signalFor(init: CallInit, timeoutMs: number | undefined): AbortSignal | undefined {
  const signals = [init.signal, timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)].filter((s): s is AbortSignal => s !== undefined);
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}

/**
 * The fetch given, held to its request's signal: one already aborted sends
 * nothing, and an abort ends the wait though the fetch does not heed it (a
 * suite's in-process app.fetch does not; review pass 1). What the server
 * started still runs: a write that timed out may have landed.
 */
function heeding(send: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return (request) => {
    const signal = request.signal;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      send(request).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  };
}

/** The body as sent: JSON parsed where it is JSON, the text where it is not, null where there is none. */
function parsed(text: string | undefined): unknown {
  if (text === undefined || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type RestClient = {
  /** The typed openapi-fetch client, for a caller that names a path and wants its request checked against the document. */
  raw: Client<paths>;
  /**
   * An operation by its operationId, its input one object, as the tool's
   * schema accepts it (the MCP server's SDK has held it there; a TypeScript
   * caller's types do): the path's fields fill the path, the rest rides the
   * query string (GET, DELETE) or a JSON body (POST, PATCH), as the REST core
   * reads it, and the core holds what arrives to the schema again. A query
   * string carries text, so a null or undefined there is left out. Any status
   * is an answer, and so is an input a URL cannot carry (refusedHere); only a
   * request that never got one throws — the core away, the timeout, the
   * caller's signal — and a write that threw may still have landed.
   */
  call<K extends CallableOperation>(name: K, input: InputOf<K>, init?: CallInit): Promise<Answer>;
  /**
   * A job's event stream, by its id: the response itself, unread — its body
   * the stream, or a refusal's JSON — for the caller to pass on or read. A
   * job id a URL path cannot carry is answered as `call` answers one.
   */
  stream(jobId: string, init?: CallInit): Promise<Response>;
};

export function createRestClient(opts: RestClientOptions): RestClient {
  const send = heeding(opts.fetch ?? ((request: Request) => globalThis.fetch(request)));
  const raw = createClient<paths>({ baseUrl: opts.baseUrl, fetch: send });
  /** The headers every request carries beside its own: the forwarder slot, and the extra headers as they are now. */
  const carry = (headers: Headers): void => {
    if (opts.forwarderKey !== undefined) headers.set(FORWARDER_HEADER, opts.forwarderKey);
    for (const [name, value] of Object.entries(opts.headers?.() ?? {})) headers.set(name, value);
  };
  raw.use({
    onRequest({ request }) {
      carry(request.headers);
      return request;
    },
  });
  const keyed = (init: CallInit): Record<string, string> => (init.key === undefined ? {} : { "x-brain-key": init.key });

  return {
    raw,
    async call(name, input, init = {}) {
      const { method, path } = OPERATIONS[name];
      const rest: Record<string, unknown> = { ...(input as Record<string, unknown>) };
      const pathParams: Record<string, string> = {};
      for (const field of fieldsOf(path)) {
        const unfit = unfitForPath(rest[field]);
        if (unfit) return refusedHere(field, unfit);
        pathParams[field] = rest[field] as string;
        delete rest[field];
      }
      const readsQuery = method === "GET" || method === "DELETE";
      if (readsQuery) {
        for (const [field, value] of Object.entries(rest)) if (unfitForQuery(value)) return refusedHere(field, "holds a lone surrogate, which a URL cannot carry");
      }
      // Untyped here: the method and path are the operation's own, read from the document by its name, which the generic types cannot follow.
      const request = raw.request as unknown as (method: string, path: string, init: Record<string, unknown>) => Promise<{ data?: unknown; error?: unknown; response: Response }>;
      const { data, error, response } = await request(method.toLowerCase(), path, {
        params: { path: pathParams, ...(readsQuery ? { query: rest } : {}) },
        ...(readsQuery ? {} : { body: rest }),
        headers: keyed(init),
        signal: signalFor(init, opts.timeoutMs),
        parseAs: "text",
      });
      // openapi-fetch parses an error's JSON itself; a success's text is parsed here.
      return { status: response.status, ok: response.ok, sent: true, headers: response.headers, body: response.ok ? parsed(data as string | undefined) : error ?? null };
    },
    async stream(jobId, init = {}) {
      const unfit = unfitForPath(jobId);
      if (unfit) {
        const { status, headers, body } = refusedHere("job_id", unfit);
        return new Response(JSON.stringify(body), { status, headers });
      }
      // Sent here, not through openapi-fetch, which reads a refusal's body
      // itself and would hand back a response already read (review pass 1).
      const headers = new Headers(keyed(init));
      carry(headers);
      const base = opts.baseUrl.replace(/\/+$/, "");
      return send(new Request(`${base}/v1/jobs/${encodeURIComponent(jobId)}/stream`, { headers, signal: signalFor(init, undefined) }));
    },
  };
}
