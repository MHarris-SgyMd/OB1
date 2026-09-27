#!/usr/bin/env bun
// score-comparison.ts (SMD-1961) — score each model's decisions on the long-doc
// entity set against the adjudicated gold, on ACCURACY and TIME.
//   bun score-comparison.ts <results.json> [<results.json> ...]
import { readFileSync } from "node:fs";
const HERE = new URL(".", import.meta.url).pathname;
const rd = (f: string) => JSON.parse(readFileSync(f[0] === "/" ? f : `${HERE}/${f}`, "utf8"));

// gold, derived the same way finalize-grades did
const a = rd("grader-a.json") as Record<string, [number, string]>;
const b = rd("grader-b.json") as Record<string, [number, string]>;
const dec = rd("adjudication-decisions.json") as Record<string, [number, string]>;
const key = rd("grading-key.json").key as Record<string, { extractor_type: string }>;
const gold: Record<string, [number, string]> = {};
for (const id of Object.keys(key)) {
  if (dec[id]) gold[id] = dec[id];
  else { const av = a[id] ?? [0, "none"], bv = b[id] ?? [0, "none"]; gold[id] = [av[0], av[0] ? av[1] : "none"]; }
}
const ids = Object.keys(gold);

const pct = (x: number) => (x * 100).toFixed(1) + "%";
const quant = (xs: number[], q: number) => { if (!xs.length) return 0; const s = [...xs].sort((m, n) => m - n); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

type Row = { model: string; validAcc: number; typeAcc: number; exact: number; meanMs: number | null; p50: number | null; p95: number | null; totalS: number | null; note: string };
const rows: Row[] = [];

function scoreModel(model: string, decide: (id: string) => { valid: number; type: string } | null, times: number[], note = "") {
  let vc = 0, tc = 0, tTotal = 0, exact = 0, missing = 0;
  for (const id of ids) {
    const d = decide(id);
    if (!d) { missing++; continue; }
    const [gv, gt] = gold[id];
    if (d.valid === gv) vc++;
    if (gv === 1 && d.valid === 1) { tTotal++; if (d.type === gt) tc++; }
    if (d.valid === gv && (gv === 0 || d.type === gt)) exact++;
  }
  const n = ids.length - missing;
  rows.push({ model, validAcc: vc / n, typeAcc: tTotal ? tc / tTotal : 0, exact: exact / n,
    meanMs: times.length ? times.reduce((s, x) => s + x, 0) / times.length : null,
    p50: times.length ? quant(times, 0.5) : null, p95: times.length ? quant(times, 0.95) : null,
    totalS: times.length ? times.reduce((s, x) => s + x, 0) / 1000 : null,
    note: note + (missing ? ` (${missing} missing)` : "") });
}

// baseline: the extractor's actual output (it emitted all as valid; type = its type)
scoreModel("extractor (7B @p2, real)", (id) => ({ valid: 1, type: key[id].extractor_type }), [], "extraction wall-clock, not per-decision");

for (const f of process.argv.slice(2)) {
  const j = rd(f) as { model: string; results: Record<string, { choice?: string; label?: string; ms: number }> };
  const times: number[] = [];
  const decide = (id: string) => {
    const r = j.results[id]; if (!r) return null;
    times.push(r.ms);
    const c = r.choice ?? r.label ?? "none";
    const invalid = c === "not a named entity" || c === "none";
    return { valid: invalid ? 0 : 1, type: invalid ? "none" : c };
  };
  // prime times array by scoring
  scoreModel(j.model, decide, times);
}

console.log(`\n  Entity validity + typing on the SMD-1961 long-doc set (${ids.length} graded mentions; gold = 2 blind graders κ=0.931 + adjudication)\n`);
console.log("  model                        valid-acc  type-acc  exact   mean ms   p50 ms   p95 ms   total");
console.log("  " + "─".repeat(98));
for (const r of rows) {
  const t = r.meanMs == null ? "     —        —        —        —  " :
    `${r.meanMs!.toFixed(0).padStart(7)}  ${String(r.p50).padStart(7)}  ${String(r.p95).padStart(7)}  ${r.totalS!.toFixed(0).padStart(5)}s`;
  console.log(`  ${r.model.padEnd(28)} ${pct(r.validAcc).padStart(8)}  ${pct(r.typeAcc).padStart(7)}  ${pct(r.exact).padStart(6)}  ${t}   ${r.note}`);
}
console.log("\n  valid-acc = valid/invalid decision vs gold; type-acc = correct type among gold-valid ∩ model-valid; exact = both right.");
