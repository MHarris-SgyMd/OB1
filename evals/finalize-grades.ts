#!/usr/bin/env bun
/**
 * finalize-grades.ts (SMD-1961) — merge the two blind graders + the maintainer's
 * adjudication into the ids-only labelled fixture (the entity-gate-grades.json
 * shape), and score the extractor's precision + type accuracy against it.
 * Local file reads only.
 */
import { readFileSync, writeFileSync } from "node:fs";
const HERE = new URL(".", import.meta.url).pathname;
const rd = (f: string) => JSON.parse(readFileSync(`${HERE}/${f}`, "utf8"));

const a = rd("grader-a.json") as Record<string, [number, string]>;
const b = rd("grader-b.json") as Record<string, [number, string]>;
const dec = rd("adjudication-decisions.json") as Record<string, [number, string]>;
const key = rd("grading-key.json").key as Record<string, { name: string; thought: string; entity: string; extractor_type: string; source: string }>;
const TYPES = ["tool", "topic", "project", "person", "organization", "place"];

const mentions: Record<string, unknown>[] = [];
let tp = 0, fp = 0, typeRight = 0, typeTotal = 0;
const valDist: Record<string, number> = { valid: 0, invalid: 0 };
const typeDist: Record<string, number> = {};

for (const id of Object.keys(key)) {
  const av = a[id] ?? [0, "none"], bv = b[id] ?? [0, "none"];
  let valid: number, type: string;
  if (dec[id]) { [valid, type] = dec[id]; }
  else if (av[0] === bv[0] && (av[0] === 0 || av[1] === bv[1])) { valid = av[0]; type = av[0] === 0 ? "none" : av[1]; }
  else { throw new Error(`unadjudicated disagreement ${id}`); }

  mentions.push({ thought: key[id].thought, entity: key[id].entity, valid, type: valid ? TYPES.indexOf(type) : -1, grader_a: av, grader_b: bv });
  valDist[valid ? "valid" : "invalid"]++;
  if (valid) typeDist[type] = (typeDist[type] ?? 0) + 1;

  // extractor precision: the extractor emitted every one of these (they are its rows), so each is a tp or fp by the adjudicated valid
  if (valid) { tp++; if (key[id].extractor_type === type) typeRight++; typeTotal++; }
  else fp++;
}

const precision = tp / (tp + fp);
writeFileSync(`${HERE}/fixtures/longdoc-grades.json`, JSON.stringify({
  generated: new Date().toISOString(),
  origin: "SMD-1961 long-document corpus (longest thoughts on the dogfood stable brain, mixed 7B/27B extraction incl. SMD-2240 partial prefixes); one mention per entity per doc, sampled by hash, the entity's first-occurrence window. Two blind Claude graders + maintainer adjudication; grader_a/grader_b are [valid,type-string], valid + type (index in types, -1 for none) are the adjudication. ids + numbers only (check 9).",
  types: TYPES,
  count: mentions.length,
  interannotator: "valid kappa 0.931 (97.5% raw); type agreement 90.8% among both-valid",
  mentions,
}, null, 1));

console.log(`  fixture: ${mentions.length} graded mentions → fixtures-longdoc-grades.json`);
console.log(`  adjudicated labels: ${valDist.valid} valid, ${valDist.invalid} invalid (${(valDist.valid / mentions.length * 100).toFixed(1)}% valid)`);
console.log(`  valid type distribution: ${Object.entries(typeDist).sort((x, y) => y[1] - x[1]).map(([t, n]) => `${n} ${t}`).join(", ")}`);
console.log(`\n  === extractor (qwen2.5:7b @p2, +27B on the partials) scored on this set ===`);
console.log(`  entity precision (valid / all extracted): ${tp}/${tp + fp} = ${(precision * 100).toFixed(1)}%`);
console.log(`  type accuracy (correct type | valid):     ${typeRight}/${typeTotal} = ${(typeRight / typeTotal * 100).toFixed(1)}%`);
