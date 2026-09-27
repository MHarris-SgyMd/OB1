#!/usr/bin/env bun
/**
 * jev-reliability.ts (SMD-2052) — does a model's CONFIDENCE separate its correct
 * validity calls from its wrong ones? Issues the binary validity decision per
 * SMD-1961 item, keeps p_true, bins by p_true, and reports the gold-valid rate
 * per bin. If high p_true → high gold-valid rate (and low → low), confidence is
 * informative and a decider-arbitrated cascade is viable; if flat, it is noise.
 *
 *   bun jev/decider/jev-reliability.ts <base-url> <model-name>
 */
const [BASE, MODEL] = process.argv.slice(2);
const fs = require("node:fs");
const G = process.env.OB1_JEV_GOLD_DIR;
if (!G) { console.error("set OB1_JEV_GOLD_DIR to the SMD-1961 evals dir with the gold files"); process.exit(2); }
const rd = (f: string) => JSON.parse(fs.readFileSync(`${G}/${f}`, "utf8"));
const a = rd("grader-a.json"), b = rd("grader-b.json"), dec = rd("adjudication-decisions.json"), key = rd("grading-key.json").key;
const gold: Record<string, number> = {};
for (const id of Object.keys(key)) gold[id] = dec[id] ? dec[id][0] : ((a[id]?.[0] ?? 0));
const sheet = fs.readFileSync(`${G}/grading-sheet.jsonl`, "utf8").split("\n").filter(Boolean).map((l: string) => JSON.parse(l));

type Row = { pTrue: number; pIns: number; goldValid: number };
const rows: Row[] = [];
for (let i = 0; i < sheet.length; i++) {
  const it = sheet[i];
  const req = { model: MODEL, decisions: [{ id: "v", kind: "binary", proposition: `"${it.name}" is a specific named entity (a tool, topic, project, person, organization, or place), not a generic word or phrase`, context: it.context }] };
  try {
    const res = await fetch(`${BASE}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
    const j = await res.json() as { results?: { p_true?: number | null; p_insufficient: number }[] };
    const r = j.results?.[0]; if (!r) continue;
    rows.push({ pTrue: r.p_true ?? 0, pIns: r.p_insufficient, goldValid: gold[it.item] });
  } catch {}
  if ((i + 1) % 80 === 0) process.stderr.write(`  ${i + 1}/${sheet.length}\n`);
}

// reliability table: bin by p_true, gold-valid rate per bin (base rate is 75.3%)
const bins = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];
console.log(`\n  ${MODEL} validity reliability (n=${rows.length}); base rate ${(rows.filter(r => r.goldValid).length / rows.length * 100).toFixed(1)}% valid`);
console.log("  p_true bin      items   gold-valid%   (if informative, this rises across bins)");
for (let k = 0; k < bins.length - 1; k++) {
  const inb = rows.filter(r => r.pTrue >= bins[k] && r.pTrue < bins[k + 1]);
  const gv = inb.filter(r => r.goldValid).length;
  console.log(`  [${bins[k].toFixed(1)}, ${bins[k + 1] > 1 ? "1.0]" : bins[k + 1].toFixed(1) + ")"}  ${String(inb.length).padStart(6)}   ${inb.length ? (gv / inb.length * 100).toFixed(1) + "%" : "—"}`);
}
// separation: does thresholding on p_true beat the base rate? report top/bottom quartiles
const byConf = [...rows].sort((x, y) => y.pTrue - x.pTrue);
const q = Math.floor(rows.length / 4);
const top = byConf.slice(0, q), bot = byConf.slice(-q);
console.log(`\n  top-quartile p_true: ${(top.filter(r => r.goldValid).length / q * 100).toFixed(1)}% valid  |  bottom-quartile: ${(bot.filter(r => r.goldValid).length / q * 100).toFixed(1)}% valid`);
// simple AUC (prob a random valid outranks a random invalid on p_true)
const pos = rows.filter(r => r.goldValid).map(r => r.pTrue), neg = rows.filter(r => !r.goldValid).map(r => r.pTrue);
let wins = 0, ties = 0;
for (const p of pos) for (const n of neg) { if (p > n) wins++; else if (p === n) ties++; }
console.log(`  AUC (p_true ranks valid over invalid): ${((wins + ties / 2) / (pos.length * neg.length)).toFixed(3)}  (0.5 = no signal, 1.0 = perfect)`);
