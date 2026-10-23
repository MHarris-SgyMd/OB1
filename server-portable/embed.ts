/**
 * embed.ts — how a capture becomes vectors, in one place.
 *
 * Lifted out of index.ts for SMD-946, and not for tidiness. `db/reembed.ts`
 * walks the whole corpus and re-embeds every thought, and it has to produce
 * exactly what a capture would: the same windows, the same blurb rule, the same
 * prompt template, the same whole-content-then-head-window fallback, the same
 * width check. A second copy of that logic in a script is the defect FORK.md
 * keeps finding — a value defined twice — and here the value is every stored
 * vector: two implementations that drift by one separator produce vectors that
 * are not comparable, and nothing reports it.
 *
 * So the server and the re-embed worker call the same function, and the only
 * thing either supplies is configuration. The configuration is resolved from an
 * environment record by `resolveEmbedConfig`, with the defaulting rules index.ts
 * used to hold, so the two cannot disagree about what an unset variable means
 * either. core/context.ts passes `() => resolveEmbedConfig(env())` because the
 * server reads its environment lazily (root.ts initEnv seeds it before the first read);
 * reembed.ts passes process.env once.
 *
 * Nothing in here imports a database client or a framework, so it builds for
 * every target index.ts does.
 */

import { chunkContent, DEFAULT_EXTRACT_WINDOW_TOKENS, DEFAULT_MAX_TOKENS, DEFAULT_OVERLAP_TOKENS, EXTRACT_OVERLAP_RATIO } from "./chunk.ts";
import {
  applyEmbeddingPrompt,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIM,
  DEFAULT_METADATA_MODEL,
  DEFAULT_LLM_BASE_URL,
  CHUNK_CONTEXT_PROMPTS,
  applyChunkContextPrompt,
  composeChunkForEmbedding,
  usableChunkContext,
  resolveChunkContext,
  resolveChunkTokens,
  resolveEmbeddingDimensions,
  resolveExtractWindow,
  resolveExtractMaxWindows,
  EXTRACT_WINDOW_HEADER,
  EXTRACT_RETRY_RUNAWAY,
  EXTRACT_STREAM_ABORT,
  type ChunkTokensFrom,
  type ExtractWindowFrom,
} from "../db/config.mjs";
import { flagOn, mayLeaveBox, resolveEgressPolicy, type EgressDecision, type EgressPolicy, type EgressSubject } from "./egress.ts";
import { statusType, usageOf, withProviderSpan } from "./spans.ts";

/** The environment keys this module reads. A subset of root.ts's Env. */
export type EmbedEnv = {
  OB1_LLM_BASE_URL?: string;
  OB1_LLM_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /** Where the chat calls go when it is not where the embeddings go; see resolveProviderEndpoints (SMD-1902). */
  OB1_CHAT_BASE_URL?: string;
  /** The chat endpoint's own credential. */
  OB1_CHAT_API_KEY?: string;
  /** 1/on: OB1_LLM_BASE_URL is on this machine or its private network — declared, never guessed from the address (SMD-1903). */
  OB1_LLM_LOCAL?: string;
  /** Likewise for OB1_CHAT_BASE_URL; a chat endpoint at the same base is the same box, declared by either knob. */
  OB1_CHAT_LOCAL?: string;
  /** The egress gate's mode — deny (the default), allow or off — and its terms; see egress.ts. */
  OB1_EGRESS_POLICY?: string;
  OB1_EGRESS_ALLOW?: string;
  OB1_EGRESS_DENY?: string;
  OB1_EMBEDDING_MODEL?: string;
  OB1_EMBEDDING_DIM?: string;
  OB1_EMBEDDING_DIMENSIONS?: string;
  OB1_CHUNK_TOKENS?: string;
  OB1_CHUNK_OVERLAP?: string;
  OB1_CHUNK_CONTEXT?: string;
  OB1_METADATA_MODEL?: string;
  /** Estimated tokens of thought text per entity-extraction call; unset derives it from the metadata model's served context (SMD-1879). */
  OB1_EXTRACT_CHUNK_TOKENS?: string;
  /** The most windows one thought is extracted in; a longer one is extracted over its first this many (SMD-2240). Unset: db/config.mjs's EXTRACT_MAX_WINDOWS, 24. */
  OB1_EXTRACT_MAX_WINDOWS?: string;
  /** The supersession judge's model, when it is not the metadata model (SMD-1901). */
  OB1_JUDGE_MODEL?: string;
  /** The typed-decision tier's model that gives the consolidation pass's verdict, the judge's model then only writing proposals (SMD-3115); unset, the judge decides. */
  OB1_CONSOLIDATE_DECIDER?: string;
  /** A larger local model a runaway extraction call escalates to instead of the penalised retry (SMD-2000); unset keeps the same-model retry. */
  OB1_EXTRACT_ESCALATE_MODEL?: string;
  OB1_METADATA_TEMPERATURE?: string;
  OB1_METADATA_REASONING?: string;
  OB1_LLM_TIMEOUT?: string;
};

/**
 * Seconds a single provider call may take before it is abandoned. Generous on
 * purpose: the whole-content embedding of a long document on a local model, or
 * a blurb generated from a whole document by a large chat model, can run to
 * tens of seconds on modest hardware, and a timeout that fires on slow-but-
 * working is worse than none. What it exists for is the call that never
 * returns: before it, a hung provider parked a re-embed worker until the
 * second Ctrl-C (first review of SMD-946), and the lease it held expired
 * under it.
 *
 * The budget is per request, but the queue is shared: a long capture sends its
 * whole-content request and every window's at once, each timed from dispatch,
 * and a provider that serves one request at a time (Ollama with
 * OLLAMA_NUM_PARALLEL=1) answers the last of them after all the others. So the
 * default has to cover a whole document's worth of requests in series, not
 * one — lower it towards a hosted API's figure only against a provider that
 * serves in parallel.
 */
export const DEFAULT_LLM_TIMEOUT_S = 120;

/**
 * How much of a provider's error body is kept. A proxy answering a 413 or a
 * 502 with a full HTML page would otherwise land whole in every message built
 * from it — and db/reembed.ts stores that message on the claim row.
 */
export const PROVIDER_ERROR_CHARS = 500;

/**
 * What a provider call can fail with, told apart without parsing messages:
 * the deadline passed (`timeout`), the provider answered with an error status
 * (`http`, with the status), or it answered 2xx with a body that is not JSON
 * (`body`) — or the call was never made, because the egress gate refused to
 * send the text to an endpoint not declared local (`egress`, SMD-1903; no
 * status, and nothing about the provider). Anything else — a refused
 * connection, a reset — is the runtime's own error and is rethrown as it came.
 */
export class ProviderError extends Error {
  /**
   * @param body The provider's own words, capped — what refusesLength reads,
   *   kept apart from the message so the base URL in the message cannot be
   *   mistaken for them.
   */
  constructor(message: string, readonly kind: "timeout" | "http" | "body" | "egress", readonly status?: number, readonly body = "") {
    super(message);
    this.name = "ProviderError";
  }
}

/** The runtime's codes for a provider that did not answer at all: refused, reset, no route, or the connection's own timeout. */
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ConnectionRefused", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"]);
/** Bun's codes for a name that did not resolve (it reports these with `syscall: "getaddrinfo"` too). */
const UNRESOLVED_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ETIMEOUT"]);

