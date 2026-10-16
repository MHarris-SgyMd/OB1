#!/usr/bin/env bun
/**
 * eval-judge-decide.ts — can decider-4b settle the consolidation judge's easy pairs? (SMD-3058)
 *
 * The judge (server-portable/consolidate.ts, prompt 4) spends one call to the metadata model on every candidate
 * pair, with both thoughts' text in the prompt, and nearly every pair ends unrelated, related, evolves or
 * duplicate: on the canary, 295 change records judged and no proposal (SMD-3006). Beside a live call it is the
 * costliest pass there is (SMD-3024). This spike asks the typed-decision tier (ob1-jev/1, decider-4b; SMD-2050,
 * SMD-2265) about the same pairs, read the way the judge reads them, and scores a cascade: the decider settles a
 * pair only when it is confident the verdict is not `outdates`, and every other pair goes to an LLM judge, whose
 * saved answers (eval-judge.ts --out) stand in for the call.
 *
 * Asked of every pair, so both framings score from one run:
 *   S  binary   "THOUGHT A and THOUGHT B are about the same subject";
 *   T  choice   related | evolves | duplicate | outdates: the two-pass framing's second question, used only where S
 *               says same subject (asked of every pair here, so a band can move without a rerun);
 *   C  choice   all five verdicts: the one-pass framing.
 * The options carry prompt 4's verdict definitions (the decider is semantic: bare names cost accuracy, SMD-2427),
 * and the context is prompt 4's own rendering of the two thoughts (dates, writers, the 6,000-character cut, the
 * escaped tags) without its rules.
 *
 * The decider never settles `outdates`: a proposal needs a direction and a quote from the current thought, prompt
 * 4's guard against invented supersessions, which a classifier cannot give. So the cascade loses a true
 * supersession only by settling it as something else, and that count is what this spike exists to measure.
 *
 *   OB1_JEV_BASE_URL=http://127.0.0.1:8021 OB1_JEV_LOCAL=1 OB1_JEV_MODEL=decider-4b \
 *     bun eval-judge-decide.ts --pairs /private/tmp/smd3058/judge-pairs.jsonl --out /private/tmp/smd3058/decider.jsonl
 *   bun eval-judge-decide.ts --pairs … --decider …/decider.jsonl --judge 7b=…/answers-7b.jsonl --judge 27b=…/answers-27b.jsonl
 *   bun eval-judge-decide.ts --self-check     # the settle rules, the context and the scoring; no model
 *   … --out … --packed                        # the three questions in one request (a server with DECIDER_PACK=1 reads the pair once)
 *   … --out … --clip 600                      # each thought cut to its first 600 characters before the decider reads it
 *
 * --out appends one line per pair and skips the pairs already in it, so an interrupted run resumes. The pairs,
 * decider and answers files hold the brain's text (eval-judge.ts --export): keep them out of the repo.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadEnv } from "./env.ts";
import { buildJudgeMessages, type Verdict } from "../server-portable/consolidate.ts";
import { jevDecideMany, resolveJevConfig, type JevConfig, type JevDecision, type JevEnv, type JevOption, type JevResult } from "../server-portable/jev.ts";
import { proposes, rightFor, type AnswerLine, type PairLine } from "./eval-judge.ts";

// ── The questions ─────────────────────────────────────────────────────────────

/** The two-pass framing's first question, the proposition its binary decision weighs. */
export const SAME_SUBJECT = "THOUGHT A and THOUGHT B are about the same subject";
/** The choices' question. */
export const RELATION_QUESTION = "How do THOUGHT A and THOUGHT B relate?";

