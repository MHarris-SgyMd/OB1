#!/usr/bin/env bun
/**
 * eval-stated-status.ts — which reading should label a ticket whose status a
 * thought no longer tells right, before search labels it? (SMD-2540.)
 *
 * The gap. Board-sync keeps ticket rows current; a note that says what state a
 * ticket is in is not a ticket row, so nothing marks it when the ticket moves.
 * 077 (SMD-2271) demotes a lifecycle-less thought only when every ticket it
 * names is finished, and never when it names an open one, so a session summary
 * that says "2306 is in progress" ranks first for "what next" on 2026-10-14
 * (dd70dccc, `demoted: []`) after SMD-2306 went Done. The fix the ticket asks
 * for is a label, not a demotion: the hit says which tickets moved, and its
 * rank stays 077's.
 *
 * What this measures, before any SQL is written (eval-transitive-freshness.ts's
 * shape: a TypeScript oracle over the brain's own rows, read-only). The first
 * registration's six candidates are evals/stated-status.ts's CANDIDATES (the
 * second and third registrations, below, add one each). Two families:
 *   moved-*  — the ticket's status when the thought was written against its
 *              status now, from thought_audit (board-sync updates a ticket row
 *              in place, so every status a row held is an event's payload,
 *              055). Three readings of "written": when the row was stored, when
 *              its supersedes chain's oldest row was, or the session's end the
 *              hook's last line records — 351 of stable's 1,006 summaries were
 *              stored a day or more after their session ended (re-captures),
 *              dd70dccc among them: stored 10-08, session ended 10-03. And
 *              moved-session-stated: moved-session for the tickets the text
 *              says some status of, the claim still the history's;
 *   stated-* — the status the text states after a mention, against now: the
 *              key alone, or with the list steps and bare numbers too.
 * Each reads only a thought with no lifecycle of its own (node_state's open IS
 * NULL): a ticket row, and a note filed under one, keeps its own status.
 *
 * The gold (evals/fixtures/stated-status-labels.json: ids and numbers only,
 * never text). A graded item is one label — a thought, a ticket, the claim
 * ("was In Progress when this was written" or "states it is In Progress") and
 * the status now — and its grade is one of:
 *   wrong  — the claim is false: the ticket was not in that state when the
 *            thought's content was written, or the text does not state that
 *            status of that ticket in its own voice (it quotes or corrects it,
 *            the status belongs to something else, the number is not the
 *            ticket);
 *   noise  — true, but the thought says nothing of the ticket's state, progress
 *            or what remains that a reader could take as current (a citation, a
 *            ticket filed, a passing mention);
 *   useful — true, and the thought does say or imply such a thing: the label
 *            corrects a picture a reader would otherwise take from it.
 * Two blind graders per round, given the rubric, an excerpt of each thought
 * around its labelled tickets, its dates and the tickets' status histories, and
 * nothing of the candidates. Disagreements go to a third blind grader choosing
 * between the two grades.
 *
 * The sample: per candidate, its first SAMPLE labels on thoughts nothing
 * supersedes, ordered by a fixed hash of (thought, ticket, claim); the union is
 * graded once, an item shared by candidates counted for each.
 *
 * PRE-REGISTERED decision (written before the first measured run):
 *   1. A candidate QUALIFIES only if
 *      (a) the measured case: dd70dccc carries a label for SMD-2306 whose claim
 *          is a started status and whose now is completed;
 *      (b) precision: of its sampled labels, every one graded, at least
 *          PRECISION_MIN are not `wrong` — a wrong label is worse than none;
 *      (c) signal: at least USEFUL_MIN of its graded labels are `useful`.
 *      The lifecycle guard (a thought with a lifecycle of its own is never
 *      labelled) is the caller's here, so it cannot fail in this program; the
 *      census prints how many such thoughts each candidate would have labelled,
 *      and PR 2's SQL is held to the guard by its own tests.
 *   2. Among qualifying candidates the one with the most estimated useful
 *      labels on the corpus (labels × its sampled useful share) wins, but a
 *      stated-* candidate is chosen over the best qualifying moved-* only when
 *      its estimate is at least STATED_MARGIN higher: the moved family reads no
 *      prose, so a reworded note cannot fool it.
 *   3. If none qualifies, the label does not ship as specified; the verdict
 *      says which condition failed.
 *
 *   AMENDED after the first graded run (a bug in reading the history, not a
 *   change of rule): the history was read in thought_audit's seq order, and
 *   046's backfill numbered a ticket's older events after newer ones (SMD-1525:
 *   Done at seq 477, Backlog at seq 792), so a status was read as the one
 *   before it. "The status at a time" is now the last event, in the log's
 *   order, at or before it — the log's order being 060's one copy of it,
 *   ob1_thought_events_in_order (seq since 050, (created_at, seq) before);
 *   the first fix read (created_at, seq) by hand, and the house order (the
 *   first review pass) moved no label. Before the fix, six of the seven wrong
 *   labels moved-session then produced were this, and the seventh (1f6578b3)
 *   a note that knew SMD-1998 was Done seconds before board-sync recorded it.
 *   moved-session qualified on its own sample before the fix too; the run
 *   after it, and the labels the fix changed, are what the verdict below reads.
 *
 *   RESULT of the first registration (rounds 1–2, 118 graded labels; κ 0.969
 *   and 1.000): moved-session qualifies on its sample — 0 of 30 wrong, 0.667
 *   useful — and nothing else does: the stated-* candidates are 0.567 and
 *   0.500 precise (reported speech, a status that belongs to a PR or a step),
 *   moved-stored and moved-chain read the wrong time. But over EVERY graded
 *   label moved-session produces, 7 of 68 are wrong (0.897; after the fix —
 *   not the seven above): a sample of 30 missed them, and the registration
 *   read the sample alone. All 7 are one case: a note written 0–18 minutes
 *   before board-sync recorded a move its writer had just made (fab47c58, stored 19:10, SMD-1938 Done at 19:25). So
 *   the first registration's pick does not ship.
 *
 * SECOND registration (written after round 2's grades, before it ran):
 *   moved-session-lag (evals/stated-status.ts's SECOND) reads "then" LAG_MS (an
 *   hour) after the written time. The hour was chosen after seeing the 18
 *   minutes; the held-out sample is the guard. It QUALIFIES only if (a); (b)
 *   over a held-out sample — SAMPLE labels by a second hash (HELD_OUT_SALT),
 *   none of them graded in rounds 1–2, graded by two fresh blind graders — AND
 *   over every graded label it produces, any round (pooled); (c) over the
 *   held-out sample. If it does not, the label does not ship as specified.
 *
 *   RESULT of the second registration: it does not qualify, and its held-out
 *   sample was never graded as a sample (2 of its 30 items happen to be in
 *   round 3's) — over every graded label it produces, 4 of 51 are wrong
 *   (0.922). Reading "then" an hour late put a move the note never
 *   knew of into its claim (45144934: SMD-2294 started a minute after the
 *   session ended, and the label said the note was written while it was In
 *   Progress).
 *
 * THIRD registration (written after the second failed; the maintainer chose it
 * over stopping, 2026-10-14). moved-session-settled (evals/stated-status.ts's
 * THIRD): "then" at the written time, as moved-session reads it, and no label
 * when the ticket already held its current status type LAG_MS after it. Its
 * conditions are the second's, over a held-out sample of its own
 * (HELD_OUT_SALT_3, none of it graded in rounds 1–2, two fresh blind graders).
 * DISCLOSED: computed on rounds 1–2's labels before this registration was
 * written, it scored 53 of 54 (0.981) pooled — that number chose the rule, so
 * the held-out sample is the only independent evidence; the pooled precision
 * after round 3 still holds those 54.
 *
 *   RESULT of the third registration (round 3, 30 held-out labels, κ 0.714,
 *   4 adjudicated): moved-session-settled QUALIFIES and is chosen — held out
 *   29 of 30 right (0.967) and 21 useful (0.700), the only independent
 *   evidence; pooled over every graded
 *   label it produces, 82 of 84 (0.976, the 53 of 54 that chose it among
 *   them); the measured case labelled. On the corpus: 742 labels on 409
 *   thoughts (274 of the labels on superseded thoughts), 519 estimated useful
 *   (328 on thoughts nothing supersedes, the sample's own population); one
 *   thought's label names up to 12 tickets (3 at p90), so the label needs a cap. Its two
 *   wrong labels are a ticket that moved minutes after the note to a status
 *   that is not its current one (3a37f18b, 1886b600). evals/README.md has the
 *   tables.
 *
 * THE RECORD. The three registrations are closed, and the gold records the
 * evidence each was decided on, as of round 3: per graded item, the samples
 * that drew it and the label sets that held it; per candidate, its labels, its
 * labels on unsuperseded thoughts, and whether it labels the measured case.
 * The verdict is computed from that record (recordedDecision), the self-check
 * holds its numbers with no database — each registration's at the round it
 * was decided: the first and second at round 2 (moved-session pooled 61 of 68,
 * moved-session-lag 47 of 51), the third at round 3 — and readGold refuses a
 * record that breaks its invariants or names another candidate order. Nothing
 * rewrites it; a new registration brings its own candidates, rounds and
 * record. A live run builds the same snapshot and compares it whole, and its
 * drift is information: what moved in the evidence (samples, graded pools, the
 * measured case) apart from what moved only in counts (labels, fresh, which
 * the estimates read and no condition does). How it got here, in three review
 * passes: samples redrawn live turned a moved ticket into a "none" verdict
 * (pass 1 recorded them); the drift check compared less than the record held
 * (pass 2 made one snapshot, compared whole); and a `--record` that rewrote
 * the record re-decided closed registrations and failed the pins (pass 3
 * removed it). One held-out item (1f3cea4f, SMD-2294, moved) shares its thought
 * and ticket with a round-1 stated item; it was not among the 53 of 54 that
 * chose the rule, so the held-out evidence is still unseen by the choice.
 *
 * KNOWN HAZARDS for PR 2 (the first review pass; inside the measured
 * precision, not fixed here): a list step takes a count with the key's digit
 * count as a ticket (`SMD-2306, 1006 summaries` reads SMD-1006); and a
 * ticket's history is every row's that carries its key, a superseded or
 * duplicate ticket row's events among them, while its status now is the
 * head's.
 *
 * The census: per candidate, how many thoughts and labels, split session
 * summaries / other and superseded / not; how many tickets one thought's label
 * names (the cap the label needs); and, for the moved family, how many
 * (thought, ticket) pairs had no history at the written time (no label).
 *
 * Read-only against the live brain: the connection opens with
 * default_transaction_read_only on. No model is called. Run from a one-off
 * container on the brain's data network, DATABASE_URL in a 0600 env file
 * (never on argv):
 *
 *   podman run --rm --network open-brain_data --env-file <0600 file> \
 *     -v <worktree>:/repo:ro -v <out dir>:/out -w /repo/evals \
 *     oven/bun:1.4.3-alpine bun eval-stated-status.ts [flags]
 *
 *   … --list-wrong                       each candidate's wrong graded labels
 *        under the pooled table
 *   … --dump-ungraded /out/<file>        every live sampled label the gold
 *        lacks, with an excerpt, its stored time and the tickets' histories,
 *        to grade from (refused inside the repo: it holds thought text). How
 *        rounds 1–3 were graded: two blind graders per round given that file
 *        and the rubric above, a third choosing between them where they
 *        disagreed; a round enters the gold by hand, its items in the shape
 *        the fixture's `note` gives and its agreement what kappa() computes
 *        over them (readGold checks both).
 *   bun eval-stated-status.ts --self-check   the readings, the candidates,
 *        the samples, the recorded verdict and its invariants, the gold's
 *        provenance; no database
 */

