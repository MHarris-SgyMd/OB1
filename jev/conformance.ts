#!/usr/bin/env bun
/**
 * conformance.ts — does the model we serve conform to its own published
 * evaluation? (SMD-2050)
 *
 * The weights' sha256 says the bytes are the ones pinned; it does not say the
 * runtime reads them as their author did. The openJev repository publishes a
 * per-row receipt for exactly this bundle — reports/v2/predictions_v2.jsonl,
 * 1,000 rows of data/real_banking_test.jsonl (800 in scope, 200 that should
 * abstain), each with the predicted option and its confidence, written by
 * scripts/evaluate.py from artifacts/v2/model.safetensors, whose sha256 is the
 * one the Hugging Face bundle manifest names beside our model.onnx — and the
 * totals in evaluation_report_v2.json. Both are fetched pinned (commit and
 * sha256), never vendored.
 *
 * Two arms over the same rows:
 *
 * - `receipt`: the evaluator's own prompt — raw option descriptions in the
 *   row's order, `__insufficient_evidence__` wherever the row puts it — and
 *   the report's one fitted temperature. This is the runtime under test: the
 *   predicted option must agree with the receipt on every row, the
 *   confidence to float noise, and the totals must be the report's.
 * - `served`: the same rows through the contract, as a spike gets them —
 *   buildPrompt's `It is …` labels, the tier's own abstention last, the
 *   bundle's per-K calibrator. Not held to the receipt: it is a different
 *   prompt and a different calibration, and what it costs on this workload is
 *   the record (jev/README.md, "Conformance").
 *
 *   bun conformance.ts <model dir>    # both arms, the table; exits 1 when the receipt arm does not conform
 *
 * test-jev.ts [10] runs the same functions when JEV_TEST_MODEL_DIR is set.
 */

import { INSUFFICIENT_EVIDENCE } from "../server-portable/jev-contract.ts";
import { ensureModel, type ModelPins } from "./fetch-model.ts";
import { createEngine, loadVerdict, softmax, type Calibrator, type Encoder, type Runner } from "./verdict.ts";

const OPENJEV = "Heman10x-NGU/openJev-verdict-2.0";
/** The receipt, its inputs and its totals, at the commit that holds them. */
export const RECEIPT: ModelPins = {
  repo: OPENJEV,
  revision: "bff28567cff463b833bf044f351a8b7945d53e07",
  files: {
    "real_banking_test.jsonl": { bytes: 855_855, sha256: "533f773c5167a402c30685c1f673bc68feb1d29c096d583a2cdfd9afb58a0426" },
    "predictions_v2.jsonl": { bytes: 206_768, sha256: "1d9274ac3bc0bf27e18919d874fbbead570b4e44f4166e06246f706844999f26" },
    "evaluation_report_v2.json": { bytes: 10_206, sha256: "f8ca47f9c3fd7939cf82c783b93eae0de79c7008efb8deaa566f8b9ed5ecb173" },
  },
  url: (name) => {
    const path = { "real_banking_test.jsonl": "data", "predictions_v2.jsonl": "reports/v2", "evaluation_report_v2.json": "reports/v2" }[name];
    return `https://raw.githubusercontent.com/${OPENJEV}/${RECEIPT.revision}/${path}/${name}`;
  },
};

type Row = { id: string; question: string; text: string; candidates: { id: string; description: string }[]; target_id: string; is_abstention: boolean };
type Receipt = { id: string; predicted_id: string; confidence: number };
export type Report = { temperature: number; calibrated: { accuracy: number; ece_equal_width: number; brier_score: number; abstention: { recall: number; precision: number } } };

export type ArmMetrics = { rows: number; accuracy: number; abstentionRecall: number; abstentionPrecision: number; ece: number; brier: number; ms: number };
export type ReceiptArm = ArmMetrics & { agree: number; maxConfidenceDelta: number; disagreements: string[] };

/** Top-1 ECE over ten equal-width bins, as the report's `ece_equal_width`; Brier summed over the options, averaged over rows. */
function metricsOf(outs: { probs: number[]; ids: string[]; row: Row }[], ms: number): ArmMetrics {
  let correct = 0, predAbst = 0, trueAbst = 0, brier = 0;
  const tops: { conf: number; correct: boolean }[] = [];
  for (const { probs, ids, row } of outs) {
    let top = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[top]) top = i;
    const ok = ids[top] === row.target_id;
    if (ok) correct++;
    if (ids[top] === INSUFFICIENT_EVIDENCE) { predAbst++; if (row.is_abstention) trueAbst++; }
    brier += probs.reduce((s, p, j) => s + (p - (ids[j] === row.target_id ? 1 : 0)) ** 2, 0);
    tops.push({ conf: probs[top], correct: ok });
  }
  let ece = 0;
  for (let b = 0; b < 10; b++) {
    const bin = tops.filter((t) => t.conf > b / 10 && t.conf <= (b + 1) / 10);
    if (bin.length) ece += (bin.length / tops.length) * Math.abs(bin.filter((t) => t.correct).length / bin.length - bin.reduce((s, t) => s + t.conf, 0) / bin.length);
  }
  const gold = outs.filter((o) => o.row.is_abstention).length;
  return { rows: outs.length, accuracy: correct / outs.length, abstentionRecall: trueAbst / gold, abstentionPrecision: trueAbst / predAbst, ece, brier: brier / outs.length, ms };
}

export type Loaded = { rows: Row[]; receipt: Map<string, Receipt>; report: Report; encoder: Encoder; run: Runner; cal: Calibrator };

