#!/usr/bin/env bun
/**
 * eval-calibration.ts — was the confidence earned? (SMD-1809)
 *
 * The fork writes a confidence in three places — the consolidation judge on
 * every proposal (migration 029), the entity extractor on every mention and
 * edge (016), and the metadata model's kind band that SMD-1951 froze — and it
 * resolves claims in three: a reviewer accepts or rejects a proposal, a hand
 * label agrees or not with the model's kind, and the fork record confirms or
 * refutes a hypothesis. Nothing compared the two. This harness does, as a READ
 * MODEL over what the log already holds — no table, no migration, no new
 * confidence source — so the first question, "is calibration measurable from
 * the existing log, and is any mechanism systematically over- or
 * under-confident", is answered before anything that would act on the answer
 * is built (the ticket's measure-first posture, SMD-1038's).
 *
 * The ledger: one row per (mechanism, claim, the confidence it carried, the
 * outcome it resolved to, what resolved it). A row with no confidence is
 * UNSCORED, never scored as 0 — the unscorable share is itself a number the
 * report prints, because today it is most of the brain. A row nothing has
 * resolved is UNRESOLVED and counted the same way. Only a row with both sides
 * enters a score.
 *
 * The score, per mechanism: a reliability table (each stated value or band —
 * how many claims, how many held), the Brier score, the expected calibration
 * error, and the Brier skill against the one baseline the ticket asks for, a
 * constant at the base rate, which knows nothing about any claim (skill 0 = no
 * better than that constant; negative = worse). A band maps to a nominal
 * probability (BAND_P) for the Brier and ECE only; the reliability table does
 * not depend on the mapping, and it is the table that says which way a band
 * runs. A mechanism whose confidence takes ONE value is flagged as constant: no
 * monotone re-weighting of a constant reorders anything, so a
 * "calibration-adjusted read" over it is the identity by construction — which
 * is the ticket's second Verify item answered without running it.
 *
 * Where the sides come from:
 *   kind band     fixtures/thought-kinds.json — the model's first-pass band on
 *                 each thought, resolved by the hand kind (right / wrong)
 *   judge         supersession_proposals — the judge's confidence on each
 *                 pair it called a conflict (029 records no other verdict, so
 *                 this scores its positive calls only), resolved by the
 *                 reviewer: accepted = applied, rejected = declined; pending =
 *                 unresolved. 029 keeps no reason, so a rejection cannot say
 *                 whether the conflict call itself failed or only its direction
 *                 or its timing did — "did not hold" is an upper bound on the
 *                 judge's failures. One mechanism per judge_key
 *   extractor     thought_entities + ob1_entity_edges — the confidence on each
 *                 mention and edge; nothing in a brain resolves them (the
 *                 labelled captures in eval-entities.ts are that outcome set,
 *                 outside the brain), so they report a distribution only
 *   declared      metadata.confidence on a thought — a number in [0, 1], or a
 *                 string holding one — the key a writer can set today; resolved
 *                 by the fixture's hypothesis status (confirmed / refuted) or
 *                 by being superseded (another thought's `supersedes` points at
 *                 it). A hypothesis or a superseded thought with no declared
 *                 value is the unscored row the report counts.
 *
 * What the log forgets: a deleted thought takes its proposals with it (029
 * cascades) and clears any pointer at it (025 sets null), while thought_audit
 * keeps the delete. So a brain whose operator prunes refuted or superseded
 * thoughts reads as better calibrated than it was; the report counts the
 * deletes the log remembers so the reader can see how much is missing.
 *
 * Modes:
 *   bun eval-calibration.ts --self-check      the arithmetic and the ledger rules; no database
 *   bun eval-calibration.ts --offline         the fixture-only mechanisms (kind band, hypotheses)
 *   DATABASE_URL=… bun eval-calibration.ts    the report over the live brain as well
 */

import { SQL } from "bun";
import { loadEnv } from "./env.ts";
import { readFixture, type Fixture } from "./eval-thought-kinds.ts";

// ── The ledger ───────────────────────────────────────────────────────────────

/** One claim, the confidence it carried, and what it resolved to. */
export type LedgerRow = {
  /** The producer, as the log names it: a judge_key, an extraction_key, or one of the fixed names below. */
  mechanism: string;
  /** The claim: a thought id, a proposal id, or a mention/edge key. */
  claim: string;
  /** What kind of claim: a thought's kind or its own statement, a proposal, an entity mention, an entity edge. */
  kind: "thought" | "proposal" | "mention" | "edge";
  /** The confidence as a probability, or null when the claim carried none. */
  stated: number | null;
  /** The band it was stated as, when it was a band rather than a number. */
  band: string | null;
  /** 1 the claim held, 0 it did not, null nothing has resolved it. */
  outcome: 0 | 1 | null;
  /** What resolved it: "hand label", "reviewer", "fork record", "superseded"; null when unresolved. */
  resolvedBy: string | null;
};

