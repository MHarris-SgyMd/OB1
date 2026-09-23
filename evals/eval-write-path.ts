#!/usr/bin/env bun
/**
 * eval-write-path.ts — what survives capture into a later deliverable, and
 * which planted errors are caught, by which mechanism (Linear SMD-1713;
 * Phase 4 of SMD-1729, the third layer of the four SMD-1737 will report).
 *
 * Every other number under evals/ is retrieval (layer 1) or, since SMD-1719,
 * use (layer 2: did a later write cite what came back). This is layer 3, the
 * number the verification loop rests on: of what should have survived from a
 * session into a later deliverable, how much did; of the errors planted along
 * the way, how many were caught, and by what. GBrain's shape — sessions,
 * planted salient units, a rate before and after — copied small.
 *
 * The reduced first form, said so. The ticket's "deliverable that carries
 * citations" needs SMD-1715's `capture_deliverable`, which is not built, and
 * migration 042's `record_citation` has no MCP caller (SMD-1733 owns that
 * argument). On this fork today a deliverable is what SMD-1719 already scores
 * as a citation: a `capture_thought` whose `derived_from` names the returned
 * ids it used. That is what runs here; when 1715 lands the arm swaps the
 * tool and the scorer does not change.
 *
 * Keyless. The provider is scripted the way test-chunking.ts scripts it: a
 * `Bun.serve` answering `/embeddings` (one axis per fictional subject named
 * in the text, a hashed tie-break) and `/chat/completions` (the capture's
 * metadata, the extractor's entities, and the consolidation judge's verdict
 * by one blunt rule — numbers that differ under one subject conflict). The
 * real server is booted in-process against a throwaway Postgres; nothing
 * needs a model or a credential. So the judge measured here is the PLUMBING
 * from a verdict to a deliverable and the rule's own false positives, not a
 * model's catch rate — that number is eval-consolidate.ts's.
 *
 * The arms. `default` has every mechanism on; each other arm switches one
 * off at the memory side, never at the reader: `-supersedes` (the newer
 * decision never names the older, so the read has nothing to label),
 * `-judge` (no extraction and no consolidation pass, so no proposal),
 * `-actor` (the two keys never classified, so no `By:` kind). The reader is
 * one fixed policy over the hits (write-path.ts `decide`); a `blind` reader
 * that ignores every label runs once more so the gate can show its floor has
 * teeth, as db/test-replay.ts shows with random vectors.
 *
 *   ../db/with-postgres.sh bun eval-write-path.ts              # every arm, the report
 *   ../db/with-postgres.sh bun eval-write-path.ts --gate       # the default arm and the blind reader only; hold baselines.json's write_path floor (CI, the data-layer job)
 *   ../db/with-postgres.sh bun eval-write-path.ts --only -judge   # one arm, its observation as JSON
 *   bun eval-write-path.ts --self-check                        # the rules, probed with hand-known answers; no database
 *   bun eval-write-path.ts --record                            # every arm, then write the write_path section of baselines.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssert } from "../db/test-support.ts";
import { buildJudgeMessages, parseJudgement } from "../server-portable/consolidate.ts";
import { buildMessages as buildEntityMessages } from "../server-portable/entities.ts";
import { DELIVERABLES, ITEMS, READER_K, SESSIONS, SUBJECTS, type Item } from "./write-path-corpus.ts";
import {
  ARMS, MECHANISMS, STUB_DIM, armOff, caughtBy, compareToFloor, corpusLabel, corpusProblems, decide, floorOf, fnv1a, judgeRule, mcnemarExact, noiseBucket, numbersIn,
  pair, parseCapturedId, parseHits, parseProposalIds, ratesOf, ratio, renderDeliverable, renderReport, scoreArm, stubChat, subjectsIn, vectorFor,
  type Arm, type ArmScore, type Floor, type Hit, type Mechanism, type Observation, type Paired, type ReaderPolicy, type WritePathBaseline,
} from "./write-path.ts";

const HERE = import.meta.dir;
const BASELINES = join(HERE, "baselines.json");
const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const valueOf = (f: string): string | undefined => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
for (const a of args) {
  if (!["--gate", "--self-check", "--only", "--record"].includes(a) && !(args[args.indexOf(a) - 1] === "--only")) {
    console.error(`unknown argument ${a}; see the header for the four modes`);
    process.exit(2);
  }
}
if (has("--only") && (valueOf("--only") === undefined || valueOf("--only")!.startsWith("--"))) {
  console.error(`--only takes one of ${ARMS.join(", ")}; alone it would run everything and report something other than what was asked`);
  process.exit(2);
}

// ── Running an arm ──────────────────────────────────────────────────────────

async function runArm(url: string, arm: Arm, reader: ReaderPolicy): Promise<Observation> {
  const proc = Bun.spawn(["bun", join(HERE, "_write-path-arm.ts")], {
    env: { ...process.env, DATABASE_URL: url, OB1_WP_ARM: arm, OB1_WP_READER: reader },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  if (code !== 0 || !line) {
    console.error(err.slice(-3000));
    throw new Error(`the ${arm}/${reader} arm exited ${code}${line ? "" : " with no RESULT line"}`);
  }
  const summary = err.split("\n").find((l) => l.startsWith("SUMMARY "));
  if (summary) console.log(`  ${summary.slice(8)}`);
  return JSON.parse(line.slice(7)) as Observation;
}

type Run = { scores: ArmScore[]; paired: Paired[]; caught: Record<string, Mechanism[]>; blind: ArmScore };

/**
 * Every arm and the blind reader for the report and the record; for the
 * gate, the default arm and the blind reader only — the three other arms
 * produce the paired table, which the gate does not hold, and each is a
 * schema reset, thirty-six captures, two workers and twelve searches that
 * could fail the step for a reason the gate does not claim to guard.
 */
