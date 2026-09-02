#!/usr/bin/env bun
/**
 * eval-meta.ts — score the metadata-extraction model on the task it actually does.
 *
 * This is the second call OB1 makes per capture, and its output is not decoration:
 * `type` drives list_thoughts filtering, `people` and `topics` drive the stats
 * tallies, `dates_mentioned` and `action_items` are what someone scans a week
 * later. Getting it wrong is not a crash — it is a brain that quietly cannot find
 * things.
 *
 * llama3.2 was chosen by size. Observed failures on real captures: "Elastically"
 * as a topic, "IT" as the only topic for a certificate reminder, `action_item` as
 * a type (outside the enum), and one capture with no topics at all.
 *
 * Scored per field, because they fail independently and matter differently:
 *   json      returned parseable JSON in JSON mode at all
 *   type      inside the five-value enum, before any normalisation
 *   people    exact set match — a hallucinated person is worse than none
 *   dates     ISO dates present when the text contains one
 *   topics    non-empty, and not obvious noise
 *   actions   an action item when the text implies one
 */

const BASE = process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434/v1";

/** Verbatim from server-portable/index.ts, so this scores the real prompt. */
const SYSTEM = `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`;

const TYPES = ["observation", "task", "idea", "reference", "person_note"];

type Case = {
  text: string;
  people: string[];
  wantDate: boolean;
  wantAction: boolean;
  topicHints: string[];   // at least one topic should relate to one of these
  okTypes: string[];      // more than one is often defensible
};

const CASES: Case[] = [
  {
    text: "Met Priya on Tuesday to discuss migrating the search index off Elasticsearch by March.",
    people: ["Priya"], wantDate: false, wantAction: true,
    topicHints: ["elastic", "search", "migrat"], okTypes: ["task", "person_note", "observation"],
  },
  {
    text: "Renew the SSL certificate for the staging cluster before it expires at the end of the month.",
    people: [], wantDate: false, wantAction: true,
    topicHints: ["ssl", "cert", "stag"], okTypes: ["task"],
  },
  {
    text: "Postgres stores jsonb containment with the @> operator, and a GIN index makes it fast.",
    people: [], wantDate: false, wantAction: false,
    topicHints: ["postgres", "jsonb", "index", "gin"], okTypes: ["reference", "observation"],
  },
  {
    text: "Anita recommended Seeing Like a State on 2026-03-14, said it changed how she thinks about central planning.",
    people: ["Anita"], wantDate: true, wantAction: false,
    topicHints: ["book", "read", "state", "planning"], okTypes: ["reference", "person_note", "observation"],
  },
  {
    text: "Sourdough starter needs feeding every twelve hours once it doubles reliably.",
    people: [], wantDate: false, wantAction: true,
    topicHints: ["sourdough", "starter", "bak", "bread"], okTypes: ["task", "reference", "observation"],
  },
  {
    text: "Dev and Anita both said the take-home exercise took a full weekend, so we should drop it from the hiring loop.",
    people: ["Dev", "Anita"], wantDate: false, wantAction: true,
    topicHints: ["hir", "interview", "recruit", "take-home"], okTypes: ["task", "observation", "idea"],
  },
  {
    text: "What if the nightly reconciliation ran incrementally instead of scanning the whole billing topic?",
    people: [], wantDate: false, wantAction: false,
    topicHints: ["reconcil", "billing", "kafka", "increment"], okTypes: ["idea", "observation"],
  },
  {
    text: "Cutting caffeine after noon made the biggest difference to how quickly I fall asleep.",
    people: [], wantDate: false, wantAction: false,
    topicHints: ["caffeine", "sleep", "coffee", "health"], okTypes: ["observation", "reference"],
  },
];

type Score = {
  model: string;
  json: number; type: number; people: number; dates: number; topics: number; actions: number;
  outEnum: string[]; hallucinated: string[]; emptyTopics: number;
  seconds: number; total: number;
};