export const KIND_BAND = "kind band (the metadata model's first pass, thought-kinds.json)";
export const DECLARED = "declared (metadata.confidence)";

/** The nominal probability a band stands for, for the Brier and the ECE. Stated, not measured: the reliability table is the measurement. */
export const BAND_P: Record<string, number> = { high: 0.9, medium: 0.6, low: 0.3 };

/** A declared confidence: a number in [0, 1], or a string holding one. Anything else is not a confidence and reads as none. */
export function parseDeclared(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

function invert(map: Record<string, string[]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, ids] of Object.entries(map)) for (const id of ids) out.set(id, k);
  return out;
}

/** The kind band: every thought the model answered for, resolved by the hand kind. An answer with no usable band is a claim with no confidence. */
export function kindBandRows(f: Fixture): LedgerRow[] {
  const kindOf = invert(f.kinds), bandOf = invert(f.first_pass_confidence);
  const rows: LedgerRow[] = [];
  for (const [guess, ids] of Object.entries(f.first_pass)) for (const id of ids) {
    const kind = kindOf.get(id);
    if (!kind) continue;
    const band = bandOf.get(id) ?? null;
    rows.push({ mechanism: KIND_BAND, claim: id, kind: "thought", stated: band ? BAND_P[band] ?? null : null, band, outcome: guess === kind ? 1 : 0, resolvedBy: "hand label" });
  }
  return rows;
}

/**
 * The writer's own confidence: one row per claim, each claim once. A hypothesis
 * is resolved by the fork record where the fixture says confirmed or refuted;
 * a thought another thought supersedes is resolved against — the ticket's
 * reading ("superseded by a corrected value"), which counts a supersession
 * that merely extends the same way and so overstates refutation; the fork
 * record wins where both apply, since a verdict is a resolution and a pointer
 * is a hint at one. A thought that declared a value and that nothing resolved
 * is unresolved. The confidence is whatever the writer declared under
 * metadata.confidence, usually nothing.
 */
export function declaredRows(f: Fixture, declared: Map<string, number | null>, superseded: Iterable<string>): LedgerRow[] {
  const statusOf = invert(f.status), sup = new Set(superseded);
  const rows: LedgerRow[] = [];
  const seen = new Set<string>();
  for (const id of f.kinds.hypothesis ?? []) {
    const s = statusOf.get(id);
    let outcome: 0 | 1 | null = s === "confirmed" ? 1 : s === "refuted" ? 0 : null, resolvedBy: string | null = outcome === null ? null : "fork record";
    if (outcome === null && sup.has(id)) { outcome = 0; resolvedBy = "superseded"; }
    rows.push({ mechanism: DECLARED, claim: id, kind: "thought", stated: declared.get(id) ?? null, band: null, outcome, resolvedBy });
    seen.add(id);
  }
  for (const id of sup) if (!seen.has(id)) { rows.push({ mechanism: DECLARED, claim: id, kind: "thought", stated: declared.get(id) ?? null, band: null, outcome: 0, resolvedBy: "superseded" }); seen.add(id); }
  for (const [id, p] of declared) if (!seen.has(id)) { rows.push({ mechanism: DECLARED, claim: id, kind: "thought", stated: p, band: null, outcome: null, resolvedBy: null }); seen.add(id); }
  return rows;
}

export type ProposalRow = { id: string; confidence: number; status: string; judge_key: string };

/** The judge: its confidence on each proposal, resolved by the reviewer — applied or declined; see the header for what a decline can and cannot mean. */
export function proposalRows(rows: ProposalRow[]): LedgerRow[] {
  return rows.map((r) => ({
    mechanism: r.judge_key, claim: r.id, kind: "proposal" as const, stated: r.confidence, band: null,
    outcome: r.status === "accepted" ? 1 : r.status === "rejected" ? 0 : null,
    resolvedBy: r.status === "pending" ? null : "reviewer",
  }));
}

export type MentionRow = { claim: string; kind: "mention" | "edge"; confidence: number; extraction_key: string };

