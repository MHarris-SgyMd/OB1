/**
 * verdict.ts — Verdict v1.4 behind the tier's contract (SMD-2050).
 *
 * The model is heman10x/rlcd-modernbert-151m: a 151M GLiClass ModernBERT-base
 * decision model, Apache-2.0, published with an ONNX export and a fitted
 * temperature calibrator. It is the public checkpoint of the openJev
 * "Verdict" line — the one on the JevBench leaderboard. The line's newer
 * verdict-2.0 is not servable today (its Hugging Face repository answers 401
 * and its GitHub weights are an LFS pointer with no object); the contract
 * does not change when it is.
 *
 * Everything the model expects is ported from its own reference engine
 * (openJev-verdict-2.0's core/formatting.py and core/engine_encoder.py), not
 * re-imagined, because a prompt that differs by one marker gives a
 * probability the calibrator was never fitted to:
 *
 * - The prompt is `<<LABEL>>label₁<<LABEL>>label₂…<<SEP>>text`; the two
 *   markers are single tokens (50368, 50369) in the model's tokenizer.
 * - A choice's labels are `It is {description}`, then `insufficient evidence`;
 *   its text `Question: {question}\n\nContext:\n{context}`.
 * - A binary decision is the engine's `noul` kind: labels `true: {p}`,
 *   `false: not {p}`, `insufficient evidence`; text
 *   `Context:\n{context}\n\nEvaluate proposition: {p}`.
 * - The output `logits` has 25 slots; the first K are the K labels'. They are
 *   divided by the calibrator's temperature for K when it has one, else by its
 *   global temperature, then softmaxed.
 * - Input is cut to 512 tokens keeping the closing [SEP] — the Rust
 *   tokenizer's rule, which the calibrator was fitted under (transformers.js
 *   drops the [SEP] instead; measured).
 *
 * The session and the tokenizer are passed in, so the rules above are tested
 * without the 606 MB model (test-jev.ts); createVerdictEngine builds the real
 * ones.
 */

import {
  INSUFFICIENT_EVIDENCE,
  JEV_CONTRACT,
  JEV_MAX_BATCH,
  JEV_MAX_OPTIONS,
  type JevDecision,
  type JevInfo,
  type JevModelInfo,
  type JevResult,
} from "../server-portable/jev-contract.ts";

/**
 * The files the engine loads, pinned: the repository, the revision and each
 * file's sha256. A file that does not hash to its pin is refused before it is
 * read (fetch-model.ts) — the weights are 606 MB of someone else's bytes.
 */
export const VERDICT = {
  name: "verdict-v1.4",
  repo: "heman10x/rlcd-modernbert-151m",
  revision: "8af2496eb63c7fa66d7d234e1f62629380030eb4",
  files: {
    "model.onnx": { bytes: 606_323_181, sha256: "4ae01f822538b000fa0e55859d4b3e6b40871d860149397e8784428b2a42ee5e" },
    "tokenizer.json": { bytes: 3_583_596, sha256: "8bb449eb0c037aae44115b65905bb339b8f3f74eb37067c19127feb3c0755723" },
    "tokenizer_config.json": { bytes: 380, sha256: "fb54f027372062b2ca52282efb04d178a8b57167a00cd8f4e816515823a2c016" },
    "calibrator.json": { bytes: 1_259, sha256: "af2a876993148efa0726b6ccf710fe2303897d20c0ce8c7c9036eb50f64d23de" },
  },
} as const;

export type VerdictFile = keyof typeof VERDICT.files;

export const LABEL_MARKER = "<<LABEL>>";
export const SEP_MARKER = "<<SEP>>";
/** The label the reference engine gives the tier's own option. */
export const INSUFFICIENT_LABEL = "insufficient evidence";
/** Tokens the reference engine reads (v1.4 cut it from 1024: trained on contexts under 71 tokens). */
export const MAX_TOKENS = 512;

/**
 * The prompt for one decision, the option ids its labels stand for in order,
 * and `head` — the text before the context, which a cut must leave whole with
 * some context after it for the model to have read the decision at all.
 */
