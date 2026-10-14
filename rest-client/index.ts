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
 * as sent, or null for none. `sent` is false for the answers the client gives
 * itself, nothing sent: an input a URL cannot carry (refusedHere) and a key no
 * header carries (unauthorizedHere).
 */
export type Answer = { status: number; ok: boolean; headers: Headers; body: unknown; sent: boolean };

/** The methods an operation answers on, the core's and a plugin's alike. */
export type Method = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * A plugin operation's route, as its manifest gives it (core/plugins.ts's
 * OPERATION_PATH under `/v1/plugins/<name>`, the name as PLUGIN_NAME_RE
 * holds it): lower-case words and hyphens, and `{field}` segments.
 */
const PLUGIN_PATH = /^\/v1\/plugins\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\/(?:[a-z0-9]+(?:-[a-z0-9]+)*|\{[a-z_]+\}))+$/;

/** The operations `call` takes: every one but the job's event stream, which answers a stream, not a body (`stream`). */
export type CallableOperation = Exclude<OperationId, "job_stream">;

type Op<K extends OperationId> = K extends keyof operations ? operations[K] : never;
/** A part of an operation's request, `{}` where it has none (openapi-typescript writes that `never`). */
type Part<T> = [T] extends [never] ? {} : [T] extends [undefined] ? {} : NonNullable<T>;
type BodyOf<K extends OperationId> = NonNullable<Op<K>["requestBody"]> extends { content: { "application/json": infer B } } ? B : never;
/** An operation's input as one object — its path's fields, its query's and its body's — as the MCP tool takes it. */
export type InputOf<K extends OperationId> = Part<Op<K>["parameters"]["path"]> & Part<Op<K>["parameters"]["query"]> & Part<BodyOf<K>>;

/** The words of the client's own refusals (refusedHere), after the field they name. */
const LONE_SURROGATE = "holds a lone surrogate, which a URL cannot carry";
const OBJECT_IN_QUERY = "is an object, which a query string cannot carry";

/** The longest delay a timer holds: setTimeout fires at once past it. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const JSON_TYPE = { "content-type": "application/json" };

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
  if (typeof value !== "string") return `expected a string, received ${value === null ? "null" : typeof value}`;
  if (value === "" || value === "." || value === "..") return `${JSON.stringify(value)} is no value a URL path can carry`;
  if (!encodable(value)) return LONE_SURROGATE;
  return null;
}

/**
 * Why a query value cannot ride a URL, or null when it can: text with a lone
 * surrogate, which percent-encoding throws on, and an object, or a list
 * holding one, which a query string has no form for — openapi-fetch's
 * serializer throws on it (review pass 4).
 */
