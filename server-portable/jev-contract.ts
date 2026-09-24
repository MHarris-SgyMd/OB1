/**
 * jev-contract.ts — the wire contract of the typed-decision tier (SMD-2050).
 *
 * A Jev-class model answers a bounded question in one forward pass with a
 * calibrated probability: "is this proposition true of this context?", or
 * "which of these options?" — no generation, so nothing to parse, repair or
 * retry. That is not the chat/completions shape, and shaping it as one would
 * make every caller pretend a classifier is a generator. So the tier has its
 * own contract, and this file is all of it: the request, the answer, the
 * limits and the one validation rule, with no imports, so the serving process
 * (jev/serve.ts) and the client (jev.ts) read the same bytes — and a second
 * model behind the same contract (SemIf, the follow-up) implements this JSON
 * and nothing else.
 *
 *   GET  {base}/health   "ok" once the model is loaded (HEAD too)
 *   GET  {base}/info     JevInfo: the contract, the model and its pins, the limits
 *   POST {base}/decide   JevRequest → JevResponse, or { error } with
 *                        400 malformed (jevRequestProblem), 409 another model,
 *                        413 over JEV_MAX_BODY_BYTES, 422 a decision this model
 *                        cannot read faithfully (its own markers in the text,
 *                        labels past its token budget — the whole request is
 *                        refused, naming the decision), 499 the caller left
 *                        before its turn, 500 the model failed
 *
 * Probabilities are conditional on the options supplied, and the tier always
 * adds one of its own — INSUFFICIENT_EVIDENCE — so a model can decline rather
 * than pick the least-bad option. What a caller does with a probability (its
 * threshold, its abstain rule) is the caller's; the tier reports, with the raw
 * logits and the temperature it applied, so a spike can recalibrate on its own
 * workload without a second serving path.
 */

/** Named in every answer; a client refuses an answer under any other. */
export const JEV_CONTRACT = "ob1-jev/1";

/** The option the tier adds to every decision: the model may say it cannot tell. */
export const INSUFFICIENT_EVIDENCE = "__insufficient_evidence__";

/** Options a caller may supply to one choice (the model's 25 slots, less the tier's own). */
export const JEV_MAX_OPTIONS = 24;

/** Decisions in one request; the client packs a longer list into requests under this and JEV_MAX_BODY_BYTES. */
export const JEV_MAX_BATCH = 64;

/**
 * Characters in any one text field, the decision's id included. The model
 * reads 512 tokens, so for the texts this only bounds the tokenizer's work;
 * for every field it is what JEV_MAX_BODY_BYTES is derived from.
 */
export const JEV_MAX_TEXT = 20_000;

/**
 * Bytes in one request body. Chosen so the largest decision the rule above
 * accepts always fits in a request of its own: a choice has at most 51 text
 * fields (its id, question, context, 24 option ids, 24 descriptions) of 20,000
 * UTF-16 units — the id too, since the second review pass: an unbounded id
 * made a decision no request could hold — and a unit costs at most 6 bytes of
 * JSON (a control character written as \u00XX), so 6.1 MB. The client packs decisions into requests under both this
 * and JEV_MAX_BATCH (first review pass: the cap was 2 MB, and 64 valid
 * decisions of 20,000 characters made a 2.5 MB request the service refused).
 */
export const JEV_MAX_BODY_BYTES = 8 * 2 ** 20;

/**
 * One decision. `binary`: is `proposition` true of `context` — the caller
 * writes the span into the proposition, since how a span is phrased is what
 * each consumer measures. `choice`: which option answers `question` about
 * `context`. `id` is the caller's and comes back on the result.
 */
export type JevDecision =
  | { id?: string; kind: "binary"; proposition: string; context: string }
  | { id?: string; kind: "choice"; question: string; options: JevOption[]; context: string };

export type JevOption = { id: string; description: string };

export type JevRequest = {
  /** The model the caller expects; a service serving another answers 409. Absent: whatever it serves. */
  model?: string;
  decisions: JevDecision[];
};

/**
 * What decided, pinned: enough to reproduce the probability and to record it
 * as provenance. The weights alone are not — the same weights under two
 * prompt engines answer differently (jev/README.md, "Conformance") — so
 * `rules` names the prompt and calibration rules too.
 */