export function buildPrompt(d: JevDecision): { prompt: string; ids: string[]; head: string } {
  let labels: string[];
  let ids: string[];
  let head: string;
  let text: string;
  if (d.kind === "binary") {
    labels = [`true: ${d.proposition}`, `false: not ${d.proposition}`, INSUFFICIENT_LABEL];
    ids = ["true", "false", INSUFFICIENT_EVIDENCE];
    head = "Context:\n";
    text = `${head}${d.context}\n\nEvaluate proposition: ${d.proposition}`;
  } else {
    labels = [...d.options.map((o) => `It is ${o.description}`), INSUFFICIENT_LABEL];
    ids = [...d.options.map((o) => o.id), INSUFFICIENT_EVIDENCE];
    head = `Question: ${d.question}\n\nContext:\n`;
    text = `${head}${d.context}`;
  }
  return { prompt: `${labels.map((l) => `${LABEL_MARKER}${l}`).join("")}${SEP_MARKER}${text}`, ids, head };
}

/** The calibrator's shape: a global temperature and, for some option counts, its own. */
export type Calibrator = { temperature: number; per_k?: Record<string, number> };

/** The reference engine's rule: the temperature fitted for K options when there is one, else the global one. */
export function temperatureFor(cal: Calibrator, k: number): number {
  const t = Number(cal.per_k?.[String(k)] ?? cal.temperature);
  if (!Number.isFinite(t) || t <= 0) throw new Error(`calibrator temperature for ${k} options is ${t}, not a positive number`);
  return t;
}

/** Softmax, stable against large logits. */
export function softmax(xs: number[]): number[] {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}

/** Token ids cut to `max`, keeping the closing special token (the Rust tokenizer's truncation). */
export function truncate(ids: number[], max: number): { ids: number[]; truncated: boolean } {
  if (ids.length <= max) return { ids, truncated: false };
  return { ids: [...ids.slice(0, max - 1), ids[ids.length - 1]], truncated: true };
}

/** The reference engine revision these rules are ported from (openJev-verdict-2.0 PR #3). */
export const ENGINE_REVISION = "00b5ee96";

/**
 * A fingerprint of the rules a probability depends on beyond the weights:
 * buildPrompt over one decision of each kind, the token budget, the
 * truncation rule and the temperature rule. Part of MODEL_INFO.rules, so a
 * change to any of them changes the provenance every answer carries — the
 * same weights under two engines answered differently on both published sets
 * (third review pass). test-jev.ts [2] pins the value, so the change is seen.
 */
export function rulesFingerprint(): string {
  const cal: Calibrator = { temperature: 2, per_k: { "3": 5 } };
  const probe = JSON.stringify([
    buildPrompt({ kind: "binary", proposition: "P", context: "C" }),
    buildPrompt({ kind: "choice", question: "Q", context: "C", options: [{ id: "a", description: "A" }] }),
    MAX_TOKENS,
    truncate([1, 2, 3, 4], 3),
    [temperatureFor(cal, 3), temperatureFor(cal, 4)],
  ]);
  return new Bun.CryptoHasher("sha256").update(probe).digest("hex").slice(0, 12);
}

export const MODEL_INFO: JevModelInfo = {
  name: VERDICT.name,
  source: `https://huggingface.co/${VERDICT.repo}`,
  revision: VERDICT.revision,
  weights_sha256: VERDICT.files["model.onnx"].sha256,
  calibrator_sha256: VERDICT.files["calibrator.json"].sha256,
  rules: `openjev-engine@${ENGINE_REVISION}#${rulesFingerprint()}`,
};

export const INFO: JevInfo = {
  contract: JEV_CONTRACT,
  model: MODEL_INFO,
  kinds: ["binary", "choice"],
  max_options: JEV_MAX_OPTIONS,
  max_batch: JEV_MAX_BATCH,
  max_tokens: MAX_TOKENS,
};