/**
 * Whether a provider call failed because the provider did not answer — an
 * outage, not a fault in the request or the configuration (SMD-2888): the
 * deadline passed, the provider answered 5xx, 408 or 429, or the connection
 * was refused, reset, unroutable, or its name did not resolve (Bun 1.4.3's
 * fetch throws a TypeError with `code: "ECONNREFUSED"`, or `"ENOTFOUND"` and
 * `syscall: "getaddrinfo"`). A capture lands without what the call would have
 * made on these, since the same call will answer once the provider is back.
 *
 * Null for everything else, which still fails the call: an egress refusal
 * (the gate's, judged before any request), any other 4xx (an input the model
 * refuses, a credential, a model that is not there), a 2xx whose body is not
 * JSON, and a plain Error such as the width mismatch — a misconfigured brain
 * keeps failing visibly (SMD-1875's reason for the probe). `reason` is a
 * marker's word (`metadata_extraction_failed`'s vocabulary, extractMetadata's
 * `provider_timeout` and `provider_<status>` among it); `detail` says it in
 * words — never the text, nor the base, which the caller names.
 *
 * A fourth "is this transient?" rule beside the three SMD-2461 means to merge;
 * kept to the provider's own failures, in one place, so that ticket can take it.
 */
export function providerDown(e: unknown): { reason: string; detail: string } | null {
  if (e instanceof ProviderError) {
    // Not the message, which names the base: the reply names that itself.
    if (e.kind === "timeout") return { reason: "provider_timeout", detail: "the request timed out (OB1_LLM_TIMEOUT)" };
    const s = e.status;
    if (e.kind === "http" && s !== undefined && (s >= 500 || s === 408 || s === 429)) return { reason: `provider_${s}`, detail: `it answered ${s}` };
    return null;
  }
  // A runtime error (Bun's fetch), read by its fields, never its message.
  const { code: raw, syscall } = typeof e === "object" && e !== null ? (e as { code?: unknown; syscall?: unknown }) : {};
  const code = typeof raw === "string" ? raw : "";
  if (syscall === "getaddrinfo" || UNRESOLVED_CODES.has(code)) return { reason: "provider_unreachable", detail: `its name does not resolve${code ? ` (${code})` : ""}` };
  if (UNREACHABLE_CODES.has(code)) return { reason: "provider_unreachable", detail: code === "ECONNREFUSED" || code === "ConnectionRefused" ? "the connection was refused" : `the connection failed (${code})` };
  return null;
}

/**
 * One call to the OpenAI-compatible provider, and the only place that makes
 * one: URL join, headers, the timeout and its name, the status attached, the
 * error body capped, the JSON parsed. The server's embedding, blurb and
 * metadata calls and the bulk passes' all come through here, so the next
 * request-level concern — a Retry-After read, a request id — is added once.
 * Before this the timeout rewrap was hand-written three times with three try
 * scopes, and the one that closed after fetch() let a deadline passing during
 * the body read escape as the bare "The operation timed out" (second review
 * of SMD-1021). The whole exchange, headers and body, is bounded here.
 *
 * Not every call in the repository: db/extract-entities.ts's model call has
 * its own bound (--timeout, per model call) and preflight's probes are one
 * interactive shot; both keep their own fetch.
 *
 * Every call names its SUBJECT — whose text this is, and what is known about
 * it — and the egress gate (egress.ts, SMD-1903) reads it against the
 * endpoint before anything is sent: an endpoint not declared local gets the
 * text only under the policy, and a refusal is a ProviderError of kind
 * `egress` thrown before the request exists. The server's capture and search
 * paths ask the gate first and skip the call, so a refusal here is the belt
 * under those braces, never the way a refused capture is meant to be found.
 *
 * Each call the gate lets through is a client span, `embeddings <model>` or
 * `chat <model>`, and a point on `gen_ai.client.operation.duration` (spans.ts
 * withProviderSpan, SMD-1849 PR 2d): the model, the endpoint's host and port,
 * the answer's token counts, and how it failed — `timeout`, the status,
 * `invalid_body`, or the runtime's code (`ECONNREFUSED`) — never the text or
 * the base's userinfo. A call the gate
 * refuses was never made, and has none.
 *
 * `signal`, a caller's (db/reembed.ts's hard stop, SMD-2679): aborted, the
 * call in hand ends at once, request or body, rejecting with its abort's
 * reason — an AbortError for a plain abort(), never OB1_LLM_TIMEOUT's error —
 * rather than running out OB1_LLM_TIMEOUT. The deadline still holds beside
 * it, and a deadline that passes is still the timeout, named.
 */
export async function providerCall<T>(cfg: EmbedConfig, path: "/embeddings" | "/chat/completions", body: unknown, subject: EgressSubject, signal?: AbortSignal): Promise<T> {
  const what = path === "/embeddings" ? "Embeddings" : "Chat completion";
  // The endpoint the PATH selects, and the one every message below names: a
  // chat call that fails names the chat base, which since SMD-1902 need not be
  // the embeddings base.
  const at = endpointFor(cfg, path);
  const gate = mayLeaveBox(subject, at, cfg.egress);
  if (!gate.allowed) throw refuseEgress(what, at.base, gate);
  const model = typeof body === "object" && body !== null ? (body as { model?: unknown }).model : undefined;
  return withProviderSpan(path === "/embeddings" ? "embeddings" : "chat", model, at.base, async (span) => {
    const answer = await exchange<T>(cfg, path, body, at, what, signal);
    span.set(usageOf(answer));
    return answer;
  }, providerErrorType);
}

/**
 * How a provider call failed, for its span and its point: `timeout`, the
 * provider's status (spans.ts statusType: 300 to 599, else `_OTHER`),
 * `invalid_body`; undefined for the runtime's own error, read by its code or
 * kind (spans.ts faultOf).
 */
function providerErrorType(err: unknown): string | undefined {
  if (!(err instanceof ProviderError)) return undefined;
  if (err.kind === "http" && err.status !== undefined) return statusType(err.status);
  return err.kind === "body" ? "invalid_body" : err.kind;
}