export type JevModelInfo = {
  /** The name OB1_JEV_MODEL compares against, e.g. `verdict-v1.4`. */
  name: string;
  /** Where the weights come from, e.g. a Hugging Face repository. */
  source: string;
  /** The source's revision the weights were fetched at. */
  revision: string;
  /** sha256 of the weights file the service verified before loading. */
  weights_sha256: string;
  /** sha256 of the calibration the probabilities are scaled by. */
  calibrator_sha256: string;
  /**
   * The rules a prompt is built and scaled by: the reference engine's
   * revision and a fingerprint the service computes from its own prompt,
   * budget and temperature rules, so it changes whenever they do — not a
   * version someone has to remember to bump (third review pass).
   */
  rules: string;
};

export type JevInfo = {
  contract: string;
  model: JevModelInfo;
  kinds: JevDecision["kind"][];
  max_options: number;
  max_batch: number;
  /** Tokens the model reads; a longer context is truncated and its result says so, labels that do not fit are refused (422). */
  max_tokens: number;
};

export type JevResult = {
  id?: string;
  kind: JevDecision["kind"];
  /**
   * Every option's probability, INSUFFICIENT_EVIDENCE included, summing to 1.
   * A binary decision's options are `true` and `false`.
   */
  probabilities: Record<string, number>;
  /** The most probable option — INSUFFICIENT_EVIDENCE when the model declines. */
  selected: string;
  /** selected is INSUFFICIENT_EVIDENCE. */
  abstained: boolean;
  p_insufficient: number;
  /** Binary only: P(true | the evidence suffices) — true's share of true + false. Null when both are 0. */
  p_true?: number | null;
  /** The raw scores, in the order of `probabilities`' keys, before the temperature. */
  logits: number[];
  temperature: number;
  /** Tokens the model read, and whether the input was cut to fit. */
  tokens: number;
  truncated: boolean;
};

export type JevResponse = {
  contract: string;
  model: JevModelInfo;
  results: JevResult[];
  /** Wall time the service spent on the request. */
  ms: number;
};

const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= JEV_MAX_TEXT;

/**
 * The one validation rule, read by both sides: the client before it sends (a
 * bad request fails at the caller, with the caller's index), the service
 * before it tokenizes. Null when the request is well formed, else the first
 * problem, naming the decision.
 */
export function jevRequestProblem(body: unknown): string | null {
  if (!body || typeof body !== "object") return "the body is not a JSON object";
  const { model, decisions } = body as { model?: unknown; decisions?: unknown };
  if (model !== undefined && !text(model)) return "`model`, when given, is a non-empty string";
  if (!Array.isArray(decisions) || decisions.length === 0) return "`decisions` is a non-empty array";
  if (decisions.length > JEV_MAX_BATCH) return `${decisions.length} decisions in one request; at most ${JEV_MAX_BATCH}`;
  for (const [i, d] of decisions.entries()) {
    const at = `decision ${i}`;
    if (!d || typeof d !== "object") return `${at} is not an object`;
    const { id, kind, context } = d as Record<string, unknown>;
    if (id !== undefined && (typeof id !== "string" || id.length > JEV_MAX_TEXT)) return `${at}: \`id\`, when given, is a string of at most ${JEV_MAX_TEXT} characters`;
    if (!text(context)) return `${at}: \`context\` is a non-empty string of at most ${JEV_MAX_TEXT} characters`;
    if (kind === "binary") {
      if (!text((d as { proposition?: unknown }).proposition)) return `${at}: a binary decision's \`proposition\` is a non-empty string of at most ${JEV_MAX_TEXT} characters`;
    } else if (kind === "choice") {
      const { question, options } = d as { question?: unknown; options?: unknown };
      if (!text(question)) return `${at}: a choice's \`question\` is a non-empty string of at most ${JEV_MAX_TEXT} characters`;
      if (!Array.isArray(options) || options.length === 0 || options.length > JEV_MAX_OPTIONS) return `${at}: a choice has 1 to ${JEV_MAX_OPTIONS} options`;
      const seen = new Set<string>();
      for (const [j, o] of options.entries()) {
        if (!o || typeof o !== "object" || !text((o as JevOption).id) || !text((o as JevOption).description)) return `${at}, option ${j}: \`id\` and \`description\` are non-empty strings`;
        const oid = (o as JevOption).id;
        if (oid === INSUFFICIENT_EVIDENCE) return `${at}, option ${j}: \`${INSUFFICIENT_EVIDENCE}\` is the tier's own option`;
        if (seen.has(oid)) return `${at}, option ${j}: \`${oid}\` is given twice`;
        seen.add(oid);
      }
    } else {
      return `${at}: \`kind\` is "binary" or "choice"`;
    }
  }
  return null;
}
