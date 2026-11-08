/**
 * priority.ts — the "what matters now" eval's rules, pure (Linear SMD-3662).
 *
 * Every rule here but registeredSource (which reads this file's text),
 * plantRows and plantFacts (which write the corpus and its facts) and the
 * measured reads (which read the database) is a function of its arguments, so
 * `eval-priority.ts --self-check` probes each with a hand-known answer and no
 * database:
 * the seeded corpus and its gold, the stub embedder, the score, the
 * shuffled-gold mutant, the pre-registered bar and the dogfood rows' shape.
 * `eval-priority.ts --seeded` plants the corpus in a throwaway Postgres and
 * runs each read through the server's own store; the scorer never sees SQL.
 *
 * The question. Asked for the highest-value unstarted issue on 2026-10-14
 * and 2026-11-02, both brains picked a ticket whose words matched the question
 * over the one the board said mattered (SMD-2540 over SMD-2888, SMD-1853 over
 * SMD-2908). SMD-3660's reads (`priority_weight`, the agenda) are meant to fix
 * that, and SMD-1737's rule says none ships default-on without a number. This
 * is the number: per prompt, a gold order written by the operator, and per
 * read, where its hits put that order.
 *
 * The score, per prompt and read, over the read's top READ_K hits:
 *   top1 — the gold's first item is the read's first hit;
 *   top3 — the gold's first item is among the read's first three;
 *   tau  — Kendall's tau-b between the gold order and the read's ranks of the
 *          gold items, an item the read left out ranked READ_K + 1 (tied with
 *          every other one left out). A prompt with one gold item has no tau.
 * The table's means are over prompts: top1 and top3 over every prompt, tau
 * over the prompts with two gold items or more.
 *
 * The mutant (the ticket's Verify). Score a read against its prompt's gold
 * shuffled, many times: if the score reads the gold's order, the shuffled
 * gold scores what chance gives — top1 the share of shuffles that put the
 * read's first hit first, [hit ∈ gold] / |gold|; top3 the read's top three's
 * share of the gold; tau 0 — whatever the read. A score that only asked
 * whether gold items were retrieved would score the shuffled gold as high as
 * the real one. `chanceOf` is the exact expectation; `shuffledScore` the run.
 */

import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { issueFacets, linearAdapter, renderIssue, type LinearIssue } from "../db/ingest-linear.ts";
import { recordStructure } from "../db/ingest-structure.ts";
import { ACTOR_NAME as BOARD_SYNC, priorityStep } from "../db/sync-linear.ts";
import { levelOf } from "../server-portable/priority-scale.ts";
import { seededRandom } from "../db/test-support.ts";
import type { SqlStore } from "../server-portable/store-sql.ts";

// ── The seeded corpus ───────────────────────────────────────────────────────

/** Who wrote an item: the seeding plants each writer's rows under its own ob1.actor name. */
export type Writer = "operator" | "meeting-notes" | "board-sync";

/** A board item's tracker fields: the Linear issue board-sync would fetch, cut to what the board needs. */
export type BoardMeta = { issue: string; status: string; status_type: "backlog" | "unstarted" | "started" | "completed" | "canceled"; priority: "Urgent" | "High" | "Medium" | "Low" | "No priority" };

/**
 * What the gold rests on that search cannot see: a due time, a stated level
 * (docs/priority.md's 0–5, absent where nobody states one: unknown), done,
 * the blocks links, a claim. The first registration's rows carried only what
 * main's search reads: the text, and a board row's facets as board-sync
 * writes them. The second (SMD-3669 PR 2) plants these where a priority read's
 * store reads them (plantFacts, below: 116's statements, 117's open items, a
 * claim in work_claims, board-sync's links), with the baseline re-run on it
 * and BAR held by its own pin, so the bar a read is judged by never moves with
 * it. A read never reads these from ITEMS: that is the answer's side.
 */
export type Facts = { dueInDays?: number; level?: number; done?: boolean; blocks?: string[]; blockedBy?: string[]; claimed?: boolean };

export type Item = {
  key: string;
  /** The row's text. Times are relative words ("tomorrow", "two weeks ago"), so a run's vectors never depend on its date. */
  text: string;
  writer: Writer;
  /** created_at is the run's now() minus this many days. */
  ageDays: number;
  /** A board item's issue, as board-sync's fetch returns it: its text is renderIssue's and its metadata issueFacets', so a read finds it as it finds a synced ticket. */
  issue?: LinearIssue;
  facts: Facts;
};

/** A fixed instant for the issues' own clocks (metadata only: the rows' created_at is relative, the text has no date). */
const ISSUE_CLOCK = "2026-11-02T00:00:00.000Z";

function linearIssue(b: BoardMeta, title: string, body: string, blocks: string[], blockedBy: string[]): LinearIssue {
  return {
    identifier: b.issue, title, description: body, url: `https://linear.app/zephyr/issue/${b.issue}`,
    createdAt: ISSUE_CLOCK, updatedAt: ISSUE_CLOCK, archivedAt: null, priorityLabel: b.priority,
    state: { name: b.status, type: b.status_type }, project: { id: "zephyr", name: "Zephyr" }, parent: null, labels: { nodes: [] },
    relations: { nodes: blocks.map((identifier) => ({ type: "blocks", relatedIssue: { identifier } })) },
    inverseRelations: { nodes: blockedBy.map((identifier) => ({ type: "blocks", issue: { identifier } })) },
  };
}

/** A board item; `blocks` its own blocks relations, `blockedBy` another issue's blocks on it, as Linear returns each side. */
const board = (key: string, b: BoardMeta, title: string, body: string, ageDays: number, facts: Facts, blocks: string[] = [], blockedBy: string[] = []): Item => {
  const issue = linearIssue(b, title, body, blocks, blockedBy);
  return { key, text: renderIssue(issue), writer: "board-sync", ageDays, issue, facts };
};

/**
 * A personal brain with no tracker behind it, and a small board beside it.
 * The ticket's list, item for item: a bill due tomorrow, a renewal next
 * month, an operator's "this matters", a commitment from a meeting, a
 * home-maintenance task overdue, an action item done last week, low-value
 * chatter; and a board with priorities, a blocker and one claimed item.
 * The chatter is the newest writing, as chatter usually is.
 */