import { SQL } from "bun";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CANDIDATES, chainRoot, keysOf, LAG_MS, labelsOf, mentionsOf, SECOND, sessionEnd, statedAfter, statusAt, THIRD, writtenAt, type Candidate, type ChainRow, type Change, type Label, type Reading, type Status } from "./stated-status.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLD_PATH = join(HERE, "fixtures", "stated-status-labels.json");

export const SAMPLE = 30;
export const PRECISION_MIN = 0.95;
export const USEFUL_MIN = 0.5;
export const STATED_MARGIN = 0.2;
/** The measured case: the 10/3 session's summary as re-captured on 10-08. */
const MEASURED = "dd70dccc-0556-4a44-a8f7-68a3e2264802";
const MEASURED_KEY = "SMD-2306";
/** Every ticket this brain holds is on one team; the gold stores a ticket as its number (check 9 allows no other string). */
const TEAM = "SMD";

// ── The gold ─────────────────────────────────────────────────────────────────

export const GRADES = ["wrong", "noise", "useful"] as const;
export type Grade = (typeof GRADES)[number];
/** The status types a claim or a now may carry, by index in the gold. */
export const TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"] as const;
const KINDS = ["moved", "stated"] as const;

/** Every candidate, in the registrations' order: the index a recorded membership names. */
export const ALL: readonly Candidate[] = [...CANDIDATES, ...SECOND, ...THIRD];

/**
 * One graded label: what it said, the two graders, the grade kept (one of
 * theirs), and — as recorded when the verdict was read — the candidates whose
 * registered sample drew it and the candidates whose label set held it.
 */
export type Item = { id: string; key: string; kind: Label["kind"]; claim: string; now: string; a: Grade; b: Grade; grade: Grade; round: number; sampled: Candidate[]; pooled: Candidate[] };
type Round = { generated: string; agreement: { raw: number; kappa: number; adjudicated: number } };
/**
 * What the verdict read besides the grades, per candidate (ALL's order): its
 * labels, those on unsuperseded thoughts, and whether it labelled the measured
 * case; `order` is fnv1a of ALL's names joined, so a reordered candidate list
 * cannot re-point the recorded indices silently.
 */
export type Recorded = { generated: string; order: number; labels: number[]; fresh: number[]; measured: boolean[] };
export type Gold = { items: Item[]; rounds: Round[]; recorded: Recorded | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The identity a grade attaches to: the same thought, ticket, kind, claim and now. A ticket that moves again is a new item. */
export const itemKey = (id: string, l: Pick<Label, "key" | "kind"> & { claim: string; now: string }) => `${id}|${l.key}|${l.kind}|${l.claim}|${l.now}`;
const labelKey = (id: string, l: Label) => itemKey(id, { key: l.key, kind: l.kind, claim: l.claim.type, now: l.now.type });

/** fnv1a of ALL's names, the order the recorded indices are read in. */
export const allOrder = () => fnv1a(ALL.join(","));

/**
 * The committed gold; a missing file or a malformed entry is an Error naming
 * the file. A gold that records a verdict is held to the record's invariants:
 * every item a sample drew is in that candidate's pooled set; each sample holds
 * SAMPLE items (the closed second registration's none); the held-out samples
 * hold no item graded in rounds 1–FIRST_ROUNDS; and `order` is ALL's.
 */
export function readGold(path = GOLD_PATH): Gold {
  if (!existsSync(path)) throw new Error(`${path}: the gold is missing`);
  let raw: { version?: unknown; items?: unknown; rounds?: unknown; recorded?: unknown };
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new Error(`${path}: not JSON (${(e as Error).message})`); }
  if (raw === null || typeof raw !== "object" || raw.version !== 1 || !Array.isArray(raw.items) || !Array.isArray(raw.rounds)) throw new Error(`${path}: not a version-1 gold file`);
  const idx = <T>(list: readonly T[], v: unknown, what: string): T => {
    if (typeof v !== "number" || !Number.isInteger(v) || list[v] === undefined) throw new Error(`${path}: bad ${what}: ${String(v)}`);
    return list[v];
  };
  const rounds = raw.rounds.map((r: { generated?: unknown; agreement?: { raw?: unknown; kappa?: unknown; adjudicated?: unknown } }, i: number) => {
    const ag = r?.agreement;
    if (typeof r?.generated !== "string" || !ag || typeof ag.raw !== "number" || typeof ag.kappa !== "number" || typeof ag.adjudicated !== "number") throw new Error(`${path}: round ${i + 1} lacks generated or agreement`);
    return { generated: r.generated, agreement: { raw: ag.raw, kappa: ag.kappa, adjudicated: ag.adjudicated } };
  });
  const members = (v: unknown, what: string): Candidate[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`${path}: ${what} must be a list of candidate indices`);
    return v.map((x) => idx(ALL, x, what));
  };
  const items = raw.items.map((e: Record<string, unknown>) => {
    if (e === null || typeof e !== "object") throw new Error(`${path}: an item is not an object`);
    if (typeof e.id !== "string" || !UUID_RE.test(e.id) || typeof e.issue !== "number" || !Number.isInteger(e.issue) || e.issue <= 0) throw new Error(`${path}: bad item ${JSON.stringify(e)}`);
    const round = e.round;
    if (typeof round !== "number" || !Number.isInteger(round) || round < 1 || round > rounds.length) throw new Error(`${path}: item ${e.id} names no round`);
    return {
      id: e.id, key: `${TEAM}-${e.issue}`, kind: idx(KINDS, e.kind, "kind"), claim: idx(TYPES, e.claim, "claim"), now: idx(TYPES, e.now, "now"),
      a: idx(GRADES, e.a, "grade a"), b: idx(GRADES, e.b, "grade b"), grade: idx(GRADES, e.grade, "grade"), round,
      sampled: members(e.sampled, "sampled"), pooled: members(e.pooled, "pooled"),
    };
  });
  let recorded: Recorded | null = null;
  if (raw.recorded !== undefined && raw.recorded !== null) {
    const r = raw.recorded as { generated?: unknown; labels?: unknown; fresh?: unknown; measured?: unknown };
    const counts = (v: unknown, what: string) => {
      if (!Array.isArray(v) || v.length !== ALL.length || !v.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 0)) throw new Error(`${path}: recorded.${what} must hold ${ALL.length} counts`);
      return v as number[];
    };
    if (typeof r?.generated !== "string") throw new Error(`${path}: recorded lacks generated`);
    if ((r as { order?: unknown }).order !== allOrder()) throw new Error(`${path}: recorded.order is not this file's candidate order (${allOrder()}): the indices would point at other candidates`);
    const measured = counts(r.measured, "measured");
    if (!measured.every((x) => x === 0 || x === 1)) throw new Error(`${path}: recorded.measured holds 0 or 1 per candidate`);
    recorded = { generated: r.generated, order: allOrder(), labels: counts(r.labels, "labels"), fresh: counts(r.fresh, "fresh"), measured: measured.map((x) => x === 1) };
    for (const it of items) {
      const stray = it.sampled.find((c) => !it.pooled.includes(c));
      if (stray) throw new Error(`${path}: item ${it.id} ${it.key} is in ${stray}'s sample but not its pooled set`);
      const early = it.sampled.find((c) => !(CANDIDATES as readonly Candidate[]).includes(c) && it.round <= FIRST_ROUNDS);
      if (early) throw new Error(`${path}: item ${it.id} ${it.key}, graded in round ${it.round}, is in ${early}'s held-out sample`);
    }
    for (const c of ALL) {
      const n = items.filter((it) => it.sampled.includes(c)).length, want = (SECOND as readonly Candidate[]).includes(c) ? 0 : SAMPLE;
      if (n !== want) throw new Error(`${path}: ${c}'s recorded sample holds ${n} items, not ${want}`);
    }
  }
  return { items, rounds, recorded };
}

