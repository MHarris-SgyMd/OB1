// A plugin handler's model call (SMD-2690 PR 3a): one chat completion through
// the brain's own provider path, so a plugin never reaches a provider itself.
// The call is the core's providerCall (embed.ts): the egress gate judges it
// before any request exists, the model-call seam (model-call.ts) holds and
// measures it, and OB1_LLM_TIMEOUT bounds it. The model is the brain's
// classifier, OB1_METADATA_MODEL, on its chat endpoint: a plugin names what to
// ask, never where or of whom. SMD-3478 is the same call for a workflow's run.

import { ProviderError, providerCall, providerDown, type EmbedConfig } from "../embed.ts";
import { hostOf, termMatches, type EgressSubject } from "../egress.ts";

/** The bounds on one call's input: each text, and the answer's tokens. */
export const MODEL_LIMITS = { text: 100_000, maxTokens: 8_192 } as const;

/** What a handler asks: a system prompt, the user's text, and how to answer. */
export type ModelRequest = {
  /** The instructions; none, and the model reads the user's text alone. */
  system?: string;
  /** The text to work on: required, at most MODEL_LIMITS.text characters. */
  user: string;
  /** Ask for a JSON object, and parse the answer as one. */
  json?: boolean;
  /** 0 to 2; the brain's classifier temperature (OB1_METADATA_TEMPERATURE) when absent. */
  temperature?: number;
  /** The answer's cap, 1 to MODEL_LIMITS.maxTokens; the provider's default when absent. */
  max_tokens?: number;
};

/**
 * Why a call answered no text. None is a fault: a runtime error that is not
 * the provider's (a bug, the store) is thrown, as ctx.call's are.
 * - REFUSED_INPUT: the request is outside the bounds above.
 * - REFUSED_EGRESS: the egress gate kept the text in (`reason` names the rule); nothing was sent.
 * - PROVIDER_UNAVAILABLE: the provider did not answer — the deadline, a 5xx, 408 or 429, or no
 *   connection (providerDown's rule, the capture path's) — so the same call may answer later.
 * - PROVIDER_REFUSED: it answered with another error status (`provider`, its own words), a body that
 *   is not JSON, or no message (`finish_reason: "length"` when it spent max_tokens first). Logged, as
 *   capture's metadata call logs it, so an operator sees a model or a field the provider refuses.
 * - NOT_JSON: `json` was asked and the answer is no JSON object (`finish_reason: "length"` when it
 *   was cut off at max_tokens).
 */
export type ModelRefusal =
  | { code: "REFUSED_INPUT"; retryable: false; message: string }
  | { code: "REFUSED_EGRESS"; retryable: false; to: string; reason: string }
  | { code: "PROVIDER_UNAVAILABLE"; retryable: true; to: string; reason: string; detail: string }
  | { code: "PROVIDER_REFUSED"; retryable: false; to: string; status?: number; detail: string; provider?: string; finish_reason?: string }
  | { code: "NOT_JSON"; retryable: false; detail: string; finish_reason?: string };

/**
 * The answer: the model's text, the object parsed from it when `json` was
 * asked, the model that answered, and why it stopped (`length`: cut off at
 * max_tokens) when the provider says.
 */
export type ModelAnswer =
  | { ok: true; value: { text: string; json?: Record<string, unknown>; model: string; finish_reason?: string } }
  | { ok: false; refusal: ModelRefusal };

const refusedInput = (message: string): ModelAnswer => ({ ok: false, refusal: { code: "REFUSED_INPUT", retryable: false, message } });

/** The request's problem, or null: every field typed and within its bound. */
function requestProblem(req: ModelRequest): string | null {
  if (typeof req !== "object" || req === null) return "the request is no object";
  if (typeof req.user !== "string" || req.user.length === 0) return "user is required: the text to work on";
  if (req.user.length > MODEL_LIMITS.text) return `user is ${req.user.length} characters; at most ${MODEL_LIMITS.text}`;
  if (req.system !== undefined && typeof req.system !== "string") return "system is no string";
  if (typeof req.system === "string" && req.system.length > MODEL_LIMITS.text) return `system is ${req.system.length} characters; at most ${MODEL_LIMITS.text}`;
  if (req.json !== undefined && typeof req.json !== "boolean") return "json is no boolean";
  if (req.temperature !== undefined && !(typeof req.temperature === "number" && req.temperature >= 0 && req.temperature <= 2)) return "temperature is no number from 0 to 2";
  if (req.max_tokens !== undefined && !(Number.isInteger(req.max_tokens) && req.max_tokens >= 1 && req.max_tokens <= MODEL_LIMITS.maxTokens)) {
    return `max_tokens is no whole number from 1 to ${MODEL_LIMITS.maxTokens}`;
  }
  return null;
}