/** The extractor: a confidence per mention or edge, nothing to resolve it in a brain. */
export function mentionRows(rows: MentionRow[]): LedgerRow[] {
  return rows.map((r) => ({ mechanism: r.extraction_key, claim: r.claim, kind: r.kind, stated: r.confidence, band: null, outcome: null, resolvedBy: null }));
}

/** A missing table or column — the migration that adds it is not applied. Any other error (a grant, a timeout, a renamed column) is not that, and is thrown, never read as "not applied" (review pass 3). */
export function absent(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return code === "42P01" || code === "42703";
}

/** The rows a score may read: both sides present and in range. A row out of range is an error naming the claim, not a row dropped. */
export function scorable(rows: LedgerRow[]): { stated: number; outcome: 0 | 1 }[] {
  const out: { stated: number; outcome: 0 | 1 }[] = [];
  for (const r of rows) {
    if (r.stated !== null && !(r.stated >= 0 && r.stated <= 1)) throw new Error(`${r.mechanism}: ${r.claim} states a confidence of ${r.stated}, outside [0, 1]`);
    if (r.outcome !== null && r.outcome !== 0 && r.outcome !== 1) throw new Error(`${r.mechanism}: ${r.claim} resolved to ${r.outcome}, not 0 or 1`);
    if (r.stated !== null && r.outcome !== null) out.push({ stated: r.stated, outcome: r.outcome });
  }
  return out;
}

// ── The score ────────────────────────────────────────────────────────────────

export type Scored = { stated: number; outcome: 0 | 1 };

/** Mean squared distance between the stated probability and what happened; 0 is perfect, 0.25 is a coin the forecaster called at 0.5, 1 is certainty refuted every time. */
export function brier(rows: Scored[]): number {
  return rows.length ? rows.reduce((s, r) => s + (r.stated - r.outcome) ** 2, 0) / rows.length : NaN;
}

/** The base rate: how often the claim held, whatever was stated. */
export function baseRate(rows: Scored[]): number {
  return rows.length ? rows.reduce((s, r) => s + r.outcome, 0) / rows.length : NaN;
}

/** Brier skill against the constant at the base rate: 1 − BS / BS_ref; null when the reference is 0 (every claim resolved the same way, so a constant is perfect and skill is undefined). */
export function skill(bs: number, rate: number): number | null {
  const ref = rate * (1 - rate);
  return ref === 0 ? null : 1 - bs / ref;
}

/** The bin a stated value falls in: its own value when the mechanism states few distinct ones (a band, a judge's floor), else a decile. */
export function binOf(distinct: number): (p: number) => string {
  if (distinct <= 12) return (p) => p.toFixed(2);
  return (p) => { const lo = Math.min(Math.floor(p * 10) / 10, 0.9); return `${lo.toFixed(1)}–${(lo + 0.1).toFixed(1)}`; };
}

export type Bin = { key: string; n: number; held: number; stated: number };

/** The reliability table: per bin, how many claims, how many held, the mean stated probability. Sorted by stated. */
export function reliability(rows: Scored[], key: (p: number) => string): Bin[] {
  const bins = new Map<string, Bin>();
  for (const r of rows) {
    const k = key(r.stated);
    let b = bins.get(k);
    if (!b) { b = { key: k, n: 0, held: 0, stated: 0 }; bins.set(k, b); }
    b.n++; b.held += r.outcome; b.stated += r.stated;
  }
  return [...bins.values()].map((b) => ({ ...b, stated: b.stated / b.n })).sort((a, b) => a.stated - b.stated);
}

/** Expected calibration error: the n-weighted mean over bins of |rate held − mean stated|. */
export function ece(bins: Bin[]): number {
  const n = bins.reduce((s, b) => s + b.n, 0);
  return n ? bins.reduce((s, b) => s + (b.n / n) * Math.abs(b.held / b.n - b.stated), 0) : NaN;
}

/** Everything the report says about one mechanism. */
export type Summary = {
  mechanism: string; claims: number; withConfidence: number; distinct: number[]; resolved: number; scorable: number;
  brier: number | null; ece: number | null; baseRate: number | null; skill: number | null; bins: Bin[]; bands: Map<string, { n: number; held: number }>;
  unresolvedWithConfidence: number; resolvedWithout: number;
  /** How many claims stated each distinct value (resolved or not). */
  perValue: Map<number, number>;
  /** How many resolved claims each resolver accounts for. */
  perResolver: Map<string, number>;
  /** The same, over the resolved claims that carry NO confidence — the rows the "cannot be scored" line is about. */
  perResolverWithout: Map<string, number>;
  /** How many claims of each kind (thought, proposal, mention, edge). */
  perKind: Map<string, number>;
};