export const ITEMS: readonly Item[] = [
  { key: "bill", writer: "operator", ageDays: 2, facts: { dueInDays: 1 },
    text: "The electric bill is due tomorrow. Autopay is switched off this month, so it has to be paid by hand." },
  { key: "renewal", writer: "operator", ageDays: 5, facts: { dueInDays: 30 },
    text: "The domain registration renews next month, and the card on file expires before then, so update the card first." },
  { key: "passport", writer: "operator", ageDays: 9, facts: { level: 4 },
    text: "This matters: get the passport renewal application in before booking the summer trip." },
  { key: "commitment", writer: "meeting-notes", ageDays: 3, facts: { dueInDays: 3 },
    text: "From Tuesday's planning meeting: I committed to send Dana the budget draft by Friday." },
  { key: "gutters", writer: "operator", ageDays: 20, facts: { dueInDays: -14 },
    text: "Home maintenance: clean the gutters. It was due two weeks ago, and the downpipe overflows when it rains." },
  { key: "claim-done", writer: "operator", ageDays: 6, facts: { done: true },
    text: "Done last week: filed the insurance claim for the cracked windscreen. Nothing is left to do on it." },
  { key: "coffee", writer: "operator", ageDays: 0, facts: { level: 0 },
    text: "Tried the new coffee place near work; the flat white was fine, nothing special." },
  { key: "documentary", writer: "operator", ageDays: 1, facts: {},
    text: "Watched half a documentary about suspension bridges this week." },
  { key: "cat", writer: "operator", ageDays: 0, facts: {},
    text: "The neighbour's cat slept on the car roof again this morning." },
  { key: "bookshelf", writer: "operator", ageDays: 1, facts: { level: 0 },
    text: "Someday I might rearrange the bookshelf by colour, no rush." },
  board("zq-urgent", { issue: "ZQ-101", status: "Todo", status_type: "unstarted", priority: "Urgent" }, "Sign-in fails for every user after the certificate rotation",
    "Nobody can sign in since this morning's rotation. Blocks ZQ-104.", 1, { level: 4, blocks: ["zq-blocked"] }, ["ZQ-104"]),
  board("zq-high", { issue: "ZQ-102", status: "Backlog", status_type: "backlog", priority: "High" }, "Exports time out on large workspaces",
    "A workspace over a few thousand records never finishes its export.", 10, { level: 3 }),
  board("zq-claimed", { issue: "ZQ-103", status: "In Progress", status_type: "started", priority: "High" }, "The rate limiter drops short bursts",
    "Another agent holds this one and has a branch open.", 4, { level: 3, claimed: true }),
  board("zq-blocked", { issue: "ZQ-104", status: "Backlog", status_type: "backlog", priority: "High" }, "Roll out single sign-on to the second tenant",
    "Blocked by ZQ-101: sign-in has to work first.", 8, { level: 3, blockedBy: ["zq-urgent"] }, [], ["ZQ-101"]),
  board("zq-medium", { issue: "ZQ-105", status: "Backlog", status_type: "backlog", priority: "Medium" }, "Tidy the settings page copy",
    "Several labels on the settings page say different things for one setting.", 12, { level: 2 }),
  board("zq-low", { issue: "ZQ-106", status: "Backlog", status_type: "backlog", priority: "Low" }, "Rename the internal date helper",
    "The helper's name says local time and it returns UTC.", 15, { level: 1 }),
  board("zq-done", { issue: "ZQ-107", status: "Done", status_type: "completed", priority: "High" }, "Fix the flaky upload test",
    "Fixed and merged.", 2, { level: 3, done: true }),
  board("zq-nopri", { issue: "ZQ-108", status: "Backlog", status_type: "backlog", priority: "No priority" }, "Write up the onboarding checklist for new contributors",
    "New contributors ask the same five questions in their first week.", 7, {}),
];

export type Prompt = {
  key: string;
  query: string;
  /** The operator's order, best first. An item left out should not be in the answer at all: done, claimed, blocked or chatter. */
  gold: string[];
};

/**
 * The prompts and their gold, written by the operator's judgement (the
 * ticket: "the gold order is written per prompt"; drafted in the session and
 * confirmed by the maintainer, 2026-11-02), not computed from
 * docs/priority.md's weights — a read built on those weights must earn its
 * score here, not inherit it. Where they agree is the ADR's evidence; where
 * they differ, SMD-3667 tunes the weights against this.
 */
export const PROMPTS: readonly Prompt[] = [
  { key: "next-ticket", query: "Which ticket should I pick up next?",
    gold: ["zq-urgent", "zq-high", "zq-medium", "zq-nopri", "zq-low"] },
  { key: "highest-value", query: "What is the highest-value unstarted issue?",
    gold: ["zq-urgent", "zq-high", "zq-medium", "zq-nopri", "zq-low"] },
  { key: "this-week", query: "What needs my attention this week?",
    gold: ["bill", "gutters", "commitment", "passport", "renewal"] },
  { key: "due-soon", query: "What's due soon?",
    gold: ["gutters", "bill", "commitment", "renewal"] },
  { key: "matters-most", query: "What matters most right now?",
    gold: ["zq-urgent", "bill", "gutters", "commitment", "passport", "zq-high", "renewal"] },
  { key: "promised", query: "What did I promise someone I would do?",
    gold: ["commitment"] },
  { key: "blocking", query: "What is holding up other work?",
    gold: ["zq-urgent"] },
];

/**
 * The registration: a hash of ITEMS, PROMPTS and registeredSource() — this
 * file from the stub embedder to the baseline reads, verbatim: the stub (its
 * constants and code, noise weights included), the score, the mutant, the
 * bar and the baseline reads' knobs, everything that sets the baseline or
 * the bar a read is judged by. The reads measured against the bar sit after
 * it, so adding one is not a new registration. Pinned so neither can change under a measured read: a
 * change to any of it is a new registration — the baseline re-run on it, and
 * recorded — never an edit (the self-check fails until this line moves with
 * it). A comment edit there counts too, on purpose: the rule is "nothing in
 * the section moved", which a reader can check without judging the edit.
 */
export const REGISTERED_CORPUS = "af94b462f72ff618";

export function corpusHash(items: readonly Item[] = ITEMS, prompts: readonly Prompt[] = PROMPTS): string {
  // A board item is registered by its issue's fields, not by renderIssue's text: a change to board-sync's adapter
  // moves no registration here. If it moves the baseline's numbers, BASELINE's drift check says so.
  const registered = items.map((it) => (it.issue ? { ...it, text: null } : it));
  return createHash("sha256").update(JSON.stringify({ items: registered, prompts, source: registeredSource() })).digest("hex").slice(0, 16);
}

/**
 * This file from the stub embedder's section to the end of the reads',
 * verbatim, line endings as LF (a CRLF checkout hashes the same). Read from
 * the source rather than from String(fn), which is Bun's transpiled output
 * and would move with a Bun upgrade, not with the eval.
 */