/** Prompt 4's verdict definitions (CONSOLIDATE_PROMPT), worded to follow the adapter's "It is …". */
export const DESCRIPTIONS: Record<Verdict, string> = {
  unrelated: "unrelated: the two are about different subjects, whatever names, systems or files they share",
  duplicate: "duplicate: the two state the same claims, so deleting either would lose nothing the other says",
  outdates:
    "outdates: the two describe the same thing at different moments, or in ways that cannot both hold, so one of them is no longer current, " +
    "such as a progress note and a later one of the same work, a status and a later status, a plan and the plan that replaced it, " +
    "a decision and its reversal, or one saying the other is done or replaced",
  evolves: "evolves: one continues the other and both stay current, such as a follow-up, a next step, a part split out, or a fix for what the other reported",
  related: "related: the same subject and compatible, neither continuing nor outdating the other; one may restate, summarise or add detail to the other",
};
export const FOUR: readonly Verdict[] = ["related", "evolves", "duplicate", "outdates"];
export const FIVE: readonly Verdict[] = ["unrelated", "related", "evolves", "duplicate", "outdates"];
const options = (vs: readonly Verdict[]): JevOption[] => vs.map((v) => ({ id: v, description: DESCRIPTIONS[v] }));

/**
 * The two thoughts as the judge reads them: prompt 4's own rendering, from "THOUGHT A, captured" to the rules after
 * thought B. With `clip`, each thought is cut to its first `clip` characters first, the decider reading less than
 * the judge does.
 */
export function pairContext(p: Pick<PairLine, "older" | "newer">, clip?: number): string {
  const cut = <S extends { content: string }>(s: S): S => (clip ? { ...s, content: s.content.slice(0, clip) } : s);
  const msg = buildJudgeMessages(cut(p.older), cut(p.newer))[0].content;
  const start = msg.indexOf("THOUGHT A, captured");
  const end = msg.lastIndexOf("\n\nReturn strict JSON");
  if (start < 0 || end <= start) throw new Error('prompt 4\'s layout moved: no span from "THOUGHT A, captured" to "Return strict JSON"');
  return msg.slice(start, end);
}

/** The three decisions every pair is asked. */
export function decisionsFor(context: string): Record<Ask, JevDecision> {
  return {
    S: { id: "S", kind: "binary", proposition: SAME_SUBJECT, context },
    T: { id: "T", kind: "choice", question: RELATION_QUESTION, options: options(FOUR), context },
    C: { id: "C", kind: "choice", question: RELATION_QUESTION, options: options(FIVE), context },
  };
}

// ── The file shapes ───────────────────────────────────────────────────────────

export type Ask = "S" | "T" | "C";
export type Decided = { probabilities: Record<string, number>; abstained: boolean; p_true?: number | null; tokens: number; truncated: boolean; ms: number };
/**
 * One pair's answers. `packedMs`: S and T, the two-pass framing's questions, were asked in one request (--packed),
 * and this is its time: one read of the pair for both. C is asked alone either way, as the one-pass framing asks
 * it. `clip`: each thought was cut to this many characters (--clip).
 */
export type DeciderLine = { pair: string; S?: Decided; T?: Decided; C?: Decided; packedMs?: number; clip?: number; error?: string };

// ── The settle rules (pure; --self-check holds them) ─────────────────────────

/**
 * A band. One-pass: settle C's top verdict when it is not `outdates`, its probability is at least `settle` and
 * `outdates` holds at most `outdatesMax`. Two-pass: S at most `lo` settles `unrelated`; S at least `hi` asks T,
 * settled by the same rule over its four; anything between goes to the judge.
 */
export type Band = { framing: "one" | "two"; settle: number; outdatesMax: number; lo: number; hi: number };

const topOf = (x: Decided, vs: readonly Verdict[]): Verdict => vs.reduce((a, v) => ((x.probabilities[v] ?? 0) > (x.probabilities[a] ?? 0) ? v : a), vs[0]);

/** The verdict the decider settles a pair at, or null to send it to the judge. Never `outdates`. */
export function settledVerdict(d: DeciderLine, b: Band): Verdict | null {
  const choose = (x: Decided | undefined, vs: readonly Verdict[]): Verdict | null => {
    if (!x || x.abstained) return null;
    const v = topOf(x, vs);
    return v !== "outdates" && (x.probabilities[v] ?? 0) >= b.settle && (x.probabilities.outdates ?? 0) <= b.outdatesMax ? v : null;
  };
  if (b.framing === "one") return choose(d.C, FIVE);
  const s = d.S;
  if (!s || s.abstained || s.p_true == null) return null;
  if (s.p_true <= b.lo) return "unrelated";
  if (s.p_true < b.hi) return null;
  return choose(d.T, FOUR);
}

