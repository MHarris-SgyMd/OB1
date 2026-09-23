#!/usr/bin/env bun
/**
 * eval-extract-windows.ts — does extracting a long thought in windows finish
 * where one call did not, and what does it cost in relationships? (SMD-1879)
 *
 * Two document sets, both through the SAME function the worker calls
 * (`extractEntities`, with the windowing passed explicitly per arm) and the
 * SAME write path and resolution rule (`record_thought_entities`, migration
 * 016) — so what is scored is what the worker would store:
 *
 *   OB1_EVAL_DOCS=stragglers.json ../db/with-postgres.sh bun eval-extract-windows.ts
 *       A JSON array of {id, content} — the thoughts that failed whole-content
 *       extraction on a brain (the 32 that timed out at 900 s on the fork's
 *       own, exported with the query in evals/README.md). Per arm: how many
 *       extract, how many answers are malformed or time out, seconds per
 *       thought, entities and edges written.
 *
 *   ../db/with-postgres.sh bun eval-extract-windows.ts --planted
 *       Three long documents with facts PLANTED at known distances: a subject
 *       and a person named in the opening, and a relation to the subject
 *       stated in the closing paragraph where the subject is "the project".
 *       Per arm: recall of the planted entities and of the planted relations,
 *       split into the relations whose endpoints share a window and the one
 *       whose endpoints do not — the loss windowing is expected to have, and
 *       what the header buys back.
 *
 *   --arms whole,w1200,w1200h,w600,w600h,whole+p,w1200p,w600p    which arms (default: all)
 *   --limit N        first N documents        --timeout S    per call (default 300)
 *
 * Arms: `whole` is one call over the WHOLE text with no answer budget — p1's
 * request without p1's 8,000-character cut, so a fair baseline for the windows
 * and not a re-run of what p1 stored; `whole+budget` the same call with
 * `max_tokens`; `wNNN` windows of NNN estimated tokens with the budget;
 * `wNNNh` the same with the note's opening line led into every window after
 * the first; `…p` retries a call that ran to its budget once with a frequency
 * penalty (entities.ts, RUNAWAY_PENALTY). The model, endpoint and temperature
 * are the metadata-extraction ones, through the worker's resolver.
 */

import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { loadEnv } from "./env.ts";
import { resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { callsMadeBy, callsOf, extractEntities, extractionKey, type Extraction, type ExtractWindowing } from "../server-portable/entities.ts";
import { estimateTokens, EXTRACT_OVERLAP_RATIO } from "../server-portable/chunk.ts";
import { requireDatabaseUrl, resetSchema } from "../db/test-support.ts";

loadEnv();
const URL_ = requireDatabaseUrl("eval-extract-windows.ts");
const args = process.argv.slice(2);
const has = (n: string) => args.includes(`--${n}`);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && !args[i + 1]?.startsWith("--") ? args[i + 1] : undefined; };
const evalBase = process.env.OB1_EVAL_BASE ?? process.env.OLLAMA_BASE;
if (!process.env.OB1_LLM_BASE_URL && evalBase) process.env.OB1_LLM_BASE_URL = evalBase;
if (!process.env.OB1_LLM_API_KEY && process.env.OB1_EVAL_KEY) process.env.OB1_LLM_API_KEY = process.env.OB1_EVAL_KEY;

const cfg = resolveEmbedConfig(process.env as EmbedEnv);
const TIMEOUT_MS = Number(flag("timeout") ?? 300) * 1000;
const LIMIT = flag("limit") ? Number(flag("limit")) : undefined;
const key = extractionKey(cfg.metadataModel);

type Doc = { id: string; content: string };
type Planted = Doc & {
  entities: { type: string; name: string }[];
  /** `far` — the endpoints are named in different windows at every arm below the document's length. */
  relations: { from: string; to: string; relation: string; far: boolean }[];
};

// ── Arms ─────────────────────────────────────────────────────────────────────

type Arm = { name: string; windowing: ExtractWindowing };
// The worker's own overlap rule (embed.ts), not a copy of its numbers.
const overlap = (n: number) => Math.floor(n * EXTRACT_OVERLAP_RATIO);
const arm = (name: string, windowTokens: number, opts: Partial<ExtractWindowing> = {}): Arm => ({
  name,
  windowing: { windowTokens, overlapTokens: windowTokens === Number.MAX_SAFE_INTEGER ? 0 : overlap(windowTokens), header: false, outputBudget: true, retryRunaway: false, ...opts },
});
const ALL_ARMS: Arm[] = [
  arm("whole", Number.MAX_SAFE_INTEGER, { outputBudget: false }),
  arm("whole+budget", Number.MAX_SAFE_INTEGER),
  arm("w1200", 1200),
  arm("w1200h", 1200, { header: true }),
  arm("w600", 600),
  arm("w600h", 600, { header: true }),
  // `p`: a call that runs to its budget is made once more with the frequency penalty.
  arm("whole+p", Number.MAX_SAFE_INTEGER, { retryRunaway: true }),
  arm("w1200p", 1200, { retryRunaway: true }),
  arm("w600p", 600, { retryRunaway: true }),
];
const wanted = flag("arms")?.split(",").map((s) => s.trim()).filter(Boolean);
const ARMS = wanted ? ALL_ARMS.filter((a) => wanted.includes(a.name)) : ALL_ARMS;
if (wanted && ARMS.length !== wanted.length) { console.error(`unknown arm in --arms; known: ${ALL_ARMS.map((a) => a.name).join(", ")}`); process.exit(2); }