/** The object a JSON answer holds, its code fence (a model's habit) let go; null for anything else. */
function jsonObjectOf(text: string): Record<string, unknown> | null {
  const bare = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const v: unknown = JSON.parse(bare);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A message's text: a string, or (as some OpenAI-compatible servers answer) its text parts joined; null for none. */
function contentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? [(p as { text: string }).text] : []));
  return parts.length ? parts.join("") : null;
}

/** Who asks: the caller's key's name and the plugin whose operation it called. One object, so the two names cannot trade places. */
export type ModelCaller = { actor: string; plugin: string };

/**
 * One chat call for a plugin's handler, made as the caller's key. The egress
 * subject is the plugin's: its actor, the plugin (the `plugin` unit:
 * `OB1_EGRESS_ALLOW=plugin:<name>` alone lets it out under deny; a deny term
 * of any unit holds it), and the user text as its content. The system prompt
 * is the plugin's own words, so the subject leaves it out; a deny marker is
 * also read against it, where keeping a call in fails safe: brain text a
 * plugin put there (as it must not) is still held back. The brain's or the
 * caller's text belongs in `user`.
 */
export async function pluginChat(cfg: EmbedConfig, { actor, plugin }: ModelCaller, req: ModelRequest): Promise<ModelAnswer> {
  const problem = requestProblem(req);
  if (problem) return refusedInput(problem);
  const to = hostOf(cfg.chat.base);
  const subject: EgressSubject = { kind: "plugin", actor, plugin, content: req.user };
  if (req.system && !cfg.chat.local && cfg.egress.mode === "allow") {
    // The system text alone, no actor or plugin, so only a marker can match it. An actor: or plugin: deny term is the
    // gate's to name, on the user subject below — read here it would blame the system text for the key's or plugin's.
    const hit = cfg.egress.deny.find((t) => termMatches(t, { kind: "plugin", content: req.system }));
    if (hit) {
      return { ok: false, refusal: { code: "REFUSED_EGRESS", retryable: false, to, reason: `OB1_EGRESS_DENY ${hit.unit}:${hit.value} matches this plugin's system text — the text was not sent to ${to}` } };
    }
  }
  const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.user }];
  let answer: { model?: unknown; choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] };
  try {
    answer = await providerCall(cfg, "/chat/completions", {
      model: cfg.metadataModel,
      ...cfg.metadataReasoning,
      temperature: req.temperature ?? cfg.metadataTemperature,
      ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
      messages,
    }, subject);
  } catch (e) {
    // The gate's own sentence, its rule and knob, without the base the message leads with: `to` names the host.
    if (e instanceof ProviderError && e.kind === "egress") {
      return { ok: false, refusal: { code: "REFUSED_EGRESS", retryable: false, to, reason: e.message.replace(/^.*? refused by the egress gate: /, "") } };
    }
    const down = providerDown(e);
    if (down) return { ok: false, refusal: { code: "PROVIDER_UNAVAILABLE", retryable: true, to, reason: down.reason, detail: down.detail } };
    if (e instanceof ProviderError) {
      // Logged as capture's metadata call logs it (the provider's capped words, never the text sent): a model the
      // provider does not serve, or a field it refuses, is the operator's to see, not only the plugin's.
      console.error(`ctx.model (plugin ${plugin}): ${e.message}`);
      return {
        ok: false,
        refusal: {
          code: "PROVIDER_REFUSED", retryable: false, to, ...(e.status !== undefined ? { status: e.status } : {}),
          detail: e.kind === "body" ? "its answer is not JSON" : `it answered ${e.status ?? e.kind}`, ...(e.body ? { provider: e.body } : {}),
        },
      };
    }
    throw e;
  }
  const choice = answer?.choices?.[0];
  const finish = typeof choice?.finish_reason === "string" ? { finish_reason: choice.finish_reason } : {};
  const text = contentText(choice?.message?.content);
  if (text === null) {
    const detail = finish.finish_reason === "length" ? "it spent max_tokens before any answer" : "its answer holds no message";
    console.error(`ctx.model (plugin ${plugin}): ${to} answered no message${finish.finish_reason ? ` (finish_reason ${finish.finish_reason})` : ""}`);
    return { ok: false, refusal: { code: "PROVIDER_REFUSED", retryable: false, to, detail, ...finish } };
  }
  const model = typeof answer.model === "string" && answer.model ? answer.model : cfg.metadataModel;
  if (!req.json) return { ok: true, value: { text, model, ...finish } };
  const json = jsonObjectOf(text);
  if (!json) {
    const cut = finish.finish_reason === "length" ? ", cut off at max_tokens" : "";
    return { ok: false, refusal: { code: "NOT_JSON", retryable: false, detail: `the answer (${text.length} characters${cut}) is no JSON object`, ...finish } };
  }
  return { ok: true, value: { text, json, model, ...finish } };
}
