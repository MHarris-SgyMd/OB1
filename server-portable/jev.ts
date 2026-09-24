/**
 * jev.ts — the client of the typed-decision tier (SMD-2050).
 *
 * Seven spikes (SMD-1874 reranker, 1897 router, 1937 extraction gate, 2016
 * runaway router, 2017 span extraction, 2018 relations, 2049 span gate) each
 * assumed a Jev-class model already loaded and callable. This is the call:
 * one knob says where the tier is (`OB1_JEV_BASE_URL`), one says which model
 * the caller expects (`OB1_JEV_MODEL`, as OB1_JUDGE_MODEL is a per-brain
 * choice — SMD-1901), and one declares it on this box (`OB1_JEV_LOCAL`). The
 * contract is jev-contract.ts; the serving process is jev/serve.ts.
 *
 * It is its own client, not providerCall: a decision is not a chat completion,
 * and no caller should have to shape a classifier as a generator. What it
 * shares with providerCall is the discipline — every call names its subject
 * and the egress gate (egress.ts, SMD-1903) reads it against the endpoint
 * before anything is sent, so a decision cannot silently leave the box; a
 * failure is a ProviderError of the same four kinds; the answer is checked
 * before it is believed.
 *
 * Provenance: every answer carries the model's name, source revision, weights
 * sha256 and calibrator sha256 (JevModelInfo). A caller that stores a
 * probability — a mention's confidence, a route — stores that beside it. The
 * lineage table that would hold it for every derived row is SMD-1731's; this
 * tier supplies what such a row would record and builds nothing to hold it.
 *
 * Nothing in the fork calls this yet: the server never decides, and preflight
 * reads the knobs only to check the tier. The spikes are the callers.
 */

import { baseUrlOr, ProviderError, providerEndpoint, refuseEgress, stringOr, type ProviderEndpoint } from "./embed.ts";
import { flagOn, mayLeaveBox, resolveEgressPolicy, type EgressEnv, type EgressPolicy, type EgressSubject } from "./egress.ts";
import {
  INSUFFICIENT_EVIDENCE,
  JEV_CONTRACT,
  JEV_MAX_BATCH,
  jevRequestProblem,
  type JevDecision,
  type JevInfo,
  type JevModelInfo,
  type JevOption,
  type JevResponse,
  type JevResult,
} from "./jev-contract.ts";

export { INSUFFICIENT_EVIDENCE, JEV_CONTRACT } from "./jev-contract.ts";
export type { JevDecision, JevInfo, JevModelInfo, JevOption, JevResult } from "./jev-contract.ts";

/** The environment keys this module reads. A subset of index.ts's Env. */
export type JevEnv = EgressEnv & {
  /** Where the tier is served, e.g. http://127.0.0.1:8020 or http://jev:8020; unset, the tier is off. */
  OB1_JEV_BASE_URL?: string;
  /** The model the caller expects the tier to serve; unset, whatever it serves (the answer names it either way). */
  OB1_JEV_MODEL?: string;
  /** 1/on: OB1_JEV_BASE_URL is on this machine or its private network — declared, never guessed from the address. */
  OB1_JEV_LOCAL?: string;
};

/**
 * Per request. A decision is tens of milliseconds on a CPU (75 ms measured on
 * the dogfood Mac), so a full batch of 64 is a few seconds; this is the bound
 * for a request that never returns, not a budget for a slow one.
 */
export const DEFAULT_JEV_TIMEOUT_MS = 30_000;

export type JevConfig = {
  endpoint: ProviderEndpoint;
  /** OB1_JEV_MODEL, when set: an answer from any other model is refused. */
  model: string | undefined;
  egress: EgressPolicy;
  timeoutMs: number;
};

