#!/usr/bin/env bun
/**
 * build-grading-sheet.ts (SMD-1961) — turn the long-doc corpus's extractor output
 * into a blind entity-grading sheet, the SMD-1937/1982 method extended to long
 * documents: two blind graders decide valid + type from the name and a window of
 * the thought alone, no extractor type/confidence shown, lines shuffled.
 *
 * Reads longdoc-corpus.json (doc ids + text) and each doc's mentions from the
 * live brain; samples up to PER_DOC per document; writes:
 *   grading-sheet.jsonl  — {item, name, context}         (blind; for the grader)
 *   grading-key.json     — {item: {thought,entity,name,extractor_type,confidence}} (hidden answer key)
 * Neither carries corpus TEXT wholesale; the sheet holds only per-mention windows.
 * Read-only against the brain.
 */
import { SQL } from "bun";
import { readFileSync, writeFileSync } from "node:fs";

const sql = new SQL({ url: process.env.DATABASE_URL });
const HERE = new URL(".", import.meta.url).pathname;
const PER_DOC = Number(process.env.OB1_GRADE_PER_DOC ?? 20);
const WIN = 180; // context chars either side of the name's first occurrence

type Doc = { id: string; title: string; text: string; source: string; approx_windows: number };
const corpus = JSON.parse(readFileSync(`${HERE}/longdoc-corpus.json`, "utf8")) as { docs: Doc[] };

// deterministic per-item shuffle/sample key
const h = (s: string) => { let x = 5381; for (let i = 0; i < s.length; i++) x = ((x * 33) ^ s.charCodeAt(i)) >>> 0; return x; };

type SheetItem = { item: string; name: string; context: string };
type KeyItem = { thought: string; entity: string; name: string; extractor_type: string; confidence: number; source: string; approx_windows: number };
const sheet: SheetItem[] = [];
const key: Record<string, KeyItem> = {};

let docsWithExtraction = 0;
for (const d of corpus.docs) {
  const mentions = (await sql`
    SELECT e.id::text AS entity, e.name, e.entity_type AS type, m.confidence
    FROM thought_entities m JOIN ob1_entities e ON e.id = m.entity_id
    WHERE m.thought_id = ${d.id}::uuid`) as { entity: string; name: string; type: string; confidence: number }[];
  if (mentions.length === 0) continue; // failed/unextracted docs — a later phase (deterministic proposer)
  docsWithExtraction++;
  // sample PER_DOC by hash of (doc,name), stable
  const picked = mentions
    .map((m) => ({ m, k: h(d.id + "|" + m.name) }))
    .sort((a, b) => a.k - b.k)
    .slice(0, PER_DOC)
    .map((x) => x.m);
  for (const m of picked) {
    // context: first occurrence of the name (case-insensitive) in the doc text
    const idx = d.text.toLowerCase().indexOf(m.name.toLowerCase());
    const ctx = idx < 0
      ? "(name not found verbatim in the text — normalized/aliased mention)"
      : d.text.slice(Math.max(0, idx - WIN), idx + m.name.length + WIN).replace(/\s+/g, " ").trim();
    const item = `${d.id.slice(0, 8)}-${h(d.id + m.entity).toString(36)}`;
    sheet.push({ item, name: m.name, context: ctx });
    key[item] = { thought: d.id, entity: m.entity, name: m.name, extractor_type: m.type, confidence: m.confidence, source: d.source, approx_windows: d.approx_windows };
  }
}

// shuffle the sheet by item hash so graders see no per-doc grouping
sheet.sort((a, b) => h(a.item) - h(b.item));

writeFileSync(`${HERE}/grading-sheet.jsonl`, sheet.map((s) => JSON.stringify(s)).join("\n") + "\n");
writeFileSync(`${HERE}/grading-key.json`, JSON.stringify({
  generated: new Date().toISOString(),
  rubric: "valid 1 = a clearly identifiable, specific named entity of one of the six types the text holds (code identifiers/files/tables/functions/env vars/branches ARE entities — maintainer 2026-09-24); type ∈ {tool,topic,project,person,organization,place}. Grade from name + context only.",
  types: ["tool", "topic", "project", "person", "organization", "place"],
  count: sheet.length,
  key,
}, null, 1));

const byType: Record<string, number> = {};
for (const it of Object.values(key)) byType[it.extractor_type] = (byType[it.extractor_type] ?? 0) + 1;
console.log(`  ${sheet.length} items from ${docsWithExtraction} extracted docs (of ${corpus.docs.length} corpus docs; PER_DOC=${PER_DOC})`);
console.log(`  extractor types in the sample: ${Object.entries(byType).sort((a,b)=>b[1]-a[1]).map(([t,n])=>`${n} ${t}`).join(", ")}`);
console.log(`  wrote grading-sheet.jsonl (blind) + grading-key.json (hidden)`);
await sql.close();