async function runAll(url: string, arms: readonly Arm[] = ARMS): Promise<Run> {
  const scores: ArmScore[] = [];
  for (const arm of arms) scores.push(scoreArm(await runArm(url, arm, "labels")));
  const blind = scoreArm(await runArm(url, "default", "blind"));
  const def = scores[0];
  const withouts = Object.fromEntries(MECHANISMS.filter((m) => scores.some((s) => s.arm === armOff(m))).map((m) => [m, scores.find((s) => s.arm === armOff(m))!]));
  const paired = MECHANISMS.filter((m) => withouts[m]).map((m) => pair(def, withouts[m], m));
  return { scores, paired, caught: caughtBy(def, withouts), blind };
}

function readBaseline(): WritePathBaseline | undefined {
  return (JSON.parse(readFileSync(BASELINES, "utf8")) as { write_path?: WritePathBaseline }).write_path;
}

function sectionFrom(run: Run): WritePathBaseline {
  const def = run.scores[0];
  // The floor is counts, not the three-place display value: rounded up,
  // 17/27 became 0.63 and the gate refused the very run it recorded; and the
  // denominator binds the population the gate must measure over.
  if (!def.survival.of || !def.catch.of || !def.coverage.of) throw new Error("the default arm has a rate with nothing under it; the record would hold no floor");
  const arms: WritePathBaseline["arms"] = {};
  for (const s of [...run.scores, run.blind]) {
    arms[s.reader === "blind" ? "default (blind reader)" : s.arm] = { ...ratesOf(s), contested: s.survival.contested, unseen_errors: s.catch.unseen, returned: s.returned, chars: s.chars };
  }
  return {
    via: "eval-write-path.ts --record",
    corpus: corpusLabel(),
    reader_k: READER_K,
    floor: floorOf(def),
    arms,
    paired: Object.fromEntries(run.paired.map((p) => [p.mechanism, { helped: p.helped.length, hurt: p.hurt.length, p: Math.round(p.p * 1000) / 1000 }])),
  };
}

// ── The self-check ──────────────────────────────────────────────────────────

/** A hit block as index.ts renders one, for the parser probes. */
function block(n: number, id: string, opts: { superseded?: string; by?: string; content: string }): string {
  const lines = [`--- Result ${n} (99.${n}% match) ---`, `ID: ${id}`];
  if (opts.superseded) lines.push(`⚠ Superseded by a newer thought — ID ${opts.superseded}`);
  lines.push(`Captured: 9/23/2026`, `Type: observation`);
  if (opts.by) lines.push(`By: ${opts.by}`);
  lines.push(`Topics: marzipan`, ``, opts.content);
  return lines.join("\n");
}
const uuid = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const hit = (n: number, o: Partial<Hit> = {}): Hit => ({ id: uuid(n), superseded: false, writer: null, content: `text ${n}`, ...o });

/** An Observation built by hand: `plainIds` presented plain, `contestedIds` contested, `hitIds` retrieved per subject. */
function fakeObservation(arm: Arm, presented: Record<string, "plain" | "contested" | "dropped" | "unseen">, opts: { uncite?: string[]; reader?: ReaderPolicy } = {}, items: readonly Item[] = ITEMS): Observation {
  const idOf: Record<string, string> = {};
  items.forEach((it, i) => { idOf[it.id] = uuid(i + 1); });
  const hits: Observation["hits"] = {};
  const bySubject = new Map<string, Item[]>();
  for (const it of items) bySubject.set(it.subject, [...(bySubject.get(it.subject) ?? []), it]);
  for (const [k, items] of bySubject) hits[k as keyof typeof SUBJECTS] = items.filter((it) => presented[it.id] !== "unseen").map((it) => idOf[it.id]);
  const deliverables = DELIVERABLES.map((spec) => {
    const lines = spec.subjects.flatMap((k) => (bySubject.get(k) ?? []).filter((it) => presented[it.id] === "plain" || presented[it.id] === "contested")
      .map((it) => ({ id: idOf[it.id], kind: presented[it.id] as "plain" | "contested", content: it.text, subject: k })));
    const derivedFrom = lines.map((l) => l.id).filter((id) => !(opts.uncite ?? []).some((u) => idOf[u] === id));
    return { title: spec.title, subjects: spec.subjects, lines, thoughtId: uuid(900 + DELIVERABLES.indexOf(spec)), derivedFrom, chars: 100 };
  });
  return { arm, reader: opts.reader ?? "labels", idOf, hits, deliverables, pendingProposals: 0, extracted: 0, ms: 0 };
}