/**
 * The decider's time on a pair under a band: C alone one-pass; two-pass, S, then T only where S reached `hi` — or,
 * packed, the one request that asked both.
 */
export function deciderMs(d: DeciderLine, b: Band): number {
  if (b.framing === "one") return d.C?.ms ?? 0;
  if (d.packedMs !== undefined) return d.packedMs;
  const t = d.S?.p_true != null && d.S.p_true >= b.hi && !d.S.abstained ? d.T?.ms ?? 0 : 0;
  return (d.S?.ms ?? 0) + t;
}

// ── Scoring (pure) ────────────────────────────────────────────────────────────

/** A gold supersession: a reviewer's accepted proposal, or a writer's own `supersedes`. */
export const isSupersession = (p: PairLine) => (p.gold.source === "proposal" && p.gold.label === "accepted") || p.gold.source === "pointer";

export type Score = {
  pairs: number; labelled: number; candidates: number;
  settled: number; settledCandidates: number; settledLabelled: number; settledRight: number;
  right: number; supersessions: number; caught: number; lost: number; falseProposals: number; proposedCandidates: number;
  judgeCalls: number; judgeErrors: number; deciderMs: number; judgeMs: number;
  settledBy: Record<string, { n: number; right: number; wrongSupersession: number }>;
  /**
   * Against the judge's own answer on the settled pairs, where no label says (a candidate) and everywhere: the
   * same verdict; a relation the judge would have written (related, evolves, duplicate) settled as unrelated; and
   * the reverse, an unrelated pair given a relation.
   */
  agree: number; agreeCandidates: number; droppedRelations: number; droppedRelationsCandidates: number; addedRelations: number; addedRelationsCandidates: number;
  /** On the labelled pairs the decider settles, how many the judge it replaced had right: the bar its own settledRight meets or misses. */
  settledJudgeRight: number;
};

const RELATIONS = new Set(["related", "evolves", "duplicate"]);

/**
 * The cascade over every pair: the decider's verdict where `band` settles one, the judge's saved answer otherwise
 * (band null: the judge alone). "Lost" counts gold supersessions the judge proposed and the decider settled away.
 */
export function score(pairs: PairLine[], decider: Map<string, DeciderLine>, judge: Map<string, AnswerLine>, band: Band | null): Score {
  const s: Score = {
    pairs: pairs.length, labelled: 0, candidates: 0, settled: 0, settledCandidates: 0, settledLabelled: 0, settledRight: 0,
    right: 0, supersessions: 0, caught: 0, lost: 0, falseProposals: 0, proposedCandidates: 0,
    judgeCalls: 0, judgeErrors: 0, deciderMs: 0, judgeMs: 0, settledBy: {},
    agree: 0, agreeCandidates: 0, droppedRelations: 0, droppedRelationsCandidates: 0, addedRelations: 0, addedRelationsCandidates: 0,
    settledJudgeRight: 0,
  };
  for (const p of pairs) {
    const d = decider.get(p.pair);
    const a = judge.get(p.pair);
    const candidate = p.gold.source === "candidate";
    if (candidate) s.candidates++; else s.labelled++;
    const settled = band && d ? settledVerdict(d, band) : null;
    if (band && d) s.deciderMs += deciderMs(d, band);
    let verdict: string | null;
    if (settled) {
      verdict = settled;
      s.settled++;
      if (candidate) s.settledCandidates++; else s.settledLabelled++;
      const theirs = a?.judgement?.verdict;
      if (theirs === settled) { s.agree++; if (candidate) s.agreeCandidates++; }
      if (settled === "unrelated" && theirs && RELATIONS.has(theirs)) { s.droppedRelations++; if (candidate) s.droppedRelationsCandidates++; }
      if (RELATIONS.has(settled) && theirs === "unrelated") { s.addedRelations++; if (candidate) s.addedRelationsCandidates++; }
    } else {
      s.judgeCalls++;
      s.judgeMs += a?.ms ?? 0;
      verdict = a?.judgement?.verdict ?? null;
      if (!verdict) s.judgeErrors++;
    }
    const proposed = verdict !== null && proposes(verdict);
    if (candidate) { if (proposed) s.proposedCandidates++; continue; }
    const right = verdict !== null && rightFor(p.gold, verdict, proposed) === true;
    if (right) s.right++;
    if (settled) {
      if (right) s.settledRight++;
      const theirs = a?.judgement?.verdict;
      if (theirs && rightFor(p.gold, theirs, proposes(theirs)) === true) s.settledJudgeRight++;
      const by = (s.settledBy[settled] ??= { n: 0, right: 0, wrongSupersession: 0 });
      by.n++;
      if (right) by.right++;
      if (isSupersession(p)) by.wrongSupersession++;
    }
    if (isSupersession(p)) {
      s.supersessions++;
      if (proposed) s.caught++;
      const judgeProposed = !!a?.judgement?.verdict && proposes(a.judgement.verdict);
      if (settled && judgeProposed) s.lost++;
    } else if (proposed) {
      s.falseProposals++;
    }
  }
  return s;
}