/** providerCall's exchange, once the gate has let it through: the request, the deadline over it, the status kept, the body capped, the JSON parsed. */
async function exchange<T>(cfg: EmbedConfig, path: "/embeddings" | "/chat/completions", body: unknown, at: ProviderEndpoint, what: string, signal?: AbortSignal): Promise<T> {
  const timedOut = () =>
    new ProviderError(`${what} request to ${at.base} timed out after ${cfg.timeoutMs / 1000} s (OB1_LLM_TIMEOUT)`, "timeout");
  let r: Response;
  try {
    r = await fetch(`${at.base}${path}`, {
      method: "POST",
      headers: at.headers,
      body: JSON.stringify(body),
      // The caller's abort rejects with its reason (AbortError for a plain abort()), the deadline as TimeoutError,
      // headers or body alike (measured on Bun 1.4.3, SMD-2679).
      signal: signal ? AbortSignal.any([AbortSignal.timeout(cfg.timeoutMs), signal]) : AbortSignal.timeout(cfg.timeoutMs),
      // OB1_LLM_TIMEOUT is the one deadline: Bun's fetch would otherwise cut
      // an unstreamed call at its own 300 s idle timeout, so a longer value
      // here never took effect (measured for SMD-1879; entities.ts).
      timeout: false,
    });
  } catch (e) {
    // The caller's stop first: a caller's own timeout signal is its stop, not
    // OB1_LLM_TIMEOUT's (review pass 2 of SMD-2679 PR 4a-1).
    if (signal?.aborted) throw e;
    // Named as what it is, with the knob, and WITHOUT a status: nothing about
    // the next attempt is known, so embedCapture treats it as transient.
    if ((e as Error).name === "TimeoutError") throw timedOut();
    throw e;
  }
  // The status is known from here on and must not be lost: a body that fails
  // to arrive after a 413 is still a 413 (the third review found a reset
  // mid-body turning a refusal into a transient, and failing a capture that
  // the metadata fallback exists to save). The deadline passing during the
  // body is the timeout. After an error status anything else leaves the body
  // empty. After a 2xx an outage is rethrown as it came — a provider that
  // crashed mid-answer resets the socket (ECONNRESET, measured on Bun 1.4.3),
  // which read as "a body that is not JSON" and failed the capture
  // providerDown would have saved (SMD-2888 review pass 1) — and any other
  // fault (a corrupt gzip, a malformed chunk) is still the body that was not
  // JSON below, as before (review pass 2).
  let text = "";
  try {
    text = await r.text();
  } catch (e) {
    // The caller's stop mid-body is the stop, not a body that was not JSON or
    // the status's failure (review pass 1 of SMD-2679 PR 4a-1: it was read so).
    if (signal?.aborted) throw e;
    if ((e as Error).name === "TimeoutError") throw timedOut();
    if (r.ok && providerDown(e)) throw e;
  }
  const capped = text.slice(0, PROVIDER_ERROR_CHARS);
  if (!r.ok) {
    // The status is a field rather than parsed back out of the message:
    // embedCapture has to distinguish "this input is too large for this model",
    // which is a stable property, from a transient outage, which is not.
    throw new ProviderError(`${what} request to ${at.base} failed: ${r.status} ${capped}`, "http", r.status, capped);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(`${at.base} answered ${r.status} with a body that is not JSON`, "body", r.status, capped);
  }
}

/**
 * The error a refused call throws, in one shape for the three diallers
 * (providerCall here, judgePair, extractEntities): kind `egress`, no status,
 * the gate's own sentence. A worker's claim row or a reply carries the
 * message; a classifier reads the kind.
 */
export function refuseEgress(what: string, base: string, gate: EgressDecision): ProviderError {
  return new ProviderError(`${what} request to ${base} refused by the egress gate: ${gate.reason}`, "egress");
}

/** The endpoint a path is served by: /embeddings by the embeddings one, /chat/completions by the chat one. */
export function endpointFor(cfg: Pick<EmbedConfig, "embeddings" | "chat">, path: "/embeddings" | "/chat/completions"): ProviderEndpoint {
  return path === "/embeddings" ? cfg.embeddings : cfg.chat;
}

/**
 * Whether a provider's error refuses the INPUT'S LENGTH — a 413, or a 400
 * whose own words say so — as against any other client error. This is the
 * fact worth acting on: a length refusal is the provider's final answer for
 * that input, where a 400 for any other reason is not. Read from the
 * provider's body, never from a message that also carries the base URL (a
 * host named "tokens" would otherwise make every 400 permanent): the error
 * object's code and type first, where an OpenAI-shaped provider puts
 * `context_length_exceeded`, then its message. Shared with
 * db/extract-entities.ts, which passes what its own error carries, so the two
 * tools read a 400 by one rule (the second review of SMD-1021 found any 400
 * recorded as a length refusal here while that tool already read the message).
 */
export function refusesLength(status: number | undefined, body: string): boolean {
  if (status === 413) return true;
  if (status !== 400) return false;
  let words = body;
  try {
    const err = (JSON.parse(body) as { error?: { code?: unknown; type?: unknown; message?: unknown } | string })?.error;
    if (err && typeof err === "object") words = [err.code, err.type, err.message].filter((x) => typeof x === "string").join(" ");
    else if (typeof err === "string") words = err;
  } catch {
    // Prose, or not JSON at all — read it as it came.
  }
  return /context|length|too long|too_long|tokens|too large/i.test(words);
}

/**
 * One OpenAI-compatible endpoint: where a call goes and what it carries. The
 * server has two — `/embeddings` and `/chat/completions` need not be served by
 * one provider (SMD-1902) — and every dialler reads the pair off the config
 * rather than a base URL and a header set that silently meant "both".
 */
export type ProviderEndpoint = {
  /**
   * Base URL, trailing slashes and userinfo stripped: what every call dials. A
   * base the URL parser refuses is kept as written, userinfo and all — fetch
   * refuses it too — so a row prints `shownBase`, not this (SMD-2885).
   */
  base: string;
  /**
   * The key, when there is one. Preflight reports that it is set and how long
   * it is, never the value; everything else reads `headers`.
   */
  key: string | undefined;
  /**
   * The base URL carried userinfo the parser reads (`http://user:pass@host/v1`,
   * or a user alone). It is sent as Basic when there is no key, and not at all
   * when there is: the key's Bearer takes the one Authorization header (SMD-2885).
   */
  userinfo: boolean;
  /** Request headers; carries Authorization only when there is a key or userinfo. */
  headers: Record<string, string>;
  /**
   * Declared on this machine or its private network — OB1_LLM_LOCAL /
   * OB1_CHAT_LOCAL — so the egress gate does not apply (SMD-1903). Declared,
   * not guessed: a loopback address with the flag unset is remote here, even
   * where preflight's credential rule calls it local.
   */
  local: boolean;
  /** The knob that declared it, when `local`: what a row or a banner names (second review pass); OB1_JEV_LOCAL for the decision tier (jev.ts, SMD-2050). */
  declaredBy?: LocalKnob;
};

/** The knobs that declare an endpoint local. */
export type LocalKnob = "OB1_LLM_LOCAL" | "OB1_CHAT_LOCAL" | "OB1_JEV_LOCAL";

/**
 * A base URL's user and password, out of it: the base without them, and the
 * Basic credential they make (RFC 7617, UTF-8), or none. Bun's fetch sends
 * userinfo as Basic from 1.4.3 and dropped it before, so it is never left in a
 * URL for fetch to decide — nor for a message to print (SMD-2885). The other
 * fetches of an operator's URL, brain-compare's and n8n provisioning's, take
 * it out the same way (SMD-2894).
 */
export function splitUserinfo(base: string): { base: string; basic?: string } {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return { base };
  }
  if (!url.username && !url.password) return { base };
  const decoded = (part: string) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const basic = Buffer.from(`${decoded(url.username)}:${decoded(url.password)}`, "utf8").toString("base64");
  url.username = "";
  url.password = "";
  // The base as written, the userinfo cut out — where the parser reads that as
  // the same URL. Else the parse rebuilt: `http:/u:p@h` and `http://u:p@h\x@other`
  // are userinfo too, and the host the parser read is the one dialled (second
  // review pass). As written, so the knobs' two spellings of one base still
  // compare equal (resolveProviderEndpoints; third review pass).
  const cut = base.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1");
  let same = false;
  try {
    same = new URL(cut).href === url.href;
  } catch {
    // the cut does not parse: the rebuild it is
  }
  return { base: same ? cut : url.href.replace(/\/+$/, ""), basic };
}

/**
 * A base as a row prints it: userinfo, which `base` no longer carries, as
 * `***@`. A base the URL parser refuses kept its userinfo (fetch refuses it
 * too), and is masked as store.ts's maskUrl masks it (second review pass).
 */
export function shownBase(at: Pick<ProviderEndpoint, "base" | "userinfo">): string {
  return at.userinfo ? at.base.replace("://", "://***@") : at.base.replace(/:\/\/[^/]*@/, "://***@");
}