/** One result from one decision's K logits. */
export function resultFrom(d: JevDecision, ids: string[], logits: number[], temperature: number, tokens: number, truncated: boolean): JevResult {
  if (logits.length !== ids.length || !logits.every(Number.isFinite)) {
    throw new Error(`the model returned ${logits.length} usable logits for ${ids.length} options (${logits.join(", ")})`);
  }
  const probs = softmax(logits.map((x) => x / temperature));
  const probabilities = Object.fromEntries(ids.map((id, i) => [id, probs[i]]));
  let top = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[top]) top = i;
  const selected = ids[top];
  const result: JevResult = {
    ...(d.id !== undefined ? { id: d.id } : {}),
    kind: d.kind,
    probabilities,
    selected,
    abstained: selected === INSUFFICIENT_EVIDENCE,
    p_insufficient: probabilities[INSUFFICIENT_EVIDENCE],
    logits,
    temperature,
    tokens,
    truncated,
  };
  if (d.kind === "binary") {
    const sufficient = probabilities.true + probabilities.false;
    result.p_true = sufficient > 0 ? probabilities.true / sufficient : null;
  }
  return result;
}

/** What the engine needs of a tokenizer: ids with the special tokens added. */
export type Encoder = { encode(text: string): { ids: number[] } };
/** What the engine needs of an inference session: one [1, n] int64 pair in, a [1, 25] float32 `logits` out (24 options and the tier's own). */
export type Runner = (inputIds: BigInt64Array, attentionMask: BigInt64Array) => Promise<Float32Array>;

export type Engine = {
  info: JevInfo;
  decide(decisions: JevDecision[]): Promise<JevResult[]>;
};

/** The two markers' ids in the model's tokenizer (core/formatting.py's LABEL_TOKEN_ID, SEP_TOKEN_ID). */
export const MARKER_IDS = { label: 50368, sep: 50369 } as const;

/**
 * A decision this model cannot read faithfully, refused rather than answered:
 * the service answers 422 naming it. Not a malformed request — the contract
 * accepts it — but one whose prompt would not be the one the model reads.
 */
export class DecisionRefused extends Error {
  constructor(message: string, readonly index: number) {
    super(message);
    this.name = "DecisionRefused";
  }
}

/** The label markers in `ids`, the separators, and the last separator's position. */
function countMarkers(ids: number[]): { labels: number; seps: number; sepAt: number } {
  let labels = 0, seps = 0, sepAt = -1;
  for (const [i, id] of ids.entries()) {
    if (id === MARKER_IDS.label) labels++;
    else if (id === MARKER_IDS.sep) { seps++; sepAt = i; }
  }
  return { labels, seps, sepAt };
}

/**
 * One decision encoded, cut to the budget and checked, or refused. The model
 * reads option k's score off the k-th label marker, so the prompt it sees must
 * carry exactly one marker per option and one separator (first review pass).
 * Two ways it would not, each refused:
 *
 * - The caller's text holds a marker. `<<LABEL>>` in a context or a
 *   description tokenizes to the marker itself, adds a slot, and every later
 *   option's probability is read off its neighbour's — measured: a description
 *   carrying one moved `p_insufficient` from 0.194 to 0.034. Notes about this
 *   tier contain the strings; the refusal names them.
 * - The labels overrun the 512 tokens — or leave too little of them for the
 *   decision's head. The cut keeps the prompt's start, so a long option list
 *   loses its later labels, the separator and every word of the question and
 *   context — measured: 24 fifty-token options kept 9 markers and still
 *   answered `o8`, not abstaining — and a list that ends at token 505 keeps
 *   every label and reads "Question: Which of these" (second review pass: the
 *   first check fired only when the separator itself was cut). A cut is
 *   answered, `truncated: true`, only when the head (`buildPrompt`'s: the
 *   question and the `Context:` line) and some context survive it — the
 *   reference engine's rule for a long context.
 */
function prepareDecision(encoder: Encoder, d: JevDecision, i: number): { d: JevDecision; ids: string[]; cut: { ids: number[]; truncated: boolean } } {
  const { prompt, ids, head } = buildPrompt(d);
  const full = encoder.encode(prompt).ids;
  const whole = countMarkers(full);
  if (whole.labels !== ids.length || whole.seps !== 1) {
    throw new DecisionRefused(`decision ${i}: its text contains the model's own markers (${LABEL_MARKER} or ${SEP_MARKER}), which would move every option's slot — remove or rewrite them before asking`, i);
  }
  const cut = truncate(full, MAX_TOKENS);
  if (cut.truncated) {
    const kept = countMarkers(cut.ids);
    // Text tokens after the separator, before the closing [SEP]; the head's own, without [CLS]/[SEP].
    const read = kept.sepAt < 0 ? 0 : cut.ids.length - kept.sepAt - 2;
    const headTokens = encoder.encode(head).ids.length - 2;
    if (kept.sepAt < 0 || read <= headTokens) {
      throw new DecisionRefused(`decision ${i}: its labels leave the model's ${MAX_TOKENS} tokens too little room — it would read ${kept.labels} of its ${ids.length} labels (the options and the tier's own) and ${read} tokens of the question and context, of the ${headTokens} the question's head alone takes — shorten the option descriptions or the proposition, or split the options`, i);
    }
  }
  return { d, ids, cut };
}