/** The tier's configuration, or null when OB1_JEV_BASE_URL is unset — the tier is opt-in. */
export function resolveJevConfig(env: JevEnv): JevConfig | null {
  const base = baseUrlOr(env.OB1_JEV_BASE_URL, "");
  if (!base) return null;
  const model = stringOr(env.OB1_JEV_MODEL, "");
  return {
    endpoint: providerEndpoint(base, undefined, flagOn(env.OB1_JEV_LOCAL), "OB1_JEV_LOCAL"),
    model: model || undefined,
    egress: resolveEgressPolicy(env),
    timeoutMs: DEFAULT_JEV_TIMEOUT_MS,
  };
}

type CallOpts = { signal?: AbortSignal; timeoutMs?: number };

/** One exchange with the tier: the deadline, the status kept, the body capped in a message, the JSON parsed. */
async function exchange<T>(cfg: JevConfig, method: "GET" | "POST", path: "/info" | "/decide", body: unknown, opts: CallOpts): Promise<T> {
  const at = cfg.endpoint.base;
  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const timedOut = () => new ProviderError(`Decision request to ${at} timed out after ${timeoutMs / 1000} s`, "timeout");
  let r: Response;
  try {
    r = await fetch(`${at}${path}`, {
      method,
      headers: cfg.endpoint.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
      redirect: "manual",
    });
  } catch (e) {
    if ((e as Error).name === "TimeoutError") throw timedOut();
    throw e;
  }
  let text = "";
  try {
    text = await r.text();
  } catch (e) {
    if ((e as Error).name === "TimeoutError") throw timedOut();
  }
  const capped = text.slice(0, 500);
  if (!r.ok) throw new ProviderError(`Decision request to ${at}${path} failed: ${r.status} ${capped}`, "http", r.status, capped);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(`${at}${path} answered ${r.status} with a body that is not JSON`, "body", r.status, capped);
  }
}

/** What is wrong with an answer, or null: the contract, the model, and every result's shape. */
export function jevAnswerProblem(cfg: Pick<JevConfig, "model">, decisions: JevDecision[], answer: JevResponse): string | null {
  if (answer?.contract !== JEV_CONTRACT) return `the answer's contract is ${JSON.stringify(answer?.contract)}, not ${JEV_CONTRACT}`;
  if (!answer.model || typeof answer.model.name !== "string") return "the answer names no model";
  if (cfg.model && answer.model.name !== cfg.model) return `the answer is from ${answer.model.name}, and OB1_JEV_MODEL expects ${cfg.model}`;
  if (!Array.isArray(answer.results) || answer.results.length !== decisions.length) return `${answer.results?.length ?? "no"} results for ${decisions.length} decisions`;
  for (const [i, r] of answer.results.entries()) {
    const d = decisions[i];
    const want = d.kind === "binary" ? ["true", "false", INSUFFICIENT_EVIDENCE] : [...d.options.map((o) => o.id), INSUFFICIENT_EVIDENCE];
    const got = Object.keys(r?.probabilities ?? {});
    if (r?.kind !== d.kind || r.id !== d.id) return `result ${i} is not decision ${i}'s (kind ${r?.kind}, id ${r?.id})`;
    if (got.length !== want.length || !want.every((k) => got.includes(k))) return `result ${i} scores ${got.join(", ")}; the decision's options are ${want.join(", ")}`;
    const ps = Object.values(r.probabilities);
    if (!ps.every((p) => Number.isFinite(p) && p >= 0 && p <= 1) || Math.abs(ps.reduce((a, b) => a + b, 0) - 1) > 1e-6) return `result ${i}'s probabilities are not a distribution (${ps.join(", ")})`;
    if (d.kind === "binary" && !(r.p_true === null || (typeof r.p_true === "number" && r.p_true >= 0 && r.p_true <= 1))) return `result ${i} has no p_true`;
  }
  return null;
}

/** The subject a decision is judged as: the caller's, with every text the request carries as the `marker` unit when the caller gave none. */
function gatedSubject(subject: EgressSubject, decisions: JevDecision[]): EgressSubject {
  if (subject.content !== undefined) return subject;
  const texts = decisions.flatMap((d) => (d.kind === "binary" ? [d.proposition, d.context] : [d.question, d.context, ...d.options.map((o) => o.description)]));
  return { ...subject, content: texts.join("\n") };
}

