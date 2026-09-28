/**
 * eval-hybrid.ts (SMD-2017) — the third shape: 7B PROPOSES → decider DECIDES.
 * The SMD-1961 gold was sampled from the 7B's own extractions, so the gold items
 * ARE 7B proposals; scoring the decider over them measures the hybrid's decide
 * quality on what the generative extractor finds (its full recall, by
 * construction). Reported beside the pure-generative baseline (the 7B's own
 * stored type) so the two shapes compare on one gold, one client.
 *
 * Needs the brain (DATABASE_URL) and decider-4b (OB1_JEV_BASE, default
 * host.containers.internal:8021) both reachable.
 */
import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { normalizeEntityName } from "../server-portable/entity-gate.ts";

const TYPES = ["tool", "topic", "project", "person", "organization", "place"];
const BASE = process.env.OB1_JEV_BASE ?? "http://host.containers.internal:8021";
const sql = new SQL(process.env.DATABASE_URL as string);
const gold = JSON.parse(readFileSync(new URL("./fixtures/longdoc-grades.json", import.meta.url), "utf8")) as
  { mentions: { thought: string; entity: string; valid: 0 | 1; type: number }[] };

const thoughtIds = [...new Set(gold.mentions.map((m) => m.thought))];
const entityIds = [...new Set(gold.mentions.map((m) => m.entity))];
const content = new Map<string, string>((await sql`SELECT id, content FROM thoughts WHERE id IN ${sql(thoughtIds)}`).map((r: any) => [r.id, r.content as string]));
const ent = new Map<string, { name: string; type: string }>((await sql`SELECT id, name, entity_type AS type FROM ob1_entities WHERE id IN ${sql(entityIds)}`).map((r: any) => [r.id, { name: r.name as string, type: r.type as string }]));

// reconstruct each gold item: name + 180-char context window (build-grading-sheet.ts pattern)
const WIN = 180;
type Item = { name: string; ctx: string; gValid: number; gType: number; b7Type: string };
const items: Item[] = [];
for (const m of gold.mentions) {
  const e = ent.get(m.entity); const doc = content.get(m.thought);
  if (!e || !doc) continue;
  const at = doc.toLowerCase().indexOf(e.name.toLowerCase());
  const ctx = (at < 0 ? doc.slice(0, 2 * WIN) : doc.slice(Math.max(0, at - WIN), at + e.name.length + WIN)).replace(/\s+/g, " ").trim();
  items.push({ name: e.name, ctx, gValid: m.valid, gType: m.type, b7Type: e.type });
}

// decider over each item (batched): a validity binary + a type choice with the
// contract's real descriptions (a semantic decider reads the description; bare
// names starve it — jev-compare.ts's wording, the production framing).
const TYPE_DESC: Record<string, string> = {
  tool: "a tool, software, library, file, table, function, or code artifact",
  topic: "a general topic, concept, or subject",
  project: "a named project, initiative, or unit of work",
  person: "a specific person",
  organization: "a company or organization",
  place: "a geographic place or location",
};
const typeOptions = TYPES.map((t) => ({ id: t, description: TYPE_DESC[t] }));
const dec = new Map<number, { valid: number; type: string }>();
const BATCH = 30;
for (let i = 0; i < items.length; i += BATCH) {
  const slice = items.slice(i, i + BATCH);
  const decisions = slice.flatMap((it, j) => [
    { id: `v${j}`, kind: "binary", proposition: `"${it.name}" is a specific named entity (a tool, topic, project, person, organization, or place), not a generic word or phrase`, context: it.ctx },
    { id: `t${j}`, kind: "choice", question: `What type of entity is "${it.name}"?`, options: typeOptions, context: it.ctx },
  ]);
  const res = await fetch(`${BASE}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "decider-4b", decisions }) });
  const j = await res.json() as { results?: { id?: string; selected: string }[] };
  if (!res.ok || !j.results) { process.stderr.write(`batch ${i} error\n`); continue; }
  for (let k = 0; k < slice.length; k++) {
    const v = j.results.find((r) => r.id === `v${k}`), t = j.results.find((r) => r.id === `t${k}`);
    const valid = v?.selected === "true" ? 1 : 0;
    const type = valid && t && TYPES.includes(t.selected) ? t.selected : "none";
    dec.set(i + k, { valid, type });
  }
  process.stderr.write(`  decided ${Math.min(i + BATCH, items.length)}/${items.length}\n`);
}

// score both shapes
const score = (verdict: (it: Item, i: number) => { valid: number; type: string }) => {
  let vAcc = 0, tAcc = 0, tDen = 0, exact = 0;
  items.forEach((it, i) => {
    const p = verdict(it, i);
    if (p.valid === it.gValid) vAcc++;
    if (it.gValid === 1 && p.valid === 1) { tDen++; if (TYPES[it.gType] === p.type) tAcc++; }
    if (p.valid === it.gValid && (it.gValid === 0 || TYPES[it.gType] === p.type)) exact++;
  });
  const n = items.length;
  return { validAcc: vAcc / n, typeAcc: tDen ? tAcc / tDen : 0, exact: exact / n };
};
// generative 7B: it extracted every gold item, so it predicts valid=1 for all, and types with its stored type
const gen = score((it) => ({ valid: 1, type: it.b7Type }));
const hyb = score((_, i) => dec.get(i) ?? { valid: 0, type: "none" });
const pct = (x: number) => (100 * x).toFixed(1) + "%";
console.log(`\n=== SMD-2017 shape comparison on the SMD-1961 gold (${items.length} items) ===`);
console.log(`  shape                         valid-acc   type-acc   exact`);
console.log(`  pure generative (7B types)    ${pct(gen.validAcc).padStart(7)}    ${pct(gen.typeAcc).padStart(7)}   ${pct(gen.exact).padStart(7)}`);
console.log(`  HYBRID (7B propose→decide)    ${pct(hyb.validAcc).padStart(7)}    ${pct(hyb.typeAcc).padStart(7)}   ${pct(hyb.exact).padStart(7)}`);
console.log(`\n  pure propose→decide is additionally recall-capped by the proposer ceiling (67% research / 78% fork exact, ~89% containment — eval-propose-recall/coverage).`);
await sql.end();
