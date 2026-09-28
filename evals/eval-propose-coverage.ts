/**
 * eval-propose-coverage.ts (SMD-2017) — the proposer recall ceiling on the FORK'S
 * OWN content, not the research-paper gold. There are no hand labels for fork
 * content, so the denominator is the 7B extractor's own entity NAMES per thought
 * (recall is about the name being proposed; the decider does the typing): what
 * fraction of what the current extractor finds would propose→decide even see?
 * The SMD-1961 gold is arXiv papers (citation-dense, a proposer's worst case);
 * fork content is Linear issues, session summaries and notes — identifier- and
 * code-artifact-dominated, where the deterministic channels should do far better.
 *
 * Run read-only against the dogfood stable brain.
 */
import { SQL } from "bun";
import { proposeCandidates } from "../server-portable/propose.ts";
import { normalizeEntityName } from "../server-portable/entity-gate.ts";

const sql = new SQL(process.env.DATABASE_URL as string);
const N = Number(process.env.SAMPLE ?? 200);
// fork content: has entities, moderate length (excludes the giant research papers and trivial notes)
const rows = await sql`
  SELECT t.id, t.content
  FROM thoughts t
  WHERE length(t.content) BETWEEN 200 AND 20000
    AND EXISTS (SELECT 1 FROM thought_entities te WHERE te.thought_id = t.id)
  ORDER BY random() LIMIT ${N}`;
const ids = rows.map((r: any) => r.id);
// the 7B's entities (name + type) for those thoughts
const ents = new Map<string, { name: string; type: string }[]>();
for (const r of await sql`SELECT te.thought_id AS t, e.name, e.entity_type AS type FROM thought_entities te JOIN ob1_entities e ON e.id = te.entity_id WHERE te.thought_id IN ${sql(ids)}`) {
  const a = ents.get((r as any).t) ?? ents.set((r as any).t, []).get((r as any).t)!;
  a.push({ name: (r as any).name, type: (r as any).type });
}

// leave-one-out gazetteer: names the graph knows from >=2 DISTINCT thoughts, so
// a name is never the answer key for the single thought being scored (a name
// unique to one thought could not be recalled from elsewhere anyway).
const nameThoughts = new Map<string, Set<string>>();
for (const r of await sql`SELECT e.name, te.thought_id AS t FROM thought_entities te JOIN ob1_entities e ON e.id = te.entity_id`) {
  const k = normalizeEntityName((r as any).name); if (!k) continue;
  (nameThoughts.get(k) ?? nameThoughts.set(k, new Set()).get(k)!).add((r as any).t);
}
const gazDict = new Set<string>();
for (const [k, ts] of nameThoughts) if (ts.size >= 2) gazDict.add(k);
process.stderr.write(`gazetteer (recurring names, >=2 thoughts): ${gazDict.size}\n`);

const TYPES = ["tool", "topic", "project", "person", "organization", "place"];
let total = 0, found = 0, contain = 0, candTotal = 0, docs = 0;
const perType: Record<string, { total: number; found: number }> = {};
for (const t of TYPES) perType[t] = { total: 0, found: 0 };
const misses: { name: string; type: string }[] = [];
const tokenRunIn = (needle: string, hay: string) => (" " + hay + " ").includes(" " + needle + " ");

for (const r of rows) {
  const content = (r as any).content as string;
  docs++;
  const cands = proposeCandidates(content, { gazetteer: gazDict });
  candTotal += cands.length;
  const candNorms = cands.map((c) => normalizeEntityName(c.name)).filter(Boolean) as string[];
  const candNorm = new Set(candNorms);
  const seen = new Set<string>();
  for (const e of ents.get((r as any).id) ?? []) {
    const k = normalizeEntityName(e.name); if (!k || seen.has(k)) continue; seen.add(k);
    total++; (perType[e.type] ??= { total: 0, found: 0 }).total++;
    const exact = candNorm.has(k);
    if (exact) { found++; perType[e.type].found++; contain++; }
    else if (candNorms.some((c) => tokenRunIn(k, c) || tokenRunIn(c, k))) contain++;
    else if (misses.length < 5000) misses.push({ name: e.name, type: e.type });
  }
}

const pct = (a: number, b: number) => (b ? (100 * a / b).toFixed(1) : "0.0") + "%";
console.log(`\n=== SMD-2017 proposer coverage on fork content (${docs} thoughts, 7B entities as denominator, +leave-one-out gazetteer) ===`);
console.log(`exact coverage:       ${found}/${total} = ${pct(found, total)}`);
console.log(`containment coverage: ${contain}/${total} = ${pct(contain, total)}   (a candidate is a token-run of the entity or vice versa)`);
console.log(`candidates/doc ${(candTotal / (docs || 1)).toFixed(1)} avg`);
console.log(`\nper type:`);
for (const t of TYPES) console.log(`  ${t.padEnd(13)} ${perType[t].found}/${perType[t].total} = ${pct(perType[t].found, perType[t].total)}`);
console.log(`\nmiss sample (7B entities the proposer did not propose):`);
for (const m of misses.slice(0, 30)) console.log(`  [${m.type}] ${JSON.stringify(m.name)}`);
await sql.end();