/** The grid each framing is swept over. */
export function grid(): Band[] {
  const out: Band[] = [];
  for (const settle of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) for (const outdatesMax of [0.01, 0.02, 0.05, 0.1, 0.2, 0.3]) out.push({ framing: "one", settle, outdatesMax, lo: 0, hi: 1 });
  for (const lo of [0, 0.02, 0.05, 0.1, 0.2, 0.3]) for (const hi of [0.6, 0.7, 0.8, 0.9, 0.95]) for (const settle of [0.5, 0.6, 0.7, 0.8, 0.9]) for (const outdatesMax of [0.02, 0.05, 0.1, 0.2])
    out.push({ framing: "two", settle, outdatesMax, lo, hi });
  return out;
}

/**
 * The band picked from the data: among those that lose no supersession the judge caught, the one settling the most
 * candidates (the pass's own population), then the most pairs overall; null when every band loses one.
 */
export function pick(pairs: PairLine[], decider: Map<string, DeciderLine>, judge: Map<string, AnswerLine>, framing: Band["framing"], maxLost = 0): { band: Band; score: Score } | null {
  let best: { band: Band; score: Score } | null = null;
  for (const band of grid().filter((b) => b.framing === framing)) {
    const sc = score(pairs, decider, judge, band);
    if (sc.lost > maxLost) continue;
    if (!best || sc.settledCandidates > best.score.settledCandidates || (sc.settledCandidates === best.score.settledCandidates && sc.settled > best.score.settled)) best = { band, score: sc };
  }
  return best;
}

/** A pair's fold, by an md5 of its key, for picking a band on one half and scoring it on the other. */
export const foldOf = (pair: string): 0 | 1 => (parseInt(createHash("md5").update(pair).digest("hex").slice(0, 8), 16) % 2) as 0 | 1;

export const bandText = (b: Band) =>
  b.framing === "one" ? `one-pass: top ≥ ${b.settle}, outdates ≤ ${b.outdatesMax}` : `two-pass: same ≤ ${b.lo} unrelated; ≥ ${b.hi} then top ≥ ${b.settle}, outdates ≤ ${b.outdatesMax}`;

// ── The run: asking the decider ───────────────────────────────────────────────

/** A result as a line keeps it. */
const decided = (x: JevResult, ms: number): Decided => ({ probabilities: x.probabilities, abstained: x.abstained, p_true: x.p_true ?? null, tokens: x.tokens, truncated: x.truncated, ms });

/**
 * Ask every pair not yet in `out`. Each decision in a request of its own by default; with `packed`, S and T in one
 * request, which a server started with DECIDER_PACK=1 answers in one call over the shared context, and C alone (a
 * question packed after T's near-copy moved off its own answer on half of a trial's pairs).
 */
