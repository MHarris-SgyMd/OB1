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
 *       Resets the schema at DATABASE_URL (test-support's throwaway guard:
 *       loopback only unless OB1_ALLOW_REMOTE_DB=1, and a database holding
 *       thoughts only with OB1_FIXTURE_RESET=1), plants the seeded corpus with
 *       the stub embedder's vectors under each writer's ob1.actor, and runs
 *       every prompt through each read — the server's own
 *       SqlStore.hybridThoughts, at the knobs its tool would send. Prints the
 *       per-prompt hits, the table, the shuffled-gold mutant beside chance,
 *       and the bar a priority read must clear against this baseline. Exits
 *       1 when a baseline read errors, when a baseline read's scores differ
 *       from priority.ts's BASELINE, when the gold ceiling cannot clear the
 *       bar, or when the mutant does not sit at chance. Keyless: no provider
 *       is called.
 *
 * The reads are priority.ts's READS, today's main as the baseline (plain,
 * current, filter), and its MEASURED: a later read joins there (SMD-3668's
 * priority_weight, SMD-3669's agenda), and the run prints its verdict against
 * the baselines of the same run. A measured read's verdict does not fail the
 * run; the gold ceiling's, which runs the same path, does.
 *
 * The dogfood rows (fixtures/priority-dogfood.json) are recorded by hand in
 * the session that asked, and printed beside the seeded table.
 */

import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssert, resetSchema } from "../db/test-support.ts";
import { SqlStore } from "../server-portable/store-sql.ts";
import {
  BACKGROUND, BAR, CHANCE_TOLERANCE, NOISE_AXES, ITEMS, PROMPTS, READ_K, REGISTERED_CORPUS, STUB_DIM, STUB_MODEL,
  BASELINE, MEASURED, MUTANT_SEED, READS, baselineCall, itemId, measuredSource, seedRow, barOn, baselineDrift, chanceOf, corpusHash, registeredSection, registeredSource, corpusProblems, dogfoodProblems, goldRanks, kendallTauB, meanScore, meanTriple, renderTable, scorePrompt, shuffledScore, stubVector, verdict, wordsOf,
  type DogfoodRow, type Item, type MeasuredRead, type PromptScore,
} from "./priority.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOGFOOD_PATH = join(HERE, "fixtures", "priority-dogfood.json");

/**
 * The gold order itself, run as a measured read: the bar's reachability (the
 * run fails when it cannot clear the bar) and the measured path's control,
 * exercised on every seeded run before a priority read exists. The one read
 * that sees the gold, so it lives here, not in priority.ts's MEASURED.
 */
