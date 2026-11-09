#!/usr/bin/env bun
/**
 * eval-priority.ts — does a read put what matters first? (SMD-3662.)
 *
 * The rules, the corpus, the score, the mutant and the pre-registered bar are
 * evals/priority.ts's; this file runs them.
 *
 *   bun eval-priority.ts --self-check
 *       Every rule against hand-known answers, the corpus against its
 *       registered hash, the dogfood rows' shape. No database, no model.
 *
 *   ../db/with-postgres.sh bun eval-priority.ts --seeded
 *       Refuses a corpus that is not the registered one. Resets the schema at
 *       DATABASE_URL (test-support's guards: refuseHeldDatabase refuses a
 *       database holding thoughts unless OB1_FIXTURE_RESET=1, and resetSchema
 *       a non-loopback one unless OB1_ALLOW_REMOTE_DB=1), plants the seeded
 *       corpus (priority.ts's plantRows) and the facts beside it (plantFacts,
 *       read back against the plan), and runs every prompt through each
 *       baseline read — a search tool called through the server's own core,
 *       the query embedded by its embedder through a stub provider on
 *       loopback — and each measured read. Prints the per-prompt hits, the
 *       table, the shuffled-gold mutant beside chance, the bar a priority read
 *       must clear against this baseline, and each measured read's verdict.
 *       Exits 1 when fewer rows are planted than items, when the database
 *       does not hold the planted facts (a fact dropped, or a statement 122
 *       would not count), when a baseline read errors or returns more than
 *       READ_K hits, when a baseline read's scores differ from priority.ts's
 *       BASELINE, when the gold ceiling errors or cannot clear the bar, when a
 *       measured read reads the answer or the answer-moved check misses the
 *       ceiling, when the dogfood rows are not sound, or when the mutant does
 *       not sit at chance for a baseline read or the ceiling. Keyless: no
 *       provider is called.
 *
 *   ../db/with-postgres.sh bun eval-priority.ts --seeded --priority-weight 0.7,0.9
 *       The same run, with SMD-3668's priority_weight also measured at each
 *       weight listed (0 to 1, comma-separated), each as an exploratory read
 *       named priority_weight@<weight>. The pre-registered read still runs and
 *       gives the verdict. An exploratory read is scored, checked for reading
 *       the answer and printed against the bar, but its line says it is no
 *       verdict: a sweep over these prompts picks nothing (BAR's rule).
 *
 * The reads are priority.ts's READS, today's main as the baseline (plain,
 * current, filter), and its MEASURED: SMD-3669's agenda and SMD-3668's
 * priority_weight at its pre-registered 0.5 (which sees the tickets' levels
 * and none of the notes' facts: priority.ts's Facts), and the run prints each
 * one's verdict against the baselines of the
 * same run. A measured read's verdict does not fail the run; the gold
 * ceiling's, which runs the same path, does.
 *
 * The dogfood rows (fixtures/priority-dogfood.json) are recorded by hand in
 * the session that asked, and printed beside the seeded table.
 */

import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssert, heldRefusal, refuseHeldDatabase, resetSchema } from "../db/test-support.ts";
import { SqlStore } from "../server-portable/store-sql.ts";
import { hashKey } from "../server-portable/auth.ts";
import { mcpClient, mcpUnderTest, servedByMcpServer } from "../server-portable/test-support.ts";
import {
  BACKGROUND, BAR, CHANCE_TOLERANCE, NOISE_AXES, ITEMS, PROMPTS, READ_K, REGISTERED_CORPUS, STUB_DIM, STUB_MODEL,
  BASELINE, DOGFOOD_READS, MEASURED, PRIORITY_WEIGHT, PRIORITY_WEIGHT_READ, priorityWeightRead, READS, baselineDrift as driftOf, idsOfAnswer, mutantTriples, itemId, measuredIds, plantRows, plantFacts, plannedFacts, plannedNoteReads, readNoteReads, factPlan, dayFrom, dueInstant, seedRow, withAnswerMoved, barOn, baselineDrift, chanceOf, corpusHash, registeredSection, registeredSource, corpusProblems, dogfoodProblems, goldRanks, kendallTauB, meanScore, meanTriple, renderTable, scorePrompt, shuffledScore, stubVector, verdict, wordsOf,
  type DogfoodRow, type Item, type MeasureInput, type PlantedFacts, type MeasuredRead, type PromptScore, type SearchTool,
} from "./priority.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The read key's name: the key the eval's reads run under, never the claimant or the operator. */
const READ_KEY = "priority-eval";
const DOGFOOD_PATH = join(HERE, "fixtures", "priority-dogfood.json");

/**
 * The gold order itself, run as a measured read: the bar's reachability (the
 * run fails when it cannot clear the bar) and the measured path's control,
 * exercised on every seeded run before a priority read exists. The one read
 * that sees the gold, so it lives here, not in priority.ts's MEASURED.
 */
const CEILING: MeasuredRead = {
  name: "gold (ceiling)", ticket: "SMD-3662",
  run: async ({ query }) => PROMPTS.find((q) => q.query === query)!.gold.map((k) => itemId(ITEMS.findIndex((it) => it.key === k))),
};

/** The fixture's rows as written, unchecked: dogfoodProblems says what is wrong with them. */
const loadDogfood = (): unknown => (JSON.parse(readFileSync(DOGFOOD_PATH, "utf8")) as { rows?: unknown }).rows;


function renderDogfood(rows: readonly DogfoodRow[]): string {
  const day = (d: number) => `${Math.floor(d / 10000)}-${String(Math.floor(d / 100) % 100).padStart(2, "0")}-${String(d % 100).padStart(2, "0")}`;
  const rank = (r: number | null) => (r === null ? "not recorded" : r === 0 ? "absent" : String(r));
  const lines = ["| date | pick | picked instead | read: rank of the pick |", "| --- | --- | --- | --- |"];
  for (const r of rows) {
    const reads = Object.entries(r.reads).map(([n, v]) => `${n} ${rank(v.rank)}`).join("; ");
    lines.push(`| ${day(r.date)} | SMD-${r.pick} | ${r.picked_instead === null ? "–" : `SMD-${r.picked_instead}`} | ${reads} |`);
  }
  return lines.join("\n");
}