/** Cohen's kappa of two graders' grades over the same items: (observed − expected) / (1 − expected). */
export function kappa(pairs: readonly [Grade, Grade][]): { n: number; raw: number; kappa: number } {
  const n = pairs.length;
  if (n === 0) return { n, raw: 0, kappa: 0 };
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const pe = GRADES.reduce((acc, g) => acc + (pairs.filter(([a]) => a === g).length / n) * (pairs.filter(([, b]) => b === g).length / n), 0);
  return { n, raw: po, kappa: pe === 1 ? 1 : (po - pe) / (1 - pe) };
}

// ── The sample and the verdict (pure) ────────────────────────────────────────

/** FNV-1a, 32-bit: the sample's fixed order, the same on every machine and run. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * A candidate's sample: its first `n` labels by hash of `salt` + item key, as
 * item keys, leaving out `exclude` (the held-out sample leaves out every item
 * the first registration's rounds graded).
 */
export function sampleOf(labelled: readonly { id: string; label: Label }[], n = SAMPLE, salt = "", exclude: ReadonlySet<string> = new Set()): string[] {
  const keys = labelled.map((x) => labelKey(x.id, x.label)).filter((k) => !exclude.has(k));
  return keys.sort((a, b) => fnv1a(salt + a) - fnv1a(salt + b) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, n);
}

/** A candidate's counts: labels (every lifecycle-less thought), fresh (those nothing supersedes, the sample's population), its sample and the grades in it. */
export type Tally = { candidate: Candidate; labels: number; fresh: number; sampled: number; graded: number; wrong: number; useful: number; measured: boolean };
/** `estimate` is the registered one (labels × the sampled useful share); `estimateFresh` the same over the sample's own population, reported beside it. */
export type Verdict = { candidate: Candidate; ok: boolean; why: string[]; estimate: number; estimateFresh: number };

/** Each candidate against conditions 1(a)–(c), with its estimated useful labels. */
export function judge(t: Tally): Verdict {
  const why: string[] = [];
  if (!t.measured) why.push("(a) dd70dccc carries no started → completed label for SMD-2306");
  if (t.sampled === 0) why.push("(b) no sample graded (closed)");
  else if (t.graded < t.sampled) why.push(`(b) ${t.sampled - t.graded} of ${t.sampled} sampled labels ungraded`);
  else if (t.graded === 0 || (t.graded - t.wrong) / t.graded < PRECISION_MIN) why.push(`(b) precision ${t.graded ? ((t.graded - t.wrong) / t.graded).toFixed(3) : "n/a"} < ${PRECISION_MIN}`);
  if (t.graded > 0 && t.useful / t.graded < USEFUL_MIN) why.push(`(c) useful share ${(t.useful / t.graded).toFixed(3)} < ${USEFUL_MIN}`);
  const share = t.graded ? t.useful / t.graded : 0;
  return { candidate: t.candidate, ok: why.length === 0, why, estimate: t.labels * share, estimateFresh: t.fresh * share };
}

/** The salts of the second and third registrations' held-out samples, and the rounds whose items both leave out. */
export const HELD_OUT_SALT = "held-out:";
export const HELD_OUT_SALT_3 = "held-out-3:";
export const FIRST_ROUNDS = 2;

/**
 * The second and third registrations: qualify on (a), (c) and (b) over a
 * held-out sample, and on (b) again over EVERY graded label the candidate
 * produces (pooled) — the check the first registration lacked.
 */
export function judgeHeldOut(t: Tally, pooled: { graded: number; wrong: number }): Verdict {
  const v = judge(t);
  const why = [...v.why];
  if (pooled.graded === 0 || (pooled.graded - pooled.wrong) / pooled.graded < PRECISION_MIN) why.push(`(b) pooled precision ${pooled.graded ? ((pooled.graded - pooled.wrong) / pooled.graded).toFixed(3) : "n/a"} < ${PRECISION_MIN}`);
  return { ...v, ok: why.length === 0, why };
}

/** The registered pick (condition 2): the most estimated useful labels, a stated-* one only STATED_MARGIN over the best moved-*; null when none qualifies. Ties keep the earlier candidate. */
export function pick(verdicts: readonly Verdict[]): Candidate | null {
  const ok = verdicts.filter((v) => v.ok);
  const best = (vs: Verdict[]) => vs.reduce<Verdict | null>((x, y) => (!x || y.estimate > x.estimate ? y : x), null);
  const moved = best(ok.filter((v) => v.candidate.startsWith("moved-"))), stated = best(ok.filter((v) => v.candidate.startsWith("stated-")));
  if (!moved) return stated?.candidate ?? null;
  return stated && stated.estimate >= moved.estimate * (1 + STATED_MARGIN) ? stated.candidate : moved.candidate;
}

export type Pooled = { graded: number; wrong: number };
export type Decision = {
  first: { t: Tally; v: Verdict }[]; firstPick: Candidate | null;
  second: { t: Tally; v: Verdict }[]; third: { t: Tally; v: Verdict }[]; chosen: Candidate | null;
  pooled: ReadonlyMap<Candidate, Pooled>;
};

/** The three registrations' verdicts from each candidate's tally and pooled grades; the chosen one is the third's. */
export function decide(tallyOf: (c: Candidate) => Tally, pooledOf: (c: Candidate) => Pooled): Decision {
  const first = CANDIDATES.map((c) => { const t = tallyOf(c); return { t, v: judge(t) }; });
  const held = (cs: readonly Candidate[]) => cs.map((c) => { const t = tallyOf(c); return { t, v: judgeHeldOut(t, pooledOf(c)) }; });
  const third = held(THIRD);
  return {
    first, firstPick: pick(first.map((x) => x.v)), second: held(SECOND), third,
    chosen: third.find((x) => x.v.ok)?.t.candidate ?? null, pooled: new Map(ALL.map((c) => [c, pooledOf(c)])),
  };
}

/**
 * What a verdict reads of one candidate besides the grades: the item keys of
 * its sample, the GRADED item keys in its label set (pooled), its labels, those
 * on unsuperseded thoughts, and whether it labels the measured case. The gold
 * records one per candidate; a live run builds one the same way, and the two
 * are compared whole.
 */
export type Snap = { sample: Set<string>; pooled: Set<string>; labels: number; fresh: number; measured: boolean };
export type Snapshot = Map<Candidate, Snap>;

/** The snapshot the gold records; null when it records none. */
export function snapshotOfGold(gold: Gold): Snapshot | null {
  const rec = gold.recorded;
  if (!rec) return null;
  const keysIn = (c: Candidate, of: "sampled" | "pooled") => new Set(gold.items.filter((it) => it[of].includes(c)).map((it) => itemKey(it.id, it)));
  return new Map(ALL.map((c, i) => [c, { sample: keysIn(c, "sampled"), pooled: keysIn(c, "pooled"), labels: rec.labels[i], fresh: rec.fresh[i], measured: rec.measured[i] }]));
}

/** The decision a snapshot and the grades make. */
export function decisionOf(snap: Snapshot, graded: ReadonlyMap<string, Item>): Decision {
  const items = (keys: Set<string>) => [...keys].map((k) => graded.get(k)).filter((x): x is Item => x !== undefined);
  return decide(
    (c) => {
      const sn = snap.get(c)!, g = items(sn.sample);
      return { candidate: c, labels: sn.labels, fresh: sn.fresh, sampled: sn.sample.size, graded: g.length, wrong: g.filter((x) => x.grade === "wrong").length, useful: g.filter((x) => x.grade === "useful").length, measured: sn.measured };
    },
    (c) => { const p = items(snap.get(c)!.pooled); return { graded: p.length, wrong: p.filter((x) => x.grade === "wrong").length }; },
  );
}