export function summarise(mechanism: string, rows: LedgerRow[]): Summary {
  const sc = scorable(rows);
  const distinct = [...new Set(rows.filter((r) => r.stated !== null).map((r) => r.stated as number))].sort((a, b) => a - b);
  const bins = sc.length ? reliability(sc, binOf(distinct.length)) : [];
  const bands = new Map<string, { n: number; held: number }>();
  for (const r of rows) if (r.band && r.outcome !== null) { const b = bands.get(r.band) ?? { n: 0, held: 0 }; b.n++; b.held += r.outcome; bands.set(r.band, b); }
  const bs = sc.length ? brier(sc) : null, rate = sc.length ? baseRate(sc) : null;
  const perValue = new Map<number, number>(), perResolver = new Map<string, number>(), perResolverWithout = new Map<string, number>(), perKind = new Map<string, number>();
  for (const r of rows) {
    if (r.stated !== null) perValue.set(r.stated, (perValue.get(r.stated) ?? 0) + 1);
    if (r.resolvedBy) perResolver.set(r.resolvedBy, (perResolver.get(r.resolvedBy) ?? 0) + 1);
    if (r.resolvedBy && r.stated === null) perResolverWithout.set(r.resolvedBy, (perResolverWithout.get(r.resolvedBy) ?? 0) + 1);
    perKind.set(r.kind, (perKind.get(r.kind) ?? 0) + 1);
  }
  return {
    mechanism, claims: rows.length,
    withConfidence: rows.filter((r) => r.stated !== null).length, distinct,
    resolved: rows.filter((r) => r.outcome !== null).length, scorable: sc.length,
    brier: bs, ece: sc.length ? ece(bins) : null, baseRate: rate, skill: bs !== null && rate !== null ? skill(bs, rate) : null, bins, bands,
    unresolvedWithConfidence: rows.filter((r) => r.stated !== null && r.outcome === null).length,
    resolvedWithout: rows.filter((r) => r.stated === null && r.outcome !== null).length,
    perValue, perResolver, perResolverWithout, perKind,
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

function table(header: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}
const f3 = (n: number | null) => (n === null || Number.isNaN(n) ? "—" : n.toFixed(3));
const pct = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(0)}%`);

/** "1.00 on 5,492, 0.50 on 1" for a few-valued confidence; the count of values otherwise. */
function distribution(s: Summary): string {
  if (s.distinct.length === 1) return `every one ${s.distinct[0].toFixed(2)}`;
  if (s.distinct.length <= 4) return [...s.perValue].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p.toFixed(2)} on ${n.toLocaleString("en-US")}`).join(", ");
  return `${s.distinct.length} distinct values`;
}
/** "17 by the fork record, 8 superseded" — who resolved the claims that carry no confidence. */
function resolvers(s: Summary): string {
  return [...s.perResolverWithout].sort((a, b) => b[1] - a[1]).map(([by, n]) => `${n} ${by === "superseded" ? "superseded" : `by the ${by}`}`).join(", ");
}
/** "4,126 (3,000 mentions, 1,126 edges)" when a mechanism claims more than one kind of thing. */
function claims(s: Summary): string {
  if (s.perKind.size <= 1) return String(s.claims);
  return `${s.claims} (${[...s.perKind].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n.toLocaleString("en-US")} ${k}${n === 1 ? "" : "s"}`).join(", ")})`;
}

/** The report over a set of summaries, in the order given. */
export function render(summaries: Summary[], heading: string, notes: string[]): string {
  const out: string[] = [`# ${heading}`, ""];
  out.push("## The ledger", "", "One row per mechanism: what it claimed, what carried a confidence, how many distinct values that confidence took, what something resolved, and what has both sides.", "");
  out.push(table(
    ["mechanism", "claims", "with a confidence", "distinct values", "resolved", "scorable"],
    summaries.map((s) => [s.mechanism, claims(s), `${s.withConfidence} (${pct(s.withConfidence, s.claims)})`, s.distinct.length <= 4 ? (s.distinct.length ? s.distinct.map((p) => p.toFixed(2)).join(", ") : "—") : String(s.distinct.length), `${s.resolved} (${pct(s.resolved, s.claims)})`, s.scorable]),
  ), "");
  for (const s of summaries) {
    if (!s.scorable) continue;
    out.push(`## ${s.mechanism}`, "");
    if (s.bands.size) {
      out.push("By the band as stated (the measurement the nominal mapping does not touch):", "", table(["band", "nominal p", "n", "held", "rate"], [...s.bands].sort((a, b) => (BAND_P[b[0]] ?? 0) - (BAND_P[a[0]] ?? 0)).map(([b, v]) => [b, BAND_P[b]?.toFixed(2) ?? "—", v.n, v.held, pct(v.held, v.n)])), "");
    }
    out.push(table(["stated", "n", "held", "rate"], s.bins.map((b) => [b.key, b.n, b.held, pct(b.held, b.n)])), "");
    const constant = s.distinct.length === 1 ? ` · the confidence is a constant (${s.distinct[0].toFixed(2)}): no monotone re-weighting reorders it` : "";
    out.push(`Brier ${f3(s.brier)} · ECE ${f3(s.ece)} · base rate ${f3(s.baseRate)} (a constant at the base rate scores Brier ${f3(s.baseRate === null ? null : s.baseRate * (1 - s.baseRate))}) · skill against it ${s.skill === null ? "— (every claim resolved the same way)" : s.skill.toFixed(3)}${constant}`, "");
    if (s.unresolvedWithConfidence) out.push(`${s.unresolvedWithConfidence} more claim(s) carry a confidence and are not yet resolved.`, "");
  }
  const unscored = summaries.filter((s) => !s.scorable || s.resolvedWithout);
  if (unscored.length) {
    out.push("## What cannot be scored, and why", "");
    for (const s of unscored) {
      if (s.resolvedWithout) out.push(`- ${s.mechanism}: ${s.resolvedWithout} resolved claim(s) carry no confidence — an outcome with nothing to score it against (${resolvers(s)}).`);
      if (!s.scorable && s.withConfidence) out.push(`- ${s.mechanism}: ${s.withConfidence} claim(s) carry a confidence (${distribution(s)}) and nothing has resolved any of them.`);
      if (!s.scorable && !s.withConfidence && !s.resolvedWithout) out.push(`- ${s.mechanism}: ${s.claims ? `${s.claims} claim(s), none with a confidence, none resolved.` : "no claims."}`);
    }
    out.push("");
  }
  if (notes.length) out.push(...notes, "");
  return out.join("\n");
}