async function selfCheck(): Promise<void> {
  const { assert, report } = createAssert();

  console.log("[1] The corpus");
  const corpus = corpusProblems();
  // (withAnswerMoved is probed in [4b], below the mutant.)
  assert(corpus.length === 0, `the seeded corpus is sound${corpus.length ? `: ${corpus.join("; ")}` : ""}`);
  assert(BAR.top1Min === 5 / 7 && BAR.top1Gain === 2 && BAR.tauGain === 0.25, "the bar is the one pre-registered on 2026-11-02 (5 of 7, +2, +0.25): changing it is a decision recorded on SMD-3662, never part of a re-registration");
  assert(corpusHash() === REGISTERED_CORPUS, `the corpus and priority.ts's registered section are the ones registered (${corpusHash()} = ${REGISTERED_CORPUS}); a change is a new registration, with its baseline re-run`);
  const reg = registeredSource();
  const fileText = readFileSync(join(HERE, "priority.ts"), "utf8");
  assert(["export const STUB_DIM", "export function stubVector(", "export function kendallTauB(", "export function scorePrompt(", "export function barOn(", "export function verdict(", "export const BAR ", "export const READ_K", "export const READS"].every((x) => reg.includes(x)) && !reg.includes("export function dogfoodProblems(") && !reg.includes("export const BASELINE") && !reg.includes("export const MEASURED"),
    "the registration hashes the stub, the score, the mutant, the bar and the baseline reads' knobs, and not the measured reads, the dogfood rows or the recorded baseline");
  assert(registeredSection(fileText.replace(/\r?\n/g, "\r\n")) === registeredSection(fileText) && registeredSection(fileText) === reg, "a CRLF checkout of priority.ts yields the same registered section, so the same hash");
  assert(READS.every((r) => BASELINE[r.name] !== undefined) && Object.keys(BASELINE).every((n) => READS.some((r) => r.name === n)), "every baseline read has a recorded baseline, and every recorded baseline a read");
  const names = [...READS, ...MEASURED, CEILING].map((r) => r.name);
  const boardRetext = ITEMS.map((it) => (it.issue ? { ...it, text: `${it.text} (rendered another way)` } : it));
  assert(corpusHash(boardRetext) === corpusHash(), "a board row's rendered text is not registered: a change to board-sync's adapter moves no registration (BASELINE's drift check says if it moved the numbers)");
  assert(corpusHash(ITEMS.map((it, i) => (i === 0 ? { ...it, text: `${it.text} Again.` } : it))) !== corpusHash(), "a personal item's text is registered");
  const zq = seedRow(ITEMS.find((i) => i.key === "zq-urgent")!, 0);
  assert(zq.metadata.source === "linear" && zq.metadata.issue === "ZQ-101" && zq.metadata.status_type === "unstarted" && zq.metadata.priority === "Urgent" && zq.metadata.genre !== undefined && zq.content.startsWith("ZQ-101 — "), "a board row is planted as board-sync writes it: issueFacets' metadata (source, issue, status, priority, genre) and renderIssue's text");
  assert(Object.keys(seedRow(ITEMS[0], 0).metadata).length === 0, "a personal row carries no tracker facets");
  // The facts planted beside the rows (SMD-3669 PR 2): every board item recorded as board-sync records it, the
  // claimed one another agent's; every personal note an open item, its day, done and level from its facts.
  const plan = factPlan(ITEMS, "2026-02-27");
  const at = (key: string) => plan.items.find((p) => ITEMS[p.index].key === key);
  assert(plan.board.length === ITEMS.filter((i) => i.issue).length && plan.items.length === ITEMS.filter((i) => !i.issue).length && JSON.stringify(plan.claims) === JSON.stringify(["ZQ-103"]),
    `the plan records every board item, opens every personal note as an item (chatter too), and claims the claimed ticket alone (${plan.board.length}, ${plan.items.length}, ${plan.claims})`);
  assert(at("bill")?.due === "2026-02-28" && at("gutters")?.due === "2026-02-13" && at("renewal")?.due === "2026-03-29" && at("cat")?.due === null && at("claim-done")?.done === true && at("bill")?.done === false
      && at("passport")?.level === 4 && at("coffee")?.level === 0 && at("cat")?.level === null && at("commitment")?.actor === "priority-eval-meeting-notes" && at("bill")?.actor === "priority-eval-operator",
    "an item's day is the run's day moved by its facts, in calendar days across a month's end; done and the level are its facts'; its writer opens it");
  assert(dayFrom("2028-02-28", 1) === "2028-02-29" && dayFrom("2026-03-01", -1) === "2026-02-28" && dueInstant("2026-02-28") === "2026-03-01T00:00:00Z",
    "a day moves across a leap day and back across a month; a bare due day is held as the next day's start in UTC");
  const facts = plannedFacts(ITEMS, "2026-02-27");
  const named = [
    "source linear ZQ-101 on zq-urgent", "statement on ticket:ZQ-101 level 4 tier 2 by board-sync due none not_before none due_ref none",
    "statement on ticket:ZQ-102 level 3 tier 2 by board-sync due none not_before none due_ref none", "statement on ticket:ZQ-106 level 1 tier 2 by board-sync due none not_before none due_ref none",
    "link zq-urgent linear blocks ZQ-104", "link zq-blocked linear blocked_by ZQ-101", "claim ZQ-103 piece none by priority-eval-other-agent",
    "item from bill open due 2026-03-01T00:00:00Z by priority-eval-operator", "item from gutters open due 2026-02-14T00:00:00Z by priority-eval-operator",
    "item from claim-done done due none by priority-eval-operator", "item from commitment open due 2026-03-03T00:00:00Z by priority-eval-meeting-notes",
    "statement on item:passport level 4 tier 1 by priority-eval-operator due none not_before none due_ref none",
    "statement on item:coffee level 0 tier 1 by priority-eval-operator due none not_before none due_ref none",
  ];
  assert(facts.length === 31 && named.every((l) => facts.includes(l)) && !facts.some((l) => l.startsWith("statement on ticket:ZQ-108")) && JSON.stringify([...facts].sort()) === JSON.stringify(facts),
    `the facts a seeded database must hold, each by its value: eight sources, seven ticket levels from the items' facts (No priority states none), the blocks link from both sides, one claim, ten items with their due instants (a bare day's end, the next day's start), three item levels (${facts.length}: ${facts.slice(0, 2).join("; ")}…)`);
  const zqLevels = ITEMS.filter((it) => it.issue && it.facts.level !== undefined).map((it) => `${it.issue!.identifier} ${it.facts.level}`);
  assert(zqLevels.join(",") === "ZQ-101 4,ZQ-102 3,ZQ-103 3,ZQ-104 3,ZQ-105 2,ZQ-106 1,ZQ-107 3" && zqLevels.every((l) => facts.some((f) => f.startsWith(`statement on ticket:${l.replace(" ", " level ")} `))),
    `every ticket's planned level is its facts', so a mapping change in board-sync's writer is a difference, not a shared move (${zqLevels})`);
  // The facts, not the label: a High whose facts state 0, and one whose facts state none, plan 0 and no statement
  // (review pass 3: every fixture ticket's facts equal its label's mapping, so the row above could not tell).
  const relabelled = ITEMS.map((it) => (it.key === "zq-high" ? { ...it, facts: { ...it.facts, level: 0 } } : it.key === "zq-medium" ? { ...it, facts: { ...it.facts, level: undefined } } : it));
  const off = plannedFacts(relabelled, "2026-02-27");
  assert(off.includes("statement on ticket:ZQ-102 level 0 tier 2 by board-sync due none not_before none due_ref none") && !off.some((l) => l.startsWith("statement on ticket:ZQ-105")),
    "a ticket's planned level follows its facts against its Linear label: a High stated 0 plans 0, a Medium with no level plans none");
  // What each note reads as a thought once 125 reads its open items (SMD-4149's first Verify, held at every seeded run).
  const notes = plannedNoteReads(ITEMS, "2026-02-27");
  const noteNamed = [
    "bill 4: unknown 2; urgency soon 2 item:bill", "gutters 5: unknown 2; overdue 3 item:gutters", "passport 4: from_items 4 item:passport",
    "commitment 3: unknown 2; urgency week 1 item:commitment", "renewal 2: unknown 2", "claim-done 2: unknown 2", "coffee 0: from_items 0 item:coffee", "cat 2: unknown 2",
  ];
  assert(notes.length === 10 && noteNamed.every((l) => notes.includes(l)) && JSON.stringify([...notes].sort()) === JSON.stringify(notes),
    `each note as a thought: the bill due tomorrow +2, the gutters overdue +3, the passport its item's level 4, the commitment +1 within the week, the renewal a month off nothing, a done item nothing, a level 0 its 0 (${notes.join("; ")})`);
  // A level 0 takes no urgency, and a done item passes its level and due time nowhere (no corpus note has either alone).
  const edge = plannedNoteReads([{ ...ITEMS[0], key: "zero-due", facts: { level: 0, dueInDays: -2 } }, { ...ITEMS[0], key: "done-high", facts: { level: 4, dueInDays: 0, done: true } }], "2026-02-27");
  assert(JSON.stringify(edge) === JSON.stringify(["done-high 2: unknown 2", "zero-due 0: from_items 0 item:zero-due"]),
    `a note whose item is at level 0 and overdue reads 0, no overdue; a done item at level 4 due today gives nothing (${edge.join("; ")})`);
  assert(new Set(names).size === names.length, "no two reads, baseline or measured, share a name");
  const dup: Item[] = [...ITEMS, ITEMS[0]];
  assert(corpusProblems(dup).some((p) => p.includes("listed twice")), "a repeated item key is refused");
  assert(corpusProblems(ITEMS, [{ key: "x", query: "q", gold: ["nope"] }]).some((p) => p.includes("names nope")), "a gold naming no item is refused");
  assert(corpusProblems([{ ...ITEMS[0], key: "dated", text: "Due on 2026-11-03." }], []).some((p) => p.includes("digit")), "a date in an item's text is refused: times are words, so vectors never move with the run's date");
  assert(corpusProblems(ITEMS, [{ key: "x", query: "q", gold: ["bill", "bill"] }]).some((p) => p.includes("twice")), "a gold listing an item twice is refused");
  const settled = (key: string) => { const f = ITEMS.find((i) => i.key === key)?.facts; return !!f && (f.done === true || f.claimed === true || (f.blockedBy?.length ?? 0) > 0); };
  for (const p of PROMPTS) assert(!p.gold.some(settled), `prompt ${p.key}'s gold holds nothing done, claimed or blocked`);
  const topics = { personal: ["bill", "renewal", "passport", "commitment", "gutters", "claim-done"], chatter: ["coffee", "documentary", "cat", "bookshelf"] };
  assert([...topics.personal, ...topics.chatter, "zq-urgent", "zq-high", "zq-claimed", "zq-blocked", "zq-medium", "zq-low", "zq-done", "zq-nopri"].every((k) => ITEMS.some((i) => i.key === k)), "the ticket's list is all there: bill, renewal, a \"this matters\", a meeting's commitment, an overdue task, one done, chatter, and a board with a blocker and a claim");

  console.log("[2] The stub embedder");
  assert(JSON.stringify(wordsOf("What's due on the 3rd? Pay ZQ-101!")) === JSON.stringify(["due", "rd", "pay", "zq"]), "words are letters only, lowercased, past the stop list");
  const v = stubVector(ITEMS[0].text);
  assert(v.length === STUB_DIM && Math.abs(Math.hypot(...v) - 1) < 1e-9, "a vector is unit length at the stub's width");
  assert(JSON.stringify(stubVector(ITEMS[0].text)) === JSON.stringify(v), "a text's vector is the same every call");
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
  const bg = BACKGROUND ** 2 / (BACKGROUND ** 2 + 1);
  const unrelated = dot(stubVector("electric bill", STUB_DIM, "query"), stubVector("gutters downpipe"));
  assert(unrelated > 0.3 && unrelated > bg - 0.01 && unrelated <= bg + 1e-12, `a query and a text sharing no word sit at the background's cosine, about ${bg.toFixed(2)} (${unrelated.toFixed(4)}), well above 0, which threshold 0 drops`);
  assert(dot(stubVector("electric bill", STUB_DIM, "query"), stubVector("the electric bill is due")) > unrelated + 0.2, "a text sharing the query's words sits nearer than one sharing none");
  const tieA = dot(stubVector("x", STUB_DIM, "query"), stubVector("gutters downpipe"));
  const tieB = dot(stubVector("x", STUB_DIM, "query"), stubVector("coffee flat white"));
  assert(tieA !== tieB, "two texts unrelated to a query are told apart by their noise weight, not left to the reads' tie-break by id");
  assert(stubVector("electric bill", STUB_DIM, "query").slice(STUB_DIM - NOISE_AXES).every((x) => x === 0), "a query carries no noise");
  assert(Math.abs(Math.hypot(...stubVector("the of and")) - 1) < 1e-12, "a text of stop words alone is the background and its noise, at unit length");
  console.log("[3] The score");
  assert(kendallTauB([1, 2, 3], [1, 2, 3]) === 1 && kendallTauB([1, 2, 3], [3, 2, 1]) === -1, "tau is 1 for the gold order and -1 for its reverse");
  assert(Math.abs(kendallTauB([1, 2, 3], [1, 11, 11])! - 2 / Math.sqrt(6)) < 1e-12, "tau-b with two items left out (tied at 11) is 2/sqrt(6)");
  assert(kendallTauB([1, 2, 3], [11, 11, 11]) === null && kendallTauB([1], [1]) === null, "tau is undefined when every item is left out, or there is one");
  assert(JSON.stringify(goldRanks(["a", "x", "b"], ["b", "a", "c"])) === JSON.stringify([3, 1, READ_K + 1]), "a gold item's rank is its place among the hits, READ_K + 1 when absent");
  const hits11 = Array.from({ length: 11 }, (_, i) => `h${i}`);
  assert(goldRanks(hits11, ["h10"])[0] === READ_K + 1, "a hit past the top READ_K counts as absent");
  const s = scorePrompt(["x", "a", "b"], ["a", "b"]);
  assert(!s.top1 && s.top3 && s.tau === 1, "gold first at rank 2: not top-1, top-3, and tau 1 (its order kept)");
  assert(scorePrompt(["a"], ["a"]).tau === null, "a one-item gold has no tau");
  const m = meanScore([{ top1: true, top3: true, tau: null }, { top1: false, top3: true, tau: 0.5 }, { top1: false, top3: false, tau: null }], [["a", "b"], ["a", "b"], ["a"]]);
  assert(m.top1 === 1 / 3 && m.top3 === 2 / 3 && m.tau === 0.25 && m.tauPrompts === 2, "means: top-1 and top-3 over every prompt; tau over two-item golds, a null there 0");

  console.log("[4] The shuffled-gold mutant");
  const gold = ["a", "b", "c", "d", "e"];
  const perfect = shuffledScore(gold, gold);
  const ch = chanceOf(gold, gold);
  assert(ch.top1 === 1 / 5 && ch.top3 === 3 / 5 && ch.tau === 0, "chance for the perfect read on a five-item gold: 1/5, 3/5, 0");
  assert(Math.abs(perfect.top1 - ch.top1) <= CHANCE_TOLERANCE && Math.abs(perfect.top3 - ch.top3) <= CHANCE_TOLERANCE && Math.abs(perfect.tau) <= CHANCE_TOLERANCE,
    `the perfect read against a shuffled gold scores chance (${perfect.top1.toFixed(3)}, ${perfect.top3.toFixed(3)}, ${perfect.tau.toFixed(3)})`);
  assert(JSON.stringify(shuffledScore(gold, gold)) === JSON.stringify(perfect), "the mutant's shuffles are seeded: the same every run");
  // Teeth: an order-blind score (is the first hit any gold item?) run through the same mutant scores far from chance.
  const orderBlind = (h: readonly string[], g: readonly string[]) => ({ ...scorePrompt(h, g), top1: g.includes(h[0]) });
  const blind = shuffledScore(gold, gold, orderBlind);
  assert(Math.abs(blind.top1 - ch.top1) > CHANCE_TOLERANCE, `an order-blind top-1 through the mutant scores ${blind.top1.toFixed(3)} against chance's ${ch.top1.toFixed(3)}: the mutant tells them apart`);
  const junk = shuffledScore(["x", "y", "z"], gold);
  assert(junk.top1 === 0 && junk.top3 === 0, "a read that retrieves no gold item scores 0 shuffled or not");

  const twin = mutantTriples([gold, gold], [gold, gold]);
  assert(JSON.stringify(twin[0]) !== JSON.stringify(twin[1]), "two prompts with one gold and one read are shuffled apart (a seed each), so their errors don't add up");

  console.log("[4b] The answer moved, and put back");
  const before = JSON.stringify({ g: PROMPTS.map((p) => p.gold), f: ITEMS.map((i) => i.facts) });
  const registered = PROMPTS.map((p) => [...p.gold]);
  const inside = await withAnswerMoved(async () => ({ golds: PROMPTS.map((p) => [...p.gold]), facts0: ITEMS[0].facts, facts1: ITEMS[1].facts }));
  assert(inside.golds.every((g, i) => g.length > 0 && g.every((k) => !registered[i].includes(k))) && inside.facts0 === ITEMS[1].facts && inside.facts1 === ITEMS[2].facts,
    "inside withAnswerMoved every gold, one-item golds included, shares no item with the registered one, and each item holds the next item's facts");
  assert(JSON.stringify({ g: PROMPTS.map((p) => p.gold), f: ITEMS.map((i) => i.facts) }) === before, "after it, every gold and fact is back as registered");
  await withAnswerMoved(async () => { throw new Error("x"); }).catch(() => undefined);
  assert(JSON.stringify({ g: PROMPTS.map((p) => p.gold), f: ITEMS.map((i) => i.facts) }) === before && corpusHash() === REGISTERED_CORPUS, "a read that throws inside it still leaves the answer put back");

  console.log("[5] The bar");
  const golds = PROMPTS.map((p) => p.gold);
  const none: PromptScore[] = PROMPTS.map(() => ({ top1: false, top3: false, tau: 0 }));
  const all: PromptScore[] = PROMPTS.map((p) => ({ top1: true, top3: true, tau: p.gold.length >= 2 ? 1 : null }));
  assert(verdict(all, [none], golds).helped, "a read with every gold first, against a baseline with none, helps");
  const same = verdict(all, [all], golds);
  assert(!same.helped && same.failed.some((f) => f.startsWith("(b)")) && same.failed.some((f) => f.startsWith("(c)")), "a read no better than the baseline fails (b) and (c)");
  const fiveOf7 = all.map((x, i) => (i < 5 ? x : { top1: false, top3: true, tau: x.tau }));
  assert(verdict(fiveOf7, [none], golds).helped, `top-1 on 5 of 7 meets (a) at ${BAR.top1Min.toFixed(3)}`);
  const fourOf7 = all.map((x, i) => (i < 4 ? x : { top1: false, top3: true, tau: x.tau }));
  assert(verdict(fourOf7, [none], golds).failed.some((f) => f.startsWith("(a)")), "top-1 on 4 of 7 fails (a)");
  const regress = all.map((x, i) => (i === 6 ? { top1: false, top3: false, tau: x.tau } : x));
  const baseKeeps = none.map((x, i) => (i === 6 ? { top1: false, top3: true, tau: 0 } : x));
  assert(verdict(regress, [baseKeeps], golds).failed.some((f) => f.startsWith("(d) prompt 7")), "a prompt a baseline kept in the top 3 and the read lost fails (d)");
  assert(verdict(all, [none, all], golds).failed.some((f) => f.startsWith("(b)")), "the bar reads the BEST baseline: one strong baseline read is enough to fail (b)");

  const recorded = BASELINE.plain;
  const asRecorded: PromptScore[] = PROMPTS.map((p) => ({ top1: recorded.top1.includes(p.key), top3: recorded.top3.includes(p.key), tau: null }));
  assert(driftOf("plain", asRecorded).length === 1 && driftOf("plain", asRecorded)[0].startsWith("plain tau"), "the drift check reads tau: prompts as recorded, a tau that differs is drift");
  const swapped = asRecorded.map((x, i) => (PROMPTS[i].key === "due-soon" ? { ...x, top3: false } : PROMPTS[i].key === "this-week" ? { ...x, top3: true } : x));
  assert(swapped.filter((x) => x.top3).length === recorded.top3.length && driftOf("plain", swapped).some((d) => d.startsWith("plain top3 on")), "a top-3 count that holds while its prompts change is drift: the bar's (d) reads which prompts");
  assert(driftOf("nobody", asRecorded).length === 1, "a read with no record is drift");

  console.log("[5c] The held-database guard");
  assert(heldRefusal(18, undefined, "--seeded") !== null && heldRefusal(18, "0", "--seeded") !== null, "a database holding thoughts is refused without OB1_FIXTURE_RESET=1");
  assert(heldRefusal(18, "1", "--seeded") === null && heldRefusal(0, undefined, "--seeded") === null, "it is let through with OB1_FIXTURE_RESET=1, or when it holds none");

  console.log("[6] The baseline reads are the tools, called over MCP");
  const argsOf = (name: string) => READS.find((r) => r.name === name)!.args;
  assert(READS.find((r) => r.name === "plain")!.tool === "search" && Object.keys(argsOf("plain")).length === 0, "plain is the search tool, the query alone");
  assert(argsOf("current").prefer_current === true && Object.keys(argsOf("current")).length === 1, "current is search_thoughts with prefer_current, its other arguments the tool's defaults");
  assert((argsOf("filter").filter as Record<string, unknown>)?.priority === "High" && Object.keys(argsOf("filter")).length === 1, "filter is search_thoughts with the workaround's filter alone");
  assert(READ_K === 10, `the score reads ${READ_K} hits; --seeded fails when a baseline read returns more, which the score would not read`);
  assert(JSON.stringify(idsOfAnswer("search", { results: [{ id: "a" }, { id: "b" }] })) === '["a","b"]' && JSON.stringify(idsOfAnswer("search_thoughts", { hits: [{ id: "c" }] })) === '["c"]', "a tool's answer is read for its ids: search's results, search_thoughts' hits");
  assert(JSON.stringify(measuredIds(["a", "b", "a", "c"])) === JSON.stringify(["a", "b", "c"]) && measuredIds(Array.from({ length: 15 }, (_, i) => `x${i}`)).length === READ_K, "a measured read's ids are scored once each, first occurrence kept, the top READ_K");
  const sent: { tool: SearchTool; args: Record<string, unknown> }[] = [];
  const pwIds = await PRIORITY_WEIGHT_READ.run({ query: "q", embedding: [], store: null as unknown as SqlStore, callTool: async (tool, args) => { sent.push({ tool, args }); return ["a", "b"]; } });
  assert(PRIORITY_WEIGHT === 0.5 && sent.length === 1 && sent[0].tool === "search_thoughts" && JSON.stringify(sent[0].args) === JSON.stringify({ query: "q", priority_weight: 0.5 }) && JSON.stringify(pwIds) === '["a","b"]',
    "priority_weight is search_thoughts at the weight pre-registered on SMD-3668 (0.5), its other arguments the tool's defaults, its hits as the tool returns them: a changed weight is a new pre-registration, never a re-run");
  const sentAt: Record<string, unknown>[] = [];
  const at7 = priorityWeightRead(0.7, "priority_weight@0.7");
  await at7.run({ query: "q", embedding: [], store: null as unknown as SqlStore, callTool: async (_tool, args) => { sentAt.push(args); return []; } });
  assert(at7.name === "priority_weight@0.7" && at7.ticket === "SMD-3668" && JSON.stringify(sentAt) === JSON.stringify([{ query: "q", priority_weight: 0.7 }]), "an exploratory read sends its own weight under its own name; the pre-registered read keeps 0.5 (above)");
  const ew = (raw: string | undefined) => exploratoryWeights(raw);
  const weightsOf = (raw: string) => { const r = ew(raw); return "weights" in r ? JSON.stringify(r.weights) : `error: ${r.error}`; };
  assert(weightsOf("0.7,0.9") === "[0.7,0.9]" && weightsOf(" 0 , 1 ") === "[0,1]", "--priority-weight reads weights from 0 to 1, comma-separated, in the order given");
  assert(["", "1.2", "-0.1", "x", "0.7,", "NaN", "Infinity"].every((raw) => "error" in ew(raw)) && "error" in ew(undefined), "--priority-weight refuses no value, a value outside 0 to 1, and one that is no number");
  assert(weightsOf("0.7,0.7").includes("twice") && weightsOf("0.9,0.5").includes("pre-registered"), "--priority-weight refuses a weight listed twice, and the pre-registered one, which always runs");

  console.log("[7] The dogfood rows");
  const raw = loadDogfood();
  const sound = dogfoodProblems(raw);
  assert(sound.length === 0, `the committed rows are sound${sound.length ? `: ${sound.join("; ")}` : ""}`);
  const rows = raw as DogfoodRow[];
  assert(dogfoodProblems(undefined).some((p) => p.includes("not an array")) && dogfoodProblems({ 0: rows[0] }).some((p) => p.includes("not an array")), "a fixture with no rows array is reported, not thrown on");
  const noPick = dogfoodProblems([{ ...rows[0], pick: undefined as unknown as number, picked_instead: undefined as unknown as number }]);
  assert(noPick.some((p) => p.includes("pick is not")) && !noPick.some((p) => p.includes("pick itself")), "a row missing its pick says so, and not that its alternative is the pick itself");
  assert(dogfoodProblems([null, rows[0]]).some((p) => p.includes("not an object")), "a row that is not an object, before another, is reported, not thrown on");
  assert(dogfoodProblems([{ ...rows[0], reads: { plian: { rank: 0 } } }]).some((p) => p.includes("plian")), "a read name outside DOGFOOD_READS is refused, so rows stay comparable read by read");
  assert([...READS, ...MEASURED].every((r) => DOGFOOD_READS.includes(r.name)), `every seeded read, baseline and measured, is a name a dogfood row may use (${DOGFOOD_READS.join(", ")})`);
  assert(rows.length >= 2 && rows[0].pick === 2888 && rows[0].picked_instead === 2540 && rows[1].pick === 2908 && rows[1].picked_instead === 1853, "the ticket's two cases are its first rows: SMD-2888 over SMD-2540 (10-14), SMD-2908 over SMD-1853 (11-02)");
  assert(dogfoodProblems([{ ...rows[0], date: 20261314 }]).some((p) => p.includes("date")), "a row's date must be a real YYYYMMDD day");
  assert(dogfoodProblems([{ ...rows[0], pick: "SMD-2888" as unknown as number }]).some((p) => p.includes("pick")), "a pick is the ticket's number, not its key (check 9 allows numbers and ids)");
  assert(dogfoodProblems([{ ...rows[0], reads: { plain: { rank: -1 } } }]).some((p) => p.includes("rank")), "a negative rank is refused: 0 is absent, ranks start at 1");
  assert(dogfoodProblems([{ ...rows[0], reads: { plain: { rank: 1.5 } } }]).some((p) => p.includes("rank")), "a fractional rank is refused");
  assert(dogfoodProblems([{ ...rows[0], thought: "1bb25732" }]).some((p) => p.includes("thought")), "the session's thought is a full id");
  assert(dogfoodProblems([rows[1], rows[0]]).some((p) => p.includes("date order")), "rows are appended in date order, never re-sorted");
  assert(dogfoodProblems([{ ...rows[0], reads: { plain: null as unknown as { rank: number } } }]).some((p) => p.includes("not an object")), "a read recorded as null is reported, not thrown on");
  assert(dogfoodProblems([{ ...rows[0], picked_instead: rows[0].pick }]).some((p) => p.includes("pick itself")), "a row whose alternative is its pick is refused");

  report();
}

