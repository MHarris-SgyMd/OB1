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
 * before anything is sent, so a decision cannot silently leave the box; the
 * refusal is a ProviderError of kind `egress`, a deadline one of `timeout`, an
 * error status `http` (422: a decision this model cannot read faithfully), an
 * answer outside the contract `body`; a refused connection or the caller's own
 * abort is the runtime's error, rethrown as it came — providerCall's rule. The
 * answer is checked before it is believed.
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
  JEV_MAX_BODY_BYTES,
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
 * The deadline of a request, by default: a fixed part for the exchange and the
 * queue, and a part per decision for the forward passes. Measured per
 * decision at 512 tokens: 146 ms on the dogfood Mac's host, 379 ms in the
 * podman VM the profile runs in, so a full batch of 64 is 25 s there — and
 * the service runs one request at a time, so a request also waits for the ones
 * ahead of it. A flat 30 s timed out the second of two concurrent full batches
 * (fifth review pass); 30 s + 1 s a decision holds a full batch behind one
 * other full batch. The deadline scales with the caller's own request, not the
 * queue it joins: one decision behind two full batches in the container (51 s
 * of queue) still has 31 s — a caller that shares a busy tier passes a larger
 * `timeoutMs` (sixth review pass). `timeoutMs` in a call replaces the whole
 * of it, per request.
 */
export const DEFAULT_JEV_TIMEOUT_MS = 30_000;
export const JEV_PER_DECISION_MS = 1_000;

/** A request's deadline: the caller's `timeoutMs`, else the fixed part plus a part per decision. */
export function requestTimeoutMs(cfg: Pick<JevConfig, "timeoutMs">, decisions: number, opts: { timeoutMs?: number } = {}): number {
  return opts.timeoutMs ?? cfg.timeoutMs + decisions * JEV_PER_DECISION_MS;
}

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

/**
 * `timeoutMs` bounds each request a call makes (jevDecideMany makes one per
 * packed batch), not the call: a bound on the whole call is a `signal`, e.g.
 * AbortSignal.timeout(…), which every request of the call shares.
 */
type CallOpts = { signal?: AbortSignal; timeoutMs?: number };