let registeredCache: string | null = null;
export function registeredSource(): string {
  registeredCache ??= registeredSection(readFileSync(fileURLToPath(import.meta.url), "utf8"));
  return registeredCache;
}

/** The registered section of a copy of this file's text, CRLF read as LF. */
export function registeredSection(text: string): string {
  const src = text.replace(/\r\n/g, "\n");
  // At a line's start, so the markers this function names inside its own quotes are not them.
  const from = src.indexOf("\n// ── The stub embedder ─");
  const to = src.indexOf("\n// ── The reads measured against the bar ─");
  if (from < 0 || to < from) throw new Error("priority.ts: the registered section's markers are missing");
  return src.slice(from, to);
}

/** What is wrong with a corpus: unknown or repeated keys, an empty gold, a gold item listed twice. Empty when sound. */
export function corpusProblems(items: readonly Item[] = ITEMS, prompts: readonly Prompt[] = PROMPTS): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  for (const it of items) {
    if (keys.has(it.key)) out.push(`item ${it.key} is listed twice`);
    keys.add(it.key);
    if (/\d/.test(it.text.replace(/ZQ-\d+/g, ""))) out.push(`item ${it.key}'s text has a digit outside its ticket key: times are words`);
    for (const k of [...(it.facts.blocks ?? []), ...(it.facts.blockedBy ?? [])]) if (!items.some((o) => o.key === k)) out.push(`item ${it.key} links to ${k}, not an item`);
  }
  const pkeys = new Set<string>();
  for (const p of prompts) {
    if (pkeys.has(p.key)) out.push(`prompt ${p.key} is listed twice`);
    pkeys.add(p.key);
    if (p.gold.length === 0) out.push(`prompt ${p.key} has no gold`);
    if (p.gold.length > READ_K) out.push(`prompt ${p.key}'s gold is longer than the ${READ_K} a read returns`);
    if (new Set(p.gold).size !== p.gold.length) out.push(`prompt ${p.key}'s gold lists an item twice`);
    for (const g of p.gold) if (!keys.has(g)) out.push(`prompt ${p.key}'s gold names ${g}, not an item`);
  }
  return out;
}

// ── The stub embedder ───────────────────────────────────────────────────────

/**
 * Keyless vectors: a hashed bag of words over a shared background. Each word
 * (letters only, lowercased, past a short stop list) adds ±1 on one word axis
 * chosen by its hash, and the words' sum is normalised; every vector then
 * carries BACKGROUND on axis 0, so two texts sharing no word sit at cosine
 * BACKGROUND²/(BACKGROUND²+1), about 0.4, as unrelated texts do under a real
 * model, never at 0, which threshold 0 drops and no model gives (the first
 * version's filter read returned nothing where stable's returned all four
 * High tickets). A text, not a query, also carries a small weight on one of
 * NOISE_AXES chosen by its hash, so texts that tie on words are ordered by a
 * hash, never by the corpus's listing order (the reads break a tie by id, and
 * the ids follow the listing). Texts that share words sit nearer, so plain
 * search ranks by word overlap: a lexical stand-in for an embedding model,
 * and no model's judgement of meaning. The seeded number measures the read's
 * ORDERING on a fixed similarity, which is what a priority read changes; the
 * dogfood rows carry the real model's.
 */
export const STUB_DIM = 1024;
export const STUB_MODEL = "priority-stub";
const STOP = new Set("a an and the of to in on for is it i my me be by at or as so do did what which who this that with from into has have was are its should would someone".split(" "));

export function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
}

/**
 * FNV-1a over UTF-16 code units: a stable 32-bit hash. The same function as
 * evals/write-path.ts's, kept here rather than imported so the registration
 * hashes the stub's whole code: a change to a shared copy would move these
 * vectors without moving the hash.
 */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const BACKGROUND = 0.8;
export const NOISE_AXES = 16;