async function askAll(pairs: PairLine[], out: string, cfg: JevConfig, opts: { packed: boolean; clip?: number }): Promise<void> {
  const done = new Set(existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as DeciderLine).pair) : []);
  const todo = pairs.filter((p) => !done.has(p.pair));
  console.error(`  ${pairs.length} pairs, ${done.size} already in ${out}, ${todo.length} to ask (3 decisions each${opts.packed ? ": S and T in one request, C alone" : ""}${opts.clip ? `, each thought cut to ${opts.clip} characters` : ""})`);
  let n = 0;
  for (const p of todo) {
    const context = pairContext(p, opts.clip);
    const line: DeciderLine = { pair: p.pair, ...(opts.clip ? { clip: opts.clip } : {}) };
    try {
      const q = decisionsFor(context);
      const alone = async (ask: Ask) => {
        const r = await jevDecideMany(cfg, [q[ask]], { kind: "judge", content: context });
        line[ask] = decided(r.results[0], r.ms);
      };
      if (opts.packed) {
        const r = await jevDecideMany(cfg, [q.S, q.T], { kind: "judge", content: context });
        line.S = decided(r.results[0], r.ms);
        line.T = decided(r.results[1], r.ms);
        line.packedMs = r.ms;
      } else {
        await alone("S");
        await alone("T");
      }
      await alone("C");
    } catch (e) {
      line.error = String((e as Error)?.message ?? e).slice(0, 300);
    }
    appendFileSync(out, JSON.stringify(line) + "\n");
    if (++n % 20 === 0) console.error(`  ${n}/${todo.length}`);
  }
}

// ── The report ────────────────────────────────────────────────────────────────

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");
const med = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };

function row(name: string, sc: Score): string {
  const acc = sc.settledLabelled ? pct(sc.settledRight, sc.settledLabelled) : "-";
  const secs = ((sc.deciderMs + sc.judgeMs) / sc.pairs / 1000).toFixed(2);
  return `  ${name.padEnd(54)} ${pct(sc.settledCandidates, sc.candidates).padStart(5)} ${pct(sc.settled, sc.pairs).padStart(5)}  ${acc.padStart(5)}  ${`${sc.caught} of ${sc.supersessions}`.padStart(8)} ${String(sc.lost).padStart(4)} ${String(sc.falseProposals).padStart(5)} ${String(sc.judgeCalls).padStart(6)} ${secs.padStart(7)}`;
}

