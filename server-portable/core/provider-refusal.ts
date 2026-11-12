// An embedding call's failure as a coded refusal (SMD-2892), for the three
// request-time callers that cannot do without the vector: a search whose
// provider answered an error that is no outage, a capture likewise, and an
// edit whose provider did not answer or answered an error. A gate's refusal, a
// width mismatch or a runtime error no outage names is still thrown. Before it the provider's error was
// thrown, and reached the caller raw: a search's FAILED 500, a capture's
// STORE_UNAVAILABLE (retryable, naming the store), each carrying the
// provider's body under the base it was sent to.

import { providerFault, shownBase, type ProviderEndpoint } from "../embed.ts";
import type { Refusal } from "./refusal.ts";

export type EmbeddingProviderError = Extract<Refusal, { code: "EMBEDDING_PROVIDER_ERROR" }>;

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
    ...(f.status !== undefined ? { status: f.status } : {}), setting: "OB1_LLM_BASE_URL",
    ...(reader ? { base: shownBase(at), ...(f.provider ? { provider: f.provider } : {}) } : {}),
  };
}
