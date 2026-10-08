#!/usr/bin/env bun
/**
 * eval-judge.ts — does the consolidation judge's answer carry information,
 * measured on a brain's own labels? (SMD-1873)
 *
 * eval-consolidate.ts measures the judge on a corpus that lived in /tmp and is
 * gone; this harness needs no corpus. Every brain the pass has run on already
 * holds two kinds of label for the pairs the judge sees, and it reads both:
 *
 *   proposal  a reviewed supersession proposal — accepted (the conflict held,
 *             in the direction the reviewer applied) or rejected (it did not).
 *             The reviewer's word on the judge's own past positives.
 *   link      two board tickets the board links (053's `link` facets:
 *             duplicate_of, child_of, blocks, relates_to) — a human said the
 *             two are related, and none of those relations is a reversal.
 *             079 keeps such a pair out of the candidates, so the judge never
 *             sees one in a pass; here it is asked directly.
 *
 * and a third set with no label, so the rates are the pass's own:
 *
 *   candidate  pairs `consolidation_candidates()` hands the pass today,
 *              sampled — what share become proposals, how many undirected.
 *
 * Two steps, so the brain is read once and the model is called offline:
 *
 *   DATABASE_URL=… bun eval-judge.ts --export /private/tmp/judge-pairs.jsonl [--per-relation 40] [--candidates 120]
 *   bun eval-judge.ts --pairs /private/tmp/judge-pairs.jsonl [--out answers.jsonl] [--concurrency 3] [--logprobs 10] [--limit N]
 *   bun eval-judge.ts --pairs … --replay answers.jsonl      # score saved answers, no model
 *   bun eval-judge.ts --self-check                           # the arithmetic, no database or model
 *
 * --export reads in ONE repeatable-read, read-only transaction, so it can be
 * pointed at a live brain: Postgres refuses any write inside it. The pairs
 * file holds the thoughts' text — it is the brain's content, kept where the
 * operator puts it, never committed. The sample is deterministic (ordered by
 * an md5 of the pair's ids), so two exports of an unchanged brain agree.
 *
 * What it reports, per gold set and overall:
 *   - the verdicts against each label (a confusion table);
 *   - the stated confidence: how many distinct values, and its histogram;
 *   - with --logprobs, the verdict token's probability beside it;
 *   - discrimination: the AUROC of each confidence against whether the
 *     verdict was right — 0.5 is a coin, and a constant is 0.5 by
 *     construction (eval-calibration.ts's point, measured here per pair);
 *   - direction: the share of conflicts that name a side, and right/wrong on
 *     the accepted proposals;
 *   - on the candidates, what the pass would record at --min-confidence.
 *
 * "Right" per label: an accepted proposal is a conflict; a rejected one is
 * not; a linked pair is related and is neither unrelated nor a conflict — a
 * board link is never a reversal (a duplicate_of pair is the one place a
 * reader could argue otherwise, and it is reported on its own row). A
 * rejected proposal says the conflict did not hold, not why; 2448 found most
 * rejections were two tickets the judge called a conflict, so "not a
 * conflict" is the claim it supports.
 *
 * The judge is the worker's: judgePair through embed.ts's resolver
 * (OB1_JUDGE_MODEL, else OB1_METADATA_MODEL; OB1_LLM_BASE_URL or
 * OB1_EVAL_BASE), the egress gate included. The header's writer clause is
 * the row's mark (050), as the worker sends it.
 */

