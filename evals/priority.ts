/**
 * priority.ts — the "what matters now" eval's rules, pure (Linear SMD-3662).
 *
 * Everything here is a function of its arguments, so `eval-priority.ts
 * --self-check` probes each rule with a hand-known answer and no database:
 * the seeded corpus and its gold, the stub embedder, the score, the
 * shuffled-gold mutant, the pre-registered bar and the dogfood rows' shape.
 * `eval-priority.ts --seeded` plants the corpus in a throwaway Postgres and
 * runs each read through the server's own store; the scorer never sees SQL.
 *
 * The question. Asked "what should I work on next?" on 2026-10-14 and
 * 2026-11-02, both brains picked a ticket whose words matched the question
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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── The seeded corpus ───────────────────────────────────────────────────────

/** Who wrote an item: the seeding plants each writer's rows under its own ob1.actor name. */
export type Writer = "operator" | "meeting-notes" | "board-sync";

/** A board item's tracker fields, as board-sync writes them into metadata (db/ingest-linear.ts's issueFacets). */
export type BoardMeta = { issue: string; status: string; status_type: "backlog" | "unstarted" | "started" | "completed" | "canceled"; priority: "Urgent" | "High" | "Medium" | "Low" | "No priority" };

/**
 * What a later read may know of an item that search cannot: the facts
 * SMD-3663's assertions, SMD-3665's open items and SMD-3666's sources will
 * carry. Nothing on main reads them; they are here so a later read is seeded
 * from the same corpus the baseline was measured on, not a re-written one.
 * `level` is docs/priority.md's scale (0–5) as the item's writer states it,
 * absent where nobody states one (unknown).
 */
export type Facts = { dueInDays?: number; level?: number; done?: boolean; blocks?: string[]; blockedBy?: string[]; claimed?: boolean };

export type Item = {
  key: string;
  /** The row's text. Times are relative words ("tomorrow", "two weeks ago"), so a run's vectors never depend on its date. */
  text: string;
  writer: Writer;
  /** created_at is the run's now() minus this many days. */
  ageDays: number;
  board?: BoardMeta;
  facts: Facts;
};

const boardText = (b: BoardMeta, title: string, body: string): string =>
  `${b.issue} — ${title}\nProject: Zephyr · Status: ${b.status} (${b.status_type}) · Priority: ${b.priority}\n\n${body}`;

const board = (key: string, b: BoardMeta, title: string, body: string, ageDays: number, facts: Facts): Item =>
  ({ key, text: boardText(b, title, body), writer: "board-sync", ageDays, board: b, facts });

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
    "Nobody can sign in since this morning's rotation. Blocks ZQ-104.", 1, { level: 4, blocks: ["zq-blocked"] }),
  board("zq-high", { issue: "ZQ-102", status: "Backlog", status_type: "backlog", priority: "High" }, "Exports time out on large workspaces",
    "A workspace over a few thousand records never finishes its export.", 10, { level: 3 }),
  board("zq-claimed", { issue: "ZQ-103", status: "In Progress", status_type: "started", priority: "High" }, "The rate limiter drops short bursts",
    "Another agent holds this one and has a branch open.", 4, { level: 3, claimed: true }),
  board("zq-blocked", { issue: "ZQ-104", status: "Backlog", status_type: "backlog", priority: "High" }, "Roll out single sign-on to the second tenant",
    "Blocked by ZQ-101: sign-in has to work first.", 8, { level: 3, blockedBy: ["zq-urgent"] }),
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
 * ticket: "the gold order is written per prompt"), not computed from
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
 * The registration: a hash of ITEMS, PROMPTS, the stub embedder (its
 * constants and the source of its functions, noise weights included: they
 * set the baseline the bar is relative to), READ_K and BAR, pinned so neither
 * the set nor the bar can change under a measured read. A change to any of
 * them is a new registration — the baseline re-run on it, and recorded —
 * never an edit (the self-check fails until this line moves with it).
 */
export const REGISTERED_CORPUS = "de5bcbc5395ceb9a";

export function corpusHash(items: readonly Item[] = ITEMS, prompts: readonly Prompt[] = PROMPTS): string {
  return createHash("sha256").update(JSON.stringify({ items, prompts, stub: stubSource(), readK: READ_K, bar: BAR })).digest("hex").slice(0, 16);
}

/**
 * The stub embedder's section of this file, verbatim: its constants, stop
 * list, noise weights and code. Read from the source rather than from
 * String(fn), which is Bun's transpiled output and would move with a Bun
 * upgrade, not with the stub.
 */
export function stubSource(): string {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  // At a line's start, so the markers this function names inside its own quotes are not them.
  const from = src.indexOf("\n// ── The stub embedder ─");
  const to = src.indexOf("\n// ── The score ─");
  if (from < 0 || to < from) throw new Error("priority.ts: the stub embedder's section markers are missing");
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

/** FNV-1a over UTF-16 code units: a stable 32-bit hash. */
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

/** Mulberry32: a seeded generator, so the mutant's shuffles are the same every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
 */
export function shuffledScore(hits: readonly string[], gold: readonly string[], score: (hits: readonly string[], gold: readonly string[]) => PromptScore = scorePrompt, seed = MUTANT_SEED, shuffles = SHUFFLES): { top1: number; top3: number; tau: number } {
  const next = rng(seed);
  let top1 = 0, top3 = 0, tau = 0, tauN = 0;
  for (let i = 0; i < shuffles; i++) {
    const s = score(hits, shuffle(gold, next));
    if (s.top1) top1++;
    if (s.top3) top3++;
    if (s.tau !== null) { tau += s.tau; tauN++; }
  }
  return { top1: top1 / shuffles, top3: top3 / shuffles, tau: tauN ? tau / tauN : 0 };
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
 * Work 3). The bar a priority read (SMD-3668's `priority_weight`, SMD-3669's
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

export function dogfoodProblems(rows: readonly DogfoodRow[]): string[] {
  const out: string[] = [];
  rows.forEach((r, i) => {
    const at = `row ${i + 1} (${r.date ?? "?"})`;
    if (!isDay(r.date)) out.push(`${at}: date is not a YYYYMMDD day`);
    if (i > 0 && r.date < rows[i - 1].date) out.push(`${at}: rows are not in date order`);
    if (!ticketNumber(r.pick)) out.push(`${at}: pick is not a ticket number`);
    if (r.picked_instead !== null && !ticketNumber(r.picked_instead)) out.push(`${at}: picked_instead is not a ticket number`);
    if (r.picked_instead === r.pick) out.push(`${at}: picked_instead is the pick itself`);
    if (!UUID_RE.test(r.thought ?? "")) out.push(`${at}: thought is not an id`);
    for (const f of ["query", "note"] as const) if (typeof r[f] !== "string" || r[f].trim().length === 0) out.push(`${at}: ${f} is empty`);
    if (!r.reads || typeof r.reads !== "object" || Object.keys(r.reads).length === 0) out.push(`${at}: no read recorded`);
    for (const [name, v] of Object.entries(r.reads && typeof r.reads === "object" ? r.reads : {})) {
      if (!v || typeof v !== "object" || !("rank" in v)) { out.push(`${at}: read ${name} is not an object with a rank`); continue; }
      if (!(v.rank === null || (Number.isInteger(v.rank) && (v.rank as number) >= 0))) out.push(`${at}: read ${name}'s rank is not a number from 0 or null`);
    }
  });
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
