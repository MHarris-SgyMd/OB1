#!/usr/bin/env bun
// decide_generative.ts (SMD-1961) — run a generative model (via Ollama's OpenAI API)
// as an entity validity+type classifier over the blind grading sheet, timing each
// call. Same task/options as the decider, for an apples-to-apples compare.
//   OB1_GEN_MODEL=qwen2.5:7b OB1_GEN_BASE=http://localhost:11434/v1 \
//     bun decide_generative.ts <sheet.jsonl> <out.json>
import { readFileSync, writeFileSync } from "node:fs";

const [sheet, outpath] = process.argv.slice(2);
const MODEL = process.env.OB1_GEN_MODEL ?? "qwen2.5:7b";
const BASE = process.env.OB1_GEN_BASE ?? "http://localhost:11434/v1";
const LABELS = ["tool", "topic", "project", "person", "organization", "place", "none"];
const SYS = `You classify a candidate entity. Given a NAME and its CONTEXT, reply with EXACTLY ONE word from this list and nothing else: ${LABELS.join(", ")}. Use "none" if it is not a specific named entity of one of those types.`;

const items = readFileSync(sheet, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const results: Record<string, { label: string; raw: string; ms: number }> = {};
let ok = 0, bad = 0;
const t0 = Date.now();
for (let i = 0; i < items.length; i++) {
  const it = items[i];
  const body = {
    model: MODEL, temperature: 0, max_tokens: 8,
    messages: [{ role: "system", content: SYS },
      { role: "user", content: `NAME: ${it.name}\nCONTEXT: ${it.context}\nANSWER:` }],
  };
  const t = Date.now();
  let raw = "", label = "none";
  try {
    const res = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json() as { choices?: { message?: { content?: string } }[] };
    raw = (j.choices?.[0]?.message?.content ?? "").trim();
    const low = raw.toLowerCase();
    label = LABELS.find((L) => low.includes(L)) ?? "none";
    ok++;
  } catch (e) { raw = `ERROR ${(e as Error).message.slice(0, 60)}`; bad++; }
  results[it.item] = { label, raw, ms: Date.now() - t };
  if ((i + 1) % 50 === 0) process.stderr.write(`  ${i + 1}/${items.length}\n`);
}
writeFileSync(outpath, JSON.stringify({ model: MODEL, base: BASE, n: items.length, ok, bad, total_ms: Date.now() - t0, results }));
console.log(`[done] ${MODEL}: ${ok} ok, ${bad} errors, ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${outpath}`);
