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

/** An answer as it came: its status, its headers, and its body — JSON parsed, or the text as sent, or null for none. */
export type Answer = { status: number; ok: boolean; headers: Headers; body: unknown };

type Op<K extends OperationId> = K extends keyof operations ? operations[K] : never;
/** A part of an operation's request, `{}` where it has none (openapi-typescript writes that `never`). */
type Part<T> = [T] extends [never] ? {} : [T] extends [undefined] ? {} : NonNullable<T>;
type BodyOf<K extends OperationId> = NonNullable<Op<K>["requestBody"]> extends { content: { "application/json": infer B } } ? B : never;
/** An operation's input as one object — its path's fields, its query's and its body's — as the MCP tool takes it. */
export type InputOf<K extends OperationId> = Part<Op<K>["parameters"]["path"]> & Part<Op<K>["parameters"]["query"]> & Part<BodyOf<K>>;

/** The `{field}` names a path fills, in order. */
const fieldsOf = (path: string): string[] => [...path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);

/** A request's signal: the caller's, the timeout's, both, or none. */
function signalFor(init: CallInit, timeoutMs: number | undefined): AbortSignal | undefined {
  const signals = [init.signal, timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)].filter((s): s is AbortSignal => s !== undefined);
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
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
   * An operation by its operationId, its input one object: the path's fields
   * fill the path, the rest rides the query string (GET, DELETE) or a JSON
   * body (POST, PATCH), as the REST core reads it. Any status is an answer;
   * only a request that never got one throws (the core away, the timeout).
   */
  call<K extends OperationId>(name: K, input: InputOf<K>, init?: CallInit): Promise<Answer>;
  /** A job's event stream, by its id: the response itself, its body the stream, for the caller to pass on or read. */
  stream(jobId: string, init?: CallInit): Promise<Response>;
};

export function createRestClient(opts: RestClientOptions): RestClient {
  const raw = createClient<paths>({ baseUrl: opts.baseUrl, fetch: opts.fetch });
  raw.use({
    onRequest({ request }) {
      if (opts.forwarderKey !== undefined) request.headers.set(FORWARDER_HEADER, opts.forwarderKey);
      for (const [name, value] of Object.entries(opts.headers?.() ?? {})) request.headers.set(name, value);
      return request;
    },
  });
  const keyed = (init: CallInit) => (init.key === undefined ? {} : { "x-brain-key": init.key });

  return {
    raw,
    async call(name, input, init = {}) {
      const { method, path } = OPERATIONS[name];
      const rest: Record<string, unknown> = { ...(input as Record<string, unknown>) };
      const pathParams: Record<string, unknown> = {};
      for (const field of fieldsOf(path)) {
        pathParams[field] = rest[field];
        delete rest[field];
      }
      const readsQuery = method === "GET" || method === "DELETE";
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
      return { status: response.status, ok: response.ok, headers: response.headers, body: response.ok ? parsed(data as string | undefined) : error ?? null };
    },
    async stream(jobId, init = {}) {
      const { response } = await raw.GET("/v1/jobs/{job_id}/stream", {
        params: { path: { job_id: jobId } },
        headers: keyed(init),
        signal: signalFor(init, undefined),
        parseAs: "stream",
      });
      return response;
    },
  };
}