// ── The planted set ──────────────────────────────────────────────────────────

/** Neutral filler: meeting-note prose with no named entities, so a window between the planted facts extracts nothing that competes with them. */
function filler(paragraphs: number, seed: number): string {
  const sentences = [
    "The morning session went over the remaining open questions from last week and agreed on who would follow up on each.",
    "Most of the discussion concerned how the rollout should be sequenced so that the earlier steps could be reverted without touching the later ones.",
    "There was general agreement that the documentation should be updated before the change lands rather than after.",
    "Several people asked for the timeline to be written down, and it was, with the caveat that the dates were estimates.",
    "The afternoon was spent reviewing the checklist item by item, and two items were dropped as no longer relevant.",
    "A recurring theme was that the earlier decision to keep the interface small had made this round of changes easier.",
    "The notes from the previous review were read back and nothing in them was contradicted by what was decided today.",
    "It was agreed that the next review would look at the measurements rather than at the plan again.",
    "One participant noted that the cost estimates had not been revisited since the scope changed, and this was added to the list.",
    "The session closed with a summary of the decisions and the names of those responsible for each follow-up.",
  ];
  const out: string[] = [];
  for (let p = 0; p < paragraphs; p++) {
    const n = 4 + ((seed + p) % 3);
    const s: string[] = [];
    for (let i = 0; i < n; i++) s.push(sentences[(seed * 7 + p * 3 + i) % sentences.length]);
    out.push(s.join(" "));
  }
  return out.join("\n\n");
}

const PLANTED: Planted[] = [
  {
    id: "planted-1",
    content: `Open Brain review notes\n\nAnita leads the Open Brain project and opened the review.\n\n${filler(22, 1)}\n\nClosing: the project depends on PostgreSQL for every store it ships, and Anita will present the results at Acme next month.`,
    entities: [{ type: "person", name: "Anita" }, { type: "project", name: "Open Brain" }, { type: "tool", name: "PostgreSQL" }, { type: "organization", name: "Acme" }],
    relations: [
      { from: "Anita", to: "Open Brain", relation: "works_on", far: false },
      { from: "Open Brain", to: "PostgreSQL", relation: "depends_on", far: true },
    ],
  },
  {
    id: "planted-2",
    content: `Kafka migration — planning session\n\nSam owns the Kafka migration at Acme.\n\n${filler(24, 2)}\n\nOutcome: the migration now targets Redpanda instead, and Sam moves to the platform team in Lisbon.`,
    entities: [{ type: "person", name: "Sam" }, { type: "organization", name: "Acme" }, { type: "tool", name: "Kafka" }, { type: "tool", name: "Redpanda" }, { type: "place", name: "Lisbon" }],
    relations: [
      { from: "Sam", to: "Acme", relation: "member_of", far: false },
      { from: "Kafka migration", to: "Redpanda", relation: "uses", far: true },
    ],
  },
  {
    id: "planted-3",
    content: `Grafana rollout\n\nPriya approved the Grafana rollout for the observability team.\n\n${filler(20, 3)}\n\nDecision: the rollout uses Prometheus as its only data source, and Dev will pair with Priya on the dashboards.`,
    entities: [{ type: "person", name: "Priya" }, { type: "person", name: "Dev" }, { type: "tool", name: "Grafana" }, { type: "tool", name: "Prometheus" }],
    relations: [
      { from: "Dev", to: "Priya", relation: "co_occurs_with", far: false },
      { from: "Grafana rollout", to: "Prometheus", relation: "uses", far: true },
    ],
  },
];

// ── Run ──────────────────────────────────────────────────────────────────────

await resetSchema(URL_, { dim: 8, model: "eval-stub" });
const sql = new SQL({ url: URL_, max: 2 });
const norm = async (s: string) => ((await sql`SELECT normalize_entity_name(${s}) AS n`)[0] as { n: string | null }).n ?? "";