/** A URL not yet split, as shownBase prints it: what a message names an operator's URL by (SMD-2894). */
export function shownUrl(url: string): string {
  const split = splitUserinfo(url);
  return shownBase({ base: split.base, userinfo: split.basic !== undefined });
}

/** An endpoint from its parts, with the one header rule every call shares. */
export function providerEndpoint(base: string, key: string | undefined, local = false, declaredBy?: LocalKnob): ProviderEndpoint {
  const split = splitUserinfo(base.replace(/\/+$/, ""));
  // A local endpoint needs no credential, so the key is optional there.
  // Sending `Authorization: Bearer undefined` to Ollama is harmless but
  // confusing in logs, so the header is omitted entirely when there is no
  // credential. A key wins over userinfo, as fetch's own header rule has it.
  const authorization = key ? `Bearer ${key}` : split.basic ? `Basic ${split.basic}` : undefined;
  return {
    base: split.base,
    key,
    userinfo: split.basic !== undefined,
    local,
    ...(local && declaredBy ? { declaredBy } : {}),
    headers: authorization
      ? { Authorization: authorization, "Content-Type": "application/json" }
      : { "Content-Type": "application/json" },
  };
}

/**
 * The two endpoints, from the environment. `OB1_LLM_BASE_URL` (key
 * `OB1_LLM_API_KEY`, else `OPENROUTER_API_KEY`) is the embeddings endpoint and,
 * unless `OB1_CHAT_BASE_URL` names another, the chat endpoint too — with the
 * same key, so a deployment that sets neither chat knob sends exactly what it
 * sent before this split.
 *
 * A credential belongs to an endpoint, not to the environment. A chat base
 * that is a different endpoint gets `OB1_CHAT_API_KEY`, or its own userinfo
 * (SMD-2885), and nothing else: a local chat model beside a hosted embedder
 * (the Edge0 shape, SMD-1880) must not be handed the hosted provider's key,
 * and there is no other way to say "no key here" while `OB1_LLM_API_KEY` is
 * set (empty means unset throughout). Two spellings of the same base are the
 * same endpoint and share the key; userinfo in a base is a credential like a
 * key (providerEndpoint), so a chat base with userinfo of its own stands
 * alone. A hosted chat base with neither a key nor userinfo of its own is a
 * configuration preflight fails by name, not one this function papers over.
 *
 * Whether an endpoint is LOCAL is declared the same way (SMD-1903):
 * `OB1_LLM_LOCAL` for the embeddings endpoint, `OB1_CHAT_LOCAL` for a chat
 * endpoint of its own — and a chat endpoint at the SAME base is the same box,
 * so either knob declares it, for both calls (the first review pass found
 * `OB1_CHAT_LOCAL` alone discarded on the shared endpoint, every call refused
 * and no row saying why). Nothing is read off the address.
 */
export function resolveProviderEndpoints(env: EmbedEnv): { embeddings: ProviderEndpoint; chat: ProviderEndpoint } {
  // baseUrlOr: trimmed, trailing slashes off, and slashes alone are unset (SMD-1843).
  const llmBase = baseUrlOr(env.OB1_LLM_BASE_URL, DEFAULT_LLM_BASE_URL);
  const embeddings = providerEndpoint(llmBase, env.OB1_LLM_API_KEY || env.OPENROUTER_API_KEY, flagOn(env.OB1_LLM_LOCAL), "OB1_LLM_LOCAL");
  const chatBase = baseUrlOr(env.OB1_CHAT_BASE_URL, embeddings.base);
  const chatFlag = flagOn(env.OB1_CHAT_LOCAL);
  const chatSplit = splitUserinfo(chatBase);
  const sameBase = chatSplit.base === embeddings.base;
  const chat = providerEndpoint(chatBase, env.OB1_CHAT_API_KEY, chatFlag || (sameBase && embeddings.local), chatFlag ? "OB1_CHAT_LOCAL" : "OB1_LLM_LOCAL");
  // No credential of its own and the same base: it IS the embeddings endpoint,
  // key and all — declared local by either knob, and the knob that did travels
  // with it. Userinfo is part of the spelling: none in the chat base, or the
  // same as the embeddings base's, is still the same endpoint, key included
  // (second review pass). Anything else — its own key, its own userinfo
  // (SMD-2885), or a different base — stands alone.
  if (!chat.key && sameBase && (chatSplit.basic === undefined || chatSplit.basic === splitUserinfo(llmBase).basic)) {
    const shared: ProviderEndpoint = chat.local && !embeddings.local ? { ...embeddings, local: true, declaredBy: "OB1_CHAT_LOCAL" } : embeddings;
    return { embeddings: shared, chat: shared };
  }
  return { embeddings, chat };
}

