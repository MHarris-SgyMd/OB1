#!/usr/bin/env bun
/**
 * adjudicate.ts (SMD-1961) — combine the two blind graders: agreement, Cohen's
 * kappa on valid, type-agreement among both-valid, and the disagreement list to
 * hand-adjudicate. Auto-labels the agreements; emits the rest to adjudication-todo.json.
 * Local file reads only (no DB).
 */
import { readFileSync, writeFileSync } from "node:fs";
const HERE = new URL(".", import.meta.url).pathname;
const rd = (f: string) => JSON.parse(readFileSync(`${HERE}/${f}`, "utf8"));

const a = rd("grader-a.json") as Record<string, [number, string]>;
const b = rd("grader-b.json") as Record<string, [number, string]>;
const key = rd("grading-key.json").key as Record<string, { name: string; extractor_type: string; thought: string; entity: string; source: string }>;
const ctx: Record<string, string> = {};
for (const line of readFileSync(`${HERE}/grading-sheet.jsonl`, "utf8").split("\n").filter(Boolean)) {
  const o = JSON.parse(line); ctx[o.item] = o.context;
}

const ids = Object.keys(key);
let n11 = 0, n00 = 0, n10 = 0, n01 = 0; // valid confusion (A,B)
let bothValid = 0, typeAgree = 0;
const agreed: Record<string, { valid: number; type: string; grader_a: [number, string]; grader_b: [number, string] }> = {};
const todo: { item: string; name: string; extractor_type: string; a: [number, string]; b: [number, string]; reason: string; context: string }[] = [];

for (const id of ids) {
  const av = a[id]?.[0] ?? 0, at = a[id]?.[1] ?? "none";
  const bv = b[id]?.[0] ?? 0, bt = b[id]?.[1] ?? "none";
  if (av === 1 && bv === 1) n11++; else if (av === 0 && bv === 0) n00++; else if (av === 1 && bv === 0) n10++; else n01++;
  if (av !== bv) { todo.push({ item: id, name: key[id].name, extractor_type: key[id].extractor_type, a: [av, at], b: [bv, bt], reason: "valid", context: ctx[id] }); continue; }
  if (av === 0) { agreed[id] = { valid: 0, type: "none", grader_a: [av, at], grader_b: [bv, bt] }; continue; }
  // both valid
  bothValid++;
  if (at === bt) { typeAgree++; agreed[id] = { valid: 1, type: at, grader_a: [av, at], grader_b: [bv, bt] }; }
  else todo.push({ item: id, name: key[id].name, extractor_type: key[id].extractor_type, a: [av, at], b: [bv, bt], reason: "type", context: ctx[id] });
}

const N = ids.length;
const po = (n11 + n00) / N;
const pA = (n11 + n10) / N, pB = (n11 + n01) / N;
const pe = pA * pB + (1 - pA) * (1 - pB);
const kappa = (po - pe) / (1 - pe);

console.log(`  items: ${N}`);
console.log(`  valid confusion (A,B): both-valid ${n11}, both-invalid ${n00}, A-only ${n10}, B-only ${n01}`);
console.log(`  valid agreement: ${(po * 100).toFixed(1)}%  Cohen's kappa: ${kappa.toFixed(3)}`);
console.log(`  type agreement among both-valid: ${typeAgree}/${bothValid} = ${(typeAgree / bothValid * 100).toFixed(1)}%`);
console.log(`  → auto-agreed (labelled): ${Object.keys(agreed).length}`);
console.log(`  → to adjudicate: ${todo.length} (${todo.filter(t => t.reason === "valid").length} valid, ${todo.filter(t => t.reason === "type").length} type)`);

writeFileSync(`${HERE}/adjudication-agreed.json`, JSON.stringify(agreed, null, 1));
writeFileSync(`${HERE}/adjudication-todo.json`, JSON.stringify(todo, null, 1));
console.log(`  wrote adjudication-agreed.json + adjudication-todo.json`);
