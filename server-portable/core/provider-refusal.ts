// An embedding call's failure as a coded refusal (SMD-2892), for the three
// request-time callers that cannot do without the vector: a search whose
// provider answered an error that is no outage, a capture likewise, and an
// edit whose provider did not answer or answered an error. A gate's refusal, a
// width mismatch or a runtime error no outage names is still thrown. Before it the provider's error was
// thrown, and reached the caller raw: a search's FAILED 500, a capture's
// STORE_UNAVAILABLE (retryable, naming the store), each carrying the
// provider's body under the base it was sent to.

import { isRedirect, providerFault, ProviderError, shownBase, type ProviderEndpoint } from "../embed.ts";
import { oneLine } from "../consolidate.ts";
import type { Refusal } from "./refusal.ts";

export type EmbeddingProviderError = Extract<Refusal, { code: "EMBEDDING_PROVIDER_ERROR" }>;

/** What a provider's final answer points at, by its status: the one table `check` and the reply's advice read (review pass 5: three tables drifted). */
export type ProviderAnswerClass = "key" | "credit" | "model" | "redirect" | "request" | "body" | "other";
export function answerClass(status: number | undefined, reason: string): ProviderAnswerClass {
  if (reason === "provider_body") return "body";
  if (status === 401 || status === 403) return "key";
  if (status === 402) return "credit";
  if (status === 404) return "model";
  if (status !== undefined && isRedirect(status)) return "redirect";
  if (status === 400 || status === 413 || status === 422) return "request";
  return "other";
}

/**
 * The settings to look at, by what the provider answered (review pass 3: a REST caller was told only the base, a
 * key's or a model's refusal included): the key for a 401, 402 or 403, the model for a 404, the model and its width
 * for a 400, 413 or 422, the base alone otherwise — a redirect, a body, an outage (whose status is an outage's, none of
 * these). Names, never values.
 */
export function checksFor(status: number | undefined, reason: string): string[] {
  switch (answerClass(status, reason)) {
    case "key": case "credit": return ["OB1_LLM_API_KEY", "OPENROUTER_API_KEY"];
    case "model": return ["OB1_EMBEDDING_MODEL"];
    case "request": return ["OB1_EMBEDDING_MODEL", "OB1_EMBEDDING_DIM"];
    default: return [];
  }
}

/** The reply's advice for a final refusal, by the same class: what an operator checks, and that a retry will not help until then. */
export function adviceFor(r: Pick<EmbeddingProviderError, "status" | "reason" | "setting">): string {
  const key = "(OB1_LLM_API_KEY, else OPENROUTER_API_KEY)";
  const wait = "retrying will not help until then.";
  switch (answerClass(r.status, r.reason)) {
    case "key": return `An operator checks ${r.setting} and its key ${key}; ${wait}`;
    case "credit": return `An operator checks the credit of the account behind its key ${key}; ${wait}`;
    case "model": return `An operator checks ${r.setting} and the embedding model it serves (OB1_EMBEDDING_MODEL); ${wait}`;
    case "redirect": return `An operator sets ${r.setting} where it points; ${wait}`;
    case "request": return `It may be a setting it is sent with (OB1_EMBEDDING_MODEL, OB1_EMBEDDING_DIM), which an operator checks, or this text (a shorter or plainer one may land).`;
    case "body": return `Something in front of the provider (a proxy, a gateway) may be answering for it: an operator checks ${r.setting}; ${wait}`;
    default: return `An operator checks ${r.setting}; ${wait}`;
  }
}

/** Invisible characters a reader would not see but a model reads: zero-width, bidi embeddings and isolates, tags. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

/**
 * The provider's own words as a reply tells them or a log line prints them (SMD-2892 review pass 4): the brain's own
 * key, and anything shaped like a credential, redacted — an endpoint that echoes the request sends the brain's
 * Authorization back, and a reader key must never read it; invisible characters dropped; one line, so a provider
 * forges no log line or reply line of its own; capped.
 */
export function providerSaid(words: string, at: Pick<ProviderEndpoint, "key">, cap = 500): string {
  let s = words;
  // A key of eight characters or more, as any real one is: a shorter placeholder (a stub's "stub") would blank words.
  if (at.key && at.key.length >= 8) s = s.split(at.key).join("[redacted]");
  s = s.replace(/\b(Bearer|Basic|Token)\s+(?=[A-Za-z0-9._~+/=-]*[0-9=])[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]").replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
  return oneLine(s.replace(INVISIBLE, "")).slice(0, cap);
}

/**
 * What a log line says of a provider's failure: its message, and for a body error (a gateway's error object, a proxy's
 * page) the words it answered, which the message leaves out (review pass 3: the operator's log said less than a
 * reader's reply) — cleaned as a reply's are (review pass 4: raw, they forged log lines and carried terminal escapes).
 */
export function providerLogWords(e: unknown, at: Pick<ProviderEndpoint, "key">): string {
  const message = (e as Error)?.message ?? String(e);
  return providerSaid(e instanceof ProviderError && e.kind === "body" && e.body ? `${message} — it said: ${e.body}` : message, at, 800);
}

/**
 * The refusal for `e`, or null for what is no provider's answer (embed.ts
 * providerFault: the gate's refusal, a width mismatch), which the caller
 * still throws. `reader`: whether the caller may be told where the provider
 * is and what it said — a capture-only key is told neither (SMD-2284's rule
 * for a capture's provider, render.ts's and the REST core's capturedFor).
 */
export function embeddingProviderError(e: unknown, at: Pick<ProviderEndpoint, "base" | "userinfo" | "key">, reader: boolean): EmbeddingProviderError | null {
  const f = providerFault(e);
  if (!f) return null;
  return {
    code: "EMBEDDING_PROVIDER_ERROR", retryable: f.retryable, reason: f.reason, detail: f.detail,
    ...(f.status !== undefined ? { status: f.status } : {}), setting: "OB1_LLM_BASE_URL", check: f.retryable ? [] : checksFor(f.status, f.reason),
    ...(reader ? { base: shownBase(at), ...(f.provider ? { provider: providerSaid(f.provider, at) } : {}) } : {}),
  };
}