/** `calls` is every model call the thought cost — entities.ts's callsOf, the worker's own count, or what a thrown thought had made (fourth and fifth review passes). */
type Outcome = { arm: string; id: string; tokens: number; windows: number; calls: number; ok: boolean; malformed: boolean; timedOut: boolean; error?: string; seconds: number; entities: number; edges: number; retried: boolean };
const outcomes: Outcome[] = [];

async function runOne(arm: Arm, doc: Doc): Promise<{ thoughtId: string | null; ex: Extraction | null; out: Outcome }> {
  const t0 = Date.now();
  const tokens = estimateTokens(doc.content);
  const [{ r }] = await sql`SELECT upsert_thought(${`${arm.name} :: ${doc.id}\n\n${doc.content}`}, ${{ metadata: { arm: arm.name, doc: doc.id } }}::jsonb) AS r`;
  const thoughtId = (r as { id: string }).id;
  try {
    const ex = await extractEntities(doc.content, cfg, TIMEOUT_MS, { kind: "extraction" }, arm.windowing);
    const seconds = (Date.now() - t0) / 1000;
    const retried = ex.retried === true;
    if (ex.malformed) {
      const out = { arm: arm.name, id: doc.id, tokens, windows: ex.windows, calls: callsOf(ex), ok: false, malformed: true, timedOut: false, seconds, entities: 0, edges: 0, retried };
      outcomes.push(out);
      return { thoughtId, ex, out };
    }
    const [{ w }] = await sql`SELECT record_thought_entities(${thoughtId}::uuid, ${key}, ${ex.entities}::jsonb, ${ex.relations}::jsonb) AS w`;
    const res = w as { mentions?: number; edges?: number };
    const out = { arm: arm.name, id: doc.id, tokens, windows: ex.windows, calls: callsOf(ex), ok: true, malformed: false, timedOut: false, seconds, entities: res.mentions ?? 0, edges: res.edges ?? 0, retried };
    outcomes.push(out);
    return { thoughtId, ex, out };
  } catch (e) {
    const seconds = (Date.now() - t0) / 1000;
    const timedOut = (e as Error).name === "TimeoutError" || /timed out/i.test((e as Error).message);
    // The calls a thrown thought made ride on the error, so the `calls`
    // column counts them (second review pass).
    const out = { arm: arm.name, id: doc.id, tokens, windows: 0, calls: callsMadeBy(e), ok: false, malformed: false, timedOut, error: (e as Error).message.slice(0, 120), seconds, entities: 0, edges: 0, retried: false };
    outcomes.push(out);
    return { thoughtId, ex: null, out };
  }
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

console.log(`  model:  ${cfg.metadataModel} via ${cfg.chat.base}, temperature ${cfg.metadataTemperature}, ${TIMEOUT_MS / 1000} s per call`);
console.log(`  arms:   ${ARMS.map((a) => a.name).join(", ")}\n`);

if (has("planted")) {
  const docs = LIMIT ? PLANTED.slice(0, LIMIT) : PLANTED;
  for (const d of docs) console.log(`  ${d.id}: ${estimateTokens(d.content)} estimated tokens, ${d.entities.length} planted entities, ${d.relations.length} planted relations (${d.relations.filter((r) => r.far).length} far)`);
  console.log("");
  const rows: { arm: string; ents: string; near: string; far: string; ok: number; windows: string; sec: number }[] = [];
  for (const arm of ARMS) {
    let entHit = 0, entTotal = 0, nearHit = 0, nearTotal = 0, farHit = 0, farTotal = 0, ok = 0;
    const windows: number[] = [], secs: number[] = [];
    const missed: string[] = [];
    for (const d of docs) {
      process.stderr.write(`  … ${arm.name} ${d.id}\n`);
      const { thoughtId, out } = await runOne(arm, d);
      windows.push(out.windows); secs.push(out.seconds);
      if (!out.ok || !thoughtId) { entTotal += d.entities.length; nearTotal += d.relations.filter((r) => !r.far).length; farTotal += d.relations.filter((r) => r.far).length; missed.push(`${d.id}: ${out.malformed ? "malformed" : out.error ?? "failed"}`); continue; }
      ok++;
      const got = (await sql`SELECT e.entity_type AS type, e.normalized_name AS n FROM thought_entities m JOIN ob1_entities e ON e.id = m.entity_id WHERE m.thought_id = ${thoughtId}::uuid`) as { type: string; n: string }[];
      for (const p of d.entities) {
        entTotal++;
        const n = await norm(p.name);
        if (got.some((g) => g.type === p.type && g.n === n)) entHit++; else missed.push(`${d.id}: entity ${p.name}/${p.type}`);
      }
      for (const rel of d.relations) {
        const [from, to] = await Promise.all([norm(rel.from), norm(rel.to)]);
        const [{ c }] = await sql`
          SELECT count(*)::int AS c FROM ob1_entity_edges g
          JOIN ob1_entities a ON a.id = g.from_entity_id JOIN ob1_entities b ON b.id = g.to_entity_id
          WHERE g.thought_id = ${thoughtId}::uuid
            AND ((a.normalized_name = ${from} AND b.normalized_name = ${to}) OR (a.normalized_name = ${to} AND b.normalized_name = ${from}))`;
        // Any relation between the two planted endpoints counts: the question
        // is whether the model connected them at all across the distance, not
        // which of the seven verbs it chose.
        const hit = Number(c) > 0;
        if (rel.far) { farTotal++; if (hit) farHit++; else missed.push(`${d.id}: FAR ${rel.from} → ${rel.to}`); }
        else { nearTotal++; if (hit) nearHit++; else missed.push(`${d.id}: near ${rel.from} → ${rel.to}`); }
      }
    }
    rows.push({ arm: arm.name, ents: `${entHit}/${entTotal}`, near: `${nearHit}/${nearTotal}`, far: `${farHit}/${farTotal}`, ok, windows: [...new Set(windows)].join("/"), sec: median(secs) });
    if (missed.length) console.log(`    ${arm.name} missed: ${missed.join("; ")}`);
  }
  console.log(`\n  ${docs.length} planted documents; recall through the real write path and resolution rule\n`);
  console.log("  arm            extracted  entities  near relations  FAR relations  windows  median s");
  console.log("  " + "─".repeat(84));
  for (const r of rows) console.log(`  ${r.arm.padEnd(14)} ${String(r.ok).padStart(9)}  ${r.ents.padStart(8)}  ${r.near.padStart(14)}  ${r.far.padStart(13)}  ${r.windows.padStart(7)}  ${r.sec.toFixed(1).padStart(8)}`);
  await sql.close();
  process.exit(0);
}

const docsPath = process.env.OB1_EVAL_DOCS;
if (!docsPath) { console.error("Set OB1_EVAL_DOCS to a JSON array of {id, content}, or pass --planted."); process.exit(2); }
const all = (JSON.parse(readFileSync(docsPath, "utf8")) as Doc[]).filter((d) => (d.content ?? "").trim().length > 0).sort((a, b) => a.content.length - b.content.length);
const docs = LIMIT ? all.slice(0, LIMIT) : all;
console.log(`  documents: ${docs.length} from ${docsPath}; ${docs.reduce((n, d) => n + d.content.length, 0).toLocaleString()} characters; ${Math.min(...docs.map((d) => estimateTokens(d.content)))}–${Math.max(...docs.map((d) => estimateTokens(d.content)))} estimated tokens\n`);

for (const arm of ARMS) {
  for (const d of docs) {
    process.stderr.write(`  … ${arm.name} ${d.id.slice(0, 8)} (${estimateTokens(d.content)} tokens)\n`);
    const { out } = await runOne(arm, d);
    console.log(`    ${arm.name.padEnd(13)} ${d.id.slice(0, 8)} ${String(out.tokens).padStart(5)} tok  ${out.ok ? "ok       " : out.malformed ? "malformed" : out.timedOut ? "TIMEOUT  " : "ERROR    "}  ${out.seconds.toFixed(1).padStart(6)} s  windows ${out.windows}  entities ${out.entities}  edges ${out.edges}${out.retried ? "  retried" : ""}${out.error ? `  ${out.error}` : ""}`);
  }
}

console.log(`\n  ${docs.length} documents per arm, ${cfg.metadataModel}, ${TIMEOUT_MS / 1000} s per call\n`);
console.log("  arm            extracted  malformed  timed out  median s  total s  mean entities  mean edges  calls  retried thoughts");
console.log("  " + "─".repeat(116));
for (const arm of ARMS) {
  const os = outcomes.filter((o) => o.arm === arm.name);
  const ok = os.filter((o) => o.ok);
  const mean = (f: (o: Outcome) => number) => (ok.length ? ok.reduce((n, o) => n + f(o), 0) / ok.length : 0);
  console.log(
    `  ${arm.name.padEnd(14)} ${String(ok.length).padStart(9)}  ${String(os.filter((o) => o.malformed).length).padStart(9)}  ${String(os.filter((o) => o.timedOut).length).padStart(9)}  ` +
      `${median(os.map((o) => o.seconds)).toFixed(1).padStart(8)}  ${os.reduce((n, o) => n + o.seconds, 0).toFixed(0).padStart(7)}  ${mean((o) => o.entities).toFixed(1).padStart(13)}  ${mean((o) => o.edges).toFixed(1).padStart(10)}  ${String(os.reduce((n, o) => n + o.calls, 0)).padStart(5)}  ${String(os.filter((o) => o.retried).length).padStart(16)}`
  );
}
await sql.close();