export type EmbedConfig = {
  /** Where `/embeddings` is dialled: OB1_LLM_BASE_URL and its key. */
  embeddings: ProviderEndpoint;
  /** Where `/chat/completions` is dialled: the embeddings endpoint unless OB1_CHAT_BASE_URL names another. */
  chat: ProviderEndpoint;
  embeddingModel: string;
  embeddingDim: number;
  /** Whether to send the OpenAI `dimensions` parameter. */
  dimensionsRequested: boolean;
  /** Tokens per window; see chunkTokensFrom for how it was decided. */
  chunkTokens: number;
  /** Estimated tokens a capture is windowed above: chunkTokens, unless the model's window raised it (SMD-1305). */
  chunkThreshold: number;
  /**
   * Where chunkTokens came from: OB1_CHUNK_TOKENS, the configured model's
   * window in db/config.mjs's KNOWN_MODEL_WINDOW, or chunk.ts's default for a
   * model the table does not know. Preflight prints it (SMD-1305).
   */
  chunkTokensFrom: ChunkTokensFrom;
  /** The configured model's window in KNOWN_MODEL_WINDOW, when it has one. */
  modelWindow: number | undefined;
  chunkOverlap: number;
  /** Whether to generate a situating blurb per window before embedding it. */
  chunkContext: boolean;
  /** The chat model the blurb is generated with — the metadata model. */
  metadataModel: string;
  /**
   * Estimated tokens of thought text per entity-extraction call (SMD-1879): a
   * thought over it is extracted in windows of this size. OB1_EXTRACT_CHUNK_TOKENS,
   * else derived from the metadata model's served context (db/config.mjs,
   * KNOWN_CHAT_MODEL_WINDOW) and never above entities.ts's default, else that
   * default. The server never extracts; preflight prints the rule and its source.
   */
  extractChunkTokens: number;
  extractChunkTokensFrom: ExtractWindowFrom;
  /** The model's context would have held a larger window than the measured default it is held at. */
  extractChunkTokensCapped: boolean;
  /** The model's listed context holds no window at all beside the rules and an answer; the default is in force and preflight warns. */
  extractChunkTokensUnfit: boolean;
  /** The metadata model's served context in KNOWN_CHAT_MODEL_WINDOW, when it has one. */
  extractModelWindow: number | undefined;
  /** Overlap between extraction windows: chunk.ts's ratio of the window (150 of 1200). */
  extractChunkOverlap: number;
  /**
   * The most windows one thought is extracted in (SMD-2240), and the text
   * bound a run chunk.ts cannot split meets (entities.ts, boundedWindows): a longer
   * thought is extracted over its first windows and its claim recorded
   * succeeded with a caveat naming the coverage. OB1_EXTRACT_MAX_WINDOWS,
   * else db/config.mjs's EXTRACT_MAX_WINDOWS.
   */
  extractMaxWindows: number;
  extractMaxWindowsFrom: "OB1_EXTRACT_MAX_WINDOWS" | "default";
  /** Whether a window after the first carries the note's opening line — entities.ts's documentHeader; measured in evals/README.md. */
  extractHeader: boolean;
  /** Whether a call that ran to its answer budget is retried once with a frequency penalty; measured in evals/README.md. */
  extractRetryRunaway: boolean;
  /** Whether a budgeted call's answer is streamed and aborted before its budget — at the third copy of one item (entities.ts's RunawayDetector, SMD-1960) or once it ends in TOKEN_REPEATS copies of one unit (repeatedTail, SMD-2449); measured in evals/README.md. */
  extractStreamAbort: boolean;
  /**
   * A larger local model a runaway extraction call is remade on — no penalty,
   * the same messages — instead of the penalised same-model retry (SMD-2000):
   * OB1_EXTRACT_ESCALATE_MODEL, else "" (the retry stays as it was). The 27B
   * that never looped on the thoughts the 7B could not finish is the case; the
   * escalation spends the large model only where the small one has failed, so
   * this is a per-brain choice the way judgeModel is (SMD-1901). The pass key
   * stays the FIRST model's — the pass is the small model's and the escalation
   * is its retry mechanism; which model answered is recorded on the dump line,
   * and durable per-row lineage is SMD-1731's. windowingFor ignores it when it
   * matches the metadata model (a same-model retry with no penalty is weaker
   * than the penalised one it would replace).
   */
  extractEscalateModel: string;
  /**
   * The model the supersession judge (consolidate.ts) runs on: OB1_JUDGE_MODEL,
   * else the metadata model. The two tasks were one knob, so the only way to
   * judge with a stronger model was to tag every capture with it too; SMD-1873
   * measured them apart on one 7B — extraction fine, the judge at floor
   * confidence on every pair. The pass key carries this name (consolidateKey),
   * so a change starts a fresh pass rather than mixing judgements (SMD-1901).
   */
  judgeModel: string;
  /**
   * Decide mode (SMD-3115): OB1_CONSOLIDATE_DECIDER, the typed-decision tier's model that gives the pass's verdict,
   * the judge's model then only writing the proposals it calls and, since decide version 4, answering the mediated-pair
   * test's link step (consolidate-decide.ts, SMD-3203); "" when the judge decides.
   * The pass key names it with the judge's model (consolidatePassKey), so turning it on starts a fresh pass.
   */
  decider: string;
  metadataTemperature: number;
  /** Extra chat-completion fields controlling reasoning; see metadataReasoning. */
  metadataReasoning: Record<string, unknown>;
  /** Per provider call, both endpoints. OB1_LLM_TIMEOUT in seconds; see DEFAULT_LLM_TIMEOUT_S. */
  timeoutMs: number;
  /**
   * What may leave the box for an endpoint not declared local (SMD-1903):
   * OB1_EGRESS_POLICY and its terms, read by providerCall and the two diallers
   * that keep their own fetch. Deny by default; see egress.ts.
   */
  egress: EgressPolicy;
};

/** A string knob: trimmed, and "" or whitespace is unset. `qwen2.5:7b ` from a .env file is not a model. */
export function stringOr(raw: string | undefined, fallback: string): string {
  const v = raw?.trim();
  return v ? v : fallback;
}

/** A base-URL knob: stringOr, then trailing slashes off — and a value that was slashes alone is unset too. */
export function baseUrlOr(raw: string | undefined, fallback: string): string {
  const bare = fallback.replace(/\/+$/, "");
  return stringOr(stringOr(raw, bare).replace(/\/+$/, ""), bare);
}

/**
 * Resolve the embedding configuration from an environment record.
 *
 * Every rule here used to be a small function in index.ts reading `env()`. They
 * are unchanged in what they decide; only where they live moved. An empty
 * string is treated as unset throughout, matching db/config.mjs.
 */
export function resolveEmbedConfig(env: EmbedEnv): EmbedConfig {
  const model = stringOr(env.OB1_EMBEDDING_MODEL, DEFAULT_EMBEDDING_MODEL);
  const dim = env.OB1_EMBEDDING_DIM ? Number(env.OB1_EMBEDDING_DIM) : DEFAULT_EMBEDDING_DIM;
  // The window a capture is split at. Until SMD-1305 this was chunk.ts's
  // constant for every model — 1200, chosen for Ollama's 2048-token batch —
  // while the default model embeds 18,919 tokens whole and a 512-token model
  // had its windows cut. The rule is db/config.mjs's, so the server,
  // reembed.ts and preflight cannot disagree about it: an explicit
  // OB1_CHUNK_TOKENS wins for both the size and the threshold, a model the
  // window table knows derives a threshold from its window at the shipped
  // ratio (capped where the whole vector was measured to stop holding) and a
  // size at or under the constant, and an unknown model keeps the constant.
  const chunk = resolveChunkTokens(env.OB1_CHUNK_TOKENS, model, DEFAULT_MAX_TOKENS);
  const metadataModel = stringOr(env.OB1_METADATA_MODEL, DEFAULT_METADATA_MODEL);
  // The extraction window is the METADATA model's, not the embedding model's
  // (SMD-1879): one call's text is bounded by what that model's served context
  // holds beside the rules and its answer, and by what it was measured to
  // finish. Same shape as the embedding rule above, a different model and a
  // different table.
  const extract = resolveExtractWindow(env.OB1_EXTRACT_CHUNK_TOKENS, metadataModel, DEFAULT_EXTRACT_WINDOW_TOKENS);
  const extractCap = resolveExtractMaxWindows(env.OB1_EXTRACT_MAX_WINDOWS);
  return {
    ...resolveProviderEndpoints(env),
    embeddingModel: model,
    embeddingDim: dim,
    /**
     * Whether to ask the provider for a narrower vector, via the OpenAI
     * `dimensions` parameter. This exists so a model whose native width exceeds
     * pgvector's 2000-dimension HNSW ceiling can be used at all:
     * `qwen3-embedding:4b` emits 2560 and cannot be indexed, but truncated to
     * 1024 it scored the best retrieval result measured on real data. Providers
     * apply the parameter to any model, including ones never trained for
     * Matryoshka truncation, with no error either way — so the decision is
     * db/config.mjs's, shared with preflight and the migrator.
     */
    dimensionsRequested: resolveEmbeddingDimensions(env.OB1_EMBEDDING_DIMENSIONS, dim, model),
    chunkTokens: chunk.tokens,
    chunkThreshold: chunk.threshold,
    chunkTokensFrom: chunk.from,
    modelWindow: chunk.window,
    // The overlap follows a window that DERIVED smaller than the constant
    // (first review pass): at 300 tokens chunk.ts clamps the default 150 to
    // half the window, and its carry rule — never carry the whole buffer —
    // then carries nothing out of a two-segment window, so a granite-embedding
    // capture had no overlap at all. Scaled at the ratio the constant fixes
    // (150 of 1200 → 37 of 300). Gated on the SOURCE, not the size (second
    // pass): an explicit OB1_CHUNK_TOKENS keeps the 150 it always had, so a
    // pinned store does not change shape on upgrade; OB1_CHUNK_OVERLAP wins
    // over both.
    chunkOverlap: numberOr(env.OB1_CHUNK_OVERLAP,
      chunk.from === "window" && chunk.tokens < DEFAULT_MAX_TOKENS ? Math.floor((DEFAULT_OVERLAP_TOKENS * chunk.tokens) / DEFAULT_MAX_TOKENS) : DEFAULT_OVERLAP_TOKENS,
      "non-negative"),
    chunkContext: resolveChunkContext(env.OB1_CHUNK_CONTEXT),
    metadataModel,
    extractChunkTokens: extract.tokens,
    extractChunkTokensFrom: extract.from,
    extractChunkTokensCapped: extract.capped,
    extractChunkTokensUnfit: extract.unfit,
    extractModelWindow: extract.window,
    extractChunkOverlap: Math.floor(extract.tokens * EXTRACT_OVERLAP_RATIO),
    extractMaxWindows: extractCap.windows,
    extractMaxWindowsFrom: extractCap.from,
    extractHeader: EXTRACT_WINDOW_HEADER,
    extractRetryRunaway: EXTRACT_RETRY_RUNAWAY,
    extractStreamAbort: EXTRACT_STREAM_ABORT,
    // The larger model a runaway escalates to (SMD-2000); "" keeps the
    // penalised same-model retry. A per-brain choice, like the judge's model.
    extractEscalateModel: stringOr(env.OB1_EXTRACT_ESCALATE_MODEL, ""),
    // Trimmed like its sibling (SMD-1843): the judge's own knob, else the
    // metadata model as resolved above.
    judgeModel: stringOr(env.OB1_JUDGE_MODEL, metadataModel),
    decider: stringOr(env.OB1_CONSOLIDATE_DECIDER, ""),
    // Deterministic by default; overridable for anyone who wants variety.
    metadataTemperature: numberOr(env.OB1_METADATA_TEMPERATURE, 0, "non-negative"),
    metadataReasoning: metadataReasoning(env.OB1_METADATA_REASONING),
    // Seconds, as --ttl and --timeout are elsewhere in this fork; a timeout of
    // zero would fail every call, so zero means the default too.
    timeoutMs: numberOr(env.OB1_LLM_TIMEOUT, DEFAULT_LLM_TIMEOUT_S, "positive") * 1000,
    egress: resolveEgressPolicy(env),
  };
}