const CEILING: MeasuredRead = {
  name: "gold (ceiling)", ticket: "SMD-3662",
  run: async ({ prompt }) => PROMPTS.find((q) => q.key === prompt.key)!.gold.map((k) => itemId(ITEMS.findIndex((it) => it.key === k))),
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

function selfCheck(): void {
  const { assert, report } = createAssert();

  console.log("[1] The corpus");
  const corpus = corpusProblems();
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
  const measured = measuredSource(fileText);
  assert(measured.includes("export const MEASURED") && !/\.gold\b|\.facts\b|\bPROMPTS\b|\bITEMS\b/.test(measured), "no measured read names the gold or the items' facts: a read reads the database, as a deployed one would");
  assert(/\.gold\b/.test(measuredSource("\nexport const MEASURED: readonly MeasuredRead[] = [{ name: \"x\", ticket: \"t\", run: async ({ prompt }) => PROMPTS.find((q) => q.key === prompt.key)!.gold }];\n// ── next")), "the probe sees a measured read that looks the gold up");
  const zq = seedRow(ITEMS.find((i) => i.key === "zq-urgent")!, 0);
  assert(zq.metadata.source === "linear" && zq.metadata.issue === "ZQ-101" && zq.metadata.status_type === "unstarted" && zq.metadata.priority === "Urgent" && zq.metadata.genre !== undefined && zq.content.startsWith("ZQ-101 — "), "a board row is planted as board-sync writes it: issueFacets' metadata (source, issue, status, priority, genre) and renderIssue's text");
  assert(Object.keys(seedRow(ITEMS[0], 0).metadata).length === 0, "a personal row carries no tracker facets");
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

  console.log("[6] The reads' knobs are the tools'");
  const reads = readFileSync(join(HERE, "..", "server-portable", "core", "reads.ts"), "utf8");
  const call = reads.match(/tool: "search", arm: "hybrid", query, limit: (\d+), threshold: (\d+), recencyWeight: SEARCH_COMPAT_RECENCY_WEIGHT, preferCurrent: SEARCH_COMPAT_PREFER_CURRENT, filter: \{\} \}/);
  assert(call !== null && Number(call[1]) === READ_K && Number(call[2]) === 0, `the search tool sends limit ${READ_K} and threshold 0, as the plain read does`);
  assert(/const SEARCH_COMPAT_RECENCY_WEIGHT = 0;/.test(reads) && /const SEARCH_COMPAT_PREFER_CURRENT = false;/.test(reads), "the search tool's recency weight is 0 and prefer_current off, as the plain read's");
  const schemas = readFileSync(join(HERE, "..", "server-portable", "core", "schemas.ts"), "utf8");
  // search_thoughts' own block: from its key to the next tool's.
  const from = schemas.indexOf("\n  search_thoughts: {");
  const to = schemas.indexOf("\n  search_thoughts_keyword: {");
  const block = from >= 0 && to > from ? schemas.slice(from, to) : "";
  assert(block.length > 0, "search_thoughts' schema block is found, between its key and search_thoughts_keyword's");
  assert(new RegExp(`limit: z\\.number\\(\\)\\.optional\\(\\)\\.default\\(${READ_K}\\)`).test(block), `search_thoughts' limit default is ${READ_K}, the filter read's`);
  assert(/threshold: z\.number\(\)\.optional\(\)\.default\(0\)/.test(block) && /recency_weight: z\.number\(\)\.optional\(\)\.default\(0\)/.test(block), "search_thoughts' threshold and recency weight default to 0, the filter read's");
  assert(/prefer_current: z\.boolean\(\)\.optional\(\)\.default\(false\)/.test(block), "search_thoughts' prefer_current defaults off, as the filter read sends it");

  console.log("[7] The dogfood rows");
  const raw = loadDogfood();
  const sound = dogfoodProblems(raw);
  assert(sound.length === 0, `the committed rows are sound${sound.length ? `: ${sound.join("; ")}` : ""}`);
  const rows = raw as DogfoodRow[];
  assert(dogfoodProblems(undefined).some((p) => p.includes("not an array")) && dogfoodProblems({ 0: rows[0] }).some((p) => p.includes("not an array")), "a fixture with no rows array is reported, not thrown on");
  assert(dogfoodProblems([null, rows[0]]).some((p) => p.includes("not an object")), "a row that is not an object, before another, is reported, not thrown on");
  assert(dogfoodProblems([{ ...rows[0], reads: { plian: { rank: 0 } } }]).some((p) => p.includes("plian")), "a read name outside DOGFOOD_READS is refused, so rows stay comparable read by read");
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

async function seeded(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun eval-priority.ts --seeded"); process.exit(2); }
  const problems = corpusProblems();
  if (problems.length) { console.error(`the corpus is not sound: ${problems.join("; ")}`); process.exit(2); }
  const probe = new SQL({ url, max: 1 });
  const exists = ((await probe`SELECT (to_regclass('thoughts') IS NOT NULL) AS present`)[0] as { present: boolean }).present;
  const held = exists ? Number(((await probe`SELECT count(*)::int AS n FROM thoughts`)[0] as { n: number }).n) : 0;
  await probe.end();
  if (held > 0 && process.env.OB1_FIXTURE_RESET !== "1") {
    console.error(`the database at DATABASE_URL holds ${held} thought(s) and --seeded DROPS the schema. Point it at a throwaway (../db/with-postgres.sh), or set OB1_FIXTURE_RESET=1 if you mean it.`);
    process.exit(2);
  }
  // resetSchema refuses a non-loopback database unless OB1_ALLOW_REMOTE_DB=1 (test-support's guard).
  await resetSchema(url, { dim: STUB_DIM, model: STUB_MODEL });

  const sql = new SQL({ url, max: 1 });
  const keyOf = new Map<string, string>();
  const seeds = ITEMS.map((it, i) => ({ key: it.key, row: seedRow(it, i) }));
  let planted = 0;
  try {
    for (const actor of [...new Set(seeds.map((s) => s.row.actor))]) {
      // Each writer's rows under its own ob1.actor, as a raw insert is stamped (050's ob1_stamp_actor).
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('ob1.actor', ${JSON.stringify({ name: actor })}, true)`;
        for (const { key, row } of seeds) {
          if (row.actor !== actor) continue;
          await tx`INSERT INTO thoughts (id, content, content_fingerprint, embedding, embedding_model, metadata, created_at)
                   VALUES (${row.id}::uuid, ${row.content}, content_fingerprint_of(${row.content}), ${`[${stubVector(row.content).join(",")}]`}::vector, ${STUB_MODEL},
                           ${row.metadata}::jsonb, now() - make_interval(days => ${row.ageDays}))`;
          keyOf.set(row.id, key);
        }
      });
    }
    planted = Number(((await sql`SELECT count(*)::int AS n FROM thoughts WHERE metadata->>'actor_name' LIKE 'priority-eval-%'`)[0] as { n: number }).n);
  } finally {
    await sql.close();
  }
  if (planted !== ITEMS.length) { console.error(`planted ${planted} of ${ITEMS.length} rows under the eval's writers`); process.exit(1); }

  const store = new SqlStore(url, { max: 1 });
  const results = new Map<string, { hits: string[][]; scores: PromptScore[] }>();
  const errors: string[] = [];
  try {
    for (const r of READS) {
      const hits: string[][] = [];
      for (const p of PROMPTS) {
        // A baseline read that errors fails the run, below: a baseline that never ran would set the bar.
        // Its prompt is scored as no hits meanwhile, so the table still prints.
        try {
          const rows = await store.hybridThoughts(baselineCall(r, p.query));
          hits.push(rows.map((row) => keyOf.get(row.id) ?? `?${row.id}`));
        } catch (e) {
          errors.push(`baseline read ${r.name} on ${p.key}: ${e instanceof Error ? e.message : String(e)}`);
          hits.push([]);
        }
      }
      results.set(r.name, { hits, scores: hits.map((h, i) => scorePrompt(h, PROMPTS[i].gold)) });
    }
    // The reads measured against the bar, the gold ceiling last: one that errors on a prompt scores it false, false, 0.
    for (const r of [...MEASURED, CEILING]) {
      const hits: string[][] = [];
      for (const p of PROMPTS) {
        try {
          const ids = await r.run({ store, prompt: { key: p.key, query: p.query }, embedding: stubVector(p.query, STUB_DIM, "query") });
          // The top READ_K are what the score reads, and all the table shows.
          hits.push(ids.slice(0, READ_K).map((id) => keyOf.get(id) ?? `?${id}`));
        } catch (e) {
          errors.push(`measured read ${r.name} on ${p.key}: ${e instanceof Error ? e.message : String(e)}`);
          hits.push([]);
        }
      }
      results.set(r.name, { hits, scores: hits.map((h, i) => scorePrompt(h, PROMPTS[i].gold)) });
    }
  } finally {
    await store.close();
  }

  const golds = PROMPTS.map((p) => p.gold);
  console.log(`priority eval, seeded: ${ITEMS.length} items, ${PROMPTS.length} prompts, corpus ${corpusHash()}, stub ${STUB_MODEL} @ ${STUB_DIM}\n`);
  for (const [i, p] of PROMPTS.entries()) {
    console.log(`${p.key}: "${p.query}"\n  gold     ${p.gold.join(" > ")}`);
    for (const r of [...READS, ...MEASURED]) {
      const { hits, scores } = results.get(r.name)!;
      const sc = scores[i];
      console.log(`  ${r.name.padEnd(8)} ${hits[i].join(", ") || "(nothing)"}  [top-1 ${sc.top1 ? "yes" : "no"}, top-3 ${sc.top3 ? "yes" : "no"}, tau ${sc.tau === null ? "–" : sc.tau.toFixed(3)}]`);
    }
  }

  const table = [...READS, ...MEASURED, CEILING].map((r) => ({ name: r.name, ...results.get(r.name)! })).map((r) => ({
    read: r.name,
    score: meanScore(r.scores, golds),
    mutant: meanTriple(r.hits.map((h, i) => shuffledScore(h, golds[i], scorePrompt, MUTANT_SEED + i)), golds),
    chance: meanTriple(r.hits.map((h, i) => chanceOf(h, golds[i])), golds),
  }));
  console.log(`\n${renderTable(table)}\n`);

  const off = table.filter((t) => Math.abs(t.mutant.top1 - t.chance.top1) > CHANCE_TOLERANCE || Math.abs(t.mutant.top3 - t.chance.top3) > CHANCE_TOLERANCE || Math.abs(t.mutant.tau - t.chance.tau) > CHANCE_TOLERANCE);
  const bases = READS.map((r) => results.get(r.name)!.scores);
  const t = barOn(bases, golds);
  const kept = t.keepTop3.map((i) => PROMPTS[i].key);
  console.log(`The bar a priority read must clear on this corpus (priority.ts's BAR, pre-registered): top-1 on at least ${t.top1Need} of ${t.prompts} (at least ${t.top1Floor}, and the best baseline's ${t.bestTop1} + ${BAR.top1Gain}); mean tau at least ${t.tauNeed.toFixed(3)} (the best baseline's ${t.bestTau.toFixed(3)} + ${BAR.tauGain}); top-3 kept on ${kept.length ? kept.join(", ") : "no prompt (no baseline read had any)"}.`);
  for (const r of MEASURED) {
    const v = verdict(results.get(r.name)!.scores, bases, golds);
    console.log(`Measured read ${r.name} (${r.ticket}) against the baselines: ${v.helped ? "HELPS: it clears the pre-registered bar" : `does not clear the bar: ${v.failed.join("; ")}`}.`);
  }
  const ceiling = verdict(results.get(CEILING.name)!.scores, bases, golds);
  console.log(`The gold ceiling against the baselines: ${ceiling.helped ? "helps (the bar is reachable)" : `fails: ${ceiling.failed.join("; ")}`}.`);
  if (errors.length) console.error(`\n${errors.length} read(s) errored, each scored false, false, 0 on its prompt:\n  ${errors.join("\n  ")}`);
  const raw = loadDogfood();
  const dogfood = dogfoodProblems(raw);
  console.log(`\nThe dogfood rows (fixtures/priority-dogfood.json, recorded by hand at the time):\n\n${dogfood.length ? `(not shown: ${dogfood.join("; ")})` : renderDogfood(raw as DogfoodRow[])}\n`);

  const failures: string[] = [];
  const baselineErrors = errors.filter((e) => e.startsWith("baseline "));
  if (baselineErrors.length) failures.push(`${baselineErrors.length} baseline read(s) errored, and a baseline that never ran would set the bar`);
  const drift = READS.flatMap((r) => baselineDrift(r.name, results.get(r.name)!.scores, golds));
  if (drift.length) failures.push(`the baseline moved from priority.ts's BASELINE (${drift.join("; ")}): re-record it with the main it was measured on, since the bar moves with it`);
  if (!ceiling.helped) failures.push("the gold ceiling cannot clear the bar, so no read can: the registration needs fixing");
  if (errors.some((e) => e.startsWith(`measured read ${CEILING.name} `))) failures.push("the gold ceiling errored, so the measured reads' path is broken");
  if (off.length) failures.push(`the shuffled-gold mutant is not at chance for ${off.map((t) => t.read).join(", ")}: the score reads something other than the gold's order`);
  if (dogfood.length) failures.push(`the dogfood rows are not sound: ${dogfood.join("; ")}`);
  if (failures.length) {
    for (const f of failures) console.error(f);
    process.exit(1);
  }
  console.log(`Every baseline read ran and matches its recorded baseline, the bar is reachable, and the shuffled-gold mutant sits within ${CHANCE_TOLERANCE} of chance for every read.`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--self-check")) selfCheck();
  else if (args.includes("--seeded")) await seeded();
  else { console.error("usage: bun eval-priority.ts --self-check | --seeded"); process.exit(2); }
}