/**
 * The default arm's expected presentation, item by item, derived from the
 * corpus and the rules — never typed by hand: a stale decision and an agent's
 * inference are dropped (superseded; an agent's word where the operator
 * spoke), an agent's true fact on such a subject is dropped too (the actor
 * arm's hurt case), and both sides of every same-subject pair the judge's rule
 * reads as a conflict are contested (the slips and their correct twins, and
 * the two true facts with different numbers) unless already dropped. Every
 * item is taken as retrieved; the live run's k cut is the live run's.
 */
type Expected = Record<string, "plain" | "contested" | "dropped" | "unseen">;
function expectedDefault(): Expected {
  const p: Expected = {};
  for (const it of ITEMS) p[it.id] = "plain";
  for (const it of ITEMS) {
    if (it.planted.kind === "stale") p[it.id] = "dropped";
    if (it.writer === "bot" && ITEMS.some((o) => o.subject === it.subject && o.writer === "op")) p[it.id] = "dropped";
  }
  for (let i = 0; i < ITEMS.length; i++) for (let j = i + 1; j < ITEMS.length; j++) {
    const a = ITEMS[i], b = ITEMS[j];
    // 029: a superseded thought is neither `me` nor a candidate, and the pair
    // (replacement, its own target) is never judged; every other pair is.
    if (a.subject !== b.subject || a.planted.kind === "stale" || b.planted.kind === "stale" || b.supersedes === a.id) continue;
    if (judgeRule(a.text, b.text).verdict !== "conflict") continue;
    for (const x of [a, b]) if (p[x.id] === "plain") p[x.id] = "contested";
  }
  return p;
}