/** The pinned receipt files (fetched into `<modelDir>/conformance`, verified) and the model's loaded parts. */
export async function loadConformance(modelDir: string, opts: { threads?: number; log?: (l: string) => void } = {}): Promise<Loaded> {
  const dir = `${modelDir}/conformance`;
  await ensureModel(dir, { pins: RECEIPT, log: opts.log });
  const lines = async (f: string) => (await Bun.file(`${dir}/${f}`).text()).trim().split("\n").map((l) => JSON.parse(l));
  const rows = (await lines("real_banking_test.jsonl")) as Row[];
  const receipt = new Map(((await lines("predictions_v2.jsonl")) as Receipt[]).map((r) => [r.id, r]));
  const report = (await Bun.file(`${dir}/evaluation_report_v2.json`).json()) as Report;
  const { encoder, run, cal } = await loadVerdict(modelDir, { threads: opts.threads ?? 4 });
  return { rows, receipt, report, encoder, run, cal };
}

/** The receipt arm: the evaluator's prompt and temperature, compared row by row. */
export async function receiptArm(l: Loaded): Promise<ReceiptArm> {
  const t0 = performance.now();
  const outs: { probs: number[]; ids: string[]; row: Row }[] = [];
  let agree = 0, maxConfidenceDelta = 0;
  const disagreements: string[] = [];
  for (const row of l.rows) {
    // core/formatting.py's build_model_input over the raw descriptions — scripts/evaluate.py's call, uncut (these rows are all under 512 tokens).
    const prompt = `${row.candidates.map((c) => `<<LABEL>>${c.description}`).join("")}<<SEP>>Question: ${row.question}\n\nContext:\n${row.text}`;
    const ids = l.encoder.encode(prompt).ids;
    const logits = await l.run(BigInt64Array.from(ids, BigInt), new BigInt64Array(ids.length).fill(1n));
    const probs = softmax(Array.from(logits.subarray(0, row.candidates.length)).map((x) => x / l.report.temperature));
    const optionIds = row.candidates.map((c) => c.id);
    let top = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[top]) top = i;
    const want = l.receipt.get(row.id);
    if (want && want.predicted_id === optionIds[top]) {
      agree++;
      maxConfidenceDelta = Math.max(maxConfidenceDelta, Math.abs(probs[top] - want.confidence));
    } else {
      disagreements.push(`${row.id}: ${optionIds[top]} (${probs[top].toFixed(3)}), receipt ${want?.predicted_id} (${want?.confidence.toFixed(3)})`);
    }
    outs.push({ probs, ids: optionIds, row });
  }
  return { ...metricsOf(outs, performance.now() - t0), agree, maxConfidenceDelta, disagreements };
}

/** The served arm: the same rows as `choice` decisions through the engine the service runs. */
export async function servedArm(l: Loaded): Promise<ArmMetrics & { differsFromReceipt: number }> {
  const engine = createEngine(l.encoder, l.run, l.cal);
  const t0 = performance.now();
  const outs: { probs: number[]; ids: string[]; row: Row }[] = [];
  let differs = 0;
  for (const row of l.rows) {
    const options = row.candidates.filter((c) => c.id !== INSUFFICIENT_EVIDENCE);
    const [r] = await engine.decide([{ kind: "choice", question: row.question, context: row.text, options }]);
    const ids = Object.keys(r.probabilities);
    outs.push({ probs: ids.map((id) => r.probabilities[id]), ids, row });
    if (l.receipt.get(row.id)?.predicted_id !== r.selected) differs++;
  }
  return { ...metricsOf(outs, performance.now() - t0), differsFromReceipt: differs };
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: bun conformance.ts <model dir>   (the directory serve.ts fetched the pinned files into)");
    process.exit(2);
  }
  const l = await loadConformance(dir, { log: (m) => console.log(`conformance: ${m}`) });
  const a = await receiptArm(l);
  const s = await servedArm(l);
  const r = l.report.calibrated;
  console.log(`\n${l.rows.length} rows of ${OPENJEV}@${RECEIPT.revision.slice(0, 8)} data/real_banking_test.jsonl\n`);
  console.log(`| | accuracy | abstention recall | abstention precision | ECE | Brier |`);
  console.log(`| --- | --- | --- | --- | --- | --- |`);
  console.log(`| published (evaluation_report_v2, T=${l.report.temperature.toFixed(4)}) | ${pct(r.accuracy)} | ${pct(r.abstention.recall)} | ${pct(r.abstention.precision)} | ${r.ece_equal_width.toFixed(4)} | ${r.brier_score.toFixed(4)} |`);
  console.log(`| receipt arm (this runtime, the evaluator's prompt) | ${pct(a.accuracy)} | ${pct(a.abstentionRecall)} | ${pct(a.abstentionPrecision)} | ${a.ece.toFixed(4)} | ${a.brier.toFixed(4)} |`);
  console.log(`| served arm (the contract's prompt, the bundle's calibrator) | ${pct(s.accuracy)} | ${pct(s.abstentionRecall)} | ${pct(s.abstentionPrecision)} | ${s.ece.toFixed(4)} | ${s.brier.toFixed(4)} |`);
  console.log(`\nreceipt arm: the predicted option agrees on ${a.agree}/${l.rows.length} rows, confidence within ${a.maxConfidenceDelta.toExponential(2)} (${(a.ms / 1000).toFixed(1)} s)`);
  for (const d of a.disagreements.slice(0, 10)) console.log(`  ${d}`);
  console.log(`served arm: ${s.differsFromReceipt} answers differ from the receipt's (${(s.ms / 1000).toFixed(1)} s)`);
  const conforms = a.agree === l.rows.length && a.maxConfidenceDelta < 1e-4;
  console.log(conforms ? "\nCONFORMS — the runtime reproduces the published receipt" : "\nDOES NOT CONFORM");
  process.exit(conforms ? 0 : 1);
}