/** The decision the gold records; null when it records none. */
export function recordedDecision(gold: Gold): Decision | null {
  const snap = snapshotOfGold(gold);
  return snap && decisionOf(snap, new Map(gold.items.map((it) => [itemKey(it.id, it), it])));
}

/**
 * How one candidate's live snapshot differs from the recorded one: `evidence`
 * counts what the conditions read (sample and pooled items, the measured
 * case), `counts` what only the estimates read (labels, fresh).
 */
export type Drift = { candidate: Candidate; sampleIn: number; sampleOut: number; pooledIn: number; pooledOut: number; labels: [number, number]; fresh: [number, number]; measured: [boolean, boolean]; evidence: number; counts: number };
export function driftOf(rec: Snapshot, live: Snapshot): Drift[] {
  const minus = (a: Set<string>, b: Set<string>) => [...a].filter((k) => !b.has(k)).length;
  return ALL.map((c) => {
    const r = rec.get(c)!, l = live.get(c)!;
    const d = { candidate: c, sampleIn: minus(l.sample, r.sample), sampleOut: minus(r.sample, l.sample), pooledIn: minus(l.pooled, r.pooled), pooledOut: minus(r.pooled, l.pooled), labels: [r.labels, l.labels] as [number, number], fresh: [r.fresh, l.fresh] as [number, number], measured: [r.measured, l.measured] as [boolean, boolean] };
    return { ...d, evidence: d.sampleIn + d.sampleOut + d.pooledIn + d.pooledOut + Number(r.measured !== l.measured), counts: Number(r.labels !== l.labels) + Number(r.fresh !== l.fresh) };
  });
}

/** The decision's tables, as the README carries them. */
function printDecision(d: Decision, listWrong: (c: Candidate) => string[]) {
  const pct = (n: number, of: number) => (of ? (n / of).toFixed(3) : "—");
  const row = ({ t, v }: { t: Tally; v: Verdict }, held: boolean) => {
    const p = d.pooled.get(t.candidate)!;
    return `| ${t.candidate} | ${t.measured ? "yes" : "no"} | ${t.sampled} | ${t.graded} | ${t.wrong} | ${t.useful} | ${pct(t.graded - t.wrong, t.graded)} | ${pct(t.useful, t.graded)} | ${held ? `${p.graded} | ${p.wrong} | ` : ""}${v.estimate.toFixed(0)} | ${v.estimateFresh.toFixed(0)} | ${v.ok ? "yes" : `no — ${v.why.join("; ")}`} |`;
  };
  console.log("\n## The first registration\n");
  console.log("| candidate | (a) measured | sampled | graded | wrong | useful | precision | useful share | est. useful labels | est. (unsuperseded) | qualifies |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const x of d.first) console.log(row(x, false));
  console.log("\n| candidate | graded among all its labels | wrong | precision |");
  console.log("|---|---|---|---|");
  for (const c of ALL) {
    const p = d.pooled.get(c)!;
    console.log(`| ${c} | ${p.graded} | ${p.wrong} | ${pct(p.graded - p.wrong, p.graded)} |`);
    for (const w of listWrong(c)) console.log(`  wrong: ${w}`);
  }
  const fp = d.firstPick;
  console.log(`\nThe first registration's pick: ${fp ? `${fp} (pooled precision ${pct(d.pooled.get(fp)!.graded - d.pooled.get(fp)!.wrong, d.pooled.get(fp)!.graded)})` : "none"}`);
  const heldHead = "| candidate | (a) measured | held-out sampled | graded | wrong | useful | precision | useful share | pooled graded | pooled wrong | est. useful labels | est. (unsuperseded) | qualifies |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  console.log(`\n## The second registration (held-out sample, lag ${LAG_MS / 60000} min)\n\n${heldHead}`);
  for (const x of d.second) console.log(row(x, true));
  if (d.second.every((x) => x.t.sampled === 0)) console.log("\nClosed: its pooled precision failed before its held-out sample was graded, so the sample is not.");
  console.log(`\n## The third registration (held-out sample, settled within ${LAG_MS / 60000} min)\n\n${heldHead}`);
  for (const x of d.third) console.log(row(x, true));
  console.log(`\nChosen: ${d.chosen ?? "none — the label does not ship as specified"}`);
}


// ── The measurement ──────────────────────────────────────────────────────────

type Row = { id: string; content: string; stored: number; supersedes: string | null; lifecycle: boolean; superseded: boolean };
const isSummary = (content: string) => content.startsWith("Session summary — ");
const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** What a grader reads of a thought: its opening, and ±EXCERPT characters around every mention of the labelled tickets, merged; the hook's session line. */
const EXCERPT = 300;
export function excerpt(content: string, keys: ReadonlySet<string>): string {
  const spans: [number, number][] = [[0, Math.min(content.length, EXCERPT)]];
  for (const m of mentionsOf(content)) if (keys.has(m.key)) spans.push([Math.max(0, m.start - EXCERPT), Math.min(content.length, m.end + EXCERPT)]);
  const session = [...content.matchAll(/^Session [0-9a-f-]{36}, .*$/gm)].at(-1);
  if (session) spans.push([session.index!, session.index! + session[0].length]);
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of spans) { const last = merged.at(-1); if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else merged.push([...s]); }
  return merged.map(([a, b]) => content.slice(a, b)).join("\n[…]\n");
}
const claimText = (l: Label) => l.kind === "moved"
  ? `When this thought's content was written, ${l.key} was ${l.claim.name}; it is now ${l.now.name}.`
  : `This thought states ${l.key} is ${l.claim.name}; it is now ${l.now.name}.`;