function selfCheck(): void {
  const { assert, report } = createAssert();

  console.log("[1] The corpus holds its shape");
  const problems = corpusProblems();
  assert(problems.length === 0, `the committed corpus has no shape problem${problems.length ? `:\n    ${problems.join("\n    ")}` : ""}`);
  const broken = ITEMS.map((it) => ({ ...it }));
  broken[0] = { ...broken[0], text: "A note that names no subject at all." };
  assert(corpusProblems(broken).some((p) => /names no subject/.test(p)), "an item naming no subject is a problem");
  const twice = [...ITEMS, { ...ITEMS[0] }];
  assert(corpusProblems(twice).some((p) => /appears twice/.test(p)), "a duplicate id is a problem");
  const unref = ITEMS.map((it) => (it.id === "hs2" ? { ...it, supersedes: undefined } : it));
  assert(corpusProblems(unref).some((p) => /does not carry supersedes/.test(p)), "a stale decision whose replacement carries no supersedes is a problem");
  const digitDecision = ITEMS.map((it) => (it.id === "hs1" ? { ...it, text: "We decided the Harpsichord release ships as 1 bundle." } : it));
  assert(corpusProblems(digitDecision).some((p) => /carries a digit/.test(p)), "a decision with a digit is a problem (the judge would catch what supersedes should)");
  assert(corpusProblems(ITEMS, [DELIVERABLES[0]]).some((p) => /in no deliverable/.test(p)), "a subject in no deliverable is a problem");
  const sameText = ITEMS.map((it) => (it.id === "cb3" ? { ...it, text: ITEMS.find((o) => o.id === "cb1")!.text } : it));
  assert(corpusProblems(sameText).some((p) => /repeats cb1's text/.test(p)), "two items with one text are one row after the fingerprint: a problem");
  const loneInference = ITEMS.map((it) => (it.id === "ob2" ? { ...it, planted: { kind: "inference" as const, against: "ob1" } } : it));
  assert(corpusProblems(loneInference).some((p) => /where the operator never spoke/.test(p)), "an inference on an agent-only subject is uncatchable: a problem");
  const digitOnDecisionSubject = ITEMS.map((it) => (it.id === "hs3" ? { ...it, text: "The Harpsichord release notes are 3 pages in the shared folder." } : it));
  assert(corpusProblems(digitOnDecisionSubject).some((p) => /-supersedes arm would move the judge/.test(p)), "a digit on a subject with a decision pair couples the -supersedes arm to the judge: a problem");
  const crowdedSessions = [{ title: "Crowd", items: ["x1", "x2", "x3"].map((id) => ({ ...ITEMS[1], id, text: `The Quicksilver cache note ${id}.` })) }, ...SESSIONS];
  assert(corpusProblems(crowdedSessions.flatMap((s) => s.items), DELIVERABLES, crowdedSessions).some((p) => /more than the shipped/.test(p)), "a slip with more earlier neighbours than the shipped candidate count may miss its twin: a problem");
  const tied = ITEMS.map((it) => (it.id === "mz2" ? { ...it, text: ITEMS.find((o) => o.id === "mz1")!.text + " " } : it));
  assert(corpusProblems(tied).some((p) => /noise buckets/.test(p)), "two texts of one subject in one noise bucket tie for the query: a problem");
  assert(new Set(ITEMS.map((it) => noiseBucket(it.text))).size === ITEMS.length, "every committed text takes its own noise bucket");
  assert(ITEMS.filter((it) => it.subject === "marzipan").length > READER_K, `Project Marzipan has more items than the reader's k (${READER_K})`);
  assert(ITEMS.length >= 30 && SESSIONS.length >= 20, `${SESSIONS.length} sessions, ${ITEMS.length} items`);

  console.log("[2] The stub provider's rules");
  const v = vectorFor("Project Marzipan replaces the nightly export.");
  assert(v.length === STUB_DIM && v[0] === 1 && v.filter((x) => x !== 0).length === 2, "a text names its subject on that axis and one noise axis");
  const w = v.find((x, i) => i >= 12 && x !== 0)!;
  assert(w >= 0.02 && w < 0.1 && Math.abs(w - (0.02 + 0.08 * (noiseBucket("Project Marzipan replaces the nightly export.") / 1000))) < 1e-12, "the noise weight is the bucket's, in [0.02, 0.1)");
  assert(vectorFor("Project Marzipan").length === STUB_DIM && vectorFor("Project Marzipan")[0] === 1, "the query (the phrase alone) sits on the same axis");
  assert(vectorFor("nothing named here").filter((x) => x !== 0).length === 1, "a text naming no subject is noise alone");
  const d1 = vectorFor("The Quicksilver cache holds 4096 entries before it evicts."), d2 = vectorFor("The Quicksilver cache holds 2048 entries before it evicts.");
  assert(JSON.stringify(d1) !== JSON.stringify(d2) && d1[1] === 1 && d2[1] === 1, "two texts of one subject share the axis and differ in the tie-break");
  assert(JSON.stringify(vectorFor("Project Marzipan x")) === JSON.stringify(vectorFor("project marzipan X ")), "the tie-break ignores case and outer whitespace");
  assert(fnv1a("a") !== fnv1a("b") && fnv1a("") === 0x811c9dc5, "the hash is FNV-1a");
  assert(JSON.stringify(subjectsIn("Deliverable: the Zeppelin budget and Saffron onboarding")) === JSON.stringify(["zeppelin", "saffron"]), "a deliverable names several subjects, in the table's order");
  assert(JSON.stringify(numbersIn("40 thousand, 3 approvers")) === JSON.stringify(["40", "3"]) && numbersIn("no digits").length === 0, "numbersIn reads digit runs");
  assert(judgeRule("holds 4096 entries", "holds 2048 entries").verdict === "conflict" && judgeRule("holds 4096 entries", "holds 2048 entries").supersedes === "B", "different numbers under one subject: conflict, newer current");
  assert(judgeRule("ships as one bundle", "ships as two bundles").verdict === "agree", "no digits: agree (a decision is the supersedes arm's, not the judge's)");
  assert(judgeRule("holds 4096 entries", "is warmed daily").verdict === "agree", "a number against none: agree");
  assert(judgeRule("costs 40 thousand", "costs 40 thousand").verdict === "agree", "the same numbers: agree");
  assert(judgeRule("is 40 thousand for the quarter", "has 3 approvers").verdict === "conflict", "two true facts with different numbers: the rule fires — the planted false positive");
  const judgeAnswer = JSON.parse(stubChat([{ role: "user", content: "Compare…\n\nTHOUGHT A, captured 2026-09-01:\n<thought_a>\nholds 4096 entries\n</thought_a>\n\nTHOUGHT B, captured 2026-09-02:\n<thought_b>\nholds 2048 entries\n</thought_b>\n\nAnswer as JSON." }]));
  assert(judgeAnswer.verdict === "conflict" && judgeAnswer.supersedes === "B" && judgeAnswer.confidence === 0.9, "the chat stub answers the judge's prompt with the rule's verdict");
  const entities = JSON.parse(stubChat([{ role: "user", content: "Extract…\n<thought_content>\nThe Zeppelin budget is 40 thousand.\n</thought_content>\nReturn strict JSON" }]));
  assert(entities.entities.length === 1 && entities.entities[0].name === "the Zeppelin budget" && entities.entities[0].type === "project" && Array.isArray(entities.relationships), "the chat stub answers the extractor with the subject as one entity");
  const meta = JSON.parse(stubChat([{ role: "system", content: "Extract metadata…" }, { role: "user", content: "Saffron onboarding takes 5 sessions." }]));
  assert(meta.type === "observation" && JSON.stringify(meta.topics) === JSON.stringify(["saffron"]) && Array.isArray(meta.people), "the chat stub answers the metadata prompt with the subject as the topic");
  assert(JSON.parse(stubChat([{ role: "user", content: "no subject here" }])).topics[0] === "unplaced", "a text naming no subject still gets a topic (the prompt asks for at least one)");
  // The real prompts, not a sketch of them: both name their own delimiters in
  // their rules before the wrapped text, and the stub must read the text.
  const realEntities = JSON.parse(stubChat(buildEntityMessages("The Zeppelin budget is 40 thousand for the quarter.")));
  assert(realEntities.entities.length === 1 && realEntities.entities[0].name === "the Zeppelin budget", "the stub reads the extractor's REAL prompt: the wrapped text, not the rule that names the tags");
  const realJudge = parseJudgement(stubChat(buildJudgeMessages(
    { content: "The Quicksilver cache holds 4096 entries before it evicts.", createdAt: "2026-09-01T00:00:00Z", writer: "operator" },
    { content: "The Quicksilver cache holds 2048 entries before it evicts.", createdAt: "2026-09-02T00:00:00Z", writer: "operator" },
  )));
  assert(realJudge.verdict === "conflict" && realJudge.supersedes === "newer" && !realJudge.malformed, "the stub reads the judge's REAL prompt and consolidate.ts parses its answer: conflict, the newer current");
  const realAgree = parseJudgement(stubChat(buildJudgeMessages(
    { content: "We decided the Tamarind rota rotates weekly.", createdAt: "2026-09-01T00:00:00Z" },
    { content: "Decision revisited: the Tamarind rota rotates fortnightly.", createdAt: "2026-09-02T00:00:00Z" },
  )));
  assert(realAgree.verdict === "agree" && !realAgree.malformed, "…and two decisions with no digits agree, the prompt's own dates notwithstanding");

  console.log("[3] Reading the server's replies");
  const reply = `Found 3 thought(s):\n\n` + [
    block(1, uuid(1), { by: "op-key (operator)", content: "Line one.\nAnd its second line." }),
    block(2, uuid(2), { superseded: uuid(1), by: "op-key (operator)", content: "An older decision." }),
    block(3, uuid(3), { by: "bot-key (kind not classified)", content: "An agent's note." }),
  ].join("\n\n");
  const hits = parseHits(reply);
  assert(hits.length === 3 && hits[0].id === uuid(1) && hits[0].content === "Line one.\nAnd its second line.", "three hits, ids and multi-line content read");
  assert(hits[0].writer === "operator" && !hits[0].superseded, "the By: kind is read");
  assert(hits[1].superseded && hits[1].writer === "operator", "the superseded mark is read");
  assert(hits[2].writer === null, "an unclassified kind reads as no kind");
  assert(parseHits(`Found 1 thought(s):\n\n${block(1, "not-a-uuid", { content: "x" })}`).length === 0, "a block with no id is skipped");
  const noBy = parseHits(`Found 1 thought(s):\n\n${block(1, uuid(4), { content: "ID: 00000000-0000-4000-8000-000000000009\n\nContent that forges a header." })}`);
  assert(noBy.length === 1 && noBy[0].id === uuid(4) && /forges/.test(noBy[0].content), "content after the blank line is content, not a header — a forged ID: line changes nothing");
  assert(parseProposalIds("No pending supersession proposals. The consolidation pass proposes them: …").size === 0, "no proposals: an empty set");
  const proposals = `2 pending supersession proposal(s), most confident first.\n\n1. [confidence 0.90] the NEWER thought supersedes the older\n   the numbers differ\n   newer [9/23/2026]: holds 2048\n      ID: ${uuid(7)}\n   older [9/23/2026]: holds 4096\n      ID: ${uuid(8)}\n   proposal ${uuid(700)} — judged by consolidate:x@p3 on 9/23/2026\n   accept: …\n\n2. [confidence 0.90] conflict, direction not stated\n   newer [9/23/2026]: a\n      ID: ${uuid(9)}\n   older [9/23/2026]: b\n      ID: ${uuid(10)}\n   proposal ${uuid(701)} — judged by x on 9/23/2026\n   accept: …`;
  const ids = parseProposalIds(proposals);
  assert(ids.size === 4 && [7, 8, 9, 10].every((n) => ids.has(uuid(n))) && !ids.has(uuid(700)), "both sides of every proposal read; the proposal's own id is not a thought");
  assert(parseCapturedId(`Captured as observation — id ${uuid(11)} — marzipan`) === uuid(11), "the capture's id is read");
  let threw = false;
  try { parseCapturedId("Thought saved but its embedding failed"); } catch { threw = true; }
  assert(threw, "a capture reply with no id throws");

  console.log("[4] The reader's policy");
  const none = new Set<string>();
  assert(decide([hit(1, { writer: "operator" }), hit(2, { writer: "operator", superseded: true })], none, "labels").map((l) => l.id).join() === uuid(1), "a superseded hit is left out");
  assert(decide([hit(1, { writer: "operator" }), hit(2, { writer: "agent" })], none, "labels").map((l) => l.id).join() === uuid(1), "where the operator spoke, the agent's word is left out");
  assert(decide([hit(1, { writer: "agent" }), hit(2, { writer: "agent" })], none, "labels").length === 2, "where nobody contradicts the agent, its word stands");
  assert(decide([hit(1, { writer: null }), hit(2, { writer: null })], none, "labels").length === 2, "with no kinds (the -actor arm), nothing is dropped for its writer");
  assert(decide([hit(1, { writer: "operator", superseded: true }), hit(2, { writer: "agent" })], none, "labels").map((l) => l.id).join() === uuid(2), "a superseded operator's hit does not stand for the operator");
  const contested = decide([hit(1, { writer: "operator" }), hit(2, { writer: "operator" })], new Set([uuid(2)]), "labels");
  assert(contested[0].kind === "plain" && contested[1].kind === "contested", "a hit in a pending proposal is contested, not dropped");
  const blind = decide([hit(1, { writer: "operator", superseded: true }), hit(2, { writer: "agent" })], new Set([uuid(2)]), "blind");
  assert(blind.length === 2 && blind.every((l) => l.kind === "plain"), "the blind reader states every hit plain");
  const text = renderDeliverable(DELIVERABLES[0], { marzipan: [{ id: uuid(1), kind: "plain", content: "A." }, { id: uuid(2), kind: "contested", content: "B." }] });
  assert(/^Deliverable: Platform status\n\n## Project Marzipan\n- A\.\n- \(contested, pending review\) B\.\n\n## the Quicksilver cache\n- nothing on record/.test(text), "the deliverable renders a heading per subject, contested lines marked, an empty subject said");
  assert(JSON.stringify(subjectsIn(text)) === JSON.stringify(DELIVERABLES[0].subjects), "the deliverable's text names exactly its subjects, so its vector spans their axes");

  console.log("[5] The scorer's partitions");
  const exp = expectedDefault();
  const def = scoreArm(fakeObservation("default", exp));
  const salient = ITEMS.filter((it) => it.planted.kind === "salient").length;
  const errors = ITEMS.length - salient;
  assert(def.survival.of === salient && def.catch.of === errors && def.catch.unseen === 0, `every salient item (${salient}) and every retrieved error (${errors}) is scored`);
  const contestedTwins = ITEMS.filter((it) => it.planted.kind === "salient" && exp[it.id] === "contested").map((it) => it.id).sort().join(",");
  assert(contestedTwins === "md1,pw1,qs1,sf1,zp1,zp2", `the six true twins the judge's rule reaches are contested, not plain (${contestedTwins})`);
  assert(def.survival.n === salient - 8 && def.survival.contested === 6 && def.survival.dropped === 2, "survival: the six contested and the agent's two true facts (hs3, md3) are not plain");
  assert(def.catch.n === errors && Object.values(def.catch.byClass).every((r) => r.n === r.of && r.of === 3), "every error caught, three per class");
  assert(def.coverage.n === def.coverage.of && def.coverage.of === salient - 8 + 6 + 3, "every line — plain or contested — cites its source; dropped items are no line");
  const dropOne = scoreArm(fakeObservation("default", { ...exp, mz1: "dropped" }));
  assert(dropOne.survival.n === def.survival.n - 1 && dropOne.survival.dropped === def.survival.dropped + 1, "a salient fact dropped from its deliverable costs survival one");
  const unseen = scoreArm(fakeObservation("default", { ...exp, mz2: "unseen", qs2: "unseen" }));
  assert(unseen.survival.unseen === 1 && unseen.survival.n === def.survival.n - 1, "a salient fact never retrieved is lost as unseen");
  assert(unseen.catch.unseen === 1 && unseen.catch.of === errors - 1 && unseen.catch.n === errors - 1, "an error never retrieved is counted beside the catch rate, not inside it");
  assert(!unseen.outcome.qs2.counted && !unseen.outcome.qs2.right && unseen.outcome.mz2.counted && !unseen.outcome.mz2.right, "an unseen error is outside the catch population (not counted, not right); an unseen fact is counted and lost");
  const elsewhere = fakeObservation("default", exp);
  elsewhere.hits.marzipan = [...(elsewhere.hits.marzipan ?? []), elsewhere.idOf.qs1];
  elsewhere.hits.quicksilver = (elsewhere.hits.quicksilver ?? []).filter((id) => id !== elsewhere.idOf.qs1);
  assert(!scoreArm(elsewhere).outcome.qs1.retrieved, "retrieved means the search for ITS subject returned it, not any search");
  const plainError = scoreArm(fakeObservation("default", { ...exp, hs1: "plain" }));
  assert(plainError.catch.n === errors - 1 && plainError.catch.byClass.stale.n === 2 && !plainError.outcome.hs1.right, "an error stated plain is not caught");
  const uncited = scoreArm(fakeObservation("default", exp, { uncite: ["mz1", "cb1"] }));
  assert(uncited.coverage.n === def.coverage.n - 2 && uncited.coverage.of === def.coverage.of, "a line whose source is not in derived_from is uncovered");
  let scoreThrew = false;
  try { const o = fakeObservation("default", exp); delete o.idOf.mz1; scoreArm(o); } catch { scoreThrew = true; }
  assert(scoreThrew, "an item the runner never mapped is a run fault, and throws");
  const twicePlain = fakeObservation("default", exp);
  twicePlain.deliverables[0].lines.push({ ...twicePlain.deliverables[0].lines[0], kind: "contested" });
  assert(scoreArm(twicePlain).survival.n === def.survival.n, "a thought stated plain anywhere is stated plain, whatever another line says");

  console.log("[6] Pairing and attribution");
  const noSupersedes = scoreArm(fakeObservation("-supersedes", { ...exp, hs1: "plain", tm1: "plain", ln2: "plain" }));
  const p1 = pair(def, noSupersedes, "supersedes");
  assert([...p1.helped].sort().join() === "hs1,ln2,tm1" && p1.hurt.length === 0, `supersedes helped the three stale decisions and hurt nothing (${p1.helped.join(",")} / ${p1.hurt.join(",")})`);
  assert(p1.errors.helped === 3 && p1.facts.helped === 0 && p1.unpaired.length === 0, "the split says the three were errors");
  const unseenThere = scoreArm(fakeObservation("-supersedes", { ...exp, hs1: "unseen", tm1: "plain", ln2: "plain" }));
  const pu = pair(def, unseenThere, "supersedes");
  assert(pu.unpaired.join() === "hs1" && [...pu.helped].sort().join() === "ln2,tm1", "an error one arm never retrieved is unpaired, not credited to the mechanism");
  assert(caughtBy(def, { supersedes: unseenThere }).hs1.length === 0 && caughtBy(def, { supersedes: unseenThere }).tm1.join() === "supersedes", "…and attribution skips it too");
  assert(p1.p === 0.25, "McNemar exact over 3 helped / 0 hurt is 0.25");
  // Without the judge nothing is contested: the three slips stand plain (uncaught), the six twins return to plain.
  const noJudge = scoreArm(fakeObservation("-judge", Object.fromEntries(Object.entries(exp).map(([k, v]) => [k, v === "contested" ? "plain" : v])) as Expected));
  const p2 = pair(def, noJudge, "judge");
  assert([...p2.helped].sort().join() === "md2,qs2,sf2" && p2.hurt.length === 6, `the judge helped the three slips and hurt the six true twins it contested (${p2.helped.join(",")} / ${p2.hurt.join(",")})`);
  assert(p2.errors.helped === 3 && p2.errors.hurt === 0 && p2.facts.helped === 0 && p2.facts.hurt === 6, "the split: the judge's help is all errors, its hurt all facts");
  assert(Math.abs(p2.p - 0.508) < 0.001, "McNemar exact over 3 helped / 6 hurt is 0.508");
  // Without the actor's kind: the two unnumbered inferences stand plain, the agent's two true facts stand plain, and pw2 is contested by the judge instead of dropped.
  const noActor = scoreArm(fakeObservation("-actor", { ...exp, gr2: "plain", ln4: "plain", hs3: "plain", md3: "plain", pw2: "contested" }));
  const p3 = pair(def, noActor, "actor");
  assert([...p3.helped].sort().join() === "gr2,ln4" && [...p3.hurt].sort().join() === "hs3,md3", `the actor mark helped the two unnumbered inferences and hurt the agent's two true facts (${p3.helped.join(",")} / ${p3.hurt.join(",")})`);
  const caught = caughtBy(def, { supersedes: noSupersedes, judge: noJudge, actor: noActor });
  assert(caught.hs1.join() === "supersedes" && caught.qs2.join() === "judge" && caught.gr2.join() === "actor", "each error's mechanism is the one whose removal lets it through");
  assert(caught.pw2.length === 0 && def.outcome.pw2.right && noActor.outcome.pw2.right && noJudge.outcome.pw2.right, "an error caught by two mechanisms at once (pw2: the actor drops it, the judge contests it) names neither");
  assert(mcnemarExact(0, 0) === 1 && mcnemarExact(1, 0) === 1 && mcnemarExact(5, 0) === 0.0625 && Math.abs(mcnemarExact(8, 2) - 0.109375) < 1e-9, "McNemar's exact test on hand-known values");
  let mcThrew = false;
  try { mcnemarExact(1001, 0); } catch { mcThrew = true; }
  assert(mcThrew, "past 1,000 discordant pairs the exact sum is refused");
  let pairThrew = false, caughtThrew = false;
  try { const o = scoreArm(fakeObservation("-judge", exp)); delete o.outcome.mz1; pair(def, o, "judge"); } catch { pairThrew = true; }
  try { const o = scoreArm(fakeObservation("-judge", exp)); delete o.outcome.qs2; caughtBy(def, { judge: o }); } catch { caughtThrew = true; }
  assert(pairThrew && caughtThrew, "an item scored in one arm and not the other is a fault, for the pairing and the attribution alike");

  console.log("[7] The floor, and the ticket's mutant");
  const floor: Floor = floorOf(def);
  assert(floor.survival.n === def.survival.n && floor.survival.of === 27 && floor.catch.of === 9 && floor.unseenErrors === 0, "the floor is counts: 27 facts, 9 errors, no error unseen");
  assert(compareToFloor(def, floor).length === 0, "the default arm holds its own floor");
  const grownItems = [...ITEMS, { ...ITEMS[0], id: "x9", text: "Project Marzipan has a ninth note." }];
  const grown = scoreArm(fakeObservation("default", { ...exp, x9: "plain" }, {}, grownItems), grownItems);
  assert(compareToFloor(grown, floor).some((f) => /^survival: measured over 28 item\(s\), recorded over 27/.test(f)), "a corpus that grew is not the recorded population, even at a higher rate");
  const hidden = scoreArm(fakeObservation("default", { ...exp, qs2: "unseen" }));
  const hiddenFailures = compareToFloor(hidden, floor);
  assert(hiddenFailures.some((f) => /^catch: measured over 8/.test(f)) && hiddenFailures.some((f) => /^unseen errors: 1/.test(f)), "an error that stopped being retrieved fails by population and by the unseen ceiling, though the rate stayed 1");
  const mutant = scoreArm(fakeObservation("default", { ...exp, mz3: "dropped" }));
  const failures = compareToFloor(mutant, floor);
  // The dropped line is also one citation fewer, so coverage's population moves too — two failures, both true.
  assert(failures.some((f) => /^survival: .* below the recorded/.test(f)) && failures.every((f) => /^(survival|coverage):/.test(f)), `one planted fact dropped from its deliverable fails the survival floor (${failures.join("; ")})`);
  assert(compareToFloor(plainError, floor).some((f) => /^catch:/.test(f)), "an error stated plain fails the catch floor");
  assert(compareToFloor(uncited, floor).some((f) => /^coverage:/.test(f)), "an uncited line fails the coverage floor");
  const better = scoreArm(fakeObservation("default", { ...exp, qs1: "plain" }));
  assert(compareToFloor(better, floor).length === 0, "a rate above the floor passes; the floor is a floor");
  const empty = scoreArm({ ...fakeObservation("default", exp), deliverables: [] });
  assert(compareToFloor(empty, floor).some((f) => /^coverage: measured over 0/.test(f)), "a run with no lines is not the recorded population");
  assert(compareToFloor(empty, { ...floor, coverage: { n: 0, of: 0 } }).some((f) => /^coverage: nothing to measure/.test(f)), "a rate with nothing under it never passes silently");
  const blindRun = scoreArm(fakeObservation("default", Object.fromEntries(ITEMS.map((it) => [it.id, "plain" as const])), { reader: "blind" }));
  assert(blindRun.catch.n === 0 && blindRun.catch.of === errors && blindRun.survival.n === salient, "the blind reader catches nothing and states everything — the floor's teeth");
  const recorded = readBaseline();
  assert(recorded !== undefined && recorded.floor.survival.of > 0 && recorded.floor.catch.of > 0 && recorded.floor.coverage.of > 0, "baselines.json carries a write_path floor as counts");
  assert(recorded !== undefined && recorded.reader_k === READER_K && recorded.corpus === corpusLabel(), "the record names this corpus and the reader's k");

  const rendered = renderReport([def, noJudge], [p2], caught);
  assert(/^arm\s+reader\s+survival/.test(rendered) && /judge\s+3\s+6\s+0\.508\s+0\/6\s+3\/0/.test(rendered) && /qs2\s+wrong_number\s+judge/.test(rendered), "the report renders the arms, the paired row with its split, and the attribution");

  report();
}

// ── Modes ───────────────────────────────────────────────────────────────────

if (has("--self-check")) {
  selfCheck();
} else {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun eval-write-path.ts");
    process.exit(2);
  }
  const only = valueOf("--only");
  if (only !== undefined) {
    if (!(ARMS as readonly string[]).includes(only)) { console.error(`--only takes one of ${ARMS.join(", ")}`); process.exit(2); }
    const obs = await runArm(url, only as Arm, "labels");
    const s = scoreArm(obs);
    console.log(renderReport([s], [], {}));
    console.log(JSON.stringify(obs, null, 1));
    process.exit(0);
  }
  const gate = has("--gate");
  console.log(`write-path eval: ${corpusLabel()}, stub dim ${STUB_DIM}; one process per arm${gate ? "; the gate runs the default arm and the blind reader" : ""}\n`);
  if (gate) {
    // The corpus's own shape first: the gate must not measure a corpus the
    // rules would refuse (the self-check runs in another job).
    const problems = corpusProblems();
    if (problems.length) { console.error(`the corpus breaks its shape rules:\n  ${problems.join("\n  ")}`); process.exit(1); }
  }
  const run = await runAll(url, gate ? ["default"] : ARMS);
  console.log("");
  console.log(renderReport([...run.scores, run.blind], run.paired, run.caught));
  if (has("--record")) {
    const all = JSON.parse(readFileSync(BASELINES, "utf8")) as Record<string, unknown>;
    all.write_path = sectionFrom(run);
    writeFileSync(BASELINES, JSON.stringify(all, null, 2) + "\n");
    console.log(`\nwrote the write_path section of ${BASELINES}`);
  }
  if (has("--gate")) {
    const recorded = readBaseline();
    if (!recorded) { console.error("\nbaselines.json has no write_path section; run --record once."); process.exit(2); }
    const { assert, report } = createAssert();
    const f = recorded.floor;
    console.log(`\n[gate] the default arm against the recorded floor (survival ${f.survival.n}/${f.survival.of}, catch ${f.catch.n}/${f.catch.of}, coverage ${f.coverage.n}/${f.coverage.of}, ${f.unseenErrors} error(s) unseen)`);
    assert(recorded.reader_k === READER_K && recorded.corpus === corpusLabel(), `the floor was recorded on this corpus at this k (recorded "${recorded.corpus}", k=${recorded.reader_k})`);
    const failures = compareToFloor(run.scores[0], f);
    assert(failures.length === 0, `the default arm holds the floor${failures.length ? `: ${failures.join("; ")}` : ""}`);
    const blindCatch = ratio(run.blind.catch), ownCatch = ratio(run.scores[0].catch), floorCatch = ratio(f.catch);
    assert(blindCatch !== null && ownCatch !== null && floorCatch !== null && blindCatch < floorCatch && blindCatch < ownCatch,
      `the floor has teeth: a reader that ignores every label catches ${blindCatch === null ? "n/a" : (100 * blindCatch).toFixed(0) + "%"}, below the recorded ${floorCatch === null ? "n/a" : floorCatch.toFixed(3)} and below this run's labelled reader`);
    assert(run.blind.survival.n >= run.scores[0].survival.n, "…and states at least as many facts plain, so the labels are what the catch costs");
    report();
  }
}