export function stubVector(text: string, dim = STUB_DIM, kind: "text" | "query" = "text"): number[] {
  const wordAxes = dim - 1 - NOISE_AXES;
  const words = new Array<number>(wordAxes).fill(0);
  for (const w of wordsOf(text)) {
    const h = fnv1a(w);
    words[h % wordAxes] += (h >>> 31) === 1 ? 1 : -1;
  }
  const n = Math.sqrt(words.reduce((s, x) => s + x * x, 0));
  const v = [BACKGROUND, ...words.map((x) => (n === 0 ? 0 : x / n)), ...new Array<number>(NOISE_AXES).fill(0)];
  if (kind === "text") {
    const h = fnv1a(text.trim().toLowerCase());
    v[1 + wordAxes + (h % NOISE_AXES)] = 0.02 + 0.08 * (((h >>> 8) % 1000) / 1000);
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

// ── The seeding and the baseline call ───────────────────────────────────────

/** A fixed id per item, so the reads' tie-break by id is the same every run. */
export const itemId = (i: number): string => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;

/** What `--seeded` inserts for an item: its id, text, metadata, age and the ob1.actor name its writer's rows are stamped under. */
export type SeedRow = { id: string; content: string; metadata: Record<string, unknown>; ageDays: number; actor: string };

export function seedRow(it: Item, i: number): SeedRow {
  return { id: itemId(i), content: it.text, metadata: it.issue ? issueFacets(it.issue) : {}, ageDays: it.ageDays, actor: `priority-eval-${it.writer}` };
}

/**
 * Plant the rows: each writer's under its own ob1.actor, as a raw insert is
 * stamped (050's ob1_stamp_actor), created_at the database's now() less the
 * row's age, the vector the stub's for the row's content. Returns how many
 * rows carry the eval's writers.
 */
export async function plantRows(sql: SQL, rows: readonly SeedRow[]): Promise<number> {
  for (const actor of [...new Set(rows.map((r) => r.actor))]) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('ob1.actor', ${JSON.stringify({ name: actor })}, true)`;
      for (const row of rows) {
        if (row.actor !== actor) continue;
        await tx`INSERT INTO thoughts (id, content, content_fingerprint, embedding, embedding_model, metadata, created_at)
                 VALUES (${row.id}::uuid, ${row.content}, content_fingerprint_of(${row.content}), ${`[${stubVector(row.content).join(",")}]`}::vector, ${STUB_MODEL},
                         ${row.metadata}::jsonb, now() - make_interval(days => ${row.ageDays}))`;
      }
    });
  }
  return Number(((await sql`SELECT count(*)::int AS n FROM thoughts WHERE metadata->>'actor_name' LIKE 'priority-eval-%'`)[0] as { n: number }).n);
}

/**
 * The facts a priority read's store reads, planted after the rows (SMD-3669 PR 2, the second registration): what
 * the gold rests on, written where a deployed brain keeps it, by the writers that keep it there.
 *   - A board item: its issue recorded as board-sync records the head it has just written (recordStructure: the
 *     source, its blocks links, its mentions), board-sync declared a priority source by the operator (116), and
 *     board-sync's own priority step stating each ticket's level from its Linear priority. Its done and its blockers
 *     are the issue's own fields; its claim (facts.claimed) is another agent's, in work_claims.
 *   - A personal note, every one, chatter too (the maintainer, 2026-11-08): an open item opened from it by its
 *     writer (117), due on its facts' day, done when its facts say so, and its stated level (facts.level) the
 *     operator's statement on the item (116), the operator's key classified operator.
 * Days are calendar days in UTC from the run's own day, so the urgency windows (119, 122) read the same each run.
 */
export type FactPlan = {
  board: number[];
  claims: string[];
  items: { index: number; actor: string; due: string | null; done: boolean; level: number | null }[];
};

/** The run's day moved by `days`, YYYY-MM-DD in UTC. */
export function dayFrom(today: string, days: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** What plantFacts writes for `items` on the day `today`: pure, so --self-check reads it. */
export function factPlan(items: readonly Item[], today: string): FactPlan {
  const plan: FactPlan = { board: [], claims: [], items: [] };
  items.forEach((it, index) => {
    if (it.issue) {
      plan.board.push(index);
      if (it.facts.claimed) plan.claims.push(it.issue.identifier);
      return;
    }
    plan.items.push({
      index, actor: `priority-eval-${it.writer}`,
      due: it.facts.dueInDays === undefined ? null : dayFrom(today, it.facts.dueInDays),
      done: it.facts.done === true, level: it.facts.level ?? null,
    });
  });
  return plan;
}

/** Who holds a claimed board item: another agent's key, not the read key the eval's reads run under. */
export const CLAIMANT = "priority-eval-other-agent";
/** The operator's key, whose statements on the personal items are the operator's. */
export const OPERATOR = "priority-eval-operator";

/**
 * What the database holds once plantFacts has run, read back value by value (review pass 1: counts passed a due day
 * dropped on the way), one sorted line a fact: a ticket's source and its counted level, a relation link, a live
 * claim, and an open item by the note it was read from, with its status, its due day, its counted level and tier, and
 * who opened it. Any statement in tier 4 (inferred) is a line of its own, which no plan has.
 */
export type PlantedFacts = string[];

/**
 * Plant factPlan's facts for `rows` (seedRow's, planted), `today` the run's day. Throws on any refusal: a fact not
 * planted would score a read on a corpus other than the registered one.
 */
export async function plantFacts(sql: SQL, store: SqlStore, items: readonly Item[], rows: readonly SeedRow[], today: string): Promise<PlantedFacts> {
  const plan = factPlan(items, today);
  const run = `priority-eval@${ISSUE_CLOCK}`;
  for (const i of plan.board) {
    await sql.begin(async (tx) => { await recordStructure(tx, rows[i].id, linearAdapter.map(items[i].issue!), run, { take: true }); });
  }
  const [declared] = (await sql`SELECT declare_priority_source(${BOARD_SYNC}, true) AS r`) as { r: { ok: boolean; error?: string } }[];
  if (!declared.r.ok) throw new Error(`declare_priority_source(${BOARD_SYNC}): ${declared.r.error}`);
  const step = await priorityStep(sql, { name: BOARD_SYNC });
  if (!("step" in step)) throw new Error(`board-sync's priority step is off: ${step.off}`);
  const tally = await step.step.run({ dryRun: false });
  if (tally.refused.length) throw new Error(`board-sync's priority step was refused: ${tally.refused.join(", ")}`);
  for (const issue of plan.claims) {
    const r = await store.claimWork({ issue, label: "another agent's branch", leaseSeconds: 86_400, actor: { name: CLAIMANT } });
    if (r.outcome !== "claimed") throw new Error(`claim_work(${issue}): ${r.outcome} ${r.code ?? ""}`);
  }
  // The operator's key classified as SETUP.md classifies a brain's own: an unclassified key's statement is tier 4,
  // inferred, which 122 counts only when asked.
  await sql`SELECT set_agent_kind(${OPERATOR}, 'operator')`;
  for (const p of plan.items) {
    const actor = { name: p.actor };
    const opened = await store.openItem({ text: items[p.index].text, dueAt: p.due ?? undefined, originThought: rows[p.index].id, actor, scope: "write" });
    if (opened.outcome !== "opened" || !opened.item) throw new Error(`open_item(${items[p.index].key}): ${opened.outcome} ${opened.code ?? ""} ${opened.message ?? ""}`);
    if (p.done) {
      const done = await store.setItemStatus({ id: opened.item.id, status: "done", actor, scope: "write" });
      if (done.outcome === "refused") throw new Error(`set_item_status(${items[p.index].key}): ${done.code} ${done.message ?? ""}`);
    }
    if (p.level !== null) {
      const stated = await store.assertPriority({ kind: "item", key: opened.item.id, level: p.level, actor: { name: OPERATOR }, scope: "write" });
      if (stated.outcome !== "asserted") throw new Error(`assert_priority(${items[p.index].key}): ${stated.outcome} ${stated.code ?? ""} ${stated.message ?? ""}`);
    }
  }
  // Every statement planted is one 122 counts: tier 4 (inferred) would read as unknown and pass unseen.
  const [inferred] = (await sql`SELECT count(*)::int AS n FROM priority_assertions WHERE closed_at IS NULL AND tier = 4`) as { n: number }[];
  if (inferred.n > 0) throw new Error(`${inferred.n} planted statement(s) are tier 4 (inferred), which effective_priority counts only when asked`);
  const keyOf = new Map(rows.map((r, i) => [r.id, items[i].key] as const));
  const lines: string[] = [];
  for (const r of (await sql`SELECT identity FROM thought_sources WHERE system = 'linear'`) as { identity: string }[]) lines.push(`ticket ${r.identity}`);
  for (const r of (await sql`SELECT item_key, level FROM priority_assertions WHERE closed_at IS NULL AND item_kind = 'ticket' AND maker_name = ${BOARD_SYNC} AND tier = 2`) as { item_key: string; level: number }[]) lines.push(`ticket ${r.item_key} level ${r.level}`);
  for (const r of (await sql`
      SELECT s.identity, f.payload->>'relation' AS relation, f.payload->>'target' AS target
        FROM thought_facets f JOIN thought_sources s ON s.thought_id = f.thought_id AND s.system = 'linear'
       WHERE f.kind = 'link' AND f.valid_until IS NULL AND f.payload->>'relation' IN ('blocks', 'blocked_by')`) as { identity: string; relation: string; target: string }[]) {
    lines.push(`link ${r.identity} ${r.relation} ${r.target}`);
  }
  for (const r of (await sql`SELECT issue, holder_name FROM work_claims WHERE released_at IS NULL AND expires_at > now()`) as { issue: string; holder_name: string }[]) lines.push(`claim ${r.issue} by ${r.holder_name}`);
  // A bare due day is held as its end, the next day's start in UTC (119): the day is that instant less one.
  for (const r of (await sql`
      SELECT i.origin_thought_id::text AS origin, i.status, i.opened_by_name,
             to_char((i.due_at - interval '1 day') AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS due,
             (SELECT a.level || ' tier ' || a.tier FROM priority_assertions a
               WHERE a.closed_at IS NULL AND a.item_kind = 'item' AND a.item_key = i.item_id::text) AS level
        FROM open_items i`) as { origin: string; status: string; opened_by_name: string; due: string | null; level: string | null }[]) {
    lines.push(`item ${keyOf.get(r.origin) ?? r.origin} ${r.status} due ${r.due ?? "none"} level ${r.level ?? "none"} by ${r.opened_by_name}`);
  }
  for (const r of (await sql`SELECT item_kind, item_key FROM priority_assertions WHERE closed_at IS NULL AND tier = 4`) as { item_kind: string; item_key: string }[]) lines.push(`tier-4 statement on ${r.item_kind} ${r.item_key}`);
  return lines.sort();
}

/** What plantFacts should read back for `items` on the day `today`: the plan's facts, a board item's levels and links its issue's own. */
export function plannedFacts(items: readonly Item[], today: string): PlantedFacts {
  const plan = factPlan(items, today);
  const lines: string[] = [];
  for (const i of plan.board) {
    const b = items[i].issue!;
    lines.push(`ticket ${b.identifier}`);
    const level = levelOf("linear", b.priorityLabel);
    if (level !== null) lines.push(`ticket ${b.identifier} level ${level}`);
    for (const r of b.relations?.nodes ?? []) if (r.type === "blocks" && r.relatedIssue) lines.push(`link ${b.identifier} blocks ${r.relatedIssue.identifier}`);
    for (const r of b.inverseRelations?.nodes ?? []) if (r.type === "blocks" && r.issue) lines.push(`link ${b.identifier} blocked_by ${r.issue.identifier}`);
  }
  for (const issue of plan.claims) lines.push(`claim ${issue} by ${CLAIMANT}`);
  for (const p of plan.items) lines.push(`item ${items[p.index].key} ${p.done ? "done" : "open"} due ${p.due ?? "none"} level ${p.level === null ? "none" : `${p.level} tier 1`} by ${p.actor}`);
  return lines.sort();
}

/** The two search tools a baseline read, or a measured read's callTool, calls. */
export type SearchTool = "search" | "search_thoughts";

/** The thought ids a tool's structured answer names, best first: `search`'s results, `search_thoughts`' hits. */
export function idsOfAnswer(tool: SearchTool, value: unknown): string[] {
  const v = value as { results?: { id: string }[]; hits?: { id: string }[] };
  return (tool === "search" ? v.results : v.hits)?.map((r) => r.id) ?? [];
}

// ── The score ───────────────────────────────────────────────────────────────

/** How many hits a read returns: the `search` tool's fixed ten. */
export const READ_K = 10;

export type PromptScore = { top1: boolean; top3: boolean; tau: number | null };

/** 1-based rank of each gold item among the read's hits; an item past READ_K or absent is READ_K + 1. */
export function goldRanks(hits: readonly string[], gold: readonly string[]): number[] {
  const top = hits.slice(0, READ_K);
  return gold.map((g) => { const i = top.indexOf(g); return i < 0 ? READ_K + 1 : i + 1; });
}

/**
 * Kendall's tau-b between two rankings of one list; x has no ties here (the
 * gold is a strict order), y may (items the read left out). Null when either
 * side has no untied pair: one item, or every item left out.
 */
export function kendallTauB(x: readonly number[], y: readonly number[]): number | null {
  let concordant = 0, discordant = 0, tiesX = 0, tiesY = 0, pairs = 0;
  for (let i = 0; i < x.length; i++) {
    for (let j = i + 1; j < x.length; j++) {
      pairs++;
      const dx = Math.sign(x[i] - x[j]);
      const dy = Math.sign(y[i] - y[j]);
      if (dx === 0) tiesX++;
      if (dy === 0) tiesY++;
      if (dx !== 0 && dy !== 0) { if (dx === dy) concordant++; else discordant++; }
    }
  }
  const denom = Math.sqrt((pairs - tiesX) * (pairs - tiesY));
  return denom === 0 ? null : (concordant - discordant) / denom;
}

export function scorePrompt(hits: readonly string[], gold: readonly string[]): PromptScore {
  const first = gold[0];
  const top = hits.slice(0, READ_K);
  return {
    top1: top[0] === first,
    top3: top.slice(0, 3).includes(first),
    tau: gold.length < 2 ? null : kendallTauB(gold.map((_, i) => i + 1), goldRanks(hits, gold)),
  };
}

export type ReadScore = { top1: number; top3: number; tau: number; prompts: number; tauPrompts: number };

/**
 * Means over prompts. tau's mean is over prompts with two gold items or more;
 * a null among those (the read left every gold item out) counts as 0, never
 * skipped — a read that retrieves nothing must not score as undefined.
 */
export function meanScore(scores: readonly PromptScore[], golds: readonly (readonly string[])[]): ReadScore {
  const n = scores.length;
  const tauIdx = golds.map((g, i) => (g.length >= 2 ? i : -1)).filter((i) => i >= 0);
  return {
    top1: n ? scores.filter((s) => s.top1).length / n : 0,
    top3: n ? scores.filter((s) => s.top3).length / n : 0,
    tau: tauIdx.length ? tauIdx.reduce((s, i) => s + (scores[i].tau ?? 0), 0) / tauIdx.length : 0,
    prompts: n,
    tauPrompts: tauIdx.length,
  };
}

// ── The shuffled-gold mutant ────────────────────────────────────────────────

export function shuffle<T>(xs: readonly T[], next: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const SHUFFLES = 2000;
export const MUTANT_SEED = 3662;

/** The exact chance score of `hits` against `gold` shuffled uniformly: see the header. */
export function chanceOf(hits: readonly string[], gold: readonly string[]): { top1: number; top3: number; tau: number } {
  const top = hits.slice(0, READ_K);
  return {
    top1: gold.includes(top[0]) ? 1 / gold.length : 0,
    top3: top.slice(0, 3).filter((h) => gold.includes(h)).length / gold.length,
    tau: 0,
  };
}

/**
 * The mutant: `hits` scored against `gold` shuffled SHUFFLES times; tau
 * averaged over the shuffles where it is defined. `score` is scorePrompt; the
 * self-check passes an order-blind one to show the mutant tells them apart.
 * The shuffles come from db/test-support's seededRandom (mulberry32, the one
 * copy). A run seeds each prompt apart (MUTANT_SEED + its index), so prompts
 * whose golds have one length don't share their permutations and their
 * errors.
 */
export function shuffledScore(hits: readonly string[], gold: readonly string[], score: (hits: readonly string[], gold: readonly string[]) => PromptScore = scorePrompt, seed = MUTANT_SEED, shuffles = SHUFFLES): { top1: number; top3: number; tau: number } {
  const next = seededRandom(seed).rnd;
  let top1 = 0, top3 = 0, tau = 0, tauN = 0;
  for (let i = 0; i < shuffles; i++) {
    const s = score(hits, shuffle(gold, next));
    if (s.top1) top1++;
    if (s.top3) top3++;
    if (s.tau !== null) { tau += s.tau; tauN++; }
  }
  return { top1: top1 / shuffles, top3: top3 / shuffles, tau: tauN ? tau / tauN : 0 };
}

/** A read's mutant, prompt by prompt: each prompt seeded apart (MUTANT_SEED + its index), so golds of one length don't share their shuffles. */
export function mutantTriples(hits: readonly (readonly string[])[], golds: readonly (readonly string[])[]): { top1: number; top3: number; tau: number }[] {
  return hits.map((h, i) => shuffledScore(h, golds[i], scorePrompt, MUTANT_SEED + i));
}

/** How far the mutant may sit from chance and still read as chance: about four standard errors at SHUFFLES for a share near a half. */
export const CHANCE_TOLERANCE = 0.05;

type Triple = { top1: number; top3: number; tau: number };

/**
 * Per-prompt triples (a mutant's or chance's) averaged on the table's basis:
 * top-1 and top-3 over every prompt, tau over the prompts with two gold items
 * or more, as meanScore averages the read's own — so a one-item gold's 0
 * never dilutes the mutant's tau against the tolerance.
 */
export function meanTriple(xs: readonly Triple[], golds: readonly (readonly string[])[]): Triple {
  const tauIdx = golds.map((g, i) => (g.length >= 2 ? i : -1)).filter((i) => i >= 0);
  return {
    top1: xs.reduce((a, x) => a + x.top1, 0) / xs.length,
    top3: xs.reduce((a, x) => a + x.top3, 0) / xs.length,
    tau: tauIdx.length ? tauIdx.reduce((a, i) => a + xs[i].tau, 0) / tauIdx.length : 0,
  };
}

// ── The pre-registered bar ──────────────────────────────────────────────────

/**
 * PRE-REGISTERED (2026-11-02, before any priority read is measured; SMD-3662
 * Work 3; confirmed by the maintainer the same day, with the gold orders). The bar a priority read (SMD-3668's `priority_weight`, SMD-3669's
 * agenda) must clear on the SEEDED set, at REGISTERED_CORPUS, against the
 * best of the baseline reads on each measure, to count as having helped:
 *   (a) top-1 on at least TOP1_MIN of the prompts (5 of 7);
 *   (b) top-1 on at least TOP1_GAIN more prompts than the best baseline read;
 *   (c) mean tau at least TAU_GAIN above the best baseline read's;
 *   (d) no regression: every prompt some baseline read had top-3 stays top-3.
 * Fixed edge cases:
 *   - the read's own order is the order it returns, its tie-break included;
 *   - a gold item outside the read's top READ_K ranks READ_K + 1, tied with
 *     the others left out;
 *   - tau's mean is over prompts with two gold items or more, a null there 0;
 *   - a read that refuses or errors on a prompt scores it false, false, 0;
 *   - a read with its own knobs (a weight) is measured at the value it would
 *     ship with, once; a sweep picks on dev prompts it does not report as the
 *     verdict;
 *   - the dogfood rows are reported beside the verdict and do not gate it:
 *     each is one pick on a board that has since moved.
 */
export const BAR = { top1Min: 5 / 7, top1Gain: 2, tauGain: 0.25 } as const;

export type Verdict = { helped: boolean; failed: string[] };

/** The bar's thresholds on a baseline: (a)'s floor, (b)'s from the best baseline read, (c)'s tau, and (d)'s prompts (indexes). */
export type BarOn = { prompts: number; top1Floor: number; bestTop1: number; top1Need: number; bestTau: number; tauNeed: number; keepTop3: number[] };

export function barOn(baselines: readonly (readonly PromptScore[])[], golds: readonly (readonly string[])[]): BarOn {
  const bases = baselines.map((b) => meanScore(b, golds));
  const prompts = golds.length;
  const top1Floor = Math.ceil(BAR.top1Min * prompts - 1e-9);
  const bestTop1 = Math.max(...baselines.map((b) => b.filter((s) => s.top1).length));
  const bestTau = Math.max(...bases.map((b) => b.tau));
  const keepTop3 = golds.map((_, i) => i).filter((i) => baselines.some((b) => b[i].top3));
  return { prompts, top1Floor, bestTop1, top1Need: Math.max(top1Floor, bestTop1 + BAR.top1Gain), bestTau, tauNeed: bestTau + BAR.tauGain, keepTop3 };
}

/** The bar applied: `read` per prompt against each baseline read's per-prompt scores, all over the same prompts in the same order. */
export function verdict(read: readonly PromptScore[], baselines: readonly (readonly PromptScore[])[], golds: readonly (readonly string[])[]): Verdict {
  const failed: string[] = [];
  const t = barOn(baselines, golds);
  const m = meanScore(read, golds);
  const top1N = read.filter((s) => s.top1).length;
  if (top1N < t.top1Floor) failed.push(`(a) top-1 on ${top1N} of ${t.prompts}, under ${t.top1Floor}`);
  if (top1N - t.bestTop1 < BAR.top1Gain) failed.push(`(b) top-1 on ${top1N}, the best baseline ${t.bestTop1}: under +${BAR.top1Gain}`);
  if (m.tau + 1e-9 < t.tauNeed) failed.push(`(c) mean tau ${m.tau.toFixed(3)}, the best baseline ${t.bestTau.toFixed(3)}: under +${BAR.tauGain}`);
  for (const i of t.keepTop3) if (!read[i].top3) failed.push(`(d) prompt ${i + 1} left the top 3 that a baseline read kept`);
  return { helped: failed.length === 0, failed };
}

// ── The reads ───────────────────────────────────────────────────────────────

/**
 * A baseline read: a search tool called over MCP on the server itself (the
 * MCP server and the REST core behind it, in-process, as the write-path gate
 * runs them), with the arguments a client would send beside the prompt's
 * query — today's main. The bar is measured against them,
 * so one that errors fails the run: a baseline that never ran would set the
 * bar.
 */
export type Read = { name: string; tool: SearchTool; args: Record<string, unknown> };

/**
 * The baseline (Work 4):
 *   plain   — the `search` tool;
 *   current — search_thoughts with prefer_current on (059's lifecycle
 *             demotion), its other arguments at their defaults;
 *   filter  — search_thoughts with the workaround SMD-3660 measured on
 *             2026-11-02, {"status_type":"backlog","priority":"High"}.
 */
export const READS: readonly Read[] = [
  { name: "plain", tool: "search", args: {} },
  { name: "current", tool: "search_thoughts", args: { prefer_current: true } },
  { name: "filter", tool: "search_thoughts", args: { filter: { status_type: "backlog", priority: "High" } } },
];

// ── The reads measured against the bar ──────────────────────────────────────

/**
 * What a measured read is handed for one prompt: what a deployed read would
 * have — the query's words and its stub vector, the store, and callTool, a
 * search tool called over MCP as a baseline read is (its
 * thought ids, best first). Never the prompt's key or its gold.
 */
export type MeasureInput = { query: string; embedding: number[]; store: SqlStore; callTool: (tool: SearchTool, args: Record<string, unknown>) => Promise<string[]> };

/**
 * A read measured against the bar: any function from a prompt to thought ids,
 * best first (the top READ_K are scored), so a read that is not a hybrid
 * search (SMD-3669's agenda) fits as well as one that is (SMD-3668's
 * priority_weight). One that errors on a prompt scores it false, false, 0 —
 * the bar's edge case — and the run lists the error. Outside the registered
 * section: adding the read under test is not a change to what it is judged by.
 * It reads what a deployed read could: the database. Never PROMPTS' gold or
 * ITEMS' facts, which are the answer's side: `--seeded` runs every measured
 * read again with each gold replaced by the items outside it and the facts
 * moved between items, and fails when its answer moves (the ceiling, which
 * reads the gold, is the check's control). That catches a read consulting
 * either when it runs; a read that copied them when its module loaded is the
 * reviewer's to catch. Its ids are deduplicated, first occurrence kept,
 * before the top READ_K are scored.
 */
export type MeasuredRead = { name: string; ticket: string; run: (input: MeasureInput) => Promise<readonly string[]> };

/**
 * SMD-3669's agenda, as a client would put it to a question (the maintainer, 2026-11-08): the agenda takes no query,
 * so the read searches the query as the plain baseline does (`search`, its defaults) and orders those hits by the
 * agenda — the hits the agenda lists first, in the agenda's order, then the rest in search's order. The agenda is
 * the default one (every source, startable and unclaimed work only), at its cap. A hit is the agenda's item when it
 * is the ticket's row (the thought board-sync recorded the ticket on, read by fetch's metadata) or an open item's
 * origin thought (list_items). Priority orders what is relevant; it adds nothing search did not find.
 */
export const AGENDA_READ: MeasuredRead = {
  name: "agenda", ticket: "SMD-3669",
  run: async ({ query, store, callTool }) => {
    const hits = await callTool("search", { query });
    const agenda = await store.agenda({ limit: 100, includeBlocked: false, includeClaimed: false, includeProposed: false });
    const place = new Map(agenda.items.map((it, i) => [`${it.kind}:${it.key}`, i] as const));
    // A hit's place on the agenda: its ticket's, when it is a board row; else the best of the open items read from it.
    const placeOf = async (id: string): Promise<number | undefined> => {
      const m = (await store.getThought(id))?.metadata as { source?: unknown; issue?: unknown } | undefined;
      if (m?.source === "linear" && typeof m.issue === "string") return place.get(`ticket:${m.issue}`);
      const from = await store.listItems({ statuses: ["open"], overdue: false, originThought: id, limit: 100 });
      const at = from.items.map((i) => place.get(`item:${i.id}`)).filter((n): n is number => n !== undefined);
      return at.length ? Math.min(...at) : undefined;
    };
    const rank = new Map<string, number>();
    for (const id of hits) {
      const at = await placeOf(id);
      if (at !== undefined) rank.set(id, at);
    }
    const listed = hits.filter((id) => rank.has(id)).sort((a, b) => rank.get(a)! - rank.get(b)!);
    return [...listed, ...hits.filter((id) => !rank.has(id))];
  },
};

/** The reads under measurement, each with its ticket. */
export const MEASURED: readonly MeasuredRead[] = [AGENDA_READ];

/** A measured read's ids as scored: each once, first occurrence kept, the top READ_K. */
export function measuredIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].slice(0, READ_K);
}

/**
 * Run `run` with the answer's side moved — every prompt's gold replaced by
 * the items outside it, in reverse listing order (a set and an order that
 * share nothing with the gold, one-item golds included), and each item's
 * facts handed to the next item — and put it back, whatever `run` does. A
 * read that answers differently under it reads the answer.
 */
export async function withAnswerMoved<T>(run: () => Promise<T>, prompts: readonly Prompt[] = PROMPTS, items: readonly Item[] = ITEMS): Promise<T> {
  const golds = prompts.map((p) => [...p.gold]);
  const facts = items.map((it) => it.facts);
  try {
    prompts.forEach((p, i) => (p.gold as string[]).splice(0, p.gold.length, ...items.map((it) => it.key).filter((k) => !golds[i].includes(k)).reverse()));
    items.forEach((it, i) => ((it as { facts: Facts }).facts = facts[(i + 1) % facts.length]));
    return await run();
  } finally {
    prompts.forEach((p, i) => (p.gold as string[]).splice(0, p.gold.length, ...golds[i]));
    items.forEach((it, i) => ((it as { facts: Facts }).facts = facts[i]));
  }
}


// ── The dogfood rows ────────────────────────────────────────────────────────

/**
 * One "what next" session, recorded at the time and never rewritten once the
 * board moves (the ticket's Notes). Ids and numbers only (check 9, SMD-1295):
 * `date` is YYYYMMDD, `pick` and `picked_instead` are SMD ticket numbers,
 * `thought` is the stable thought that records the session, the prompt sits
 * under `query` and the board's state under `note`. A read's `rank` is where
 * it put the pick: a number from 1, 0 when the pick was not in its results,
 * null when the session did not record it.
 */
export type DogfoodRow = {
  date: number;
  query: string;
  pick: number;
  picked_instead: number | null;
  thought: string;
  note: string;
  reads: Record<string, { rank: number | null; note?: string }>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ticketNumber = (n: unknown): boolean => Number.isInteger(n) && (n as number) > 0;

/** A YYYYMMDD number that names a real day. */
export function isDay(n: unknown): boolean {
  if (!Number.isInteger(n)) return false;
  const v = n as number;
  const d = new Date(Date.UTC(Math.floor(v / 10000), Math.floor(v / 100) % 100 - 1, v % 100));
  return v >= 20000101 && d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate() === v;
}

/**
 * The read names a dogfood row may use: the seeded set's reads (baseline and
 * measured), and
 * `ticket_rows` — search filtered to board-sync's ticket rows alone, the
 * 2026-10-14 session's second read. A new name is added here with what it
 * is, so rows stay comparable read by read.
 */
export const DOGFOOD_READS: readonly string[] = [...READS.map((r) => r.name), ...MEASURED.map((r) => r.name), "ticket_rows"];

/** What is wrong with the fixture's rows, as read from the file: not an array, or a row's problems. Never throws. */
export function dogfoodProblems(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ["the fixture's rows is not an array"];
  const rows = raw as DogfoodRow[];
  const out: string[] = [];
  rows.forEach((r, i) => {
    if (!r || typeof r !== "object") { out.push(`row ${i + 1}: not an object`); return; }
    const at = `row ${i + 1} (${r.date ?? "?"})`;
    if (!isDay(r.date)) out.push(`${at}: date is not a YYYYMMDD day`);
    const prev = i > 0 ? rows[i - 1] : null;
    if (prev && typeof prev === "object" && typeof prev.date === "number" && r.date < prev.date) out.push(`${at}: rows are not in date order`);
    if (!ticketNumber(r.pick)) out.push(`${at}: pick is not a ticket number`);
    if (r.picked_instead !== null && !ticketNumber(r.picked_instead)) out.push(`${at}: picked_instead is not a ticket number`);
    if (ticketNumber(r.pick) && r.picked_instead === r.pick) out.push(`${at}: picked_instead is the pick itself`);
    if (!UUID_RE.test(r.thought ?? "")) out.push(`${at}: thought is not an id`);
    for (const f of ["query", "note"] as const) if (typeof r[f] !== "string" || r[f].trim().length === 0) out.push(`${at}: ${f} is empty`);
    if (!r.reads || typeof r.reads !== "object" || Object.keys(r.reads).length === 0) out.push(`${at}: no read recorded`);
    for (const [name, v] of Object.entries(r.reads && typeof r.reads === "object" ? r.reads : {})) {
      if (!DOGFOOD_READS.includes(name)) out.push(`${at}: read ${name} is not one of ${DOGFOOD_READS.join(", ")}`);
      if (!v || typeof v !== "object" || !("rank" in v)) { out.push(`${at}: read ${name} is not an object with a rank`); continue; }
      if (!(v.rank === null || (Number.isInteger(v.rank) && (v.rank as number) >= 0))) out.push(`${at}: read ${name}'s rank is not a number from 0 or null`);
    }
  });
  return out;
}

// ── The recorded baseline ───────────────────────────────────────────────────

/**
 * What each baseline read scored at REGISTERED_CORPUS, recorded (main
 * 8aa855f1, 2026-11-02; the same at the second registration on main 601b0452,
 * 2026-11-08, the facts planted beside the rows moving no search): top-1 and
 * top-3 as prompt counts, mean tau to three places. `--seeded` fails when a run differs, so a change to search on main
 * that moves the baseline is seen, not absorbed.
 *
 * A record of today's main, not part of the registration. The verdict always
 * compares a measured read with the baselines measured in the same run, on
 * the same main, so the bar's rule (BAR, pre-registered) holds whatever main
 * search does; this record says when the numbers it is applied to moved. A
 * re-record changes this line and appends a dated row to evals/README.md's
 * baseline section, naming the main and the change that moved it; the rows
 * before stay as they were measured.
 */
export type Recorded = { top1: readonly string[]; top3: readonly string[]; tau: number };

export const BASELINE: Readonly<Record<string, Recorded>> = {
  plain: { top1: ["highest-value"], top3: ["highest-value", "due-soon"], tau: 0.252 },
  current: { top1: ["highest-value"], top3: ["highest-value", "due-soon"], tau: 0.212 },
  filter: { top1: [], top3: [], tau: 0.055 },
};

/**
 * How a read's scores differ from its recorded baseline; empty when they
 * match. Which prompts it puts first and in the top 3, by key, not how many:
 * the bar's (b) reads the count, but its (d) reads which prompts a baseline
 * kept, and a move that keeps the count can change them.
 */
export function baselineDrift(name: string, scores: readonly PromptScore[], prompts: readonly Prompt[] = PROMPTS, recorded: Readonly<Record<string, Recorded>> = BASELINE): string[] {
  const want = recorded[name];
  if (!want) return [`${name} has no recorded baseline`];
  const keys = (pick: (s: PromptScore) => boolean) => prompts.filter((_, i) => pick(scores[i])).map((p) => p.key);
  const got = { top1: keys((s) => s.top1), top3: keys((s) => s.top3), tau: Math.round(meanScore(scores, prompts.map((p) => p.gold)).tau * 1000) / 1000 };
  const out: string[] = [];
  for (const k of ["top1", "top3"] as const) if (got[k].join(",") !== [...want[k]].join(",")) out.push(`${name} ${k} on [${got[k].join(", ")}], recorded [${want[k].join(", ")}]`);
  if (got.tau !== want.tau) out.push(`${name} tau ${got.tau}, recorded ${want.tau}`);
  return out;
}

// ── The table ───────────────────────────────────────────────────────────────

const f3 = (x: number) => x.toFixed(3);

export function renderTable(rows: readonly { read: string; score: ReadScore; mutant: Triple; chance: Triple }[]): string {
  const lines = [
    "| read | top-1 | top-3 | mean tau | shuffled gold: top-1 / top-3 / tau | chance: top-1 / top-3 / tau |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    lines.push(`| ${r.read} | ${f3(r.score.top1)} | ${f3(r.score.top3)} | ${f3(r.score.tau)} | ${f3(r.mutant.top1)} / ${f3(r.mutant.top3)} / ${f3(r.mutant.tau)} | ${f3(r.chance.top1)} / ${f3(r.chance.top3)} / ${f3(r.chance.tau)} |`);
  }
  return lines.join("\n");
}