function report(pairs: PairLine[], decider: Map<string, DeciderLine>, judges: [string, Map<string, AnswerLine>][]): void {
  const asked = pairs.filter((p) => decider.get(p.pair) && !decider.get(p.pair)!.error);
  const errors = pairs.length - asked.length;
  const truncated = asked.filter((p) => (["S", "T", "C"] as Ask[]).some((k) => decider.get(p.pair)![k]?.truncated)).length;
  const tok = asked.map((p) => decider.get(p.pair)!.C?.tokens ?? 0);
  const ms = (k: Ask) => med(asked.map((p) => decider.get(p.pair)![k]?.ms ?? NaN).filter((x) => !Number.isNaN(x)));
  console.log(`\nThe decider: ${asked.length} of ${pairs.length} pairs answered (${errors} errors), context tokens median ${med(tok)}, max ${Math.max(0, ...tok)}, ${truncated} truncated`);
  console.log(`  median ms per decision: S ${ms("S").toFixed(0)}, T ${ms("T").toFixed(0)}, C ${ms("C").toFixed(0)}`);

  // What the decider says, beside what the labels say.
  const sources = ["proposal:accepted", "pointer:supersedes", "proposal:rejected", "link:duplicate_of", "link:child_of", "link:blocks", "link:relates_to", "candidate:none"];
  console.log("\nThe decider's one-pass top verdict by label (count), and its median P(same subject)");
  console.log(`  ${"label".padEnd(20)} ${FIVE.map((v) => v.padStart(9)).join("")}  abstain  P(same)`);
  for (const src of sources) {
    const mine = asked.filter((p) => `${p.gold.source}:${p.gold.label}` === src);
    if (!mine.length) continue;
    const c: Record<string, number> = {};
    let abst = 0;
    for (const p of mine) { const d = decider.get(p.pair)!; if (d.C?.abstained) abst++; else { const v = topOf(d.C!, FIVE); c[v] = (c[v] ?? 0) + 1; } }
    const same = med(mine.map((p) => decider.get(p.pair)!.S?.p_true ?? NaN).filter((x) => !Number.isNaN(x)));
    console.log(`  ${src.padEnd(20)} ${FIVE.map((v) => String(c[v] ?? 0).padStart(9)).join("")}  ${String(abst).padStart(7)}  ${same.toFixed(2)}`);
  }

  console.log("\nThe cascade (bands picked from the data: no supersession the judge caught is lost, the most candidates settled)");
  console.log(`  ${"".padEnd(54)} settled       acc on   true sup lost false  judge  model s`);
  console.log(`  ${"judge / framing / band".padEnd(54)}  cand   all  settled   caught      props  calls   / pair`);
  for (const [name, judge] of judges) {
    console.log(row(`${name} alone`, score(pairs, decider, judge, null)));
    for (const framing of ["one", "two"] as const) {
      for (const maxLost of [0, 1]) {
        const best = pick(pairs, decider, judge, framing, maxLost);
        console.log(best ? row(`${name} + ${bandText(best.band)}${maxLost ? " (≤1 lost)" : ""}`, best.score) : `  ${name} ${framing}-pass: every band loses more than ${maxLost}`);
        if (best && maxLost === 0) {
          const by = Object.entries(best.score.settledBy).map(([v, x]) => `${v} ${x.right}/${x.n}${x.wrongSupersession ? ` (${x.wrongSupersession} gold supersessions)` : ""}`).join(", ");
          console.log(`      settled as: ${by || "nothing"}`);
          const b = best.score;
          console.log(`      against ${name}'s own answer: the same verdict on ${b.agree} of ${b.settled} settled (candidates ${b.agreeCandidates} of ${b.settledCandidates}); ` +
            `relations dropped ${b.droppedRelations} (candidates ${b.droppedRelationsCandidates}), added ${b.addedRelations} (candidates ${b.addedRelationsCandidates})`);
          console.log(`      on the ${b.settledLabelled} labelled pairs it settles: the decider right on ${b.settledRight}, ${name} right on ${b.settledJudgeRight}`);
        }
      }
    }
  }

  console.log("\nHeld out: a band picked on one half of the pairs (md5 fold), scored on the other");
  for (const [name, judge] of judges) {
    for (const framing of ["one", "two"] as const) {
      for (const f of [0, 1] as const) {
        const fit = pairs.filter((p) => foldOf(p.pair) === f), test = pairs.filter((p) => foldOf(p.pair) !== f);
        const best = pick(fit, decider, judge, framing);
        if (!best) { console.log(`  ${name} ${framing}-pass, fold ${f}: every band loses a supersession`); continue; }
        console.log(row(`${name} ${framing}-pass, picked on fold ${f}, scored on ${1 - f}`, score(test, decider, judge, best.band)));
      }
    }
  }
}

// ── Self-check ────────────────────────────────────────────────────────────────