import { SQL } from "bun";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnv } from "./env.ts";
import { resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import {
  actorKindOf, consolidateKey, judgePair, proposalVerdict, DEFAULT_CANDIDATES, DEFAULT_MIN_CONFIDENCE, DEFAULT_MIN_SIMILARITY, type Judgement, type PairSide,
} from "../server-portable/consolidate.ts";

// ── The file shapes ──────────────────────────────────────────────────────────

export type GoldSource = "proposal" | "link" | "candidate";
export type Gold =
  | { source: "proposal"; label: "accepted" | "rejected"; direction?: "newer" | "older"; judgeKey: string; judged: { verdict: string; confidence: number }; editedSince: boolean }
  | { source: "link"; label: "duplicate_of" | "child_of" | "blocks" | "relates_to" }
  | { source: "candidate"; label: "none"; similarity: number };
export type Side = PairSide & { id: string };
export type PairLine = { pair: string; older: Side; newer: Side; gold: Gold };
export type AnswerLine = { pair: string; ms: number; judgement: Judgement | null; error?: string };

// ── Scoring arithmetic (pure; --self-check holds it) ─────────────────────────

/**
 * Whether a verdict is right for a label, or null when the label says nothing
 * (a candidate). The vocabulary is read loosely on purpose — a later prompt's
 * `related`, `continues` or `duplicate` is "related" here — so one harness
 * scores p3 and its successor alike.
 */
export function rightFor(gold: Gold, verdict: string): boolean | null {
  if (gold.source === "candidate") return null;
  if (gold.source === "proposal") return gold.label === "accepted" ? verdict === "conflict" : verdict !== "conflict";
  return verdict !== "unrelated" && verdict !== "conflict";
}

/**
 * The area under the ROC curve of `score` for telling right from wrong: the
 * chance a right answer outscores a wrong one, ties counted half (the
 * Mann-Whitney form). Null when either side is empty.
 */
export function auroc(rows: { score: number; right: boolean }[]): number | null {
  const pos = rows.filter((r) => r.right).map((r) => r.score), neg = rows.filter((r) => !r.right).map((r) => r.score);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** A pair's stable id and its sample order: the md5 of the two ids, as --export orders by. */
export const pairKey = (older: string, newer: string) => `${older}|${newer}`;

function selfCheck(): void {
  let failed = 0;
  const ok = (c: boolean, m: string) => { console.log(`  ${c ? "✓" : "✗"}  ${m}`); if (!c) failed++; };
  ok(auroc([{ score: 0.9, right: true }, { score: 0.1, right: false }]) === 1, "auroc: a perfect split is 1");
  ok(auroc([{ score: 0.8, right: true }, { score: 0.8, right: false }]) === 0.5, "auroc: a constant score is 0.5, ties counted half");
  ok(auroc([{ score: 0.2, right: true }, { score: 0.9, right: false }]) === 0, "auroc: an inverted split is 0");
  ok(auroc([{ score: 0.5, right: true }]) === null, "auroc: no wrong answers is no number");
  const acc: Gold = { source: "proposal", label: "accepted", direction: "newer", judgeKey: "k", judged: { verdict: "newer_supersedes_older", confidence: 0.8 }, editedSince: false };
  const rej: Gold = { ...acc, label: "rejected" };
  const link: Gold = { source: "link", label: "relates_to" };
  ok(rightFor(acc, "conflict") === true && rightFor(acc, "agree") === false, "an accepted proposal is right only as a conflict");
  ok(rightFor(rej, "agree") === true && rightFor(rej, "unrelated") === true && rightFor(rej, "conflict") === false, "a rejected proposal is right as anything but a conflict");
  ok(rightFor(link, "agree") === true && rightFor(link, "continues") === true && rightFor(link, "unrelated") === false && rightFor(link, "conflict") === false, "a linked pair is right as related, wrong as unrelated or a conflict");
  ok(rightFor({ source: "candidate", label: "none", similarity: 0.7 }, "conflict") === null, "a candidate has no right answer");
  console.log(failed ? `\n${failed} failed` : "\nall passed");
  process.exit(failed ? 1 : 0);
}

// ── Export: one read-only snapshot of a brain's labelled pairs ───────────────

type SideRow = { id: string; content: string; created_at: string | null; metadata: Record<string, unknown> | null };
const sideOf = (r: SideRow): Side => ({ id: r.id, content: r.content, createdAt: r.created_at, metadata: r.metadata ?? undefined, writer: actorKindOf(r.metadata) });

async function exportPairs(out: string, perRelation: number, candidates: number): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url?.trim()) { console.error("--export reads DATABASE_URL (read only)."); process.exit(2); }
  const sql = new SQL({ url, max: 1 });
  const lines: PairLine[] = [];
  const seen = new Set<string>();
  const add = (o: SideRow, n: SideRow, gold: Gold) => {
    const k = pairKey(o.id, n.id);
    if (seen.has(k) || seen.has(pairKey(n.id, o.id))) return;
    seen.add(k);
    lines.push({ pair: k, older: sideOf(o), newer: sideOf(n), gold });
  };
  try {
    await sql.begin("isolation level repeatable read read only", async (tx) => {
      const rows = (q: unknown) => q as Record<string, unknown>[];
      const side = (r: Record<string, unknown>, p: "o" | "n"): SideRow => ({ id: String(r[`${p}_id`]), content: String(r[`${p}_content`]), created_at: (r[`${p}_created`] as string | null) ?? null, metadata: (r[`${p}_meta`] as Record<string, unknown> | null) ?? null });

      // Reviewed proposals, every one: they are few and they are the judge's own positives.
      for (const r of rows(await tx`
        SELECT p.status, p.verdict, p.confidence::float AS confidence, p.judge_key, p.superseding_id::text AS superseding,
               (content_fingerprint_of(o.content) IS DISTINCT FROM p.older_fingerprint OR content_fingerprint_of(n.content) IS DISTINCT FROM p.newer_fingerprint) AS edited,
               o.id::text AS o_id, o.content AS o_content, o.created_at::text AS o_created, o.metadata AS o_meta,
               n.id::text AS n_id, n.content AS n_content, n.created_at::text AS n_created, n.metadata AS n_meta
          FROM supersession_proposals p JOIN thoughts o ON o.id = p.older_id JOIN thoughts n ON n.id = p.newer_id
         WHERE p.status IN ('accepted', 'rejected')
         ORDER BY md5(p.older_id::text || p.newer_id::text)`)) {
        const accepted = r.status === "accepted";
        add(side(r, "o"), side(r, "n"), {
          source: "proposal", label: accepted ? "accepted" : "rejected",
          // 029: superseding_id is the thought that stands — the newer row when the newer supersedes.
          ...(accepted ? { direction: r.superseding === r.n_id ? "newer" as const : "older" as const } : {}),
          judgeKey: String(r.judge_key), judged: { verdict: String(r.verdict), confidence: Number(r.confidence) }, editedSince: Boolean(r.edited),
        });
      }
      // Linked ticket pairs, up to perRelation per relation, both sides in the brain and live.
      for (const rel of ["duplicate_of", "child_of", "blocks", "relates_to"] as const) {
        for (const r of rows(await tx`
          WITH t AS (SELECT id, metadata->>'issue' AS issue, created_at FROM thoughts WHERE metadata ? 'issue'),
               pairs AS (
                 SELECT DISTINCT CASE WHEN a.created_at <= b.created_at THEN a.id ELSE b.id END AS o,
                                 CASE WHEN a.created_at <= b.created_at THEN b.id ELSE a.id END AS n
                   FROM thought_facets f JOIN t a ON a.id = f.thought_id JOIN t b ON b.issue = f.payload->>'target'
                  WHERE f.kind = 'link' AND f.valid_until IS NULL AND f.payload->>'system' = 'linear'
                    AND f.payload->>'relation' = ${rel} AND a.id <> b.id)
          SELECT o.id::text AS o_id, o.content AS o_content, o.created_at::text AS o_created, o.metadata AS o_meta,
                 n.id::text AS n_id, n.content AS n_content, n.created_at::text AS n_created, n.metadata AS n_meta
            FROM pairs JOIN thoughts o ON o.id = pairs.o JOIN thoughts n ON n.id = pairs.n
           ORDER BY md5(o.id::text || n.id::text) LIMIT ${perRelation}`)) add(side(r, "o"), side(r, "n"), { source: "link", label: rel });
      }

      // Candidates the pass would judge today, in md5 order of the newer thought, until the sample is full.
      const before = lines.length;
      for (const t of rows(await tx`SELECT id::text AS id FROM thoughts WHERE embedding IS NOT NULL ORDER BY md5(id::text)`)) {
        if (lines.length - before >= candidates) break;
        for (const r of rows(await tx`
          SELECT c.similarity, o.id::text AS o_id, o.content AS o_content, o.created_at::text AS o_created, o.metadata AS o_meta,
                 n.id::text AS n_id, n.content AS n_content, n.created_at::text AS n_created, n.metadata AS n_meta
            FROM consolidation_candidates(${t.id}::uuid, ${DEFAULT_CANDIDATES}::int, ${DEFAULT_MIN_SIMILARITY}::float) c
            JOIN thoughts o ON o.id = c.older_id JOIN thoughts n ON n.id = ${t.id}::uuid`)) {
          if (lines.length - before >= candidates) break;
          add(side(r, "o"), side(r, "n"), { source: "candidate", label: "none", similarity: Number(r.similarity) });
        }
      }
    });
  } finally {
    await sql.end();
  }
  writeFileSync(out, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
  const by = new Map<string, number>();
  for (const l of lines) by.set(`${l.gold.source}:${l.gold.label}`, (by.get(`${l.gold.source}:${l.gold.label}`) ?? 0) + 1);
  console.log(`  ${lines.length} pairs to ${out}: ${[...by].map(([k, n]) => `${k} ${n}`).join(", ")}`);
}

// ── Judge: every pair through judgePair, answers appended as they land ───────

async function judgeAll(pairs: PairLine[], out: string, concurrency: number, logprobs: number | undefined): Promise<AnswerLine[]> {
  const cfg = resolveEmbedConfig(process.env as EmbedEnv);
  console.log(`  judge ${cfg.judgeModel} at temperature ${cfg.metadataTemperature} via ${cfg.chat.base}; key ${consolidateKey(cfg.judgeModel)}; ${concurrency} at a time${logprobs ? `, top ${logprobs} logprobs` : ""}`);
  const done = new Map<string, AnswerLine>();
  if (existsSync(out)) for (const l of readFileSync(out, "utf8").split("\n").filter(Boolean)) { const a = JSON.parse(l) as AnswerLine; if (a.judgement) done.set(a.pair, a); }
  const todo = pairs.filter((p) => !done.has(p.pair));
  if (done.size) console.log(`  ${done.size} answered already in ${out}; ${todo.length} to go`);
  let next = 0, n = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (next < todo.length) {
      const p = todo[next++];
      const t = Date.now();
      let line: AnswerLine;
      try {
        const j = await judgePair(p.older, p.newer, cfg, AbortSignal.timeout(300_000), undefined, logprobs ? { logprobs } : {});
        line = { pair: p.pair, ms: Date.now() - t, judgement: j };
      } catch (e) {
        line = { pair: p.pair, ms: Date.now() - t, judgement: null, error: String((e as Error).message ?? e).slice(0, 300) };
      }
      appendFileSync(out, JSON.stringify(line) + "\n");
      if (line.judgement) done.set(p.pair, line);
      if (++n % 25 === 0) console.log(`  … ${n}/${todo.length} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return pairs.map((p) => done.get(p.pair) ?? { pair: p.pair, ms: 0, judgement: null, error: "no answer" });
}

// ── Report ───────────────────────────────────────────────────────────────────

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : "—");
const f2 = (v: number | null) => (v === null ? "—" : v.toFixed(2));

function report(pairs: PairLine[], answers: AnswerLine[], minConfidence: number): void {
  const byPair = new Map(answers.map((a) => [a.pair, a]));
  const rows = pairs.map((p) => ({ p, a: byPair.get(p.pair) })).filter((r) => r.a?.judgement && !r.a.judgement.malformed) as { p: PairLine; a: AnswerLine & { judgement: Judgement } }[];
  const malformed = answers.filter((a) => a.judgement?.malformed).length, errors = answers.filter((a) => !a.judgement).length;
  const ms = answers.filter((a) => a.judgement).map((a) => a.ms).sort((x, y) => x - y);
  console.log(`\n  ${rows.length} judged of ${pairs.length} pairs; ${malformed} malformed, ${errors} errors; median ${ms.length ? (ms[Math.floor(ms.length / 2)] / 1000).toFixed(1) : "—"} s per pair`);

  // 1. Verdicts against each label.
  const verdicts = [...new Set(rows.map((r) => r.a.judgement.verdict))].sort();
  const groups = [...new Set(rows.map((r) => `${r.p.gold.source}:${r.p.gold.label}`))].sort();
  console.log(`\n  ── verdicts by label ──\n  ${"label".padEnd(24)}${verdicts.map((v) => v.padStart(11)).join("")}   right`);
  for (const g of groups) {
    const rs = rows.filter((r) => `${r.p.gold.source}:${r.p.gold.label}` === g);
    const right = rs.filter((r) => rightFor(r.p.gold, r.a.judgement.verdict) === true).length;
    const scored = rs.filter((r) => rightFor(r.p.gold, r.a.judgement.verdict) !== null).length;
    console.log(`  ${g.padEnd(24)}${verdicts.map((v) => String(rs.filter((r) => r.a.judgement.verdict === v).length).padStart(11)).join("")}   ${scored ? `${right}/${scored} ${pct(right, scored)}` : "—"}`);
  }

  // 2. The stated confidence: is it a number or a constant?
  const stated = rows.map((r) => r.a.judgement.confidence);
  const hist = new Map<number, number>();
  for (const c of stated) hist.set(c, (hist.get(c) ?? 0) + 1);
  console.log(`\n  ── confidence ──\n  stated: ${hist.size} distinct value(s) — ${[...hist].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, n]) => `${v.toFixed(2)}×${n}`).join(", ")}`);
  const lp = rows.map((r) => r.a.judgement.probabilities?.verdict ? (r.a.judgement.probabilities.verdict.p as Record<string, number>)[r.a.judgement.verdict] ?? 0 : null).filter((v): v is number => v !== null);
  if (lp.length) {
    const s = [...lp].sort((a, b) => a - b), q = (x: number) => s[Math.min(s.length - 1, Math.floor(x * s.length))];
    console.log(`  token:  ${lp.length} with a verdict distribution; p(chosen) quantiles 10/25/50/75/90% = ${[0.1, 0.25, 0.5, 0.75, 0.9].map((x) => q(x).toFixed(3)).join(" / ")}; ${s.filter((v) => v >= 0.99).length} at ≥ 0.99`);
  }

  // 3. Discrimination: does a higher confidence mean a right verdict?
  const scored = rows.map((r) => ({ r, right: rightFor(r.p.gold, r.a.judgement.verdict) })).filter((x) => x.right !== null) as { r: typeof rows[number]; right: boolean }[];
  const tokenP = (r: typeof rows[number]) => { const d = r.a.judgement.probabilities?.verdict; return d ? (d.p as Record<string, number>)[r.a.judgement.verdict] ?? 0 : null; };
  const withTok = scored.filter((x) => tokenP(x.r) !== null);
  console.log(`\n  ── does confidence say when the verdict is right? (AUROC; 0.5 is a coin) ──`);
  console.log(`  all labelled: right ${scored.filter((x) => x.right).length}/${scored.length}; stated ${f2(auroc(scored.map((x) => ({ score: x.r.a.judgement.confidence, right: x.right }))))}${withTok.length ? `, token ${f2(auroc(withTok.map((x) => ({ score: tokenP(x.r)!, right: x.right }))))}` : ""}`);
  for (const src of ["proposal", "link"] as const) {
    const s = scored.filter((x) => x.r.p.gold.source === src), t = s.filter((x) => tokenP(x.r) !== null);
    if (s.length) console.log(`  ${src.padEnd(12)}right ${s.filter((x) => x.right).length}/${s.length}; stated ${f2(auroc(s.map((x) => ({ score: x.r.a.judgement.confidence, right: x.right }))))}${t.length ? `, token ${f2(auroc(t.map((x) => ({ score: tokenP(x.r)!, right: x.right }))))}` : ""}`);
  }

  // 4. Direction.
  const conflicts = rows.filter((r) => r.a.judgement.verdict === "conflict");
  const directed = conflicts.filter((r) => r.a.judgement.supersedes !== "unknown").length;
  console.log(`\n  ── direction ──\n  ${conflicts.length} conflict verdict(s), ${directed} name a side (${pct(directed, conflicts.length)}), ${conflicts.length - directed} undirected`);
  const acc = rows.filter((r) => r.p.gold.source === "proposal" && r.p.gold.label === "accepted");
  if (acc.length) {
    const right = acc.filter((r) => r.p.gold.source === "proposal" && r.a.judgement.verdict === "conflict" && r.a.judgement.supersedes === r.p.gold.direction).length;
    const unknown = acc.filter((r) => r.a.judgement.verdict === "conflict" && r.a.judgement.supersedes === "unknown").length;
    console.log(`  on the ${acc.length} accepted proposal(s): ${right} right side, ${unknown} undirected, ${acc.length - right - unknown} wrong side or not a conflict`);
  }

  // 5. What the pass would record from the candidates.
  const cand = rows.filter((r) => r.p.gold.source === "candidate");
  if (cand.length) {
    const recorded = cand.filter((r) => proposalVerdict(r.a.judgement) !== null && r.a.judgement.confidence >= minConfidence);
    const und = recorded.filter((r) => proposalVerdict(r.a.judgement) === "conflict_undirected").length;
    console.log(`\n  ── the pass's own population: ${cand.length} candidate pair(s) ──\n  ${recorded.length} would be recorded at --min-confidence ${minConfidence} (${pct(recorded.length, cand.length)}), ${und} of them undirected`);
  }

  // 6. Proposals judged on a text since edited, counted so a reader can discount them.
  const edited = rows.filter((r) => r.p.gold.source === "proposal" && r.p.gold.editedSince).length;
  if (edited) console.log(`\n  note: ${edited} proposal pair(s) have a side edited since the judge saw it; their label is the reviewer's on the older text`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  loadEnv();
  const args = process.argv.slice(2);
  const has = (n: string) => args.includes(`--${n}`);
  const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : undefined; };
  const int = (n: string, d: number) => { const v = flag(n); if (v === undefined) return d; const x = Number(v); if (!Number.isInteger(x) || x < 0) { console.error(`--${n} takes a whole number`); process.exit(2); } return x; };
  const evalBase = process.env.OB1_EVAL_BASE ?? process.env.OLLAMA_BASE;
  if (!process.env.OB1_LLM_BASE_URL && evalBase) process.env.OB1_LLM_BASE_URL = evalBase;

  if (has("self-check")) selfCheck();
  const exportTo = flag("export");
  if (exportTo) {
    await exportPairs(exportTo, int("per-relation", 40), int("candidates", 120));
    process.exit(0);
  }
  const pairsPath = flag("pairs");
  if (!pairsPath) { console.error("Pass --export <file> (with DATABASE_URL), --pairs <file>, or --self-check."); process.exit(2); }
  const limit = int("limit", 0);
  let pairs = readFileSync(pairsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as PairLine);
  if (limit) pairs = pairs.slice(0, limit);
  const replay = flag("replay");
  const answers = replay
    ? readFileSync(replay, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AnswerLine)
    : await judgeAll(pairs, flag("out") ?? `${pairsPath.replace(/\.jsonl$/, "")}.answers.jsonl`, int("concurrency", 3), flag("logprobs") ? int("logprobs", 10) : undefined);
  const minConfidence = flag("min-confidence") ? Number(flag("min-confidence")) : DEFAULT_MIN_CONFIDENCE;
  report(pairs, answers, minConfidence);
}
