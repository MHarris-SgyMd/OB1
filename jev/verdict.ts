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

export const MODEL_INFO: JevModelInfo = {
  name: VERDICT.name,
  source: `https://huggingface.co/${VERDICT.repo}`,
  revision: VERDICT.revision,
  weights_sha256: VERDICT.files["model.onnx"].sha256,
  calibrator_sha256: VERDICT.files["calibrator.json"].sha256,
};

export const LABEL_MARKER = "<<LABEL>>";
export const SEP_MARKER = "<<SEP>>";
/** The label the reference engine gives the tier's own option. */
export const INSUFFICIENT_LABEL = "insufficient evidence";
/** Tokens the reference engine reads (v1.4 cut it from 1024: trained on contexts under 71 tokens). */
export const MAX_TOKENS = 512;
/** The model's output slots — options plus the tier's own. */
export const SLOTS = JEV_MAX_OPTIONS + 1;

export const INFO: JevInfo = {
  contract: JEV_CONTRACT,
  model: MODEL_INFO,
  kinds: ["binary", "choice"],
  max_options: JEV_MAX_OPTIONS,
  max_batch: JEV_MAX_BATCH,
  max_tokens: MAX_TOKENS,
};

/** The prompt for one decision and the option ids its labels stand for, in order. */
export function buildPrompt(d: JevDecision): { prompt: string; ids: string[] } {
  let labels: string[];
  let ids: string[];
  let text: string;
  if (d.kind === "binary") {
    labels = [`true: ${d.proposition}`, `false: not ${d.proposition}`, INSUFFICIENT_LABEL];
    ids = ["true", "false", INSUFFICIENT_EVIDENCE];
    text = `Context:\n${d.context}\n\nEvaluate proposition: ${d.proposition}`;
  } else {
    labels = [...d.options.map((o) => `It is ${o.description}`), INSUFFICIENT_LABEL];
    ids = [...d.options.map((o) => o.id), INSUFFICIENT_EVIDENCE];
    text = `Question: ${d.question}\n\nContext:\n${d.context}`;
  }
  return { prompt: `${labels.map((l) => `${LABEL_MARKER}${l}`).join("")}${SEP_MARKER}${text}`, ids };
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
/** What the engine needs of an inference session: one [1, n] int64 pair in, a [1, SLOTS] float32 `logits` out. */
export type Runner = (inputIds: BigInt64Array, attentionMask: BigInt64Array) => Promise<Float32Array>;

export type Engine = {
  info: JevInfo;
  decide(decisions: JevDecision[]): Promise<JevResult[]>;
};

/**
 * The engine over a tokenizer, a runner and a calibrator. One forward pass per
 * decision, batch 1: a padded batch of eight measured no faster than eight
 * singles on the dogfood Mac's CPU (720 ms against 8 × 75), and batch 1 needs
 * no pad token. Decisions run one at a time; the runner's own threads are
 * where the parallelism is.
 */
export function createEngine(encoder: Encoder, run: Runner, cal: Calibrator): Engine {
  temperatureFor(cal, 3); // a calibrator with no usable global temperature is refused at load, not at the first request
  return {
    info: INFO,
    async decide(decisions) {
      const out: JevResult[] = [];
      for (const d of decisions) {
        const { prompt, ids } = buildPrompt(d);
        const cut = truncate(encoder.encode(prompt).ids, MAX_TOKENS);
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