function unfitForQuery(value: unknown): string | null {
  if (Array.isArray(value)) {
    // A list inside a list is an object here too: one level of list, of text, numbers or booleans, is all a query string carries.
    for (const v of value) {
      const unfit = Array.isArray(v) ? OBJECT_IN_QUERY : unfitForQuery(v);
      if (unfit) return unfit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") return OBJECT_IN_QUERY;
  return typeof value === "string" && !encodable(value) ? LONE_SURROGATE : null;
}

/**
 * Whether a value rides a header byte for byte as presented: RFC 9110's
 * field-vchar and obs-text — tab, printable ASCII and U+0080–U+00FF, a
 * header's latin1 bytes — with no space or tab at either end. Each bound has
 * its reason (review passes 2–5):
 * - the ends: HTTP strips them, so ` k ` would arrive as `k`, another key;
 * - an allow-list, not what Headers accepts: Headers strips a CR or LF at
 *   either end (`\rk` arrived as `k`) and passes the other control characters,
 *   which Bun's server answers with a bare 400;
 * - not visible ASCII alone: `é`, or a tab inside, rides a header and the
 *   core takes it;
 * - no DEL: a Go server, Traefik on the /api route, refuses it.
 */
const headerSafe = (value: string): boolean => /^[\t\x20-\x7e\x80-\xff]+$/.test(value) && !/^[ \t]|[ \t]$/.test(value);

/** The headers a caller's key or this client's forwarder key ride: the call's and the client's own, never an extra header's (review pass 3). */
const CREDENTIAL_HEADERS = new Set(["x-brain-key", "x-access-key", "authorization", FORWARDER_HEADER]);

/**
 * The answer for an input a URL cannot carry, given here, nothing sent: the
 * REST core's own refusal of an input (REFUSED_INPUT, the field its path, a
 * zod-like message after it), so a caller words it as it would the core's.
 */
const refusedHere = (field: string, message: string): Answer => ({
  status: 400, ok: false, sent: false, headers: new Headers(JSON_TYPE),
  body: { code: "REFUSED_INPUT", issues: [{ path: field, message }] },
});

/**
 * The answer for a key no header can carry as presented (headerSafe), given
 * here, nothing sent: the REST core's own answer to a key that matches none
 * (401 UNAUTHORIZED) — the core reads keys from headers alone, so no key it
 * could match is such a value (`health` reads none, and is answered so too).
 * A legacy raw key past U+00FF, which `?key=` carries to server-portable
 * today, cannot reach the REST core at all.
 */
const unauthorizedHere = (): Answer => ({
  status: 401, ok: false, sent: false, headers: new Headers({ ...JSON_TYPE, "www-authenticate": "Bearer" }),
  body: { code: "UNAUTHORIZED" },
});

/**
 * Why a base URL will not serve as the root every path is put under, or null
 * when it will (review passes 3–5):
 * - a space or a control character anywhere: the parser drops a tab or a line
 *   break from a host as from a path (`http://ev\til.com` reached evil.com);
 * - not http or https: `file:` read the disk, and a host and port with no
 *   scheme parsed as one;
 * - credentials in it, which fetch sends as an Authorization header round the
 *   rule that no extra header is a key;
 * - a query or a fragment, a bare `?` or `#` included, which URL reads as
 *   empty and every path would follow;
 * - a path the parser rewrites, a dot segment encoded or not, so the requests
 *   would go elsewhere than the base as written.
 */
function unfitBase(base: unknown): string | null {
  if (typeof base !== "string") return `is ${typeof base}, not a string`;
  if (/[\x00-\x20\x7f]/.test(base)) return "holds a space or a control character";
  const at = URL.parse(base);
  if (!at) return "does not parse";
  if (at.protocol !== "http:" && at.protocol !== "https:") return `has the scheme ${at.protocol}`;
  if (at.username || at.password) return "carries credentials";
  if (/[?#]/.test(base)) return "has a query or a fragment";
  const written = base.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/\/+$/, "");
  if (written !== at.pathname.replace(/\/+$/, "")) return "has a path the URL parser rewrites";
  return null;
}

/** An Answer as a Response, for stream(), which hands back responses. */
const asResponse = (a: Answer): Response => new Response(JSON.stringify(a.body), { status: a.status, headers: a.headers });

/** A request's signal: the caller's, the timeout's, both, or none. */
function signalFor(init: CallInit, timeoutMs: number | undefined): AbortSignal | undefined {
  const signals = [init.signal, timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)].filter((s): s is AbortSignal => s !== undefined);
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}

/**
 * The fetch given, held to its request's signal: one already aborted sends
 * nothing, and an abort ends the wait though the fetch does not heed it (a
 * suite's in-process app.fetch does not; review pass 1). What the server
 * started still runs: a write that timed out may have landed. The fetch runs
 * after a turn, so one that throws at once rejects like one that fails later
 * and leaves no listener behind; an answer that comes after the abort is
 * cancelled unread, its body not left to the collector (review pass 2).
 */
function heeding(send: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return (request) => {
    const signal = request.signal;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => send(request))
        .then((response) => {
          if (signal.aborted) void response?.body?.cancel().catch(() => {});
          resolve(response);
        }, reject)
        .finally(() => signal.removeEventListener("abort", onAbort));
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
   * caller's signal — and a write that threw may still have landed. That holds
   * for an input of JSON values, as the MCP server and a typed caller send: a
   * value JSON cannot carry (a bigint, a cycle, a symbol) throws as
   * JSON.stringify does, and so does an extra header no header can carry.
   */
  call<K extends CallableOperation>(name: K, input: InputOf<K>, init?: CallInit): Promise<Answer>;
  /**
   * An enabled plugin's operation (SMD-2310), which no committed document
   * names — which plugins run is the operator's choice — by its method and its
   * manifest's route, `/v1/plugins/<name>/…` with `{field}` segments: its
   * input sent and its answer read as `call` sends and reads them. A route
   * that is no plugin operation's shape rejects, as a caller's mistake.
   */
  callPath(method: Method, path: string, input: Record<string, unknown>, init?: CallInit): Promise<Answer>;
  /**
   * A job's event stream, by its id: the response itself, unread — its body
   * the stream, or a refusal's JSON — for the caller to pass on or read. A
   * job id a URL path cannot carry is answered as `call` answers one.
   */
  stream(jobId: string, init?: CallInit): Promise<Response>;
};

export function createRestClient(opts: RestClientOptions): RestClient {
  // The configuration is held at the start, not at the first call: a base
  // with a query or a fragment puts every path after it, and a forwarder key
  // no header carries as written would throw on every call (review pass 2).
  const why = unfitBase(opts.baseUrl);
  // Quoted with any credentials in it blanked, so the refusal does not print a password (review pass 4 of SMD-2287 PR 3a).
  if (why) throw new TypeError(`baseUrl must be an http or https origin, or an origin and a path: ${JSON.stringify(String(opts.baseUrl).replace(/\/\/[^/@]*@/, "//…@"))} ${why}`);
  // The timeout a whole number of milliseconds a timer can hold: setTimeout fires at once past 2^31 - 1, and AbortSignal.timeout throws on Infinity (review pass 5).
  if (opts.timeoutMs != null && !(Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0 && opts.timeoutMs <= MAX_TIMER_MS)) throw new TypeError(`timeoutMs must be a whole number of milliseconds from 1 to ${MAX_TIMER_MS}, or none: ${String(opts.timeoutMs)}`);
  if (opts.forwarderKey != null && (typeof opts.forwarderKey !== "string" || !headerSafe(opts.forwarderKey))) throw new TypeError("forwarderKey is no value a header carries as written (tab, printable ASCII and U+0080–U+00FF alone, no space or tab at either end)");
  // Every trailing slash dropped, so openapi-fetch (which drops one more if it finds one) and stream() build under one root.
  const base = opts.baseUrl.replace(/\/+$/, "");
  const send = heeding(opts.fetch ?? ((request: Request) => globalThis.fetch(request)));
  // A redirect is an answer, not followed: fetch carries custom headers to the
  // next origin, and the caller's key and this client's forwarder key ride
  // them (review pass 3: a 307 elsewhere took both).
  const raw = createClient<paths>({ baseUrl: base, fetch: send, redirect: "manual" });
  /** The headers every request carries beside its own: the forwarder slot, and the extra headers as they are now — never a key's. */
  const carry = (headers: Headers): void => {
    if (opts.forwarderKey != null) headers.set(FORWARDER_HEADER, opts.forwarderKey);
    for (const [name, value] of Object.entries(opts.headers?.() ?? {})) if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  };
  raw.use({
    onRequest({ request }) {
      carry(request.headers);
      return request;
    },
  });
  const keyed = (init: CallInit): Record<string, string> => (init.key == null ? {} : { "x-brain-key": init.key });

  /** One operation by its method and route: the path's fields fill the path, the rest rides the query string or the body. */
  const invoke = async (method: Method, path: string, input: Record<string, unknown>, init: CallInit): Promise<Answer> => {
    if (init.key != null && (typeof init.key !== "string" || !headerSafe(init.key))) return unauthorizedHere();
    const rest: Record<string, unknown> = { ...input };
    const pathParams: Record<string, string> = {};
    for (const field of fieldsOf(path)) {
      const unfit = unfitForPath(rest[field]);
      if (unfit) return refusedHere(field, unfit);
      pathParams[field] = rest[field] as string;
      delete rest[field];
    }
    const readsQuery = method === "GET" || method === "DELETE";
    if (readsQuery) {
      for (const [field, value] of Object.entries(rest)) {
        // A name rides the URL as it is: a `#` in one made the rest a fragment, a `&` or `=` split it (review pass 5).
        if (!/^[A-Za-z0-9_.-]+$/.test(field)) return refusedHere(field, "is no name a query string carries");
        const unfit = unfitForQuery(value);
        if (unfit) return refusedHere(field, unfit);
      }
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
    // openapi-fetch parses an error's JSON itself, and hands back "" for an empty body, which is none (review pass 2); a success's text is parsed here.
    return { status: response.status, ok: response.ok, sent: true, headers: response.headers, body: response.ok ? parsed(data as string | undefined) : error === "" ? null : error ?? null };
  };

  return {
    raw,
    // Async, so a caller's mistake is a rejection as an answer's failure is (review pass 1: callPath's threw at once).
    async call(name, input, init = {}) {
      const { method, path } = OPERATIONS[name];
      return invoke(method as Method, path, input as Record<string, unknown>, init);
    },
    async callPath(method, path, input, init = {}) {
      if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) throw new TypeError(`callPath's method must be GET, POST, PATCH or DELETE: ${JSON.stringify(method)}`);
      if (typeof path !== "string" || !PLUGIN_PATH.test(path)) throw new TypeError(`callPath's route must be a plugin operation's, /v1/plugins/<name>/… with {field} segments: ${JSON.stringify(path)}`);
      return invoke(method, path, input ?? {}, init);
    },
    async stream(jobId, init = {}) {
      if (init.key != null && (typeof init.key !== "string" || !headerSafe(init.key))) return asResponse(unauthorizedHere());
      const unfit = unfitForPath(jobId);
      if (unfit) return asResponse(refusedHere("job_id", unfit));
      // Sent here, not through openapi-fetch, which reads a refusal's body
      // itself and would hand back a response already read (review pass 1).
      const headers = new Headers(keyed(init));
      carry(headers);
      // The timeout holds until the answer's headers arrive, and not after:
      // the stream itself runs as long as its job does (review pass 2: no
      // bound at all, while a call's was kept). The caller's signal ends the
      // wait for the headers, and then the request, whose body a fetch that
      // heeds its signal ends. Joined by AbortSignal.any, which holds no
      // listener on the caller's signal past the request (review pass 3: one
      // stayed on a long-lived signal per stream).
      const clock = new AbortController();
      const signal = init.signal ? AbortSignal.any([init.signal, clock.signal]) : clock.signal;
      const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => clock.abort(new DOMException("The operation timed out.", "TimeoutError")), opts.timeoutMs);
      try {
        return await send(new Request(`${base}/v1/jobs/${encodeURIComponent(jobId)}/stream`, { headers, signal, redirect: "manual" }));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
