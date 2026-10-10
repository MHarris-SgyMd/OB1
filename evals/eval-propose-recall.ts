/**
 * eval-propose-recall.ts (SMD-2017) — the proposer's span recall is the ceiling
 * of propose→decide: a name the deterministic proposer does not offer can never
 * be decided in. This measures that ceiling before any decide call is wired,
 * against two denominators over the SMD-1961 long-doc thoughts:
 *   - GOLD: the labelled-valid entities (fixtures/longdoc-grades.json, resolved
 *     to names from the brain by id — the build-grading-sheet.ts pattern);
 *   - 7B: the entities the generative extractor currently holds for those
 *     thoughts (thought_entities), i.e. what propose→decide must at least cover
 *     to replace it.
 * It also reports candidate count per doc (the decide-cost proxy), which channel
 * found each hit, and the misses (what the proposer cannot see).
 *
 * Run against the dogfood stable brain (read-only):
 *   podman run … --network open-brain_data --env-file deploy/.env … \
 *     bun /repo/evals/eval-propose-recall.ts
 */
import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { proposeCandidates, type ProposalSource, type Candidate } from "../server-portable/propose.ts";
import { normalizeEntityName } from "../server-portable/entity-gate.ts";

const TYPES = ["tool", "topic", "project", "person", "organization", "place"] as const;
const sql = new SQL(process.env.DATABASE_URL as string);
const gold = JSON.parse(readFileSync(new URL("./fixtures/longdoc-grades.json", import.meta.url), "utf8")) as
  { mentions: { thought: string; entity: string; valid: 0 | 1; type: number }[] };

// distinct thoughts, and the entity ids we must resolve to names
const thoughtIds = [...new Set(gold.mentions.map((m) => m.thought))];
const entityIds = [...new Set(gold.mentions.map((m) => m.entity))];
const contents = new Map<string, string>((await sql`SELECT id, content FROM thoughts WHERE id IN ${sql(thoughtIds)}`).map((r: any) => [r.id, r.content as string]));
const entityName = new Map<string, string>((await sql`SELECT id, name FROM ob1_entities WHERE id IN ${sql(entityIds)}`).map((r: any) => [r.id, r.name as string]));
// the 7B's current entities per thought (what propose→decide must cover to replace it)
const sevenB = new Map<string, Set<string>>();
for (const r of await sql`SELECT te.thought_id AS t, e.name FROM thought_entities te JOIN ob1_entities e ON e.id = te.entity_id WHERE te.thought_id IN ${sql(thoughtIds)}`) {
  const k = normalizeEntityName((r as any).name); if (!k) continue;
  (sevenB.get((r as any).t) ?? sevenB.set((r as any).t, new Set()).get((r as any).t)!).add(k);
}
// leave-one-out gazetteer: names the graph knows from >=2 DISTINCT thoughts
const nameThoughts = new Map<string, Set<string>>();
for (const r of await sql`SELECT e.name, te.thought_id AS t FROM thought_entities te JOIN ob1_entities e ON e.id = te.entity_id`) {
  const k = normalizeEntityName((r as any).name); if (!k) continue;
  (nameThoughts.get(k) ?? nameThoughts.set(k, new Set()).get(k)!).add((r as any).t);
}
const gazDict = new Set<string>();
for (const [k, ts] of nameThoughts) if (ts.size >= 2) gazDict.add(k);
const tokenRunIn = (needle: string, hay: string) => (" " + hay + " ").includes(" " + needle + " ");
let goldContain = 0;
process.stderr.write(`loaded ${thoughtIds.length} thoughts, ${entityName.size} entity names, gazetteer ${gazDict.size}\n`);

let goldTotal = 0, goldFound = 0, goldUnresolved = 0;
let sevenTotal = 0, sevenFound = 0;
let candTotal = 0, docs = 0;
const perType = TYPES.map(() => ({ total: 0, found: 0 }));
const bySource: Record<ProposalSource, number> = { identifier: 0, "proper-noun": 0, citation: 0, org: 0, gazetteer: 0 };
const goldMisses: { name: string; type: string }[] = [];

for (const tid of thoughtIds) {
  const content = contents.get(tid); if (!content) continue;
  docs++;
  const t0 = Date.now();
  const cands = proposeCandidates(content, { gazetteer: gazDict });
  process.stderr.write(`  doc ${docs}/${thoughtIds.length} len=${content.length} cands=${cands.length} ${Date.now() - t0}ms\n`);
  candTotal += cands.length;
  const candByNorm = new Map<string, Candidate>();
  for (const c of cands) { const k = normalizeEntityName(c.name); if (k) candByNorm.set(k, c); }
  const candNorms = [...candByNorm.keys()];
  // gold recall
  for (const m of gold.mentions.filter((x) => x.thought === tid && x.valid === 1)) {
    const raw = entityName.get(m.entity);
    if (!raw) { goldUnresolved++; continue; }
    const k = normalizeEntityName(raw); if (!k) continue;
    goldTotal++;
    const ti = m.type >= 0 && m.type < TYPES.length ? m.type : -1;
    if (ti >= 0) perType[ti].total++;
    const hit = candByNorm.get(k);
    if (hit) { goldFound++; goldContain++; if (ti >= 0) perType[ti].found++; for (const s of hit.sources) bySource[s]++; }
    else if (candNorms.some((c) => tokenRunIn(k, c) || tokenRunIn(c, k))) goldContain++;
    else goldMisses.push({ name: raw, type: ti >= 0 ? TYPES[ti] : "?" });
  }
  // 7B coverage
  for (const k of sevenB.get(tid) ?? []) { sevenTotal++; if (candByNorm.has(k)) sevenFound++; }
}

const pct = (a: number, b: number) => (b ? (100 * a / b).toFixed(1) : "0.0") + "%";
console.log(`\n=== SMD-2017 proposer recall ceiling (${docs} long-doc thoughts) ===`);
console.log(`GOLD recall (labelled-valid entities): exact ${goldFound}/${goldTotal} = ${pct(goldFound, goldTotal)}, containment ${goldContain}/${goldTotal} = ${pct(goldContain, goldTotal)}   [${goldUnresolved} gold ids no longer resolve in the brain]`);
console.log(`7B  coverage (current extractor entities): ${sevenFound}/${sevenTotal} = ${pct(sevenFound, sevenTotal)}`);
console.log(`candidates/doc: ${(candTotal / (docs || 1)).toFixed(1)} avg  (the decide-cost proxy: ×2 decisions each)`);
console.log(`\nper gold type (recall):`);
TYPES.forEach((t, i) => console.log(`  ${t.padEnd(13)} ${perType[i].found}/${perType[i].total} = ${pct(perType[i].found, perType[i].total)}`));
console.log(`\nchannel that found the gold hits (a hit can have several): ${JSON.stringify(bySource)}`);
console.log(`\ngold MISSES — what the proposer cannot see (${goldMisses.length}), sample:`);
for (const m of goldMisses.slice(0, 40)) console.log(`  [${m.type}] ${JSON.stringify(m.name)}`);
await sql.end();