/**
 * The engine over a tokenizer, a runner and a calibrator. One forward pass per
 * decision, batch 1: a padded batch of eight measured no faster than eight
 * singles on the dogfood Mac's CPU (720 ms against 8 × 75), and batch 1 needs
 * no pad token. Decisions run one at a time; the runner's own threads are
 * where the parallelism is. Every decision is prepared (prepareDecision:
 * encoded, cut, checked) before the first forward pass, so a refused decision
 * at index 40 does not leave 39 computed and discarded.
 */
export function createEngine(encoder: Encoder, run: Runner, cal: Calibrator): Engine {
  temperatureFor(cal, 3); // a calibrator with no usable global temperature is refused at load, not at the first request
  return {
    info: INFO,
    async decide(decisions) {
      const prepared = decisions.map((d, i) => prepareDecision(encoder, d, i));
      const out: JevResult[] = [];
      for (const { d, ids, cut } of prepared) {
        const inputIds = BigInt64Array.from(cut.ids, BigInt);
        const mask = new BigInt64Array(cut.ids.length).fill(1n);
        const logits = await run(inputIds, mask);
        if (logits.length < ids.length) throw new Error(`the model returned ${logits.length} logits; the decision has ${ids.length} options`);
        out.push(resultFrom(d, ids, Array.from(logits.subarray(0, ids.length)), temperatureFor(cal, ids.length), cut.ids.length, cut.truncated));
      }
      return out;
    },
  };
}

/**
 * The real engine: the pinned files in `dir` (fetch-model.ts put them there
 * and verified them), onnxruntime-node on the CPU.
 */
export async function createVerdictEngine(dir: string, opts: { threads: number }): Promise<Engine> {
  const { encoder, run, cal } = await loadVerdict(dir, opts);
  return createEngine(encoder, run, cal);
}

/**
 * The loaded parts — tokenizer, runner, calibrator — for a caller that must
 * write the prompt itself: the conformance run reproduces the model's own
 * evaluation, whose prompts are not the contract's (test-jev.ts [10]).
 * Imported here, not at the top, so the rules above load without the native
 * module.
 */
export async function loadVerdict(dir: string, opts: { threads: number }): Promise<{ encoder: Encoder; run: Runner; cal: Calibrator }> {
  const [{ Tokenizer }, ort] = await Promise.all([import("@huggingface/tokenizers"), import("onnxruntime-node")]);
  const read = (f: VerdictFile) => Bun.file(`${dir}/${f}`).json();
  const tokenizer = new Tokenizer(await read("tokenizer.json"), await read("tokenizer_config.json"));
  const cal = (await read("calibrator.json")) as Calibrator;
  const session = await ort.InferenceSession.create(`${dir}/model.onnx`, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    intraOpNumThreads: opts.threads,
    interOpNumThreads: 1,
  });
  if (!session.inputNames.includes("input_ids") || !session.inputNames.includes("attention_mask") || !session.outputNames.includes("logits")) {
    throw new Error(`${dir}/model.onnx has inputs ${session.inputNames.join(", ")} and outputs ${session.outputNames.join(", ")}; the engine needs input_ids, attention_mask → logits`);
  }
  const run: Runner = async (inputIds, mask) => {
    const dims = [1, inputIds.length];
    const out = await session.run({ input_ids: new ort.Tensor("int64", inputIds, dims), attention_mask: new ort.Tensor("int64", mask, dims) });
    return out.logits.data as Float32Array;
  };
  return { encoder: { encode: (t) => tokenizer.encode(t) }, run, cal };
}
