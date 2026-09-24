#!/usr/bin/env bun
/**
 * eval-jev-gate.ts — SMD-1937's entity gate, run end to end against the
 * typed-decision tier (SMD-2050's second slice).
 *
 * The point is the Verify bullet: a consumer spike that runs against the tier
 * with no serving code of its own. This script holds none — it calls
 * server-portable/jev.ts, which calls whatever serves `ob1-jev/1` at
 * OB1_JEV_BASE_URL — and it reads its candidates from a brain's own entity
 * graph, the labelled set SMD-1937 names: the extractor's bare-numeric and
 * address-shaped entities are not entities, and the ones it typed `person` or
 * `place` are mistyped (SMD-1935). It measures; it decides nothing for the
 * extractor, and it writes nothing to the brain (one READ ONLY transaction).
 *
 * Cohorts, each entity with one window of the first thought that mentions it:
 *
 *   bad        name ~ ^[0-9.:]+$ — a migration number, a port, an address.
 *              A strong label: not a named entity (SMD-1935's own rule).
 *   positive   a tool, project or organization mentioned in >= 5 thoughts,
 *              whose name has a letter. A WEAK label — frequent is not the same
 *              as right — so its numbers bound the gate's false rejections from
 *              above, no more.
 *   typed      the `person` and `place` entities not already in `bad` (a
 *              numeric-named person is `bad` first), the most mentioned
 *              `--per-cohort`. No label: the layer SMD-1935 found ~90% noise,
 *              reported for a human to read, since a regex cannot judge
 *              "operator".
 *
 * Arms: the deterministic baseline (reject ^[0-9.:]+$, SMD-1935's proposed
 * gate — right on `bad` and `positive` by construction, which is why SMD-1937
 * asks for the ambiguous cases); the tier's binary validity decision; and its
 * choice over the entity types plus "a number, version, port or address" and
 * "a generic word or role". One framing each, stated below — framing is
 * SMD-1937's to tune (jev/README.md, "Conformance"): this is its first number,
 * not its conclusion.
 *
 *   bun eval-jev-gate.ts --url postgres://…/openbrain [--per-cohort 60]
 *
 * Needs OB1_JEV_BASE_URL (and OB1_JEV_LOCAL=1 for a tier on the box). Prints
 * aggregates and, for the `typed` cohort, names with their decisions — the
 * brain's own vocabulary, to stdout only; nothing is written to the tree.
 */

import { SQL } from "bun";
import { loadEnv } from "./env.ts";
import { ProviderError } from "../server-portable/embed.ts";
import { INSUFFICIENT_EVIDENCE, jevDecideMany, resolveJevConfig, type JevDecision, type JevEnv, type JevResult } from "../server-portable/jev.ts";

loadEnv();
const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const url = arg("--url") ?? process.env.DATABASE_URL;
const perCohort = Number(arg("--per-cohort") ?? 60);
const cfg = resolveJevConfig(process.env as JevEnv);
if (!url || !cfg || !Number.isInteger(perCohort) || perCohort < 1) {
  console.error("usage: OB1_JEV_BASE_URL=… OB1_JEV_LOCAL=1 bun eval-jev-gate.ts --url postgres://… [--per-cohort 60]");
  process.exit(2);
}

type Candidate = { cohort: "bad" | "positive" | "typed"; name: string; type: string; context: string; metadata: Record<string, unknown> };

/** One window of the thought around the first place it names the entity, else its head. */
function windowAround(text: string, name: string, span = 400): string {
  const at = text.toLowerCase().indexOf(name.toLowerCase());
  if (at < 0) return text.slice(0, 2 * span);
  return text.slice(Math.max(0, at - span), at + name.length + span);
}

async function candidates(): Promise<Candidate[]> {
  const sql = new SQL(url!);
  try {
    return await sql.begin("read only", async (tx) => {
      const rows = (await tx`
        WITH firsts AS (
          SELECT DISTINCT ON (e.id) e.id, e.name, e.entity_type, t.content, t.metadata,
                 count(*) OVER (PARTITION BY e.id) AS mentions
          FROM ob1_entities e
          JOIN thought_entities te ON te.entity_id = e.id
          JOIN thoughts t ON t.id = te.thought_id
          ORDER BY e.id, t.created_at
        )
        SELECT name, entity_type, content, metadata, mentions,
               CASE WHEN name ~ '^[0-9.:]+$' THEN 'bad'
                    WHEN entity_type IN ('person', 'place') THEN 'typed'
                    WHEN entity_type IN ('tool', 'project', 'organization') AND mentions >= 5 AND name ~ '[A-Za-z]' THEN 'positive'
               END AS cohort
        FROM firsts
      `) as { name: string; entity_type: string; content: string; metadata: Record<string, unknown> | null; mentions: number | string; cohort: Candidate["cohort"] | null }[];
      const out: Candidate[] = [];
      for (const cohort of ["bad", "positive", "typed"] as const) {
        const pick = rows.filter((r) => r.cohort === cohort).sort((a, b) => Number(b.mentions) - Number(a.mentions) || a.name.localeCompare(b.name));
        for (const r of pick.slice(0, perCohort)) out.push({ cohort, name: r.name, type: r.entity_type, context: windowAround(r.content, r.name), metadata: r.metadata ?? {} });
      }
      return out;
    });
  } finally {
    await sql.close();
  }
}

