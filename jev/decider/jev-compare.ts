#!/usr/bin/env bun
/**
 * jev-compare.ts (SMD-2052) — compare Jev-type classifiers THROUGH the ob1-jev/1
 * contract on the SMD-1961 entity gold. For each candidate it issues the winning
 * two-decision pattern (a binary validity gate + a choice type) as one /decide
 * request, so decider (:8021) and Verdict (:8020) are measured by the same client
 * on accuracy AND time (the response's server wall-clock).
 *
 *   bun jev/decider/jev-compare.ts <base-url> <model-name> [out.json]
 */
import { readFileSync, writeFileSync } from "node:fs";

const [BASE, MODEL, OUT] = process.argv.slice(2);
if (!BASE || !MODEL) { console.error("usage: jev-compare.ts <base-url> <model-name> [out.json]"); process.exit(2); }

const G = process.env.OB1_JEV_GOLD_DIR;
if (!G) { console.error("set OB1_JEV_GOLD_DIR to the SMD-1961 evals dir holding grader-a.json, grader-b.json, adjudication-decisions.json, grading-key.json and grading-sheet.jsonl"); process.exit(2); }
const rd = (f: string) => JSON.parse(readFileSync(`${G}/${f}`, "utf8"));
const a = rd("grader-a.json"), b = rd("grader-b.json"), dec = rd("adjudication-decisions.json");
const key = rd("grading-key.json").key as Record<string, unknown>;
const gold: Record<string, [number, string]> = {};
for (const id of Object.keys(key)) {
  if (dec[id]) gold[id] = dec[id];
  else { const av = a[id] ?? [0, "none"], bv = b[id] ?? [0, "none"]; gold[id] = [av[0], av[0] ? av[1] : "none"]; }
}
const sheet = readFileSync(`${G}/grading-sheet.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const TYPES: Record<string, string> = {
  tool: "a tool, software, library, file, table, function, or code artifact",
  topic: "a general topic, concept, or subject",
  project: "a named project, initiative, or unit of work",
  person: "a specific person",
  organization: "a company or organization",
  place: "a geographic place or location",
};
const typeOptions = Object.entries(TYPES).map(([id, description]) => ({ id, description }));

const quant = (xs: number[], q: number) => { const s = [...xs].sort((m, n) => m - n); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };

let vc = 0, tc = 0, tTot = 0, exact = 0, errs = 0;
const times: number[] = [];
const perItem: Record<string, { valid: number; type: string }> = {};

for (let i = 0; i < sheet.length; i++) {
  const it = sheet[i];
  const req = {
    model: MODEL,
    decisions: [
      { id: "v", kind: "binary", proposition: `"${it.name}" is a specific named entity (a tool, topic, project, person, organization, or place), not a generic word or phrase`, context: it.context },
      { id: "t", kind: "choice", question: `What type of entity is "${it.name}"?`, options: typeOptions, context: it.context },
    ],
  };
  try {
    const res = await fetch(`${BASE}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
    const j = await res.json() as { results?: { id?: string; selected: string }[]; ms?: number; error?: string };
    if (!res.ok || !j.results) { errs++; continue; }
    times.push(j.ms ?? 0);
    const vr = j.results.find((r) => r.id === "v"), tr = j.results.find((r) => r.id === "t");
    const valid = vr?.selected === "true" ? 1 : 0;
    const type = valid && tr && TYPES[tr.selected] ? tr.selected : "none";
    perItem[it.item] = { valid, type };
    const [gv, gt] = gold[it.item];
    if (valid === gv) vc++;
    if (gv === 1 && valid === 1) { tTot++; if (type === gt) tc++; }
    if (valid === gv && (gv === 0 || type === gt)) exact++;
  } catch { errs++; }
  if ((i + 1) % 50 === 0) process.stderr.write(`  ${i + 1}/${sheet.length}\n`);
}

const n = sheet.length - errs;
const pct = (x: number) => (x * 100).toFixed(1) + "%";
const row = { model: MODEL, base: BASE, n, errs, validAcc: vc / n, typeAcc: tTot ? tc / tTot : 0, exact: exact / n,
  meanMs: times.reduce((s, x) => s + x, 0) / (times.length || 1), p50: quant(times, 0.5), p95: quant(times, 0.95), totalS: times.reduce((s, x) => s + x, 0) / 1000 };
console.log(`\n  ${MODEL} via ob1-jev/1 @ ${BASE} (${n} items, ${errs} errors)`);
console.log(`  valid-acc ${pct(row.validAcc)}  type-acc ${pct(row.typeAcc)}  exact ${pct(row.exact)}  |  mean ${row.meanMs.toFixed(0)}ms  p50 ${row.p50.toFixed(0)}ms  p95 ${row.p95.toFixed(0)}ms  total ${row.totalS.toFixed(0)}s`);
if (OUT) writeFileSync(OUT, JSON.stringify({ row, perItem }, null, 1));