async function measure(url: string, dumpPath: string | undefined) {
  // A startup parameter, so it holds on every connection the pool opens.
  const sql = new SQL({ url, max: 1, connection: { default_transaction_read_only: "on" } });

  const [types] = await sql`SELECT node_lifecycle_types() AS known`;
  const known = new Set<string>(types.known);
  const heads = new Map<string, Status>();
  const vocabulary = new Map<string, string>();
  for (const h of await sql`SELECT issue, status, status_type FROM ob1_ticket_head`) {
    if (!known.has(h.status_type) || !h.status) continue;
    heads.set(h.issue, { name: h.status, type: h.status_type });
    vocabulary.set(String(h.status).toLowerCase(), h.status_type);
  }
  if (vocabulary.has("canceled")) vocabulary.set("cancelled", "canceled");

  // The log's order is 060's one copy of it (ob1_thought_events_in_order: by
  // seq since 050, by (created_at, seq) before), kept through WITH ORDINALITY;
  // statusAt reads the last event in that order at or before a time.
  const timelines = new Map<string, Change[]>();
  for (const e of await sql`
      SELECT x.md->>'issue' AS issue, (extract(epoch FROM a.created_at) * 1000)::float8 AS at, x.md->>'status' AS status, x.md->>'status_type' AS type
        FROM ob1_thought_events_in_order(NULL) WITH ORDINALITY AS a
        CROSS JOIN LATERAL (SELECT coalesce(a.diff #> '{metadata,after}', CASE WHEN a.action = 'capture' THEN a.diff -> 'metadata' END) AS md) x
       WHERE a.action IN ('capture', 'update') AND a.diff ? 'metadata' AND x.md ? 'issue' AND x.md ? 'status' AND x.md ? 'status_type'
       ORDER BY a.ordinality`) {
    if (!known.has(e.type)) continue;
    const list = timelines.get(e.issue) ?? [];
    list.push({ at: Number(e.at), name: e.status, type: e.type });
    timelines.set(e.issue, list);
  }

  const rows: Row[] = (await sql`
      SELECT t.id::text AS id, t.content, (extract(epoch FROM t.created_at) * 1000)::float8 AS stored, t.supersedes::text AS supersedes,
             n.open IS NOT NULL AS lifecycle, n.superseded_by IS NOT NULL AS superseded
        FROM thoughts t JOIN node_state(NULL) n ON n.thought_id = t.id`).map((r: Row) => ({ ...r, stored: Number(r.stored) }));
  await sql.close();
  const chain = new Map<string, ChainRow>(rows.map((r) => [r.id, { created: r.stored, supersedes: r.supersedes }]));

  const reading = (r: Row): Reading => ({
    content: r.content, stored: r.stored, chainRoot: chainRoot(r.id, chain) ?? r.stored,
    head: (k) => heads.get(k), timeline: (k) => timelines.get(k) ?? [], vocabulary,
  });

  // Every candidate over every row. The guard is the caller's: a row with a
  // lifecycle is skipped, and what the candidate would have said of it is only
  // counted, to show the guard's reach.
  const per = new Map<Candidate, { id: string; label: Label; row: Row }[]>(ALL.map((c) => [c, []]));
  const lifecycleWouldLabel = new Map<Candidate, number>(ALL.map((c) => [c, 0]));
  const noHistory = new Map<Candidate, number>(ALL.map((c) => [c, 0]));
  for (const r of rows) {
    const rd = reading(r);
    for (const c of ALL) {
      const ls = labelsOf(c, rd);
      if (r.lifecycle) { if (ls.length) lifecycleWouldLabel.set(c, lifecycleWouldLabel.get(c)! + 1); continue; }
      for (const l of ls) per.get(c)!.push({ id: r.id, label: l, row: r });
      if (c.startsWith("moved-") && c !== "moved-session-stated") {
        const written = writtenAt(c, rd);
        for (const k of keysOf(mentionsOf(r.content), ["key", "list"])) if (heads.has(k) && !statusAt(rd.timeline(k), written)) noHistory.set(c, noHistory.get(c)! + 1);
      }
    }
  }
  const lifecycleLess = rows.filter((r) => !r.lifecycle);
  console.log(`\nThe corpus: ${rows.length} thoughts, ${lifecycleLess.length} with no lifecycle of their own (${lifecycleLess.filter((r) => isSummary(r.content)).length} session summaries), ${heads.size} ticket heads, ${timelines.size} tickets with a status history.`);

  console.log("\n## The census\n");
  console.log("| candidate | thoughts | labels | summaries | other | superseded | tickets/thought max (p90) | no history at written | lifecycle rows it would label |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const c of ALL) {
    const ls = per.get(c)!;
    const byThought = new Map<string, number>();
    for (const x of ls) byThought.set(x.id, (byThought.get(x.id) ?? 0) + 1);
    const counts = [...byThought.values()].sort((a, b) => a - b);
    const p90 = counts.length ? counts[Math.min(counts.length - 1, Math.floor(counts.length * 0.9))] : 0;
    const summ = ls.filter((x) => isSummary(x.row.content)).length;
    console.log(`| ${c} | ${byThought.size} | ${ls.length} | ${summ} | ${ls.length - summ} | ${ls.filter((x) => x.row.superseded).length} | ${counts.at(-1) ?? 0} (${p90}) | ${c.startsWith("moved-") && c !== "moved-session-stated" ? noHistory.get(c) : "—"} | ${lifecycleWouldLabel.get(c)} |`);
  }

  // The live samples, and what the gold says of them.
  // Only a missing gold is "no gold yet"; a malformed one stops the run, never
  // turning into a live verdict.
  let gold: Gold = { items: [], rounds: [], recorded: null };
  if (existsSync(GOLD_PATH)) gold = readGold();
  else console.log(`\n(no gold yet: ${GOLD_PATH})`);
  const graded = new Map(gold.items.map((it) => [itemKey(it.id, it), it]));
  const firstGraded = new Set(gold.items.filter((it) => it.round <= FIRST_ROUNDS).map((it) => itemKey(it.id, it)));
  const live = new Map<Candidate, { tally: Tally; sample: string[]; keys: Set<string> }>();
  const toGrade = new Map<string, { id: string; label: Label; row: Row }>();
  for (const c of ALL) {
    const ls = per.get(c)!;
    const fresh = ls.filter((x) => !x.row.superseded);
    const isSecond = (SECOND as readonly Candidate[]).includes(c), isThird = (THIRD as readonly Candidate[]).includes(c);
    const sample = isSecond ? sampleOf(fresh, SAMPLE, HELD_OUT_SALT, firstGraded) : isThird ? sampleOf(fresh, SAMPLE, HELD_OUT_SALT_3, firstGraded) : sampleOf(fresh);
    const byKey = new Map(fresh.map((x) => [labelKey(x.id, x.label), x]));
    // The second registration is closed — its pooled precision failed before
    // its held-out sample was graded — so nothing of its sample is dumped.
    if (!isSecond) for (const k of sample) if (!graded.has(k)) toGrade.set(k, byKey.get(k)!);
    const g = sample.map((k) => graded.get(k)).filter((x): x is Item => x !== undefined);
    const measured = ls.some((x) => x.id === MEASURED && x.label.key === MEASURED_KEY && x.label.claim.type === "started" && x.label.now.type === "completed");
    live.set(c, {
      tally: { candidate: c, labels: ls.length, fresh: fresh.length, sampled: sample.length, graded: g.length, wrong: g.filter((x) => x.grade === "wrong").length, useful: g.filter((x) => x.grade === "useful").length, measured },
      sample: isSecond ? [] : sample, keys: new Set(ls.map((x) => labelKey(x.id, x.label))),
    });
  }
  const liveSnap: Snapshot = new Map(ALL.map((c) => {
    const l = live.get(c)!;
    return [c, { sample: new Set(l.sample), pooled: new Set([...l.keys].filter((k) => graded.has(k))), labels: l.tally.labels, fresh: l.tally.fresh, measured: l.tally.measured }];
  }));
  const wrongOf = (c: Candidate, inSet: (it: Item) => boolean) => process.argv.includes("--list-wrong")
    ? gold.items.filter((it) => inSet(it) && it.grade === "wrong").map((x) => `${x.id.slice(0, 8)} ${x.key} ${x.kind} ${x.claim} → ${x.now}`) : [];

  // The verdict is the gold's: what it recorded when the verdict was read. A
  // live run says how far the brain has moved from that record, and never
  // turns drift into a verdict.
  const rec = recordedDecision(gold);
  if (rec) {
    console.log(`\nThe verdict as recorded on ${gold.recorded!.generated} (from the gold; a live run does not re-decide it):`);
    printDecision(rec, (c) => wrongOf(c, (it) => it.pooled.includes(c)));
    console.log("\n## Drift since the record\n");
    console.log("| candidate | sample items in / out | graded pooled items in / out | labels | fresh | measured |");
    console.log("|---|---|---|---|---|---|");
    const drift = driftOf(snapshotOfGold(gold)!, liveSnap);
    const yn = (b: boolean) => (b ? "yes" : "no");
    for (const d of drift) console.log(`| ${d.candidate} | ${d.sampleIn} / ${d.sampleOut} | ${d.pooledIn} / ${d.pooledOut} | ${d.labels[0]} → ${d.labels[1]} | ${d.fresh[0]} → ${d.fresh[1]} | ${yn(d.measured[0])} → ${yn(d.measured[1])} |`);
    const evidence = drift.some((d) => d.evidence), counts = drift.some((d) => d.counts);
    console.log(evidence ? "\nThe brain has moved since the record in what the verdict read (samples, graded pools or the measured case). The recorded verdict stands: its registrations are closed, and a new registration records its own evidence."
      : counts ? "\nThe brain has moved since the record in counts only (labels, fresh), which the estimates read and no condition does. The recorded verdict stands."
      : "\nThe live run matches the record.");
  } else {
    console.log("\n(the gold records no verdict yet: deciding from the live samples)");
    printDecision(decisionOf(liveSnap, graded), (c) => wrongOf(c, (it) => live.get(c)!.keys.has(itemKey(it.id, it))));
  }
  if (gold.rounds.length) for (const [i, r] of gold.rounds.entries()) console.log(`Round ${i + 1} (${r.generated}): raw agreement ${r.agreement.raw.toFixed(3)}, kappa ${r.agreement.kappa.toFixed(3)}, ${r.agreement.adjudicated} adjudicated`);
  console.log(`Ungraded live sample labels: ${toGrade.size}`);

  if (dumpPath) {
    // One entry per thought, its labels numbered; the grader sees no candidate.
    const byThought = new Map<string, { row: Row; labels: { item: string; label: Label }[] }>();
    for (const [k, x] of toGrade) {
      const e = byThought.get(x.id) ?? { row: x.row, labels: [] };
      e.labels.push({ item: k, label: x.label });
      byThought.set(x.id, e);
    }
    const out = [...byThought.values()].map(({ row, labels }) => {
      const keys = new Set(labels.map((l) => l.label.key));
      return {
        thought: row.id,
        stored: day(row.stored),
        excerpt: excerpt(row.content, keys),
        histories: Object.fromEntries([...keys].map((k) => [k, (timelines.get(k) ?? []).filter((c, i, a) => i === 0 || a[i - 1].name !== c.name).map((c) => `${day(c.at)} ${c.name}`)])),
        labels: labels.map((l) => ({ item: l.item, claim: claimText(l.label) })),
      };
    });
    writeFileSync(dumpPath, JSON.stringify(out, null, 1));
    console.log(`Wrote ${toGrade.size} labels on ${out.length} thoughts to ${dumpPath}`);
  }
}

// ── Self-check (no database) ─────────────────────────────────────────────────