/**
 * One rule for every numeric variable this file reads: empty, non-numeric and
 * out-of-range all mean the default. Number("") is 0, which passed the
 * overlap's `>= 0` and windowed long captures with NO overlap — and
 * deploy/compose.yaml forwards every optional variable as `${VAR:-}`, so a
 * composed server saw "" wherever the operator set nothing. Empty means
 * unset, as db/config.mjs's ENV proxy already says; the first review of
 * SMD-946 found the server and reembed.ts chunking differently over the same
 * corpus for exactly this reason, and this was four hand-rolled copies of the
 * same test until the boyscout pass of SMD-1021.
 */
function numberOr(raw: string | undefined, fallback: number, range: "positive" | "non-negative"): number {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && (range === "positive" ? n > 0 : n >= 0) ? n : fallback;
}

/**
 * Thinking-capable models reason before answering unless told not to, and a
 * growing share of open-weight models default to it — Gemma 4, Qwen 3,
 * DeepSeek-R1. For a fixed-schema extraction on the interactive path of every
 * capture, that is mostly cost: measured on gemma4, reasoning bought +3 points on
 * the extraction benchmark for 5.5x the latency (7.7s vs 1.4s per capture).
 *
 * So reasoning is OFF by default and opt-in. Note that `think: false` is silently
 * IGNORED on the OpenAI-compatible endpoint — `reasoning_effort` is what it
 * honours, and it is harmless to models with no reasoning mode.
 */
function metadataReasoning(rawValue: string | undefined): Record<string, unknown> {
  // Trimmed like the model, URL and numeric knobs. Compose's own dotenv trims
  // an unquoted value (measured, v5.5), so the case is a quoted `"low "` in a
  // .env file, or any other loader: that reached the provider as "low " and
  // every extraction 400ed (SMD-1843; the model and URL were trimmed one pass
  // later, on the same finding).
  const raw = (rawValue ?? "").trim().toLowerCase();
  if (raw === "on" || raw === "true" || raw === "1") return {};
  if (raw && raw !== "off" && raw !== "false" && raw !== "0") return { reasoning_effort: raw };
  return { reasoning_effort: "none" };
}

export type EmbedKind = "query" | "document";

export type EmbeddedCapture = {
  embedding: number[];
  /**
   * The model that produced `embedding` and the chunks' vectors — the one
   * value that belongs beside them, so a writer records it (021) rather than
   * re-reading the configuration at each call site.
   */
  model: string;
  chunks: { content: string; embedding: number[]; context?: string }[];
  /** Windows that were meant to carry a blurb and went in bare instead. */
  contextFailures: number;
  /**
   * Why, in the words of each failure, one entry per distinct reason — the
   * provider's status, the timeout, a blurb too long to be one. A bulk pass
   * writes these on the claim row, so an operator whose metadata model is
   * slower than OB1_LLM_TIMEOUT is told to raise the timeout, not to fix the
   * model. Empty when every blurb arrived.
   */
  contextErrors: string[];
  /**
   * The content was long enough to chunk and the whole-content embedding could
   * not be had, so `embedding` is the head window's vector. The server accepts
   * this silently, as it always has; a bulk pass records it on the row.
   */
  wholeContentFellBack: boolean;
  /**
   * The whole-content request was refused outright (400 or 413) — this call's
   * own, or, when the embedder remembers refusals, an earlier one's that meant
   * this call was not made. Either way the fallback above is the permanent
   * answer for this model rather than a transient one — the distinction a bulk
   * pass needs between "recorded, done" and "retry later".
   */
  wholeContentRefused: boolean;
  /**
   * Why the whole content fell back, in the words of the error: the provider's
   * status and message, or the timeout. Absent when it did not fall back, and
   * when a remembered refusal meant the call was never made. What a bulk pass
   * writes on the claim row, so the row says what happened to it rather than
   * that something did.
   */
  wholeContentError?: string;
};

export type Embedder = {
  /**
   * Embed a capture: one vector for `thoughts.embedding`, plus per-window
   * vectors when the content is too long to embed in a single provider call.
   * `subject` is whose text this is, for the egress gate (SMD-1903); a
   * refusal throws a ProviderError of kind `egress` before any request.
   * `signal` is a caller's stop (providerCall's): aborted, every call of the
   * capture ends and the capture rejects with its reason — no head window
   * stands in for the whole content and no window goes in bare for it.
   */
  embedCapture(content: string, subject: EgressSubject, signal?: AbortSignal): Promise<EmbeddedCapture>;
  /** One embedding. `kind` selects the query template over the document one; `subject` and `signal` as above. */
  getEmbedding(text: string, subject: EgressSubject, kind?: EmbedKind, signal?: AbortSignal): Promise<number[]>;
};

/**
 * Build an embedder over a configuration source. The source is a function
 * because the server reads its environment lazily; it is called on every request
 * to the provider, which is what the server did before this file existed.
 *
 * One piece of state lives in the returned object: whether the provider has
 * refused a whole-content embedding. The server remembers it for the life of
 * the embedder (`rememberRefusal`, the default), so a provider that refuses
 * over-length input is not asked again on every long capture — one wasted
 * round trip per process instead of one per capture, on the interactive path.
 * A bulk pass passes false: its purpose is the whole-content vector, each long
 * row's outcome is recorded on that row, and a 413 is about THAT input's
 * length — a shorter long thought may well be accepted — so remembering one
 * row's refusal would give every later row a head window it was never asked
 * about, under a reason that was another row's. The cost there is one refused
 * round trip per long row, answered before any embedding is computed.
 */