/** The tier's own description: contract, model, limits. No text is sent, so the gate is not asked; preflight's probe. */
export async function jevInfo(cfg: JevConfig, opts: CallOpts = {}): Promise<JevInfo> {
  const info = await exchange<JevInfo>(cfg, "GET", "/info", undefined, opts);
  if (info?.contract !== JEV_CONTRACT) throw new ProviderError(`${cfg.endpoint.base}/info speaks ${JSON.stringify(info?.contract)}, not ${JEV_CONTRACT}`, "body");
  return info;
}

/**
 * Many decisions about one subject — the classify-every-span caller (SMD-2017,
 * 2049) — split into requests of JEV_MAX_BATCH, in order. One subject for the
 * whole list: a caller deciding about several rows under a policy with
 * source/type/topic terms calls once per row, since one row's allowance is not
 * another's. Refused by the gate before anything is sent; a malformed
 * decision is refused before anything is sent, with its index.
 */
export async function jevDecideMany(cfg: JevConfig, decisions: JevDecision[], subject: EgressSubject, opts: CallOpts = {}): Promise<{ results: JevResult[]; model: JevModelInfo; ms: number }> {
  const gate = mayLeaveBox(gatedSubject(subject, decisions), cfg.endpoint, cfg.egress);
  if (!gate.allowed) throw refuseEgress("Decision", cfg.endpoint.base, gate);
  // Every request built and checked before the first is sent: a bad decision
  // at index 70 must not leave the first 64 decided and the caller holding
  // half an answer.
  const requests: { model?: string; decisions: JevDecision[] }[] = [];
  for (let i = 0; i < decisions.length || i === 0; i += JEV_MAX_BATCH) {
    const request = { ...(cfg.model ? { model: cfg.model } : {}), decisions: decisions.slice(i, i + JEV_MAX_BATCH) };
    const problem = jevRequestProblem(request);
    if (problem) throw new Error(`not sent to ${cfg.endpoint.base}: ${problem.replace(/^decision (\d+)/, (_, n) => `decision ${i + Number(n)}`)}`);
    requests.push(request);
  }
  const results: JevResult[] = [];
  let model: JevModelInfo | undefined;
  let ms = 0;
  for (const request of requests) {
    const batch = request.decisions;
    const answer = await exchange<JevResponse>(cfg, "POST", "/decide", request, opts);
    const wrong = jevAnswerProblem(cfg, batch, answer);
    if (wrong) throw new ProviderError(`${cfg.endpoint.base}/decide: ${wrong}`, "body");
    results.push(...answer.results);
    model = answer.model;
    ms += answer.ms;
  }
  return { results, model: model!, ms };
}

/** What a binary decision comes to: P(true | the evidence suffices), whether the model declined, and who decided. */
export type JevBinary = { p: number | null; abstained: boolean; pInsufficient: number; result: JevResult; model: JevModelInfo };

/**
 * Is `proposition` true of `context`? The ticket's `jevDecide(question, span,
 * context)`, with the span written into the proposition by the caller — how
 * a span is phrased ("\"021\" names a person") is what each spike measures,
 * so the client does not choose it.
 */
export async function jevDecide(cfg: JevConfig, d: { proposition: string; context: string }, subject: EgressSubject, opts: CallOpts = {}): Promise<JevBinary> {
  const { results, model } = await jevDecideMany(cfg, [{ kind: "binary", ...d }], subject, opts);
  const [r] = results;
  return { p: r.p_true ?? null, abstained: r.abstained, pInsufficient: r.p_insufficient, result: r, model };
}

/** Which option answers `question` about `context`? The router's and the typer's shape (SMD-1897, 1937). */
export async function jevChoose(cfg: JevConfig, d: { question: string; options: JevOption[]; context: string }, subject: EgressSubject, opts: CallOpts = {}): Promise<{ result: JevResult; model: JevModelInfo }> {
  const { results, model } = await jevDecideMany(cfg, [{ kind: "choice", ...d }], subject, opts);
  return { result: results[0], model };
}