function selfCheck() {
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, what: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) { failed++; failures.push(what); } };
  const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };

  // Keys, list steps, bare numbers.
  const dd = "- **v1.7.0:** the cutover (SMD-2287, 2286, 2382, 2306; 2306 is in progress).";
  const m = mentionsOf(dd);
  ok(m.map((x) => `${x.key}:${x.how}`).join() === "SMD-2287:key,SMD-2286:list,SMD-2382:list,SMD-2306:list,SMD-2306:bare", "dd70dccc's list: one key, three list steps, and the bare 2306 after the semicolon repeats SMD-2306");
  ok(keysOf(m, ["key"]).join() === "SMD-2287" && keysOf(m).join() === "SMD-2286,SMD-2287,SMD-2306,SMD-2382", "keysOf: the key alone, or every reading, each once, sorted");
  ok(keysOf(mentionsOf("SMD-2287, 2026-10-03 and SMD-1234, 42 tests, SMD-100/101, v1.2306")).join() === "SMD-100,SMD-101,SMD-1234,SMD-2287", "no list step into a date, a shorter number or a version; a slash step taken");
  ok(keysOf(mentionsOf("SMD-2448 → 2449 → 2261 and 2424 or 1794")).join() === "SMD-1794,SMD-2261,SMD-2424,SMD-2448,SMD-2449", "arrows, and, or step a list");
  ok(keysOf(mentionsOf("PR #2306 merged; SMD-2306x and xSMD-2306 are not keys")).length === 0, "a PR number and key-shaped words name no ticket");
  ok(mentionsOf("SMD-2306 shipped in PR #2306 and 2306 is done").filter((x) => x.how === "bare").map((x) => x.start).join() === "33", "a PR number is no bare repeat of the key it shares a number with; a plain 2306 is");
  ok(mentionsOf("SMD-12 and ABC-12; then 12 is done").filter((x) => x.how === "bare").length === 0, "a bare number two teams share is left unread");
  ok(mentionsOf("SMD-77 then 1977 and 77.5 and 77").filter((x) => x.how === "bare").map((x) => x.start).join() === "30", "a bare number is a whole token: not inside 1977, not a version");

  // When it was written.
  const line = "x\nSession 3a5c3458-9a28-4681-8812-16209c1209ba, 2026-10-02 21:54 → 2026-10-03 03:02.";
  ok(sessionEnd(line) === Date.parse("2026-10-03T03:02:59.999Z"), "sessionEnd: the last second of the end minute, UTC");
  ok(sessionEnd("Session 3a5c3458-9a28-4681-8812-16209c1209ba, 2026-10-02 21:54 → 2026-10-03 03:02. trailing") === undefined && sessionEnd("no line") === undefined, "sessionEnd: only the hook's whole line");
  ok(sessionEnd(`${line}\nSession 3a5c3458-9a28-4681-8812-16209c1209ba, 2026-10-04 01:00 → 2026-10-04 02:00.`) === Date.parse("2026-10-04T02:00:59.999Z"), "sessionEnd: the last such line wins");
  const ch = new Map<string, ChainRow>([["c", { created: 30, supersedes: "b" }], ["b", { created: 20, supersedes: "a" }], ["a", { created: 10, supersedes: null }], ["x", { created: 5, supersedes: "y" }], ["y", { created: 6, supersedes: "x" }]]);
  ok(chainRoot("c", ch) === 10 && chainRoot("a", ch) === 10 && chainRoot("x", ch) === 5 && chainRoot("q", ch) === undefined, "chainRoot: the oldest stored time along the chain; a cycle ends; an unknown id has none");

  // Status at a time; the stated status.
  const tl: Change[] = [{ at: 100, name: "Backlog", type: "backlog" }, { at: 200, name: "In Progress", type: "started" }, { at: 300, name: "Done", type: "completed" }];
  ok(statusAt(tl, 99) === undefined && statusAt(tl, 100)?.name === "Backlog" && statusAt(tl, 250)?.type === "started" && statusAt(tl, 9e9)?.type === "completed", "statusAt: undefined before the first change, the last at or before t after");
  const inverted: Change[] = [{ at: 100, name: "Backlog", type: "backlog" }, { at: 300, name: "Done", type: "completed" }, { at: 200, name: "In Progress", type: "started" }];
  ok(statusAt(inverted, 250)?.name === "In Progress" && statusAt(inverted, 400)?.name === "In Progress", "statusAt reads the log's order, not time order: a later event whose clock is earlier still wins (060's rule), and no early stop skips it");
  const vocab = new Map([["backlog", "backlog"], ["in progress", "started"], ["done", "completed"], ["canceled", "canceled"], ["cancelled", "canceled"]]);
  ok(statedAfter(dd, dd.indexOf("2306 is") + 4, vocab)?.type === "started", "statedAfter: `2306 is in progress` states started");
  ok(statedAfter(dd, dd.indexOf("2306;") + 4, vocab) === undefined, "statedAfter: a clause end stops the window");
  ok(statedAfter("SMD-1 is In\nProgress", 5, vocab) === undefined && statedAfter("SMD-1 is In  Progress", 5, vocab)?.type === "started", "statedAfter: a two-word name may space out, not across a line");
  ok(statedAfter("SMD-1 is not abandoned and undone", 5, vocab) === undefined, "statedAfter: whole words only (undone is not done)");
  ok(statedAfter(`SMD-1 ${"x".repeat(70)} done`, 5, vocab) === undefined, "statedAfter: nothing past STATED_SPAN");

  // The candidates.
  const heads = new Map<string, Status>([["SMD-2306", { name: "Done", type: "completed" }], ["SMD-2287", { name: "In Progress", type: "started" }], ["SMD-2286", { name: "Backlog", type: "backlog" }], ["SMD-2382", { name: "Done", type: "completed" }]]);
  const tls = new Map<string, Change[]>([
    ["SMD-2306", [{ at: 100, name: "Backlog", type: "backlog" }, { at: 200, name: "In Progress", type: "started" }, { at: 400, name: "Done", type: "completed" }]],
    ["SMD-2287", [{ at: 100, name: "In Progress", type: "started" }]],
    ["SMD-2382", [{ at: 450, name: "Done", type: "completed" }]],
  ]);
  const rd = (content: string, stored: number, root = stored): Reading => ({ content, stored, chainRoot: root, head: (k) => heads.get(k), timeline: (k) => tls.get(k) ?? [], vocabulary: vocab });
  const sess = (end: string) => `${dd}\nSession 3a5c3458-9a28-4681-8812-16209c1209ba, 2026-10-02 21:54 → ${end}.`;
  const T = (iso: string) => Date.parse(iso);
  const tlsReal = new Map<string, Change[]>([["SMD-2306", [{ at: T("2026-10-01T12:00:00Z"), name: "Backlog", type: "backlog" }, { at: T("2026-10-02T21:53:00Z"), name: "In Progress", type: "started" }, { at: T("2026-10-04T14:47:00Z"), name: "Done", type: "completed" }]]]);
  const real = (content: string, stored: number, root = stored): Reading => ({ ...rd(content, stored, root), timeline: (k) => tlsReal.get(k) ?? [] });
  const stored10_08 = T("2026-10-08T11:47:00Z"), root10_03 = T("2026-10-03T03:02:14Z");
  const has2306 = (ls: Label[]) => ls.some((l) => l.key === "SMD-2306" && l.claim.type === "started" && l.now.type === "completed");
  ok(!has2306(labelsOf("moved-stored", real(sess("2026-10-03 03:02"), stored10_08, root10_03))), "the measured case: moved-stored reads 10-08, when SMD-2306 was already Done — no label");
  ok(has2306(labelsOf("moved-chain", real(sess("2026-10-03 03:02"), stored10_08, root10_03))) && has2306(labelsOf("moved-session", real(sess("2026-10-03 03:02"), stored10_08))), "the measured case: moved-chain and moved-session read 10-03 — In Progress then, Done now");
  ok(has2306(labelsOf("moved-session-stated", real(sess("2026-10-03 03:02"), stored10_08))), "moved-session-stated keeps SMD-2306: its bare repeat is followed by a stated status");
  ok(!labelsOf("moved-session-stated", real(sess("2026-10-03 03:02"), stored10_08)).some((l) => l.key === "SMD-2287") && labelsOf("moved-stored", rd(dd, 500)).every((l) => l.key !== "SMD-2287"), "moved-session-stated drops a ticket the text says nothing of; an unmoved ticket is never labelled");
  ok(has2306(labelsOf("stated-lists", rd(dd, 0))) && !has2306(labelsOf("stated-keys", rd(dd, 0))), "stated-lists reads the bare 2306's in progress; stated-keys, keys alone, cannot");
  ok(labelsOf("moved-stored", rd(dd, 50)).length === 0, "no history at the written time: no label (every ticket's first event is later than 50)");
  ok(labelsOf("stated-keys", rd("SMD-2306 is done; SMD-2287 is in progress", 0)).length === 0, "stated statuses that match now carry no label (the drop-the-comparison mutant labels both)");
  const twice = labelsOf("stated-keys", rd("SMD-2306 is backlog. SMD-2306 is in progress", 0));
  ok(twice.length === 1 && twice[0].claim.type === "backlog", "stated-*: one label per ticket, the first contradicting mention's");
  const quoted = "It says SMD-2286 is In Progress. In fact it is not.";
  ok(labelsOf("stated-keys", rd(quoted, 0)).map((l) => l.key).join() === "SMD-2286", "the reported-speech trap, by construction: stated-* reads `It says SMD-2286 is In Progress` as the thought's own claim (the gold grades it wrong)");

  // The sample and the verdict.
  ok(fnv1a("") === 0x811c9dc5 && fnv1a("a") === 0xe40c292c, "fnv1a: the published 32-bit vectors");
  const lbl = (key: string): Label => ({ key, kind: "moved", claim: { name: "In Progress", type: "started" }, now: { name: "Done", type: "completed" } });
  const many = Array.from({ length: 50 }, (_, i) => ({ id: "00000000-0000-4000-8000-0000000000" + String(i).padStart(2, "0"), label: lbl("SMD-1") }));
  const s1 = sampleOf(many), s2 = sampleOf([...many].reverse());
  ok(s1.length === SAMPLE && s1.join() === s2.join(), "sampleOf: SAMPLE items, the same whatever the input order");
  const t = (c: Candidate, over: Partial<Tally>): Tally => ({ candidate: c, labels: 100, fresh: 50, sampled: 30, graded: 30, wrong: 0, useful: 20, measured: true, ...over });
  ok(judge(t("moved-session", {})).ok && judge(t("moved-session", { wrong: 1 })).ok && !judge(t("moved-session", { wrong: 2 })).ok, "(b): 29/30 qualifies (0.967), 28/30 does not (0.933)");
  ok(!judge(t("moved-session", { graded: 29 })).ok && !judge(t("moved-session", { measured: false })).ok, "(b) every sampled label graded; (a) the measured case");
  ok(judge(t("moved-session", { useful: 15 })).ok && !judge(t("moved-session", { useful: 14 })).ok, "(c): half the graded labels useful qualifies, under half does not");
  ok(judge(t("moved-session", { sampled: 20, graded: 20, wrong: 1, useful: 10 })).ok, "(b) at the line: 19 of 20 (0.950) qualifies");
  ok(Math.abs(judge(t("moved-session", { labels: 90, useful: 20 })).estimate - 60) < 1e-9, "the estimate: labels × useful share");
  const vs = (xs: [Candidate, number][]) => xs.map(([c, labels]) => judge(t(c, { labels })));
  ok(pick(vs([["moved-session", 100], ["stated-lists", 119]])) === "moved-session" && pick(vs([["moved-session", 100], ["stated-lists", 120]])) === "stated-lists", "pick: a stated-* candidate needs STATED_MARGIN over the best moved-*");
  const whole = (xs: [Candidate, number][]) => xs.map(([c, labels]) => judge(t(c, { labels, useful: 30 })));
  ok(pick(whole([["moved-session", 100], ["stated-lists", 120]])) === "stated-lists" && pick(whole([["moved-session", 100], ["stated-lists", 119]])) === "moved-session", "pick: exactly STATED_MARGIN over is enough, on estimates with no rounding (useful share 1)");
  ok(pick(vs([["moved-chain", 100], ["moved-session", 100]])) === "moved-chain" && pick(vs([["moved-chain", 100], ["moved-session", 101]])) === "moved-session", "pick: the most estimated useful labels; a tie keeps the earlier");
  ok(pick([judge(t("moved-session", { measured: false }))]) === null && pick([judge(t("stated-keys", {}))]) === "stated-keys", "pick: none qualifying is null; a stated-* alone qualifying is chosen");
  // The second registration.
  const lagged = sess("2026-10-04 14:00");
  ok(has2306(labelsOf("moved-session", real(lagged, stored10_08))) && !has2306(labelsOf("moved-session-lag", real(lagged, stored10_08))), "moved-session-lag: a move 47 minutes after the session's end is taken as the note's own — no label; moved-session labels it");
  ok(has2306(labelsOf("moved-session-lag", real(sess("2026-10-03 03:02"), stored10_08))), "moved-session-lag keeps the measured case: SMD-2306 moved a day after the 10/3 session");
  ok(writtenAt("moved-session-lag", { content: "no line", stored: 5, chainRoot: 1 }) === 5 + LAG_MS && writtenAt("moved-chain", { content: line, stored: 5, chainRoot: 1 }) === 1, "writtenAt: the lag on the stored time when there is no session line; moved-chain reads the chain's root");
  // The third: "then" at the written time; no label when the ticket already held its current type an hour after.
  ok(!has2306(labelsOf("moved-session-settled", real(lagged, stored10_08))) && has2306(labelsOf("moved-session-settled", real(sess("2026-10-03 03:02"), stored10_08))), "moved-session-settled: Done 47 minutes after the session is the writer's own move — no label; the measured case keeps its label");
  const tlsMid = new Map<string, Change[]>([["SMD-2306", [{ at: T("2026-10-01T12:00:00Z"), name: "Backlog", type: "backlog" }, { at: T("2026-10-02T22:00:00Z"), name: "In Progress", type: "started" }, { at: T("2026-10-04T14:47:00Z"), name: "Done", type: "completed" }]]]);
  const mid = (content: string): Reading => ({ ...rd(content, stored10_08), timeline: (k) => tlsMid.get(k) ?? [] });
  const midLabel = labelsOf("moved-session-settled", mid(sess("2026-10-02 21:59"))).find((l) => l.key === "SMD-2306");
  ok(midLabel?.claim.type === "backlog" && labelsOf("moved-session-lag", mid(sess("2026-10-02 21:59"))).find((l) => l.key === "SMD-2306")?.claim.type === "started", "a move within the hour to a status that is not the current one: settled keeps the written time's Backlog, lag would claim the later In Progress");
  ok(sampleOf(many, SAMPLE, HELD_OUT_SALT_3)[0] === "00000000-0000-4000-8000-000000000042|SMD-1|moved|started|completed", "the third's salt is the one its sample was drawn with (its first item, pinned)");
  ok(excerpt(`x\nSession 3a5c3458-9a28-4681-8812-16209c1209ba, 2026-10-01 00:00 → 2026-10-01 01:00.\n${"y".repeat(400)}\nSession 3a5c3458-9a28-4681-8812-16209c1209ba, 2026-10-02 00:00 → 2026-10-02 01:00.`, new Set()).includes("2026-10-02 01:00"), "the grader's excerpt shows the session line sessionEnd reads: the last");
  ok(sampleOf(many, SAMPLE, HELD_OUT_SALT_3).join() !== s1.join() && sampleOf(many, SAMPLE, HELD_OUT_SALT_3).join() !== sampleOf(many, SAMPLE, HELD_OUT_SALT).join(), "each salt orders the sample its own way, with nothing excluded");
  // A ticket whose status NAME changed within the hour but whose type is already the current one is settled.
  const tlsType = new Map<string, Change[]>([["SMD-2306", [{ at: T("2026-10-01T12:00:00Z"), name: "Backlog", type: "backlog" }, { at: T("2026-10-03T03:30:00Z"), name: "In Review", type: "started" }]]]);
  const headsType = new Map<string, Status>([["SMD-2306", { name: "In Progress", type: "started" }]]);
  const typed = (content: string): Reading => ({ ...rd(content, stored10_08), head: (k) => headsType.get(k), timeline: (k) => tlsType.get(k) ?? [] });
  ok(labelsOf("moved-session-settled", typed(sess("2026-10-03 03:02"))).length === 0 && labelsOf("moved-session", typed(sess("2026-10-03 03:02"))).length === 1, "moved-session-settled compares status types: In Review within the hour already holds In Progress's type — no label");
  const excl = new Set(s1.slice(0, 5));
  const h1 = sampleOf(many, SAMPLE, HELD_OUT_SALT, excl);
  ok(h1.length === SAMPLE && h1.every((k) => !excl.has(k)) && h1.join() !== s1.join(), "the held-out sample: another hash order, none of the excluded items");
  ok(!judgeHeldOut(t("moved-session-lag", {}), { graded: 0, wrong: 0 }).ok, "judgeHeldOut: nothing pooled is no evidence");
  ok(judgeHeldOut(t("moved-session-lag", {}), { graded: 60, wrong: 3 }).ok && !judgeHeldOut(t("moved-session-lag", {}), { graded: 60, wrong: 4 }).ok && !judgeHeldOut(t("moved-session-lag", { wrong: 2 }), { graded: 60, wrong: 2 }).ok, "judgeHeldOut: pooled 57/60 qualifies, 56/60 does not; the held-out (b) still applies");
  ok(kappa([["useful", "useful"], ["noise", "noise"]]).kappa === 1 && kappa([]).n === 0, "kappa: perfect agreement is 1; no items is none");

  // The gold.
  ok(throws(() => readGold(join(HERE, "fixtures", "no-such-gold.json"))), "readGold refuses a missing file");
  ok(existsSync(GOLD_PATH), "the gold is committed");
  if (existsSync(GOLD_PATH)) {
    const g = readGold();
    ok(g.items.every((it) => it.grade === it.a || it.grade === it.b), "every kept grade is one grader's — adjudication picks, it does not invent");
    ok(new Set(g.items.map((it) => itemKey(it.id, it))).size === g.items.length, "no item graded twice");
    const gradeOf = (id: string, key: string, kind: Label["kind"], claim: string, now: string) => g.items.find((it) => itemKey(it.id, it) === itemKey(id, { key, kind, claim, now }))?.grade;
    ok(gradeOf("c702157d-8e4a-4f1a-83ed-3c0b73ccfac9", "SMD-2284", "stated", "backlog", "completed") === "wrong"
      && gradeOf("1f6578b3-7332-47cd-b275-23b6c5e18211", "SMD-1998", "moved", "started", "completed") === "wrong"
      && gradeOf(MEASURED, MEASURED_KEY, "stated", "started", "completed") === "useful",
      "the gold means what it says: reported speech (c702157d) and the writer's own move ahead of the sync (1f6578b3) are wrong; the measured case's `2306 is in progress` is useful");
    for (const [i, r] of g.rounds.entries()) {
      const its = g.items.filter((it) => it.round === i + 1);
      const k = kappa(its.map((it) => [it.a, it.b]));
      ok(Math.abs(r.agreement.raw - k.raw) < 1e-9 && Math.abs(r.agreement.kappa - k.kappa) < 1e-9 && r.agreement.adjudicated === its.filter((it) => it.a !== it.b).length,
        `round ${i + 1}: the recorded agreement is the graders' own (${its.length} items, raw ${k.raw.toFixed(3)}, kappa ${k.kappa.toFixed(3)})`);
    }
    // The recorded verdict, from the gold alone: what the README and the header report.
    const d = recordedDecision(g);
    const row = (xs: { t: Tally }[], c: Candidate) => xs.find((x) => x.t.candidate === c)!.t;
    const third = d && row(d.third, "moved-session-settled"), ms = d && row(d.first, "moved-session");
    ok(d !== null && d.chosen === "moved-session-settled" && d.firstPick === "moved-session" && !d.second[0].v.ok, "the recorded verdict: the third registration chooses moved-session-settled; the first picked moved-session; the second is closed");
    ok(third !== null && third.sampled === 30 && third.wrong === 1 && third.useful === 21 && d!.pooled.get("moved-session-settled")!.graded === 84 && d!.pooled.get("moved-session-settled")!.wrong === 2 && third.labels === 742,
      "the recorded numbers: held out 1 of 30 wrong, 21 useful; pooled 2 of 84 wrong; 742 labels");
    const atRound2 = (c: Candidate) => { const p = g.items.filter((it) => it.pooled.includes(c) && it.round <= FIRST_ROUNDS); return { graded: p.length, wrong: p.filter((x) => x.grade === "wrong").length }; };
    const ms2 = atRound2("moved-session"), lag2 = atRound2("moved-session-lag"), set2 = atRound2("moved-session-settled");
    ok(ms !== null && ms.wrong === 0 && ms2.graded === 68 && ms2.wrong === 7, "the first pick, as it was decided at round 2: its own sample clean (0 of 30), its pooled precision not (7 of 68 wrong, 0.897)");
    ok(lag2.graded === 51 && lag2.wrong === 4 && set2.graded === 54 && set2.wrong === 1, "at round 2: the second registration closed on pooled 47 of 51 (0.922); the third's rule was chosen on 53 of 54");
    ok(g.items.every((it) => it.sampled.every((c) => c !== "moved-session-lag")), "the second registration's sample is recorded as never graded");
    const lag = d!.pooled.get("moved-session-lag")!, lagRow = d!.second[0];
    ok(lag.graded === 75 && lag.wrong === 5 && lagRow.v.why.some((w) => w.includes("closed")) && lagRow.v.why.some((w) => w.includes("pooled precision 0.933")), "the second registration in the round-3 record: closed (no sample graded), pooled 70 of 75 (0.933) — still failing, as at round 2");
    ok(third!.fresh === 468 && Math.round(d!.third[0].v.estimateFresh) === 328, "the third's unsuperseded estimate: 468 labels × 0.700 = 328");

    const text = readFileSync(GOLD_PATH, "utf8"), raw = JSON.parse(text);
    const snap = snapshotOfGold(g)!;

    // Drift counts every kind of difference; the same snapshot has none.
    const clone = (f: (sn: Snap, c: Candidate) => Snap) => new Map([...snap].map(([c, sn]) => [c, f({ ...sn, sample: new Set(sn.sample), pooled: new Set(sn.pooled) }, c)]));
    const total = (live: Snapshot) => { const d = driftOf(snap, live); return { evidence: d.reduce((n, x) => n + x.evidence, 0), counts: d.reduce((n, x) => n + x.counts, 0) }; };
    const settledOnly = (f: (sn: Snap) => void) => clone((sn, c) => { if (c === "moved-session-settled") f(sn); return sn; });
    const [inKey] = [...snap.get("moved-session")!.pooled].filter((k) => !snap.get("moved-session-settled")!.pooled.has(k));
    const [outKey] = [...snap.get("moved-session-settled")!.pooled].filter((k) => !snap.get("moved-session-settled")!.sample.has(k));
    const is = (t: { evidence: number; counts: number }, e: number, c: number) => t.evidence === e && t.counts === c;
    ok(is(total(clone((sn) => sn)), 0, 0), "drift: the recorded snapshot against itself has none");
    ok(is(total(settledOnly((sn) => { sn.measured = !sn.measured; })), 1, 0), "drift: a measured flag is evidence");
    ok(is(total(settledOnly((sn) => { sn.labels += 1; })), 0, 1) && is(total(settledOnly((sn) => { sn.fresh -= 1; })), 0, 1), "drift: a label count and a fresh count are counts only");
    ok(is(total(settledOnly((sn) => { sn.pooled.delete(outKey); sn.pooled.add(inKey); })), 2, 0), "drift: a pooled set swapping one item for another, its size unchanged, is evidence, both ways");
    ok(is(total(settledOnly((sn) => { const [k] = sn.sample; sn.sample.delete(k); sn.sample.add(inKey); })), 2, 0), "drift: a sample swapping one item is evidence, both ways");

    // A malformed gold is refused, each way the record can be wrong.
    const dir = mkdtempSync(join(tmpdir(), "stated-status-gold-"));
    try {
      const bad = (what: string, f: (r: any) => void) => {
        const r = JSON.parse(text); f(r);
        const p = join(dir, "gold.json"); writeFileSync(p, JSON.stringify(r));
        ok(throws(() => readGold(p)), `readGold refuses ${what}`);
      };
      const sampledAt = (c: Candidate) => raw.items.findIndex((e: { sampled?: number[] }) => e.sampled?.includes(ALL.indexOf(c)));
      bad("a candidate index out of range", (r) => { r.items[sampledAt("moved-session")].pooled.push(ALL.length); });
      bad("a recorded array of the wrong length", (r) => { r.recorded.labels.pop(); });
      bad("a measured flag that is not 0 or 1", (r) => { r.recorded.measured[0] = 2; });
      bad("another candidate order", (r) => { r.recorded.order += 1; });
      bad("an item in a sample but not its pooled set", (r) => { const e = r.items[sampledAt("moved-session-settled")]; e.pooled = e.pooled.filter((i: number) => i !== ALL.indexOf("moved-session-settled")); });
      bad("a sample of 29", (r) => { const e = r.items[sampledAt("moved-session-settled")]; e.sampled = e.sampled.filter((i: number) => i !== ALL.indexOf("moved-session-settled")); });
      bad("a held-out sample holding a round 1–2 item", (r) => { const e = r.items[sampledAt("moved-session-settled")]; e.round = 1; });
      bad("an item that is not an object", (r) => { r.items.push(null); });
      { const r = JSON.parse(text); r.recorded = null; const p = join(dir, "null.json"); writeFileSync(p, JSON.stringify(r)); ok(readGold(p).recorded === null, "readGold reads `recorded: null` as no record"); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
    // A third that does not qualify chooses nothing.
    ok(decisionOf(snap, new Map(g.items.map((it) => [itemKey(it.id, it), { ...it, grade: "wrong" as Grade }]))).chosen === null, "decide: a third registration that fails chooses none");
  }

  if (failed) { for (const f of failures) console.error(`FAIL ${f}`); console.error(`self-check: ${failed} FAILED`); process.exit(1); }
  console.log("self-check: OK");
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  if (process.argv.includes("--self-check")) selfCheck();
  else {
    const pathAfter = (flag: string) => {
      const i = process.argv.indexOf(flag);
      if (i < 0) return undefined;
      const p = process.argv[i + 1];
      if (p === undefined || p.startsWith("--")) { console.error(`${flag} needs a file path (outside the repo)`); process.exit(2); }
      return p;
    };
    const dump = pathAfter("--dump-ungraded");
    // The dump holds thought text, which no file in the repo may (check 9);
    // and refused before the read, not after it.
    if (dump && (resolve(dump) + "/").startsWith(resolve(HERE, "..") + "/")) { console.error(`--dump-ungraded: ${dump} is inside the repo; write it outside (e.g. a mounted /out)`); process.exit(2); }
    const url = process.env.DATABASE_URL;
    if (!url) { console.error("DATABASE_URL required (from a 0600 env file, never argv) — or --self-check"); process.exit(2); }
    await measure(url, dump);
  }
}
