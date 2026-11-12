// An embedding call's failure as a coded refusal (SMD-2892), for the three
// request-time callers that cannot do without the vector: a search whose
// provider answered an error that is no outage, a capture likewise, and an
// edit whose provider did not answer or answered an error. A gate's refusal, a
// width mismatch or a runtime error no outage names is still thrown. Before it the provider's error was
// thrown, and reached the caller raw: a search's FAILED 500, a capture's
// STORE_UNAVAILABLE (retryable, naming the store), each carrying the
// provider's body under the base it was sent to.

import { providerFault, ProviderError, shownBase, type ProviderEndpoint } from "../embed.ts";
import type { Refusal } from "./refusal.ts";

export type EmbeddingProviderError = Extract<Refusal, { code: "EMBEDDING_PROVIDER_ERROR" }>;

/**
 * The settings to look at, by what the provider answered (review pass 3: a REST caller was told only the base, a
 * key's or a model's refusal included): the key for a 401, 402 or 403, the model for a 404, the model and its width
 * for a 400, 413 or 422, the base alone for a redirect, a body or an outage. Names, never values.
 */
export function checksFor(status: number | undefined, retryable: boolean): string[] {
  if (retryable || status === undefined) return [];
  if (status === 401 || status === 402 || status === 403) return ["OB1_LLM_API_KEY", "OPENROUTER_API_KEY"];
  if (status === 404) return ["OB1_EMBEDDING_MODEL"];
  if (status === 400 || status === 413 || status === 422) return ["OB1_EMBEDDING_MODEL", "OB1_EMBEDDING_DIM"];
  return [];
}

/**
 * What a log line says of a provider's failure: its message, and for a body error (a gateway's error object, a proxy's
 * page) the words it answered, which the message leaves out (review pass 3: the operator's log said less than a
 * reader's reply). Capped as the reply's are.
 */
export function providerLogWords(e: unknown): string {
  const message = (e as Error)?.message ?? String(e);
  return e instanceof ProviderError && e.kind === "body" && e.body ? `${message} — it said: ${e.body.slice(0, 200)}` : message;
}

/**
 * The refusal for `e`, or null for what is no provider's answer (embed.ts
 * providerFault: the gate's refusal, a width mismatch), which the caller
 * still throws. `reader`: whether the caller may be told where the provider
 * is and what it said — a capture-only key is told neither (SMD-2284's rule
 * for a capture's provider, render.ts's and the REST core's capturedFor).
 */
export function embeddingProviderError(e: unknown, at: Pick<ProviderEndpoint, "base" | "userinfo">, reader: boolean): EmbeddingProviderError | null {
  const f = providerFault(e);
  if (!f) return null;
  return {
    code: "EMBEDDING_PROVIDER_ERROR", retryable: f.retryable, reason: f.reason, detail: f.detail,
    ...(f.status !== undefined ? { status: f.status } : {}), setting: "OB1_LLM_BASE_URL", check: checksFor(f.status, f.retryable),
    ...(reader ? { base: shownBase(at), ...(f.provider ? { provider: f.provider } : {}) } : {}),
  };
}