export function createEmbedder(config: () => EmbedConfig, opts: { rememberRefusal?: boolean; log?: (line: string) => void } = {}): Embedder {
  const rememberRefusal = opts.rememberRefusal ?? true;
  /**
   * Where the embedder's own lines go — a fallback to the head window, a blurb
   * refused: stderr unless the caller names a writer, as db/reembed.ts's run()
   * does so an in-process caller gets them where the CLI prints them
   * (SMD-2304). A throw from it rejects the call that logged, with its own
   * error: marked on the way out (LogThrow) so the catches below that degrade
   * a provider's failure — a blurb's, the whole content's — pass it on rather
   * than take it for the provider's and record it as a reason, and unwrapped
   * where embedCapture returns. Latched per call (callLog): the call's later
   * lines — sibling windows still in flight, the catch that would log the
   * failure again — are not written but throw the same mark, so no catch
   * here can resolve past it (review pass 2).
   */
  const log = opts.log ?? ((line: string) => console.error(line));
  class LogThrow {
    constructor(readonly error: unknown) {}
  }
  const callLog = () => {
    let failed: LogThrow | null = null;
    const say = (line: string): void => {
      if (failed) throw failed;
      try {
        log(line);
      } catch (e) {
        failed = new LogThrow(e);
        throw failed;
      }
    };
    return { say };
  };
  type Say = (line: string) => void;
  /**
   * Set when the provider rejects a whole-content embedding outright and
   * `rememberRefusal` is on. One-way: the only thing that flips it is a 400 or
   * 413, which is a property of the configured model rather than a transient
   * condition.
   */
  let wholeContentRefused = false;

  /**
   * Some embedding models are trained to see a query and a document differently,
   * and sending both bare is not a small loss: `qwen3-embedding:4b` scores 0.933
   * MRR on 97 real issues with its query instruction and 0.860 without —
   * unprompted, worse than a model a quarter its size. The templates live in
   * db/config.mjs, keyed by model, so the migration runner and the server cannot
   * disagree about them.
   *
   * A model with no entry is sent bare, which is right for most: `embeddinggemma`
   * gains 0.002 from its documented format, and nomic's prefixes measurably hurt.
   *
   * This is baked into stored vectors. Changing the template invalidates them
   * exactly as changing the model does — which is why it is keyed off the model
   * name rather than exposed as its own setting, so preflight's existing
   * model-change check already covers it.
   *
   * Applied by db/config.mjs's function rather than a copy of it: the server
   * kept its own two-line version, and both it and the original read `$&`,
   * `$'` and `$$` in the thought's text as String.replace substitution
   * patterns — a price written `$$5` was embedded as `$5`. One definition, one
   * fix, and evals/lib.ts measures the same text the server embeds.
   */
  function applyPrompt(cfg: EmbedConfig, text: string, kind: EmbedKind): string {
    return applyEmbeddingPrompt(cfg.embeddingModel, text, kind === "query");
  }

  async function getEmbedding(text: string, subject: EgressSubject, kind: EmbedKind = "document", signal?: AbortSignal): Promise<number[]> {
    const cfg = config();
    const d = await providerCall<{ data?: [{ embedding?: unknown }] }>(cfg, "/embeddings", {
      model: cfg.embeddingModel,
      input: applyPrompt(cfg, text, kind),
      ...(cfg.dimensionsRequested ? { dimensions: cfg.embeddingDim } : {}),
    }, subject, signal);
    const embedding = d?.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error(`${cfg.embeddings.base} returned no embedding for model ${cfg.embeddingModel}`);
    }

    // Refuse a width the column cannot hold. Postgres would reject the insert
    // anyway, but the error surfaces as an opaque cast failure inside a tool
    // response; naming the model and both widths makes the cause obvious. A
    // same-width model from a different family is NOT detectable here — it
    // produces valid numbers that mean something else, which is why the model is
    // recorded in ob1_config and checked by preflight.
    const expected = cfg.embeddingDim;
    if (embedding.length !== expected) {
      // The cost of changing model is always worth stating; the truncation hint
      // is only worth stating when truncation could actually resolve it.
      const hint = cfg.dimensionsRequested
        ? ` OB1_EMBEDDING_DIMENSIONS=on was set, so the provider was asked for ${expected} and ` +
          `ignored it — not every provider or model supports the parameter.`
        : embedding.length > expected
          ? ` If the model supports Matryoshka truncation, set OB1_EMBEDDING_DIMENSIONS=on to ` +
            `request ${expected} instead of ${embedding.length}.`
          : "";
      throw new Error(
        `Embedding width mismatch: model ${cfg.embeddingModel} returned ${embedding.length} ` +
          `dimensions but thoughts.embedding is vector(${expected}). Changing embedding model ` +
          `requires a schema migration and re-embedding every existing row.${hint}`
      );
    }
    return embedding;
  }

  /**
   * Generate the blurb that situates one window in its document.
   *
   * Returns an empty text with the reason on any failure, and the caller
   * degrades to a bare window rather than failing the capture. That choice is the one this feature turns on, so it
   * is worth stating why: the alternative — fail the capture — makes one flaky
   * local model call lose a thought outright, which is the failure migration 008
   * spent a whole atomic-capture design avoiding. The usual objection to
   * degrading is that it produces a silently inconsistent corpus, and that
   * objection is answered by the column rather than by the policy:
   * `thought_chunks.context` is NULL for a window embedded bare, preflight counts
   * both kinds, and the capture response says so at the time.
   */
  async function contextualiseChunk(cfg: EmbedConfig, document: string, chunk: string, subject: EgressSubject, say: Say, signal?: AbortSignal): Promise<{ text: string; error?: string }> {
    // Filled by db/config.mjs's function, shared with evals/eval-contextual.ts,
    // so the harness measures the prompt the server sends; it is one pass with
    // a function, because two string replaces read `$&` and its relatives in
    // the document as substitution patterns and would drop the window into a
    // document that itself contains the literal `{chunk}`.
    const prompt = applyChunkContextPrompt(CHUNK_CONTEXT_PROMPTS.chunk, { document, chunk });
    const bare = (error: string) => {
      say(`contextualiseChunk: ${error}`);
      return { text: "", error };
    };
    try {
      const d = await providerCall<{ choices?: [{ message?: { content?: string } }] }>(cfg, "/chat/completions", {
        model: cfg.metadataModel,
        // The same two settings extractMetadata sends, for the same reason:
        // this is the other LLM call on the interactive capture path, and a
        // thinking model left to reason costs 5.5x the latency there.
        // `qwen3.8:27b` is suggested in db/config.mjs as an OB1_METADATA_MODEL,
        // so the case is real rather than hypothetical — and reasoning text
        // arriving in a blurb would be embedded along with it.
        temperature: cfg.metadataTemperature,
        ...cfg.metadataReasoning,
        messages: [{ role: "user", content: prompt }],
      }, subject, signal);
      const out = (d?.choices?.[0]?.message?.content ?? "").trim();
      // The rule lives in db/config.mjs so the benchmark applies the same one. A
      // blurb this file accepted and the harness rejected would mean every
      // measured number described text the server does not embed.
      if (!usableChunkContext(out, chunk)) {
        // The lengths go to the log, not the reason: the reasons are deduplicated
        // per capture, and a bulk pass writes them on the claim row.
        if (out) say(`contextualiseChunk: a ${out.length}-char blurb for a ${chunk.length}-char window`);
        return bare(out ? "the model returned a blurb longer than a blurb should be" : "the model returned an empty blurb");
      }
      return { text: out };
    } catch (e) {
      // The timeout lands here too, already named with the knob by providerCall;
      // the window goes in bare, as for any other failure of this call — and
      // so does an egress refusal of the CHAT endpoint (SMD-1903): the blurb
      // is enrichment, the window is stored bare with the reason, and the
      // embedding call is judged on its own endpoint. After the log's own
      // throw, `bare` throws its mark again (callLog). The caller's stop is
      // not the blurb's failure: the capture ends (SMD-2679).
      if (signal?.aborted) throw e;
      return bare((e as Error).message);
    }
  }

  /**
   * Embed a capture: one vector for `thoughts.embedding`, plus per-window vectors
   * when the content is too long to embed in a single provider call.
   *
   * Short content — nearly everything — takes exactly the path it always did: one
   * call, one vector, no chunk rows.
   *
   * ── Long content: the whole-content vector is kept ──────────────────────────
   * `thoughts.embedding` is the whole content's vector, and the windows go to
   * `thought_chunks`, so `match_thoughts` scores the thought as the best of both.
   *
   * It used to be the FIRST WINDOW's vector, on the reasoning that sending the
   * whole content would exceed the provider's batch and be silently truncated.
   * That reasoning was sound and is no longer true of the configured default:
   * `evals/eval-contextual.ts` measures the ceiling directly, by bisecting for the
   * shortest prefix that embeds to a bit-identical vector, and `qwen3-embedding:4b`
   * read all 15,812 characters of the longest real document in the corpus. The
   * head-window rule was discarding a vector the provider would have given us.
   *
   * Measured, on 37 queries that name a document's subject and ask for a detail
   * inside one window: keeping the whole-content vector scores 0.935 MRR against
   * 0.904 for windows alone — three queries better, none worse. On
   * `embeddinggemma`, which genuinely does truncate at ~8,150 characters, it is
   * still +0.020 with none worse: a head-truncated whole-content vector is a
   * longer head than the first window, not a worse one. The 426 unchunked
   * documents move by 0.001, which is noise.
   *
   * The cost is one extra provider call on the 3.4% of captures long enough to
   * chunk, and it is best-effort: a provider that REFUSES over-length input rather
   * than truncating it — which hosted APIs do, where Ollama truncates — must not
   * turn a capture that used to succeed into one that fails, so that failure falls
   * back to the old head-window behaviour.
   *
   * A long thought stored before this change still has its head window in
   * `thoughts.embedding`. `db/reembed.ts` is the backfill: it runs this same
   * function over every row. Preflight cannot report the split, because the
   * obvious detector — `thoughts.embedding` equal to chunk 0's — has a false
   * positive it cannot distinguish: a provider that refuses over-length input
   * produces exactly that state legitimately, for every long capture, forever.
   *
   * Windows are embedded concurrently; they are independent, and serialising them
   * would multiply the latency of a long capture for no benefit.
   *
   * WITH THE FLAG ON, that concurrency has a cost worth knowing before turning it
   * on. The blurbs are generated concurrently too, and each prompt carries the
   * WHOLE document — so a six-window capture fires six simultaneous generation
   * requests, each several thousand tokens, at whatever OB1_LLM_BASE_URL points
   * at. On a local box running a large model that is a real spike. It is left
   * concurrent rather than bounded because the alternative is six sequential
   * generations on the interactive capture path, and neither is obviously right:
   * anyone turning this on has already been told to measure it first.
   */
  async function embedCapture(content: string, subject: EgressSubject, say: Say, signal?: AbortSignal): Promise<EmbeddedCapture> {
    const cfg = config();
    const windows = chunkContent(content, { maxTokens: cfg.chunkTokens, threshold: cfg.chunkThreshold, overlapTokens: cfg.chunkOverlap });
    if (!windows.length) {
      return { embedding: await getEmbedding(content, subject, "document", signal), model: cfg.embeddingModel, chunks: [], contextFailures: 0, contextErrors: [], wholeContentFellBack: false, wholeContentRefused };
    }

    const wantContext = cfg.chunkContext;
    const blurbs = wantContext
      ? await Promise.all(windows.map((w) => contextualiseChunk(cfg, content, w.content, subject, say, signal)))
      : windows.map((): { text: string; error?: string } => ({ text: "" }));
    const contexts = blurbs.map((b) => b.text);

    // What this result reports: the remembered refusal, or this call's own —
    // with rememberRefusal off the latter is the only record there is.
    let refused = wholeContentRefused;
    let wholeContentError: string | undefined;
    const [whole, ...windowVectors] = await Promise.all([
      wholeContentRefused
        ? Promise.resolve(null)
        : getEmbedding(content, subject, "document", signal).catch((e: Error & { status?: number; body?: string }) => {
            // Nor is the caller's stop (SMD-2679): the capture ends with it.
            if (signal?.aborted) throw e;
            // An egress refusal is not a fallback (SMD-1903): the windows'
            // calls are refused on the same rule, so the head window cannot
            // stand in, and the caller — the server's edit path, the re-embed
            // — is told the text was not sent rather than that it fell back.
            if (e instanceof ProviderError && e.kind === "egress") throw e;
            // A 413, or a 400 that names the length, means the provider REFUSED
            // the input rather than truncating it, which is a fact about the
            // model and this input and will be just as true next time.
            // Remembering it (the server) turns a wasted round trip on every
            // long capture into one per process. A 5xx or a network error says
            // nothing durable, so it is never remembered — and neither is any
            // other 4xx: 429 is a rate limit, 408 a timeout, 401 and 403 a
            // credential, and a 400 for any other reason is not about length.
            // This used to latch on every 4xx, so one throttled call in a bulk
            // pass downgraded every later long thought to its head window while
            // recording success (first review of SMD-946).
            wholeContentError = e.message;
            if (refusesLength(e.status, e.body ?? "")) {
              refused = true;
              if (rememberRefusal) wholeContentRefused = true;
              say(
                `embedCapture: ${cfg.embeddingModel} refused the whole content (${e.status}); ` +
                  `falling back to the head window` +
                  (rememberRefusal ? ` here and skipping the attempt for the rest of this process.` : `.`)
              );
            } else {
              // Including a 400 whose words do not name the length: not known
              // to be about this input, so not remembered and not final.
              say(`embedCapture: whole-content embedding failed, using the head window: ${e.message}`);
            }
            return null;
          }),
      ...windows.map((w, i) => getEmbedding(composeChunkForEmbedding(contexts[i], w.content), subject, "document", signal)),
    ]);

    return {
      embedding: whole ?? windowVectors[0],
      model: cfg.embeddingModel,
      chunks: windows.map((w, i) => ({
        content: w.content,
        embedding: windowVectors[i],
        ...(contexts[i] ? { context: contexts[i] } : {}),
      })),
      contextFailures: wantContext ? contexts.filter((c) => !c).length : 0,
      contextErrors: [...new Set(blurbs.flatMap((b) => (b.error ? [b.error] : [])))],
      wholeContentFellBack: whole === null,
      wholeContentRefused: refused,
      wholeContentError,
    };
  }

  return {
    embedCapture: (content, subject, signal) => {
      const call = callLog();
      return embedCapture(content, subject, call.say, signal).catch((e: unknown) => {
        throw e instanceof LogThrow ? e.error : e;
      });
    },
    getEmbedding,
  };
}