const TYPES = [
  { id: "tool", description: "a software tool, library, command or service" },
  { id: "project", description: "a project, repository or product" },
  { id: "person", description: "a specific named person" },
  { id: "organization", description: "a company, team or organization" },
  { id: "place", description: "a geographic place or location" },
  { id: "topic", description: "a subject or concept" },
  { id: "number", description: "a number, version, port or network address" },
  { id: "generic", description: "a generic word or role, not a specific name" },
];

const validity = (c: Candidate): JevDecision => ({
  kind: "binary",
  proposition: `"${c.name}" is the name of a specific tool, project, person, organization or place`,
  context: c.context,
});
const typing = (c: Candidate): JevDecision => ({ kind: "choice", question: `What is "${c.name}" in this note?`, options: TYPES, context: c.context });

/** Mann–Whitney AUROC of scores for positives above negatives (ties count half). */
function auroc(pos: number[], neg: number[]): number {
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return pos.length && neg.length ? wins / (pos.length * neg.length) : NaN;
}
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");
const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];

const all = await candidates();
// Each window leaves under its own thought's metadata, so a source/type/topic
// term the egress policy names applies to it (jevDecideMany: one subject a call);
// a row the policy refuses is counted and left out, not the end of the run.
const subject = (c: Candidate) => ({ kind: "decision" as const, actor: "eval-jev-gate", metadata: c.metadata });
const t0 = performance.now();
// One decision per request so the per-decision latency is measured, not a batch's share.
const answered: { c: Candidate; v: { p: number | null; abstained: boolean; ms: number }; t: JevResult }[] = [];
let refused = 0;
for (const c of all) {
  try {
    const t = performance.now();
    const { results } = await jevDecideMany(cfg!, [validity(c)], subject(c));
    const v = { p: results[0].p_true ?? null, abstained: results[0].abstained, ms: performance.now() - t };
    answered.push({ c, v, t: (await jevDecideMany(cfg!, [typing(c)], subject(c))).results[0] });
  } catch (e) {
    if (!(e instanceof ProviderError && e.kind === "egress")) throw e;
    refused++;
  }
}
const wall = performance.now() - t0;
const valid = answered.map((x) => x.v);

const cohort = (k: Candidate["cohort"]) => answered.filter((x) => x.c.cohort === k);
const bad = cohort("bad"), positive = cohort("positive"), typedLayer = cohort("typed");
const baselineRejects = (c: Candidate) => /^[0-9.:]+$/.test(c.name);
const rejects = (v: { p: number | null; abstained: boolean }) => v.abstained || (v.p ?? 0) < 0.5;
/** The choice arm rejects as the binary arm does: a number, a generic word, or an abstention. */
const CHOICE_REJECTS = ["number", "generic", INSUFFICIENT_EVIDENCE];

console.log(`\n${all.length} candidates from the brain${refused ? `, ${refused} refused by the egress policy and left out` : ""} (${bad.length} bad, ${positive.length} positive, ${typedLayer.length} person/place); tier ${cfg!.endpoint.base}; ${(wall / 1000).toFixed(1)} s\n`);
console.log("| arm | rejects bad (recall) | rejects positive (false rejections, weak label) |");
console.log("| --- | --- | --- |");
console.log(`| baseline ^[0-9.:]+$ | ${pct(bad.filter((x) => baselineRejects(x.c)).length, bad.length)} | ${pct(positive.filter((x) => baselineRejects(x.c)).length, positive.length)} |`);
console.log(`| tier, binary validity (p < 0.5 or abstained) | ${pct(bad.filter((x) => rejects(x.v)).length, bad.length)} | ${pct(positive.filter((x) => rejects(x.v)).length, positive.length)} |`);
console.log(`| tier, choice → number, generic or abstained | ${pct(bad.filter((x) => CHOICE_REJECTS.includes(x.t.selected)).length, bad.length)} | ${pct(positive.filter((x) => CHOICE_REJECTS.includes(x.t.selected)).length, positive.length)} |`);
const pv = (xs: typeof bad) => xs.map((x) => x.v.p ?? 0);
console.log(`\nbinary p_true: AUROC positive vs bad ${auroc(pv(positive), pv(bad)).toFixed(3)}; median bad ${quantile(pv(bad), 0.5)?.toFixed(3)}, median positive ${quantile(pv(positive), 0.5)?.toFixed(3)}; abstained ${pct(valid.filter((v) => v.abstained).length, valid.length)}`);
console.log(`choice: positives typed as the extractor typed them ${pct(positive.filter((x) => x.t.selected === x.c.type).length, positive.length)}; bad typed number ${pct(bad.filter((x) => x.t.selected === "number").length, bad.length)}`);
const ms = valid.map((v) => v.ms);
console.log(`latency, one binary decision per request: p50 ${quantile(ms, 0.5)?.toFixed(0)} ms, p95 ${quantile(ms, 0.95)?.toFixed(0)} ms`);

console.log("\nperson/place layer — the extractor's type, the tier's choice, P(named):");
for (const x of typedLayer) console.log(`  ${x.c.type.padEnd(6)} ${x.c.name.padEnd(28).slice(0, 28)} → ${x.t.selected.padEnd(12)} ${x.v.p === null ? "—" : x.v.p.toFixed(2)}`);
const agrees = typedLayer.filter((x) => x.t.selected === x.c.type).length;
console.log(`\nthe tier keeps the extractor's person/place type on ${agrees} of ${typedLayer.length}; it types ${typedLayer.filter((x) => CHOICE_REJECTS.includes(x.t.selected)).length} as number or generic, or abstains`);