// ── Modes ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const has = (n: string) => args.includes(`--${n}`);

function selfCheck(): void {
  let failed = 0;
  const ok = (cond: boolean, what: string) => { if (!cond) { failed++; console.error(`  FAIL ${what}`); } };
  const near = (a: number | null, b: number, what: string) => ok(a !== null && Math.abs(a - b) < 1e-9, `${what} (got ${a})`);

  // The arithmetic, on sets whose numbers are known by hand.
  const refused24: Scored[] = Array.from({ length: 24 }, () => ({ stated: 0.8, outcome: 0 }));
  near(brier(refused24), 0.64, "a constant 0.80 refuted 24 times is Brier 0.64");
  near(ece(reliability(refused24, binOf(1))), 0.8, "… and ECE 0.80");
  ok(skill(0.64, 0) === null, "… and skill undefined against a base rate of 0");
  const calibrated: Scored[] = [...Array.from({ length: 7 }, () => ({ stated: 0.7, outcome: 1 as const })), ...Array.from({ length: 3 }, () => ({ stated: 0.7, outcome: 0 as const }))];
  near(ece(reliability(calibrated, binOf(1))), 0, "0.70 held 7 of 10 is ECE 0");
  near(brier(calibrated), 0.21, "… and Brier 0.21");
  near(skill(brier(calibrated), baseRate(calibrated)), 0, "… and skill 0: it is the base-rate constant");
  const sharp: Scored[] = [{ stated: 1, outcome: 1 }, { stated: 0, outcome: 0 }, { stated: 1, outcome: 1 }, { stated: 0, outcome: 0 }];
  near(brier(sharp), 0, "certainty that is always right is Brier 0");
  near(skill(0, 0.5), 1, "… and skill 1 against a coin");
  const wrong: Scored[] = [{ stated: 1, outcome: 0 }, { stated: 1, outcome: 0 }];
  near(brier(wrong), 1, "certainty refuted every time is Brier 1");
  const two = reliability([{ stated: 0.9, outcome: 0 }, { stated: 0.9, outcome: 0 }, { stated: 0.6, outcome: 1 }], binOf(2));
  ok(two.length === 2 && two[0].key === "0.60" && two[0].held === 1 && two[1].key === "0.90" && two[1].n === 2 && two[1].held === 0, "the reliability table bins by stated value, ascending");
  near(ece(two), (2 / 3) * 0.9 + (1 / 3) * 0.4, "ECE weights each bin by its share");
  ok(binOf(13)(0.95) === "0.9–1.0" && binOf(13)(1) === "0.9–1.0" && binOf(13)(0.42) === "0.4–0.5", "over twelve distinct values the bins are deciles, 1.0 in the top one");

  // The ledger rules.
  const A = "10000000-0000-4000-8000-000000000001", B = "10000000-0000-4000-8000-000000000002", C = "10000000-0000-4000-8000-000000000003", D = "10000000-0000-4000-8000-000000000004";
  const fx = {
    generated: "t", origin: "o", note: "n",
    kinds: { plan: [A, B], hypothesis: [C, D] }, parts: {}, status: { confirmed: [C], open: [D] }, source_kind: { agent_capture: [A, B, C, D] },
    first_pass: { plan: [A, C], observation: [B] }, first_pass_confidence: { high: [A], medium: [C] }, first_pass_status: {},
  } as unknown as Fixture;
  const kb = kindBandRows(fx);
  ok(kb.length === 3, `the kind band has a row per answered thought (${kb.length})`);
  const a = kb.find((r) => r.claim === A), b = kb.find((r) => r.claim === B), c = kb.find((r) => r.claim === C);
  ok(a?.stated === 0.9 && a.outcome === 1 && a.band === "high", "a high band that was right: stated 0.90, held");
  ok(b?.stated === null && b.outcome === 0 && b.band === null, "an answer with no band is a resolved claim with no confidence, not a 0");
  ok(c?.stated === 0.6 && c.outcome === 0, "a medium band that was wrong: stated 0.60, did not hold");
  ok(scorable(kb).length === 2, "only the rows with both sides are scorable");
  const dr = declaredRows(fx, new Map([[C, 0.75], [A, 0.5], [B, 0.4]]), [A, C, D]);
  const at = (id: string) => dr.filter((r) => r.claim === id);
  ok(dr.length === 4 && new Set(dr.map((r) => r.claim)).size === 4, `each claim lands under the declared mechanism once (${dr.length} rows)`);
  ok(at(C)[0]?.outcome === 1 && at(C)[0]?.resolvedBy === "fork record" && at(C)[0]?.stated === 0.75, "a confirmed hypothesis held by the fork record, even where a pointer supersedes it; the declared value is read");
  ok(at(D)[0]?.outcome === 0 && at(D)[0]?.resolvedBy === "superseded" && at(D)[0]?.stated === null, "an open hypothesis another thought supersedes is resolved against");
  ok(at(A)[0]?.outcome === 0 && at(A)[0]?.resolvedBy === "superseded" && at(A)[0]?.stated === 0.5, "a superseded thought that is no hypothesis is a row of its own, with its declared value");
  ok(at(B)[0]?.outcome === null && at(B)[0]?.stated === 0.4, "a declared value on a thought nothing resolved is unresolved");
  ok(declaredRows(fx, new Map(), []).every((r) => r.stated === null) && declaredRows(fx, new Map(), []).find((r) => r.claim === D)?.outcome === null, "with nothing declared and nothing superseded, an open hypothesis is unresolved with no confidence");
  const props = proposalRows([{ id: "p1", confidence: 0.8, status: "rejected", judge_key: "j" }, { id: "p2", confidence: 0.8, status: "accepted", judge_key: "j" }, { id: "p3", confidence: 0.9, status: "pending", judge_key: "j" }]);
  ok(props[0].outcome === 0 && props[1].outcome === 1 && props[2].outcome === null && props[2].resolvedBy === null, "rejected 0, accepted 1, pending unresolved");
  ok(parseDeclared(0.7) === 0.7 && parseDeclared("0.7") === 0.7 && parseDeclared(1) === 1 && parseDeclared(0) === 0, "a declared confidence reads as a number or a numeric string");
  ok(parseDeclared(1.5) === null && parseDeclared(-0.1) === null && parseDeclared("high") === null && parseDeclared("") === null && parseDeclared(null) === null && parseDeclared(true) === null, "out of range, a word, empty, null and a boolean are not a confidence");
  let threw = "";
  try { scorable([{ mechanism: "m", claim: "x", kind: "thought", stated: 1.2, band: null, outcome: 1, resolvedBy: "r" }]); } catch (e) { threw = (e as Error).message; }
  ok(threw.includes("x") && threw.includes("1.2"), "a stated value outside [0, 1] is refused, naming the claim");

  // The summary and the report.
  const s = summarise("j", [...props, { mechanism: "j", claim: "p4", kind: "proposal", stated: null, band: null, outcome: 0, resolvedBy: "reviewer" }]);
  ok(s.claims === 4 && s.withConfidence === 3 && s.resolved === 3 && s.scorable === 2 && s.unresolvedWithConfidence === 1 && s.resolvedWithout === 1, `the summary partitions the rows (${JSON.stringify([s.claims, s.withConfidence, s.resolved, s.scorable, s.unresolvedWithConfidence, s.resolvedWithout])})`);
  near(s.brier, ((0.8 - 0) ** 2 + (0.8 - 1) ** 2) / 2, "the summary's Brier reads only the scorable rows");
  ok(s.distinct.length === 2, "distinct values count the stated ones across every row, resolved or not");
  const k = summarise(KIND_BAND, kb);
  ok(k.bands.get("high")?.n === 1 && k.bands.get("high")?.held === 1 && k.bands.get("medium")?.held === 0, "the band table counts the band as stated");
  const text = render([s, k, summarise("e", mentionRows([{ claim: "m1", kind: "mention", confidence: 1, extraction_key: "e" }]))], "probe", []);
  ok(text.includes("| j | 4 | 3 (75%) | 0.80, 0.90 | 3 (75%) | 2 |"), "the ledger row prints the partition");
  ok(text.includes("- e: 1 claim(s) carry a confidence (every one 1.00) and nothing has resolved any of them."), "an unresolvable mechanism is named with its constant");
  ok(text.includes("- j: 1 resolved claim(s) carry no confidence — an outcome with nothing to score it against (1 by the reviewer)."), "a resolved claim with no confidence is named, with who resolved THAT claim — not every resolved one");
  const mixed = render([summarise("e2", mentionRows([{ claim: "m1", kind: "mention", confidence: 1, extraction_key: "e2" }, { claim: "m2", kind: "edge", confidence: 1, extraction_key: "e2" }, { claim: "m3", kind: "edge", confidence: 0.5, extraction_key: "e2" }]))], "probe", []);
  ok(mixed.includes("(1.00 on 2, 0.50 on 1)"), "a few-valued confidence prints its distribution, most common first");
  ok(mixed.includes("| e2 | 3 (2 edges, 1 mention) |"), "a mechanism that claims two kinds of thing prints the split");
  ok(render([summarise(KIND_BAND, [])], "probe", []).includes(`- ${KIND_BAND}: no claims.`), "a fixture-fed mechanism with no live thoughts prints a row and says so");
  ok(absent({ code: "42P01" }) && absent({ code: "42703" }) && !absent({ code: "42501" }) && !absent(new Error("timeout")) && !absent(null), "a missing table or column is absent; a grant, a timeout or nothing at all is not");
  const dec = summarise(DECLARED, declaredRows(fx, new Map(), [A]));
  ok(resolvers(dec) === "1 by the fork record, 1 superseded", `the resolvers are counted by name (${resolvers(dec)})`);
  const constant = render([summarise("c", proposalRows(Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, confidence: 0.8, status: "rejected", judge_key: "c" }))))], "probe", []);
  ok(constant.includes("the confidence is a constant (0.80)") && constant.includes("Brier 0.640") && constant.includes("skill against it — (every claim resolved the same way)"), "a constant confidence is flagged, with its Brier and an undefined skill");

  // The committed fixture yields the kind-band mechanism.
  const live = kindBandRows(readFixture());
  ok(live.length > 0 && scorable(live).length > 0, "the committed fixture gives the kind band a scorable set");

  if (failed) { console.error(`self-check: ${failed} FAILED`); process.exit(1); }
  console.log("self-check: OK");
}