/** One exchange with the tier: the deadline, the status kept, the body capped in a message, the JSON parsed. */
async function exchange<T>(cfg: JevConfig, method: "GET" | "POST", path: "/info" | "/decide", body: unknown, opts: CallOpts): Promise<T> {
  const at = cfg.endpoint.base;
  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const what = path === "/info" ? "Info" : "Decision";
  const timedOut = () => new ProviderError(`${what} request to ${at} timed out after ${timeoutMs / 1000} s`, "timeout");
  let r: Response;
  try {
    r = await fetch(`${at}${path}`, {
      method,
      headers: cfg.endpoint.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
      redirect: "manual",
      // The one deadline is ours: Bun's fetch would otherwise cut a quiet
      // exchange at its own 300 s idle timeout (providerCall's note).
      timeout: false,
    });
  } catch (e) {
    // The caller's own signal first: its reason is the caller's, even when
    // that reason is a timeout of the caller's making (second review pass).
    if (opts.signal?.aborted) throw e;
    if ((e as Error).name === "TimeoutError") throw timedOut();
    throw e;
  }
  let text = "";
  try {
    text = await r.text();
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    if ((e as Error).name === "TimeoutError") throw timedOut();
    // A reset after a 2xx is not an answer to read as "not JSON" (first review
    // pass); after an error status the status is the fact — a 413 whose body
    // did not arrive is still a 413, providerCall's rule.
    if (r.ok) throw e;
  }
  const capped = text.slice(0, 500);
  // A redirect is not followed (it could point off the box); its Location is the useful part.
  const location = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
  if (!r.ok) throw new ProviderError(`${what} request to ${at}${path} failed: ${r.status}${location ? ` redirecting to ${location}` : ""} ${capped}`.trimEnd(), "http", r.status, capped);
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

/** Every text a decision sends, ids included. */
function textsOf(d: JevDecision): string[] {
  return d.kind === "binary" ? [d.id ?? "", d.proposition, d.context] : [d.id ?? "", d.question, d.context, ...d.options.flatMap((o) => [o.id, o.description])];
}

/**
 * The gate over a list of decisions, each judged on its own — one decision's
 * allowance is not another's — and the first refusal refuses the call. The
 * `marker` unit reads a different text by mode, because a marker can only
 * make its own mode's answer:
 *
 * - Under deny, an OB1_EGRESS_ALLOW `marker:` term lets a decision leave only
 *   when THAT decision's context — the thought's text, where a writer puts
 *   `#public` — carries it. Not the caller's `content`, not an option
 *   description, not another decision's context: each of those vouched for
 *   text it is not (second review pass: one `#public` context let a PHI row
 *   in the same list leave, and a fixed option description reading "a #public
 *   note" let any row leave).
 * - Under allow, an OB1_EGRESS_DENY term refuses when it matches anything the
 *   decision sends, or the caller's own `content` (first review pass: the
 *   caller's content used to replace the decisions' text, and a marker in a
 *   context it did not name went unread).
 *
 * The other units — actor, source, type, topic — are the caller's subject,
 * the same for every decision.
 */
function gateDecisions(subject: EgressSubject, decisions: JevDecision[], cfg: JevConfig): ReturnType<typeof mayLeaveBox> {
  const allowTermsDecide = cfg.egress.mode === "deny" && !cfg.egress.problems.length;
  let gate = mayLeaveBox({ ...subject, content: "" }, cfg.endpoint, cfg.egress);
  for (const [i, d] of decisions.entries()) {
    const content = allowTermsDecide ? d.context : [subject.content ?? "", ...textsOf(d)].filter(Boolean).join("\n");
    gate = mayLeaveBox({ ...subject, content }, cfg.endpoint, cfg.egress);
    if (!gate.allowed) return decisions.length > 1 ? { ...gate, reason: `decision ${i}: ${gate.reason}` } : gate;
  }
  return gate;
}

const utf8 = new TextEncoder();

/** The tier's own description: contract, model, limits. No text is sent, so the gate is not asked; preflight's probe. */
export async function jevInfo(cfg: JevConfig, opts: CallOpts = {}): Promise<JevInfo> {
  const info = await exchange<JevInfo>(cfg, "GET", "/info", undefined, opts);
  if (info?.contract !== JEV_CONTRACT) throw new ProviderError(`${cfg.endpoint.base}/info speaks ${JSON.stringify(info?.contract)}, not ${JEV_CONTRACT}`, "body");
  return info;
}

/**
 * Many decisions about one subject — the classify-every-span caller (SMD-2017,
 * 2049) — packed in order into requests of at most JEV_MAX_BATCH decisions and
 * JEV_MAX_BODY_BYTES bytes. The caller's subject (actor, and the row's
 * metadata for source/type/topic terms) is one for the list — a caller
 * deciding about several rows under such terms calls once per row — while the
 * marker unit is read per decision (gateDecisions). Refused by the gate before
 * anything is sent; a malformed decision is refused before anything is sent,
 * with its index. A decision the model cannot read (422) refuses its request,
 * and the requests before it are already answered: the error says how many.
 */
export async function jevDecideMany(cfg: JevConfig, decisions: JevDecision[], subject: EgressSubject, opts: CallOpts = {}): Promise<{ results: JevResult[]; model: JevModelInfo; ms: number }> {
  const gate = gateDecisions(subject, decisions, cfg);
  if (!gate.allowed) throw refuseEgress("Decision", cfg.endpoint.base, gate);
  // Every request built and checked before the first is sent: a bad decision
  // at index 70 must not leave the first 64 decided and the caller holding
  // half an answer.
  const envelope = { ...(cfg.model ? { model: cfg.model } : {}) };
  if (!decisions.length) throw new Error(`not sent to ${cfg.endpoint.base}: \`decisions\` is a non-empty array`);
  const requests: { model?: string; decisions: JevDecision[] }[] = [];
  const overhead = utf8.encode(JSON.stringify({ ...envelope, decisions: [] })).length;
  let batch: JevDecision[] = [], bytes = overhead;
  for (const [i, d] of decisions.entries()) {
    const problem = jevRequestProblem({ ...envelope, decisions: [d] });
    if (problem) throw new Error(`not sent to ${cfg.endpoint.base}: ${problem.replace(/^decision 0/, `decision ${i}`)}`);
    const size = utf8.encode(JSON.stringify(d)).length + 1; // and its comma
    if (batch.length && (batch.length === JEV_MAX_BATCH || bytes + size > JEV_MAX_BODY_BYTES)) {
      requests.push({ ...envelope, decisions: batch });
      batch = [];
      bytes = overhead;
    }
    batch.push(d);
    bytes += size;
  }
  requests.push({ ...envelope, decisions: batch });
  const results: JevResult[] = [];
  let model: JevModelInfo | undefined;
  let ms = 0;
  for (const request of requests) {
    const batch = request.decisions;
    let answer: JevResponse;
    try {
      answer = await exchange<JevResponse>(cfg, "POST", "/decide", request, { ...opts, timeoutMs: requestTimeoutMs(cfg, batch.length, opts) });
    } catch (e) {
      if (results.length && e instanceof ProviderError) e.message += ` (after ${results.length} of ${decisions.length} decisions were answered)`;
      throw e;
    }
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