async function extract(model: string, text: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: text }],
    }),
  });
  if (!r.ok) return null;
  const d = (await r.json()) as { choices?: [{ message?: { content?: string } }] };
  const c = d.choices?.[0]?.message?.content;
  if (typeof c !== "string") return null;
  try {
    const p = JSON.parse(c);
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch { return null; }
}

const asArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => (x as string).trim()) : [];

async function evaluate(model: string): Promise<Score> {
  const t0 = Date.now();
  const s: Score = { model, json: 0, type: 0, people: 0, dates: 0, topics: 0, actions: 0,
                     outEnum: [], hallucinated: [], emptyTopics: 0, seconds: 0, total: 0 };

  for (const c of CASES) {
    const out = await extract(model, c.text);
    if (!out) continue;
    s.json++;

    const type = String(out.type ?? "").toLowerCase().replace(/[\s-]+/g, "_");
    if (!TYPES.includes(type)) s.outEnum.push(String(out.type ?? "(missing)"));
    else if (c.okTypes.includes(type)) s.type++;

    // People: exact set, case-insensitive. A hallucinated name is a real harm —
    // it shows up in thought_stats as someone you know.
    const got = asArray(out.people).map((p) => p.toLowerCase());
    const want = c.people.map((p) => p.toLowerCase());
    if (got.length === want.length && want.every((w) => got.includes(w))) s.people++;
    for (const g of got) if (!want.includes(g)) s.hallucinated.push(`${g} (from "${c.text.slice(0, 32)}…")`);

    const dates = asArray(out.dates_mentioned).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (c.wantDate ? dates.length > 0 : dates.length === 0) s.dates++;

    const topics = asArray(out.topics);
    if (topics.length === 0) s.emptyTopics++;
    else if (topics.some((t) => c.topicHints.some((h) => t.toLowerCase().includes(h)))) s.topics++;

    const actions = asArray(out.action_items);
    if (c.wantAction ? actions.length > 0 : actions.length === 0) s.actions++;
  }

  s.seconds = (Date.now() - t0) / 1000;
  s.total = s.json + s.type + s.people + s.dates + s.topics + s.actions;
  return s;
}

const models = process.argv.slice(2);
const out: Score[] = [];
for (const m of models) {
  process.stderr.write(`  … ${m}\n`);
  try { out.push(await evaluate(m)); }
  catch (e) { process.stderr.write(`  ✗ ${m}: ${(e as Error).message.slice(0, 80)}\n`); }
}

const N = CASES.length;
console.log(`\n  ${N} captures, scored per field (higher is better, max ${N} each)\n`);
console.log("  model                  json  type  people dates topics actions   total   sec");
console.log("  " + "─".repeat(78));
for (const s of out.sort((a, b) => b.total - a.total)) {
  console.log(
    `  ${s.model.padEnd(22)} ${String(s.json).padStart(4)}  ${String(s.type).padStart(4)}  ` +
    `${String(s.people).padStart(6)} ${String(s.dates).padStart(5)} ${String(s.topics).padStart(6)} ` +
    `${String(s.actions).padStart(7)}   ${String(s.total).padStart(2)}/${N * 6}  ${s.seconds.toFixed(1).padStart(5)}`
  );
}

console.log("\n  failure detail");
for (const s of out) {
  const bits: string[] = [];
  if (s.outEnum.length) bits.push(`out-of-enum type: ${[...new Set(s.outEnum)].join(", ")}`);
  if (s.emptyTopics) bits.push(`${s.emptyTopics} capture(s) with NO topics`);
  if (s.hallucinated.length) bits.push(`invented ${s.hallucinated.length} person(s): ${s.hallucinated.slice(0, 3).join("; ")}`);
  if (s.json < N) bits.push(`${N - s.json} capture(s) returned unusable JSON`);
  console.log(`    ${s.model.padEnd(22)} ${bits.length ? bits.join(" | ") : "none"}`);
}
