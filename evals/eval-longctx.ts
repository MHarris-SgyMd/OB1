#!/usr/bin/env bun
/**
 * eval-longctx.ts — retrieval as documents grow past each model's context window.
 *
 * Everything else here uses short text. The synthetic "long" slice is 616 tokens,
 * which only probes the 512-token boundary, and the real issue corpus averages
 * ~125 tokens. So the recommendation to use `embeddinggemma` rests on evidence
 * that never approached its 2048-token limit — and a personal brain is exactly
 * where a long capture happens: a pasted transcript, a meeting write-up, a design
 * note.
 *
 * This grades documents at roughly 1K, 2K, 4K and 8K tokens with the answer in
 * the final sentence, and asks each model to find it. A model whose window is
 * shorter than the document cannot: the tail is cut before it is ever embedded,
 * silently and with no error.
 *
 * Design notes, both learned from getting this wrong before:
 *
 *   IDENTICAL LEADS. Every document in a length bucket opens the same way, so a
 *   model cannot score by matching the opening instead of retrieving the tail.
 *   An earlier version gave each document a distinctive lead and a 512-token
 *   model scored 3/3 on text it could not see.
 *
 *   MATCHED LENGTHS. Distractors are the same length as the answer, so length
 *   itself carries no signal.
 *
 *   bun eval-longctx.ts embeddinggemma bge-m3 'qwen3-embedding:4b!instruct@1024'
 */

import { embed, cosine, EVAL_BASE } from "./lib.ts";


/** Roughly 1.35 tokens per word for this kind of prose, checked against Ollama. */
const TOK_PER_WORD = 1.35;
const BUCKETS = [1000, 2000, 4000, 8000];   // target tokens per document

const LEAD = "Notes from the session, written up afterwards so the detail is not lost.";

const FILLER = [
  "We went round the same arguments as last quarter without much new evidence.",
  "There was a digression about whether the vendor evaluation was still valid,",
  "and whether anyone had re-run the load tests since the schema change landed.",
  "Nobody had, so the action was to book time before the next review.",
  "The cost model came up again: the sheet assumes steady traffic,",
  "which has not matched reality for two quarters, mostly weekend batch work.",
  "Someone suggested moving the batch to a spot fleet, noted but not owned.",
  "We revisited the on-call rotation and agreed the split is unsustainable",
  "for a team of five, particularly with two people on leave in the spring.",
  "Hiring was deferred again. On tooling, the dashboards are stale,",
  "half the panels point at metrics renamed in the last migration,",
  "and nobody trusts the alerting thresholds enough to page on them.",
  "A cleanup was proposed and scoped at a week, which felt optimistic.",
  "Documentation has drifted far from the code, and the runbooks still",
  "reference at least two systems that no longer exist anywhere.",
];

/** Distinct tails — the only thing that distinguishes documents in a bucket. */
const TAILS = [
  { key: "budget", text: "The decision, finally: we approved eighty thousand pounds for the observability migration, contingent on Priya signing the vendor contract by the fourteenth.",
    q: "how much did we approve for the observability work?" },
  { key: "kafka", text: "The conclusion nobody wrote down at the time: we are keeping Kafka and dropping the direct-to-Postgres path entirely, because the reconciliation job cannot be made idempotent.",
    q: "did we decide to keep Kafka?" },
  { key: "mentor", text: "The thing worth remembering: Dev wants to move into platform work next cycle, and Anita is the person who should mentor that transition.",
    q: "who should mentor Dev's move into platform?" },
  { key: "rollback", text: "What we settled on in the end: the rollback window stays at thirty minutes, and anything longer needs the on-call lead to approve it in writing.",
    q: "how long is the rollback window?" },
];

function build(tokens: number, tail: string): string {
  const words = Math.round(tokens / TOK_PER_WORD);
  const parts = [LEAD];
  let count = LEAD.split(" ").length;
  const tailWords = tail.split(" ").length;
  let i = 0;
  while (count < words - tailWords) {
    const s = FILLER[i++ % FILLER.length];
    parts.push(s);
    count += s.split(" ").length;
  }
  parts.push(tail);
  return parts.join(" ");
}



/** Ollama reports the served window, which is not always the card's number. */
async function servedContext(model: string): Promise<string> {
  const name = model.split("@")[0].replace(/!instruct$/, "");
  const p = Bun.spawn(["ollama", "show", name], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  return out.match(/context length\s+(\d+)/i)?.[1] ?? "?";
}

const models = process.argv.slice(2);
const table: Record<string, Record<number, string>> = {};
const ctxs: Record<string, string> = {};

for (const model of models) {
  process.stderr.write(`  … ${model}\n`);
  ctxs[model] = await servedContext(model);
  table[model] = {};
  for (const target of BUCKETS) {
    const docs = TAILS.map((t) => ({ key: t.key, text: build(target, t.text) }));
    const vecs: Record<string, number[]> = {};
    try {
      for (const d of docs) vecs[d.key] = await embed(model, d.text);
      let hit = 0;
      for (const t of TAILS) {
        const qv = await embed(model, t.q, true);
        const ranked = docs.map((d) => ({ k: d.key, s: cosine(qv, vecs[d.key]) })).sort((a, b) => b.s - a.s);
        if (ranked[0].k === t.key) hit++;
      }
      table[model][target] = `${hit}/${TAILS.length}`;
    } catch (e) {
      table[model][target] = "ERR";
      process.stderr.write(`    ${target}: ${(e as Error).message.slice(0, 70)}\n`);
    }
  }
}

const approxWords = (t: number) => Math.round(t / TOK_PER_WORD);
console.log(`\n  ${TAILS.length} documents per bucket, identical except the final sentence.`);
console.log(`  The query asks for the final sentence, so a truncated document is unfindable.\n`);
console.log("  model                              served ctx  " + BUCKETS.map((b) => `${b / 1000}K`.padStart(8)).join(""));
console.log("  " + "─".repeat(76));
for (const m of models) {
  const cells = BUCKETS.map((b) => (table[m][b] ?? "-").padStart(8)).join("");
  console.log(`  ${m.padEnd(34)} ${ctxs[m].padStart(9)}  ${cells}`);
}
console.log(`\n  bucket sizes: ${BUCKETS.map((b) => `${b} tok ≈ ${approxWords(b)} words`).join(", ")}`);
console.log("  4/4 = every document found by its conclusion. 1/4 = chance.");