/**
 * --priority-weight's value: the weights to measure SMD-3668's read at beside the pre-registered one, each once, in the
 * order given. Refused: no value, a value that is not a number from 0 to 1, a weight listed twice, and the
 * pre-registered weight, which always runs.
 */
export function exploratoryWeights(raw: string | undefined): { weights: number[] } | { error: string } {
  if (raw === undefined || raw.trim() === "") return { error: "--priority-weight takes weights from 0 to 1, comma-separated (e.g. 0.7,0.9)" };
  const weights: number[] = [];
  for (const part of raw.split(",")) {
    const w = Number(part.trim());
    if (part.trim() === "" || !Number.isFinite(w) || w < 0 || w > 1) return { error: `--priority-weight: ${JSON.stringify(part.trim())} is not a weight from 0 to 1` };
    if (w === PRIORITY_WEIGHT) return { error: `--priority-weight: ${w} is the pre-registered weight, which always runs` };
    if (weights.includes(w)) return { error: `--priority-weight: ${w} is listed twice` };
    weights.push(w);
  }
  return { weights };
}

/** The value after --priority-weight, or after --priority-weight=; undefined when the flag is absent, "" when it has none. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const next = args[i + 1];
  return next === undefined || next.startsWith("--") ? "" : next;
}

async function seeded(explore: readonly number[] = []): Promise<void> {
  // SMD-3668's read at each weight asked for, exploratory: measured as the others are, never the verdict.
  const exploratory = explore.map((w) => priorityWeightRead(w, `priority_weight@${w}`));
  const measured = [...MEASURED, ...exploratory];
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun eval-priority.ts --seeded"); process.exit(2); }
  const problems = corpusProblems();
  if (problems.length) { console.error(`the corpus is not sound: ${problems.join("; ")}`); process.exit(2); }
  if (corpusHash() !== REGISTERED_CORPUS) {
    console.error(`the corpus is ${corpusHash()}, not the registered ${REGISTERED_CORPUS}: a verdict holds only at the registration (re-register, and re-run the baseline, as --self-check says)`);
    process.exit(1);
  }
  await refuseHeldDatabase(url, "--seeded");
  // resetSchema refuses a non-loopback database unless OB1_ALLOW_REMOTE_DB=1 (test-support's guard).
  await resetSchema(url, { dim: STUB_DIM, model: STUB_MODEL });

  const sql = new SQL({ url, max: 1 });
  const seeds = ITEMS.map((it, i) => seedRow(it, i));
  const keyOf = new Map(seeds.map((row, i) => [row.id, ITEMS[i].key] as const));
  let planted = 0;
  let facts: PlantedFacts = [];
  let noteReads: string[] = [];
  let today = "";
  const factStore = new SqlStore(url, { max: 1 });
  try {
    planted = await plantRows(sql, seeds);
    // Before the facts, whose writers would refuse a missing row first and hide the count (review pass 3).
    if (planted !== ITEMS.length) throw new Error(`planted ${planted} of ${ITEMS.length} rows under the eval's writers`);
    // The facts on the database's own day, so the urgency windows the reads compute agree with the plan's days;
    // to_char, so the session's DateStyle never shapes it.
    today = String(((await sql`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d`)[0] as { d: string }).d);
    facts = await plantFacts(sql, factStore, ITEMS, seeds, today);
    // SMD-4149's first Verify: each note asked as a thought reads its open item's level and due time.
    noteReads = await readNoteReads(sql, ITEMS, seeds);
  } finally {
    await factStore.close();
    await sql.close();
  }
  const want = plannedFacts(ITEMS, today);
  // As sorted arrays, so a fact planted twice is a difference too; the message names each side's lines the other lacks.
  const less = (a: readonly string[], b: readonly string[]) => { const left = [...b]; return a.filter((l) => { const i = left.indexOf(l); if (i < 0) return true; left.splice(i, 1); return false; }); };
  const missing = less(want, facts), extra = less(facts, want);
  if (JSON.stringify(facts) !== JSON.stringify(want)) { console.error(`the database holds the facts otherwise than planned: missing ${JSON.stringify(missing)}; not planned ${JSON.stringify(extra)}`); process.exit(1); }
  const wantNotes = plannedNoteReads(ITEMS, today);
  if (JSON.stringify(noteReads) !== JSON.stringify(wantNotes)) {
    console.error(`effective_priority reads the notes otherwise than SMD-4149's rule: missing ${JSON.stringify(less(wantNotes, noteReads))}; not planned ${JSON.stringify(less(noteReads, wantNotes))}`);
    process.exit(1);
  }

  // The provider the server's own embedder calls: the stub's query vector for each input (the model is one
  // db/config.mjs has no prompt for, so the server sends the query bare), on loopback.
  const provider = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as { input: string | string[]; model: string };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({ data: inputs.map((text, index) => ({ index, embedding: stubVector(text, STUB_DIM, "query") })), model: body.model });
    },
  });
  // The server, in-process (the write-path gate's pattern, _write-path-arm.ts): every OB1_* knob the parent set goes
  // but the throwaway guard's, so the server boots on this eval's own; then its MCP server and REST core, a read key.
  for (const k of Object.keys(process.env)) if (k.startsWith("OB1_") && k !== "OB1_ALLOW_REMOTE_DB" && k !== "OB1_FIXTURE_RESET") delete process.env[k];
  for (const k of ["MCP_ACCESS_KEY", "OPENROUTER_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) delete process.env[k];
  const KEY_RAW = "priority-eval-read";
  Object.assign(process.env, {
    DATABASE_URL: url, OB1_LLM_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, OB1_LLM_LOCAL: "1",
    OB1_EMBEDDING_MODEL: STUB_MODEL, OB1_EMBEDDING_DIM: String(STUB_DIM), OB1_LLM_TIMEOUT: "10",
    MCP_ACCESS_KEYS: `${READ_KEY}:read:${hashKey(KEY_RAW)}`,
  });
  const worker = await mcpUnderTest();
  if (!servedByMcpServer()) { console.error("the server under test is not the MCP server (mcp-server/stack.ts)"); process.exit(1); }
  // The server's request lines (one per tool call, timestamped) out of the eval's output: their times differ from run
  // to run. Loaded by a path read at run time, as mcpUnderTest loads the stack: telemetry.ts reaches OpenTelemetry,
  // which only the stack's own install carries (test-server's rule on db/ and evals/ imports).
  const telemetry = "../server-portable/telemetry.ts";
  ((await import(telemetry)) as { useRequestLog: (next: (line: string) => void) => unknown }).useRequestLog(() => {});
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: worker.fetch });
  const client = mcpClient(`http://127.0.0.1:${server.port}`, KEY_RAW);
  const store = new SqlStore(url, { max: 1 });
  /** A search tool over MCP, as a client calls it; its ids from the structured answer, best first. A refusal throws. */
  const callTool = async (tool: SearchTool, args: Record<string, unknown>): Promise<string[]> => {
    const body = (await client.rpc("tools/call", { name: tool, arguments: args })) as { error?: unknown; result?: { isError?: boolean; structuredContent?: unknown; content?: { text?: string }[] } };
    if (body.error) throw new Error(`${tool}: JSON-RPC error ${JSON.stringify(body.error)}`);
    const text = (body.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    if (body.result?.isError) throw new Error(`${tool} refused: ${text.slice(0, 300)}`);
    if (body.result?.structuredContent === undefined) throw new Error(`${tool} answered with no structured content`);
    return idsOfAnswer(tool, body.result.structuredContent);
  };
  const vectorOf = new Map(PROMPTS.map((p) => [p.query, stubVector(p.query, STUB_DIM, "query")] as const));
  const toKeys = (ids: readonly string[]) => ids.map((id) => keyOf.get(id) ?? `?${id}`);
  /** One pass of a measured read over every prompt: its hits as item keys, and the errors it raised, by prompt. */
  const runMeasured = async (r: MeasuredRead, pass: string): Promise<{ hits: string[][]; errors: string[] }> => {
    const out = { hits: [] as string[][], errors: [] as string[] };
    for (const p of PROMPTS) {
      const input: MeasureInput = { query: p.query, embedding: vectorOf.get(p.query)!, store, callTool };
      try {
        // Each id once, the top READ_K: what the score reads, and all the table shows.
        out.hits.push(toKeys(measuredIds(await r.run(input))));
      } catch (e) {
        out.errors.push(`measured read ${r.name}${pass} on ${p.key}: ${e instanceof Error ? e.message : String(e)}`);
        out.hits.push([]);
      }
    }
    return out;
  };
  const results = new Map<string, { hits: string[][]; scores: PromptScore[] }>();
  const errors: string[] = [];
  const answerReaders: string[] = [];
  const deeper: string[] = [];
  try {
    for (const r of READS) {
      const hits: string[][] = [];
      for (const p of PROMPTS) {
        // A baseline read that errors fails the run, below: a baseline that never ran would set the bar.
        // Its prompt is scored as no hits meanwhile, so the table still prints.
        try {
          const ids = await callTool(r.tool, { ...r.args, query: p.query });
          if (ids.length > READ_K) deeper.push(`${r.name} on ${p.key}: ${ids.length}`);
          hits.push(toKeys(ids));
        } catch (e) {
          errors.push(`baseline read ${r.name} on ${p.key}: ${e instanceof Error ? e.message : String(e)}`);
          hits.push([]);
        }
      }
      results.set(r.name, { hits, scores: hits.map((h, i) => scorePrompt(h, PROMPTS[i].gold)) });
    }
    // The reads measured against the bar, the gold ceiling last: one that errors on a prompt scores it false, false, 0.
    for (const r of [...measured, CEILING]) {
      const first = await runMeasured(r, "");
      errors.push(...first.errors);
      results.set(r.name, { hits: first.hits, scores: first.hits.map((h, i) => scorePrompt(h, PROMPTS[i].gold)) });
    }
    // Each measured read again with the answer moved: one whose ids move with it reads the answer. The ceiling is the control.
    // A pass that errors is reported as an error, not compared: an error is not a sign of reading the answer.
    for (const r of [...measured, CEILING]) {
      const again = await withAnswerMoved(() => runMeasured(r, " (answer moved)"));
      if (again.errors.length) { errors.push(...again.errors); continue; }
      if (JSON.stringify(again.hits) !== JSON.stringify(results.get(r.name)!.hits)) answerReaders.push(r.name);
    }
  } finally {
    await store.close();
    server.stop(true);
    provider.stop(true);
  }

  const golds = PROMPTS.map((p) => p.gold);
  console.log(`priority eval, seeded: ${ITEMS.length} items, ${PROMPTS.length} prompts, corpus ${corpusHash()}, stub ${STUB_MODEL} @ ${STUB_DIM}\n`);
  // The days are the run's own; the effective values hold on any day (SMD-4149).
  console.log(`Each note asked as a thought (effective_priority, SMD-4149: its open item's level and due time, as planned):\n${noteReads.map((l) => `  ${l}`).join("\n")}\n`);
  for (const [i, p] of PROMPTS.entries()) {
    console.log(`${p.key}: "${p.query}"\n  gold     ${p.gold.join(" > ")}`);
    for (const r of [...READS, ...measured]) {
      const { hits, scores } = results.get(r.name)!;
      const sc = scores[i];
      console.log(`  ${r.name.padEnd(8)} ${hits[i].join(", ") || "(nothing)"}  [top-1 ${sc.top1 ? "yes" : "no"}, top-3 ${sc.top3 ? "yes" : "no"}, tau ${sc.tau === null ? "–" : sc.tau.toFixed(3)}]`);
    }
  }

  const table = [...READS, ...measured, CEILING].map((r) => ({ name: r.name, ...results.get(r.name)! })).map((r) => ({
    read: r.name,
    score: meanScore(r.scores, golds),
    mutant: meanTriple(mutantTriples(r.hits, golds), golds),
    chance: meanTriple(r.hits.map((h, i) => chanceOf(h, golds[i])), golds),
  }));
  console.log(`\n${renderTable(table)}\n`);

  // The chance gate holds the score; it reads the baselines and the ceiling, whose ids are each once. A measured read's verdict never fails the run.
  const gated = new Set([...READS.map((r) => r.name), CEILING.name]);
  const off = table.filter((t) => gated.has(t.read)) .filter((t) => Math.abs(t.mutant.top1 - t.chance.top1) > CHANCE_TOLERANCE || Math.abs(t.mutant.top3 - t.chance.top3) > CHANCE_TOLERANCE || Math.abs(t.mutant.tau - t.chance.tau) > CHANCE_TOLERANCE);
  const bases = READS.map((r) => results.get(r.name)!.scores);
  const t = barOn(bases, golds);
  const kept = t.keepTop3.map((i) => PROMPTS[i].key);
  console.log(`The bar a priority read must clear on this corpus (priority.ts's BAR, pre-registered): top-1 on at least ${t.top1Need} of ${t.prompts} (at least ${t.top1Floor}, and the best baseline's ${t.bestTop1} + ${BAR.top1Gain}); mean tau at least ${t.tauNeed.toFixed(3)} (the best baseline's ${t.bestTau.toFixed(3)} + ${BAR.tauGain}); top-3 kept on ${kept.length ? kept.join(", ") : "no prompt (no baseline read had any)"}.`);
  for (const r of measured) {
    const v = verdict(results.get(r.name)!.scores, bases, golds);
    if (exploratory.includes(r)) console.log(`Exploratory read ${r.name} (${r.ticket}; not the pre-registered ${PRIORITY_WEIGHT}, so no verdict: a sweep over these prompts picks nothing) against the baselines: ${v.helped ? "would clear the bar" : `would not clear the bar: ${v.failed.join("; ")}`}.`);
    else console.log(`Measured read ${r.name} (${r.ticket}) against the baselines: ${v.helped ? "HELPS: it clears the pre-registered bar" : `does not clear the bar: ${v.failed.join("; ")}`}.`);
  }
  const ceiling = verdict(results.get(CEILING.name)!.scores, bases, golds);
  console.log(`The gold ceiling against the baselines: ${ceiling.helped ? "helps (the bar is reachable)" : `fails: ${ceiling.failed.join("; ")}`}.`);
  if (errors.length) console.error(`\n${errors.length} error(s): a read that errors scores that prompt false, false, 0; an answer-moved pass that errors is not compared or scored:\n  ${errors.join("\n  ")}`);
  const raw = loadDogfood();
  const dogfood = dogfoodProblems(raw);
  console.log(`\nThe dogfood rows (fixtures/priority-dogfood.json, recorded by hand at the time):\n\n${dogfood.length ? `(not shown: ${dogfood.join("; ")})` : renderDogfood(raw as DogfoodRow[])}\n`);

  const failures: string[] = [];
  const baselineErrors = errors.filter((e) => e.startsWith("baseline "));
  if (baselineErrors.length) failures.push(`${baselineErrors.length} baseline read(s) errored, and a baseline that never ran would set the bar`);
  const drift = READS.flatMap((r) => baselineDrift(r.name, results.get(r.name)!.scores));
  if (drift.length) failures.push(`the baseline moved from priority.ts's BASELINE (${drift.join("; ")}): re-record it with the main it was measured on, since the bar moves with it`);
  if (deeper.length) failures.push(`a baseline read returned more than the ${READ_K} hits the score reads (${deeper.join("; ")}): READ_K no longer matches the tool`);
  if (!ceiling.helped) failures.push("the gold ceiling cannot clear the bar, so no read can: the registration needs fixing");
  if (errors.some((e) => e.startsWith(`measured read ${CEILING.name} `))) failures.push("the gold ceiling errored, so the measured reads' path is broken");
  const cheats = answerReaders.filter((n) => n !== CEILING.name);
  if (cheats.length) failures.push(`measured read(s) ${cheats.join(", ")} answer differently when the gold and facts move: a read must read the database, not the answer`);
  if (errors.some((e) => e.startsWith(`measured read ${CEILING.name} (answer moved)`))) failures.push("the gold ceiling errored with the answer moved, so the answer-moved check is broken");
  else if (!answerReaders.includes(CEILING.name)) failures.push("the answer-moved check did not see the ceiling, which reads the gold: the check is broken");
  if (off.length) failures.push(`the shuffled-gold mutant is not at chance for ${off.map((t) => t.read).join(", ")}: the score reads something other than the gold's order`);
  if (dogfood.length) failures.push(`the dogfood rows are not sound: ${dogfood.join("; ")}`);
  if (failures.length) {
    for (const f of failures) console.error(f);
    process.exit(1);
  }
  console.log(`Every baseline read ran and matches its recorded baseline, the bar is reachable, and the shuffled-gold mutant sits within ${CHANCE_TOLERANCE} of chance for every baseline read and the ceiling.`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--self-check")) await selfCheck();
  // The server's own pools stay open after the run; the verdict is the exit code.
  else if (args.includes("--seeded")) {
    const unknown = args.filter((a) => a.startsWith("--") && a !== "--seeded" && a !== "--priority-weight" && !a.startsWith("--priority-weight="));
    if (unknown.length) { console.error(`--seeded does not take ${unknown.join(", ")}: its one option is --priority-weight w,...`); process.exit(2); }
    const raw = flagValue(args, "--priority-weight");
    const explore = raw === undefined ? { weights: [] } : exploratoryWeights(raw);
    if ("error" in explore) { console.error(explore.error); process.exit(2); }
    await seeded(explore.weights);
    process.exit(0);
  }
  else { console.error("usage: bun eval-priority.ts --self-check | --seeded [--priority-weight w,...]"); process.exit(2); }
}
