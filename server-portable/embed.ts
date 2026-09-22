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
 * either. index.ts passes `() => resolveEmbedConfig(env())` because it reads its
 * environment lazily (Cloudflare Workers bindings arrive per request);
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
  EXTRACT_WINDOW_HEADER,
  EXTRACT_RETRY_RUNAWAY,
  type ChunkTokensFrom,
  type ExtractWindowFrom,
} from "../db/config.mjs";
import { flagOn, mayLeaveBox, resolveEgressPolicy, type EgressDecision, type EgressPolicy, type EgressSubject } from "./egress.ts";

/** The environment keys this module reads. A subset of index.ts's Env. */
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
  /** The supersession judge's model, when it is not the metadata model (SMD-1901). */
  OB1_JUDGE_MODEL?: string;
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
 */
export async function providerCall<T>(cfg: EmbedConfig, path: "/embeddings" | "/chat/completions", body: unknown, subject: EgressSubject): Promise<T> {
  const what = path === "/embeddings" ? "Embeddings" : "Chat completion";
  // The endpoint the PATH selects, and the one every message below names: a
  // chat call that fails names the chat base, which since SMD-1902 need not be
  // the embeddings base.
  const at = endpointFor(cfg, path);
  const gate = mayLeaveBox(subject, at, cfg.egress);
  if (!gate.allowed) throw refuseEgress(what, at.base, gate);
  const timedOut = () =>
    new ProviderError(`${what} request to ${at.base} timed out after ${cfg.timeoutMs / 1000} s (OB1_LLM_TIMEOUT)`, "timeout");
  let r: Response;
  try {
    r = await fetch(`${at.base}${path}`, {
      method: "POST",
      headers: at.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
      // OB1_LLM_TIMEOUT is the one deadline: Bun's fetch would otherwise cut
      // an unstreamed call at its own 300 s idle timeout, so a longer value
      // here never took effect (measured for SMD-1879; entities.ts).
      timeout: false,
    });
  } catch (e) {
    // Named as what it is, with the knob, and WITHOUT a status: nothing about
    // the next attempt is known, so embedCapture treats it as transient.
    if ((e as Error).name === "TimeoutError") throw timedOut();
    throw e;
  }
  // The status is known from here on and must not be lost: a body that fails
  // to arrive after a 413 is still a 413 (the third review found a reset
  // mid-body turning a refusal into a transient, and failing a capture that
  // the metadata fallback exists to save). The deadline passing during the
  // body is the timeout; anything else leaves the body empty.
  let text = "";
  try {
    text = await r.text();
  } catch (e) {
    if ((e as Error).name === "TimeoutError") throw timedOut();
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
  /** Base URL, trailing slashes stripped. */
  base: string;
  /**
   * The credential, when there is one. Preflight reports that it is set and how
   * long it is, never the value; everything else reads `headers`.
   */
  key: string | undefined;
  /** Request headers; carries Authorization only when there is a key. */
  headers: Record<string, string>;
  /**
   * Declared on this machine or its private network — OB1_LLM_LOCAL /
   * OB1_CHAT_LOCAL — so the egress gate does not apply (SMD-1903). Declared,
   * not guessed: a loopback address with the flag unset is remote here, even
   * where preflight's credential rule calls it local.
   */
  local: boolean;
  /** The knob that declared it, when `local`: what a row or a banner names (second review pass). */
  declaredBy?: "OB1_LLM_LOCAL" | "OB1_CHAT_LOCAL";
};

/** An endpoint from its parts, with the one header rule every call shares. */
export function providerEndpoint(base: string, key: string | undefined, local = false, declaredBy?: "OB1_LLM_LOCAL" | "OB1_CHAT_LOCAL"): ProviderEndpoint {
  return {
    base: base.replace(/\/+$/, ""),
    key,
    local,
    ...(local && declaredBy ? { declaredBy } : {}),
    // A local endpoint needs no credential, so the key is optional there.
    // Sending `Authorization: Bearer undefined` to Ollama is harmless but
    // confusing in logs, so the header is omitted entirely when there is no key.
    headers: key
      ? { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
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
 * that is a different endpoint gets `OB1_CHAT_API_KEY` and nothing else: a
 * local chat model beside a hosted embedder (the Edge0 shape, SMD-1880) must
 * not be handed the hosted provider's key, and there is no other way to say
 * "no key here" while `OB1_LLM_API_KEY` is set (empty means unset throughout).
 * Two spellings of the same base are the same endpoint and share the key. A
 * hosted chat base with no key of its own is a configuration preflight fails
 * by name, not one this function papers over.
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
  const embeddings = providerEndpoint(baseUrlOr(env.OB1_LLM_BASE_URL, DEFAULT_LLM_BASE_URL), env.OB1_LLM_API_KEY || env.OPENROUTER_API_KEY, flagOn(env.OB1_LLM_LOCAL), "OB1_LLM_LOCAL");
  const chatBase = baseUrlOr(env.OB1_CHAT_BASE_URL, embeddings.base);
  const chatFlag = flagOn(env.OB1_CHAT_LOCAL);
  const chat = providerEndpoint(chatBase, env.OB1_CHAT_API_KEY, chatFlag || (chatBase === embeddings.base && embeddings.local), chatFlag ? "OB1_CHAT_LOCAL" : "OB1_LLM_LOCAL");
  // No key of its own and the same base: it IS the embeddings endpoint, key
  // and all — declared local by either knob, and the knob that did travels
  // with it. Anything else — its own key, or a different base — stands alone.
  if (!chat.key && chat.base === embeddings.base) {
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
  /** The metadata model's served context in KNOWN_CHAT_MODEL_WINDOW, when it has one. */
  extractModelWindow: number | undefined;
  /** Overlap between extraction windows: chunk.ts's ratio of the window (150 of 1200). */
  extractChunkOverlap: number;
  /** Whether a window after the first carries the note's opening line — entities.ts's documentHeader; measured in evals/README.md. */
  extractHeader: boolean;
  /** Whether a call that ran to its answer budget is retried once with a frequency penalty; measured in evals/README.md. */
  extractRetryRunaway: boolean;
  /**
   * The model the supersession judge (consolidate.ts) runs on: OB1_JUDGE_MODEL,
   * else the metadata model. The two tasks were one knob, so the only way to
   * judge with a stronger model was to tag every capture with it too; SMD-1873
   * measured them apart on one 7B — extraction fine, the judge at floor
   * confidence on every pair. The pass key carries this name (consolidateKey),
   * so a change starts a fresh pass rather than mixing judgements (SMD-1901).
   */
  judgeModel: string;
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
    extractModelWindow: extract.window,
    extractChunkOverlap: Math.floor(extract.tokens * EXTRACT_OVERLAP_RATIO),
    extractHeader: EXTRACT_WINDOW_HEADER,
    extractRetryRunaway: EXTRACT_RETRY_RUNAWAY,
    // Trimmed like its sibling (SMD-1843): the judge's own knob, else the
    // metadata model as resolved above.
    judgeModel: stringOr(env.OB1_JUDGE_MODEL, metadataModel),
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
   */
  embedCapture(content: string, subject: EgressSubject): Promise<EmbeddedCapture>;
  /** One embedding. `kind` selects the query template over the document one; `subject` as above. */
  getEmbedding(text: string, subject: EgressSubject, kind?: EmbedKind): Promise<number[]>;
};

/**
 * Build an embedder over a configuration source. The source is a function
 * because index.ts reads its environment lazily; it is called on every request
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
export function createEmbedder(config: () => EmbedConfig, opts: { rememberRefusal?: boolean } = {}): Embedder {
  const rememberRefusal = opts.rememberRefusal ?? true;
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

  async function getEmbedding(text: string, subject: EgressSubject, kind: EmbedKind = "document"): Promise<number[]> {
    const cfg = config();
    const d = await providerCall<{ data?: [{ embedding?: unknown }] }>(cfg, "/embeddings", {
      model: cfg.embeddingModel,
      input: applyPrompt(cfg, text, kind),
      ...(cfg.dimensionsRequested ? { dimensions: cfg.embeddingDim } : {}),
    }, subject);
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
  async function contextualiseChunk(cfg: EmbedConfig, document: string, chunk: string, subject: EgressSubject): Promise<{ text: string; error?: string }> {
    // Filled by db/config.mjs's function, shared with evals/eval-contextual.ts,
    // so the harness measures the prompt the server sends; it is one pass with
    // a function, because two string replaces read `$&` and its relatives in
    // the document as substitution patterns and would drop the window into a
    // document that itself contains the literal `{chunk}`.
    const prompt = applyChunkContextPrompt(CHUNK_CONTEXT_PROMPTS.chunk, { document, chunk });
    const bare = (error: string) => {
      console.error(`contextualiseChunk: ${error}`);
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
      }, subject);
      const out = (d?.choices?.[0]?.message?.content ?? "").trim();
      // The rule lives in db/config.mjs so the benchmark applies the same one. A
      // blurb this file accepted and the harness rejected would mean every
      // measured number described text the server does not embed.
      if (!usableChunkContext(out, chunk)) {
        // The lengths go to the log, not the reason: the reasons are deduplicated
        // per capture, and a bulk pass writes them on the claim row.
        if (out) console.error(`contextualiseChunk: a ${out.length}-char blurb for a ${chunk.length}-char window`);
        return bare(out ? "the model returned a blurb longer than a blurb should be" : "the model returned an empty blurb");
      }
      return { text: out };
    } catch (e) {
      // The timeout lands here too, already named with the knob by providerCall;
      // the window goes in bare, as for any other failure of this call — and
      // so does an egress refusal of the CHAT endpoint (SMD-1903): the blurb
      // is enrichment, the window is stored bare with the reason, and the
      // embedding call is judged on its own endpoint.
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
  async function embedCapture(content: string, subject: EgressSubject): Promise<EmbeddedCapture> {
    const cfg = config();
    const windows = chunkContent(content, { maxTokens: cfg.chunkTokens, threshold: cfg.chunkThreshold, overlapTokens: cfg.chunkOverlap });
    if (!windows.length) {
      return { embedding: await getEmbedding(content, subject), model: cfg.embeddingModel, chunks: [], contextFailures: 0, contextErrors: [], wholeContentFellBack: false, wholeContentRefused };
    }

    const wantContext = cfg.chunkContext;
    const blurbs = wantContext
      ? await Promise.all(windows.map((w) => contextualiseChunk(cfg, content, w.content, subject)))
      : windows.map((): { text: string; error?: string } => ({ text: "" }));
    const contexts = blurbs.map((b) => b.text);

    // What this result reports: the remembered refusal, or this call's own —
    // with rememberRefusal off the latter is the only record there is.
    let refused = wholeContentRefused;
    let wholeContentError: string | undefined;
    const [whole, ...windowVectors] = await Promise.all([
      wholeContentRefused
        ? Promise.resolve(null)
        : getEmbedding(content, subject).catch((e: Error & { status?: number; body?: string }) => {
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
              console.error(
                `embedCapture: ${cfg.embeddingModel} refused the whole content (${e.status}); ` +
                  `falling back to the head window` +
                  (rememberRefusal ? ` here and skipping the attempt for the rest of this process.` : `.`)
              );
            } else {
              // Including a 400 whose words do not name the length: not known
              // to be about this input, so not remembered and not final.
              console.error(`embedCapture: whole-content embedding failed, using the head window: ${e.message}`);
            }
            return null;
          }),
      ...windows.map((w, i) => getEmbedding(composeChunkForEmbedding(contexts[i], w.content), subject)),
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

  return { embedCapture, getEmbedding };
}
