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

/**
 * Any OpenAI-compatible endpoint. Ollama by default, but the point of the
 * indirection is that the *hosted* defaults this fork inherited can be measured
 * on the same corpus as the local ones — otherwise the comparison is a leaderboard
 * citation, not a measurement.
 *
 *   OB1_EVAL_BASE=https://openrouter.ai/api/v1 OB1_EVAL_KEY=sk-or-… bun eval-retrieval.ts \
 *     openai/text-embedding-3-small qwen/qwen3-embedding-8b
 */
const BASE = process.env.OB1_EVAL_BASE ?? process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434/v1";
const KEY = process.env.OB1_EVAL_KEY ?? process.env.OPENROUTER_API_KEY ?? "";
const HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
};

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
  slice?: "core" | "hard";
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

  // ── hard slice ────────────────────────────────────────────────────────────
  // Added because the core set saturated: qwen2.5:7b scored 45/48 and the models
  // could not be separated. These are the cases where a small model is expected
  // to break down.

  {
    // Proper nouns that are NOT people. A model that treats a road or a book
    // title as a person poisons thought_stats with fictitious contacts.
    text: "The dentist on Ashworth Road recommended Seeing Like a State, oddly enough.",
    people: [], wantDate: false, wantAction: false,
    topicHints: ["dentist", "book", "recommend"], okTypes: ["observation", "reference", "person_note"],
    slice: "hard",
  },
  {
    // Negation. The decision was NOT to act; inventing an action item here is a
    // to-do list full of things you explicitly chose not to do.
    text: "After the review we decided not to migrate off Elasticsearch this year after all.",
    people: [], wantDate: false, wantAction: false,
    topicHints: ["elastic", "migrat", "decision"], okTypes: ["observation", "reference"],
    slice: "hard",
  },
  {
    // Three people in nested roles. Getting the set right requires reading who is
    // mentioned rather than pattern-matching the first capitalised word.
    text: "Priya said Dev should ask Anita about the reconciliation job before touching it.",
    people: ["Priya", "Dev", "Anita"], wantDate: false, wantAction: true,
    topicHints: ["reconcil", "billing", "job"], okTypes: ["task", "person_note", "observation"],
    slice: "hard",
  },
  {
    // A superseded date. Only the new one is true; extracting both is worse than
    // extracting neither, because a calendar with a stale entry is misleading.
    text: "The review moved from 2026-03-14 to 2026-03-21, so the earlier slot is dead.",
    people: [], wantDate: true, wantAction: false,
    topicHints: ["review", "reschedul", "meeting", "date"], okTypes: ["observation", "reference"],
    slice: "hard",
  },
  {
    // Long input with the substance at the end — the same shape the retrieval
    // eval showed models diluting.
    text: "Quarterly planning session. " + new Array(6).fill(
      "We went round the same arguments as last quarter without much new evidence, and there was a long digression about whether the previous vendor evaluation was still valid, plus the usual complaints about stale dashboards and untrustworthy alerting thresholds."
    ).join(" ") + " The decision, finally: Priya approved eighty thousand for observability, and I need to send her the contract by 2026-04-02.",
    people: ["Priya"], wantDate: true, wantAction: true,
    topicHints: ["observab", "budget", "planning", "contract"], okTypes: ["task", "observation", "person_note"],
    slice: "hard",
  },
  {
    // No usable content. The honest answer is a generic topic and no entities;
    // a model that invents structure here inflates every tally.
    text: "hmm.",
    people: [], wantDate: false, wantAction: false,
    topicHints: [""], okTypes: ["observation"],
    slice: "hard",
  },
];

type Score = {
  model: string;
  json: number; type: number; people: number; dates: number; topics: number; actions: number;
  core: number; hard: number;
  outEnum: string[]; hallucinated: string[]; emptyTopics: number;
  seconds: number; total: number;
};

/**
 * OB1_EVAL_TEMP lets the same model be scored at different sampling temperatures.
 * The server currently sends none, so extraction runs at the provider default —
 * 0.8 on Ollama — for a task with exactly one right answer.
 */
const TEMP = process.env.OB1_EVAL_TEMP === undefined ? undefined : Number(process.env.OB1_EVAL_TEMP);

async function extract(model: string, text: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      ...(TEMP === undefined ? {} : { temperature: TEMP }),
      // Thinking-capable models reason before answering unless told not to, and
      // that is pure cost for a fixed-schema extraction. `think: false` is
      // silently ignored on the OpenAI-compatible endpoint; reasoning_effort is
      // what it honours. Harmless to models without a reasoning mode.
      ...(process.env.OB1_EVAL_REASONING === "on" ? {} : { reasoning_effort: "none" }),
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
                     core: 0, hard: 0, outEnum: [], hallucinated: [], emptyTopics: 0, seconds: 0, total: 0 };

  for (const c of CASES) {
    const slice = c.slice ?? "core";
    let caseScore = 0;
    const out = await extract(model, c.text);
    if (!out) { continue; }
    s.json++; caseScore++;

    const type = String(out.type ?? "").toLowerCase().replace(/[\s-]+/g, "_");
    if (!TYPES.includes(type)) s.outEnum.push(String(out.type ?? "(missing)"));
    else if (c.okTypes.includes(type)) { s.type++; caseScore++; }

    // People: exact set, case-insensitive. A hallucinated name is a real harm —
    // it shows up in thought_stats as someone you know.
    const got = asArray(out.people).map((p) => p.toLowerCase());
    const want = c.people.map((p) => p.toLowerCase());
    if (got.length === want.length && want.every((w) => got.includes(w))) { s.people++; caseScore++; }
    for (const g of got) if (!want.includes(g)) s.hallucinated.push(`${g} (from "${c.text.slice(0, 32)}…")`);

    const dates = asArray(out.dates_mentioned).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (c.wantDate ? dates.length > 0 : dates.length === 0) { s.dates++; caseScore++; }

    const topics = asArray(out.topics);
    if (topics.length === 0) s.emptyTopics++;
    else if (topics.some((t) => c.topicHints.some((h) => t.toLowerCase().includes(h)))) { s.topics++; caseScore++; }

    const actions = asArray(out.action_items);
    if (c.wantAction ? actions.length > 0 : actions.length === 0) { s.actions++; caseScore++; }

    if (slice === "hard") s.hard += caseScore; else s.core += caseScore;
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
const nCore = CASES.filter((c) => (c.slice ?? "core") === "core").length;
const nHard = CASES.filter((c) => c.slice === "hard").length;
console.log("  model                  json  type  people dates topics actions    core     hard    total   sec");
console.log("  " + "─".repeat(100));
for (const s of out.sort((a, b) => b.total - a.total)) {
  console.log(
    `  ${s.model.padEnd(22)} ${String(s.json).padStart(4)}  ${String(s.type).padStart(4)}  ` +
    `${String(s.people).padStart(6)} ${String(s.dates).padStart(5)} ${String(s.topics).padStart(6)} ` +
    `${String(s.actions).padStart(7)}   ${`${s.core}/${nCore * 6}`.padStart(6)}  ${`${s.hard}/${nHard * 6}`.padStart(6)}  ` +
    `${`${s.total}/${N * 6}`.padStart(7)}  ${s.seconds.toFixed(1).padStart(5)}`
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