function offlineSummaries(f: Fixture): Summary[] {
  return [summarise(KIND_BAND, kindBandRows(f)), summarise(DECLARED, declaredRows(f, new Map(), []))];
}

async function score(offline: boolean): Promise<void> {
  const f = readFixture();
  if (offline) {
    console.log(render(offlineSummaries(f), `Calibration, from the fixture alone — ${f.origin} (${f.generated.slice(0, 10)})`, [
      `Offline: the two rows are the fixture's thoughts (${f.origin}), not any live brain's; the judge, the extractor, a declared confidence and the superseded thoughts need the live brain.`,
    ]));
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set; --offline scores the fixture-only mechanisms"); process.exit(2); }
  const sql = new SQL(url);
  const notes: string[] = [];
  const live = new Set((await sql`SELECT id::text AS id FROM thoughts`).map((r: { id: string }) => r.id));
  // A fixture id the brain no longer holds is dropped from every fixture-fed
  // mechanism, and the count is printed, so a kind-band n that stops matching
  // SMD-1951's table has a line saying why (review pass 1).
  const gone = new Set<string>();
  const here = (rows: LedgerRow[]) => rows.filter((r) => { if (live.has(r.claim)) return true; gone.add(r.claim); return false; });

  const declared = new Map<string, number | null>();
  let unreadable = 0;
  for (const r of await sql`SELECT id::text AS id, metadata->'confidence' AS confidence FROM thoughts WHERE metadata ? 'confidence'` as { id: string; confidence: unknown }[]) {
    const p = parseDeclared(r.confidence);
    if (p === null) unreadable++; else declared.set(r.id, p);
  }
  if (unreadable) notes.push(`${unreadable} thought(s) carry a metadata.confidence that is not a number in [0, 1]; read as none.`);
  // A table or column a migration has not added is a note; any other failure is thrown (review pass 3).
  const orNote = async <T,>(read: () => Promise<T>, note: string, none: T): Promise<T> => {
    try { return await read(); } catch (e) { if (!absent(e)) throw e; notes.push(note); return none; }
  };
  const superseded = (await orNote(() => sql`SELECT DISTINCT supersedes::text AS id FROM thoughts WHERE supersedes IS NOT NULL ORDER BY 1` as Promise<{ id: string }[]>,
    "thoughts.supersedes is absent (migration 025 not applied): nothing is resolved by supersession here.", [])).map((r) => r.id);
  const deleted = await orNote(async () => Number((await sql`SELECT count(DISTINCT thought_id)::int AS n FROM thought_audit WHERE action = 'delete'`)[0]?.n ?? 0),
    "No thought_audit table (migration 008 not applied): deletes are not counted.", 0);

  // The two fixture-fed mechanisms always have a row, even when none of the fixture's thoughts is in this brain.
  const byMechanism = new Map<string, LedgerRow[]>([[KIND_BAND, []], [DECLARED, []]]);
  const add = (rows: LedgerRow[]) => { for (const r of rows) { const l = byMechanism.get(r.mechanism) ?? []; l.push(r); byMechanism.set(r.mechanism, l); } };
  add(here(kindBandRows(f)));
  add(proposalRows(await orNote(() => sql`SELECT id::text AS id, confidence::float AS confidence, status, judge_key FROM supersession_proposals ORDER BY judge_key, judged_at, id` as Promise<ProposalRow[]>,
    "No supersession_proposals table (migration 029 not applied): the judge has no rows here.", [])));
  add(mentionRows(await orNote(async () => [
    ...(await sql`SELECT thought_id::text || ':' || entity_id::text AS claim, 'mention' AS kind, confidence::float AS confidence, extraction_key FROM thought_entities ORDER BY extraction_key, thought_id, entity_id` as MentionRow[]),
    ...(await sql`SELECT thought_id::text || ':' || from_entity_id::text || ':' || to_entity_id::text || ':' || relation AS claim, 'edge' AS kind, confidence::float AS confidence, extraction_key FROM ob1_entity_edges ORDER BY extraction_key, thought_id, from_entity_id, to_entity_id, relation` as MentionRow[]),
  ], "No entity tables (migration 016 not applied): the extractor has no rows here.", [])));
  add(here(declaredRows(f, declared, superseded)));
  await sql.end();

  const summaries = [...byMechanism].map(([m, rows]) => summarise(m, rows));
  const fixtureIds = new Set([...kindBandRows(f), ...declaredRows(f, new Map(), [])].map((r) => r.claim)).size;
  if (gone.size) notes.push(`${gone.size} of the fixture's ${fixtureIds} thought ids are not in this brain (the fixture is ${f.origin}) and are dropped from the kind band and the declared rows.`);
  if (deleted) notes.push(`${deleted} thought(s) have been deleted from this brain (thought_audit): a delete takes the thought's proposals with it and clears any pointer at it, so their outcomes are not in the ledger and the scores above are of what survived.`);
  notes.push(
    `Attribution is by the key each producer already writes (judge_key, extraction_key) and by the fixture's provenance; SMD-1731's per-run lineage would make it per prompt version, and is not needed to read this.`,
    `The shipped \`type\` facet and capture_thought carry no confidence at all: ${live.size} thought(s) in the brain, ${declared.size} with a declared one.`,
  );
  console.log(render(summaries, `Calibration: was the confidence earned? — ${new Date().toISOString().slice(0, 10)}, ${live.size} thoughts`, notes));
}

if (import.meta.main) {
  loadEnv();
  if (has("self-check")) selfCheck();
  else await score(has("offline"));
}