function selfCheck(): never {
  let bad = 0;
  const ok = (c: boolean, what: string) => { if (!c) { bad++; console.log(`  FAIL ${what}`); } };
  const dec = (p: Record<string, number>, extra: Partial<Decided> = {}): Decided => ({ probabilities: p, abstained: false, tokens: 10, truncated: false, ms: 100, ...extra });
  const one: Band = { framing: "one", settle: 0.8, outdatesMax: 0.05, lo: 0, hi: 1 };
  const two: Band = { framing: "two", settle: 0.7, outdatesMax: 0.05, lo: 0.1, hi: 0.8 };

  ok(settledVerdict({ pair: "a", C: dec({ related: 0.9, outdates: 0.02 }) }, one) === "related", "one-pass: a confident related settles");
  ok(settledVerdict({ pair: "a", C: dec({ outdates: 0.9 }) }, one) === null, "one-pass: outdates is never settled");
  const open: Band = { ...one, outdatesMax: 1 }, openTwo: Band = { ...two, outdatesMax: 1 };
  ok(settledVerdict({ pair: "a", C: dec({ outdates: 0.95 }) }, open) === null, "one-pass: outdates is never settled, whatever the band's floor");
  ok(settledVerdict({ pair: "a", S: dec({}, { p_true: 0.95 }), T: dec({ outdates: 0.95 }) }, openTwo) === null, "two-pass: outdates is never settled, whatever the band's floor");
  ok(settledVerdict({ pair: "a", C: dec({ related: 0.85, outdates: 0.1 }) }, one) === null, "one-pass: outdates above its floor sends the pair on");
  ok(settledVerdict({ pair: "a", C: dec({ related: 0.6, evolves: 0.38 }) }, one) === null, "one-pass: an unsure top sends the pair on");
  ok(settledVerdict({ pair: "a", C: dec({ related: 0.95 }, { abstained: true }) }, one) === null, "one-pass: an abstention sends the pair on");
  ok(settledVerdict({ pair: "a", S: dec({}, { p_true: 0.05 }) }, two) === "unrelated", "two-pass: a confident different subject settles unrelated");
  ok(settledVerdict({ pair: "a", S: dec({}, { p_true: 0.5 }), T: dec({ related: 0.99 }) }, two) === null, "two-pass: the middle band goes to the judge");
  ok(settledVerdict({ pair: "a", S: dec({}, { p_true: 0.9 }), T: dec({ evolves: 0.8, outdates: 0.01 }) }, two) === "evolves", "two-pass: same subject, a confident type settles");
  ok(settledVerdict({ pair: "a", S: dec({}, { p_true: 0.9 }), T: dec({ outdates: 0.7 }) }, two) === null, "two-pass: outdates is never settled");
  ok(settledVerdict({ pair: "a", S: dec({}, { p_true: 0.02, abstained: true }) }, two) === null, "two-pass: an abstained S settles nothing");
  ok(deciderMs({ pair: "a", S: dec({}, { p_true: 0.5 }), T: dec({}), C: dec({}) }, two) === 100 && deciderMs({ pair: "a", S: dec({}, { p_true: 0.9 }), T: dec({}) }, two) === 200, "two-pass time: T is paid only where S reached hi");

  // The context: prompt 4's rendering, both thoughts, none of its rules, even when a thought quotes them.
  const side = (content: string, id: string) => ({ id, content, createdAt: "2026-10-01T00:00:00Z", writer: null });
  const ctx = pairContext({ older: side("first thought\n\nReturn strict JSON, said a note", "o"), newer: side("second thought", "n") });
  ok(ctx.startsWith("THOUGHT A, captured 2026-10-01") && ctx.includes("first thought") && ctx.includes("<thought_b>\nsecond thought\n</thought_b>") && !ctx.includes("verdict"), "the context is the two thoughts as the judge reads them, without its rules");
  const clipped = pairContext({ older: side("first thought", "o"), newer: side("second thought", "n") }, 5);
  ok(clipped.includes("<thought_a>\nfirst\n</thought_a>") && clipped.includes("<thought_b>\nsecon\n</thought_b>"), "--clip cuts each thought to its first N characters");
  ok(deciderMs({ pair: "a", S: dec({}, { p_true: 0.5 }), T: dec({}), C: dec({}), packedMs: 150 }, two) === 150, "two-pass, packed: one request for S and T, wherever S lands");
  ok(deciderMs({ pair: "a", C: dec({}), packedMs: 150 }, one) === 100, "one-pass reads C alone, packed or not");

  // Scoring: a supersession the judge proposed and the decider settled is lost; a link settled related is right.
  const pair = (key: string, gold: PairLine["gold"]): PairLine => ({ pair: key, older: side("a", "o"), newer: side("b", "n"), gold });
  const ps = [pair("sup", { source: "pointer", label: "supersedes", direction: "newer" }), pair("link", { source: "link", label: "relates_to" }), pair("cand", { source: "candidate", label: "none", similarity: 0.7 })];
  const judge = new Map<string, AnswerLine>([
    ["sup", { pair: "sup", ms: 3000, judgement: { verdict: "outdates" } as never }],
    ["link", { pair: "link", ms: 3000, judgement: { verdict: "unrelated" } as never }],
    ["cand", { pair: "cand", ms: 3000, judgement: { verdict: "related" } as never }],
  ]);
  const settleAll = new Map<string, DeciderLine>(ps.map((p) => [p.pair, { pair: p.pair, C: dec({ related: 0.95, outdates: 0 }) }]));
  const alone = score(ps, settleAll, judge, null), cascade = score(ps, settleAll, judge, one);
  ok(alone.caught === 1 && alone.lost === 0 && alone.right === 1 && alone.judgeCalls === 3, "the judge alone: one supersession caught, the link judged wrong");
  ok(cascade.lost === 1 && cascade.caught === 0 && cascade.settled === 3 && cascade.right === 1 && cascade.judgeCalls === 0, "the cascade: the supersession lost, the link right, no judge call");
  ok(cascade.settledBy.related?.wrongSupersession === 1, "a supersession settled as related is counted against it");
  ok(cascade.agree === 1 && cascade.agreeCandidates === 1 && cascade.addedRelations === 1 && cascade.droppedRelations === 0, "against the judge: the candidate agrees, the link gains a relation the judge called unrelated");
  ok(cascade.settledLabelled === 2 && cascade.settledRight === 1 && cascade.settledJudgeRight === 1, "on the settled labelled pairs: the decider right on the link, the judge it replaced right on the supersession");
  const unrelatedAll = new Map<string, DeciderLine>(ps.map((p) => [p.pair, { pair: p.pair, C: dec({ unrelated: 0.95, outdates: 0 }) }]));
  const dropped = score(ps, unrelatedAll, judge, one);
  ok(dropped.droppedRelations === 1 && dropped.droppedRelationsCandidates === 1 && dropped.agree === 1, "against the judge: a candidate it called related, settled unrelated, is a dropped relation");
  ok(foldOf("x") === foldOf("x") && [0, 1].includes(foldOf("y")), "folds are deterministic");

  console.log(bad === 0 ? "eval-judge-decide.ts self-check PASS" : `eval-judge-decide.ts self-check: ${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  loadEnv();
  const args = process.argv.slice(2);
  const has = (n: string) => args.includes(`--${n}`);
  const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : undefined; };
  const flags = (n: string) => args.flatMap((a, i) => (a === `--${n}` && args[i + 1] !== undefined ? [args[i + 1]] : []));
  if (has("self-check")) selfCheck();
  const pairsPath = flag("pairs");
  if (!pairsPath) { console.error("Pass --pairs <file> with --out <file> (ask the decider) or --decider <file> --judge name=<answers> (score), or --self-check."); process.exit(2); }
  const pairs = readFileSync(pairsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as PairLine);
  const out = flag("out");
  if (out) {
    const cfg = resolveJevConfig(process.env as JevEnv);
    if (!cfg) { console.error("OB1_JEV_BASE_URL is not set: the decider has no endpoint."); process.exit(2); }
    const clip = flag("clip") === undefined ? undefined : Number(flag("clip"));
    if (clip !== undefined && !(Number.isInteger(clip) && clip > 0)) { console.error("--clip takes a whole number of characters above 0"); process.exit(2); }
    await askAll(pairs, out, cfg, { packed: has("packed"), clip });
    process.exit(0);
  }
  const deciderPath = flag("decider");
  if (!deciderPath) { console.error("Pass --decider <file> to score, or --out <file> to ask."); process.exit(2); }
  const decider = new Map(readFileSync(deciderPath, "utf8").split("\n").filter(Boolean).map((l) => { const d = JSON.parse(l) as DeciderLine; return [d.pair, d] as const; }));
  const judges = flags("judge").map((spec) => {
    const [name, file] = spec.split("=");
    if (!name || !file) { console.error(`--judge takes name=<answers file>, not ${spec}`); process.exit(2); }
    return [name, new Map(readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { const a = JSON.parse(l) as AnswerLine; return [a.pair, a] as const; }))] as [string, Map<string, AnswerLine>];
  });
  if (!judges.length) { console.error("Pass at least one --judge name=<answers file>."); process.exit(2); }
  report(pairs, decider, judges);
}
