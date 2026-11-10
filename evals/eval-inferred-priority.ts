#!/usr/bin/env bun
/**
 * eval-inferred-priority.ts — does the priority a capture infers agree with the operator's reading? (SMD-3670 PR 2.)
 *
 * PR 1 has a capture ask the metadata model for the level and the due day its text states, and states them inferred
 * (tier 4), which nothing ranks on until this measurement clears the bar pre-registered in evals/inferred-priority.ts.
 * The rules, the draw, the sheet, the score and the bar are that file's; this one runs them.
 *
 *   bun eval-inferred-priority.ts --self-check
 *       Every rule against hand-known answers, the registration against its hash, and the committed fixture, when
 *       there is one, against its shape. No database, no model.
 *
 *   bun eval-inferred-priority.ts --print-sql
 *       The SQL that lists the population — every current thought written through the capture path, one JSON line
 *       each (id, capture time, writer, text) — for a brain whose database only a container reaches:
 *         podman exec open-brain-postgres-1 psql -U postgres -d openbrain -At -c "<that SQL>" > texts.jsonl
 *
 *   bun eval-inferred-priority.ts --run <run.jsonl> (--texts <texts.jsonl> | with DATABASE_URL)
 *       The shipped inferPriority over every text, at its own capture time, through the egress gate and the
 *       metadata model the environment names (OB1_LLM_BASE_URL, OB1_METADATA_MODEL, OB1_LLM_LOCAL). One line per
 *       id, appended, so a stopped run resumes; a call the provider failed is left out, to be retried by the next
 *       run, never recorded as reading nothing. The file holds the model's phrases, so it must sit outside the repo.
 *
 *   bun eval-inferred-priority.ts --draw <run.jsonl> --sheet <sheet.md> (--texts <texts.jsonl> | with DATABASE_URL)
 *       The sample (DRAW: 60 calls and 60 others), shuffled, as a labelling sheet: each text and its capture day,
 *       never the model's call. Outside the repo too. Copy it once per rater.
 *
 *   bun eval-inferred-priority.ts --freeze <run.jsonl> <gold-sheet.md> <second-sheet.md> --note "<who labelled, when>"
 *       The filled sheets and the run → fixtures/inferred-priority.json (ids and numbers only). Refuses a sheet with
 *       a blank or unreadable answer, or one that is not the draw.
 *
 *   bun eval-inferred-priority.ts
 *       The report from the fixture: each half's precision, per writer, High where none was read, the misses, the
 *       κ between the raters, and the verdict against the bar. No database, no model.
 */

import { SQL } from "bun";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssert } from "../db/test-support.ts";
import { resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { INFER_PROMPT_VERSION, inferPriority, type Inferred } from "../server-portable/priority-infer.ts";
import {
  BAR, CAPTURES_SQL, CEILING, CONVENTIONS, DRAW, LEVEL_WORDS, MIN_CALLS, callOf, dayOffset, drawSample, dueCategory, dueRead, fromFixture, isCall, kappa,
  levelCategory, levelRead, parseSheet, registeredSection, registrationDigits, registrationHash, renderSheet, score, toFixture, verdict,
  writerKey, type Call, type Fixture, type Item, type Label, type Score,
} from "./inferred-priority.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const FIXTURE = join(HERE, "fixtures", "inferred-priority.json");

/**
 * The registration this measurement was decided on: inferred-priority.ts's registered section, hashed. Pinned before
 * the sheet was drawn (2026-11-10); a change to the section is a new registration, and a verdict holds only at the
 * one its fixture records.
 */
export const REGISTERED = "1239b47ca93a5870";

/** One line of a texts file: a thought as the population lists it. */
type Text = { id: string; at: string; writer: string; text: string };
/** One line of a run file: the model's call on a thought, with the phrases it read (which are why the file stays private). */
type RunLine = { id: string; at: string; writer: string; call: Call; level_phrase: string | null; due_phrase: string | null; ms: number; prompt_version: number };

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Refuse a private file inside the repo: a run file holds the model's phrases, and a sheet the text itself. */
function outsideRepo(path: string, what: string): string {
  const abs = resolve(path), rel = relative(REPO, abs);
  if (!rel.startsWith("..") && !rel.startsWith("/")) throw new Error(`${what} (${path}) is inside the repo: it holds thought text, so it lives outside it`);
  return abs;
}

const readJsonl = <T>(path: string): T[] => readFileSync(path, "utf8").split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l) as T);

/** The population's texts: from a texts file, or from DATABASE_URL in a read-only session. */
async function texts(): Promise<Text[]> {
  const file = flag("texts");
  if (file) return readJsonl<Text>(file);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("give --texts <texts.jsonl> or DATABASE_URL");
  const sql = new SQL({ url, max: 1, connection: { default_transaction_read_only: "on" } });
  try {
    return ((await sql.unsafe(CAPTURES_SQL)) as { json_build_object: string }[]).map((r) => JSON.parse(Object.values(r)[0] as string) as Text);
  } finally {
    await sql.close();
  }
}

// ── --run ─────────────────────────────────────────────────────────────────────

async function run(out: string): Promise<void> {
  const path = outsideRepo(out, "the run file");
  const cfg = resolveEmbedConfig(process.env as EmbedEnv);
  const done = new Set(existsSync(path) ? readJsonl<RunLine>(path).map((l) => l.id) : []);
  const todo = (await texts()).filter((t) => !done.has(t.id));
  console.log(`model ${cfg.metadataModel} at ${cfg.chat.base}; ${done.size} done, ${todo.length} to run`);
  let failed = 0;
  for (const [k, t] of todo.entries()) {
    const at = new Date(t.at), t0 = performance.now();
    // inferPriority answers null both for a text that states nothing and for a provider that failed (it logs the
    // latter): the log is caught here so a failure is left out of the file, to be retried, not counted as nothing.
    const said: string[] = [];
    const log = console.error;
    console.error = (...xs: unknown[]) => { said.push(xs.map(String).join(" ")); };
    let got: Inferred | null = null, threw: unknown = null;
    try {
      got = await inferPriority(t.text, at, { kind: "capture", actor: "eval-inferred-priority", content: t.text }, cfg);
    } catch (e) {
      threw = e;
    } finally {
      console.error = log;
    }
    const fault = threw ?? said.find((s) => /^inferPriority: /.test(s) && !/not valid JSON/.test(s));
    if (fault) {
      failed++;
      console.error(`${t.id}: left out (${String(fault).slice(0, 160)})`);
      continue;
    }
    const line: RunLine = {
      id: t.id, at: t.at, writer: t.writer, call: callOf(got, at),
      level_phrase: got?.level?.phrase ?? null, due_phrase: got?.due?.phrase ?? null,
      ms: Math.round(performance.now() - t0), prompt_version: INFER_PROMPT_VERSION,
    };
    appendFileSync(path, JSON.stringify(line) + "\n", { mode: 0o600 });
    if ((k + 1) % 50 === 0) console.log(`${k + 1} of ${todo.length}`);
  }
  console.log(`ran ${todo.length - failed}; ${failed} left out for a re-run`);
  if (failed) process.exitCode = 1;
}

// ── --draw ────────────────────────────────────────────────────────────────────

/** The run's lines, refusing a run that is not one prompt version or that covers less than the population. */
function runLines(path: string, population: readonly Text[] | null): RunLine[] {
  const lines = readJsonl<RunLine>(path);
  const versions = new Set(lines.map((l) => l.prompt_version));
  if (versions.size !== 1 || !versions.has(INFER_PROMPT_VERSION)) throw new Error(`the run holds prompt versions ${[...versions].join(", ")}, not ${INFER_PROMPT_VERSION} alone`);
  if (population) {
    const have = new Set(lines.map((l) => l.id)), missing = population.filter((t) => !have.has(t.id));
    if (missing.length) throw new Error(`the run lacks ${missing.length} of the population's ${population.length} texts: finish it with --run first`);
  }
  return lines;
}

async function draw(runPath: string, sheetPath: string): Promise<void> {
  const out = outsideRepo(sheetPath, "the sheet");
  if (registrationHash() !== REGISTERED) throw new Error(`the registration is ${registrationHash()}, not the pinned ${REGISTERED}: pin it (and commit) before a sheet is drawn`);
  const population = await texts();
  const lines = runLines(runPath, population);
  const { picked, short } = drawSample(lines);
  const byId = new Map(population.map((t) => [t.id, t]));
  writeFileSync(out, renderSheet(picked.map((p) => ({ id: p.id, at: new Date(byId.get(p.id)!.at), text: byId.get(p.id)!.text }))), { mode: 0o600 });
  const calls = lines.filter((l) => isCall(l.call)).length;
  console.log(`population ${lines.length}: ${calls} calls, ${lines.length - calls} others; drew ${picked.length}${short.length ? ` (short: ${short.join("; ")})` : ""} → ${out}`);
}

// ── --freeze ──────────────────────────────────────────────────────────────────

function freeze(runPath: string, goldPath: string, secondPath: string, note: string): void {
  const lines = runLines(runPath, null);
  const { picked } = drawSample(lines);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const sheets = [goldPath, secondPath].map((p) => {
    const { labels, problems } = parseSheet(readFileSync(p, "utf8"));
    const extra = [...labels.keys()].filter((id) => !picked.some((x) => x.id === id));
    const absent = picked.filter((x) => !labels.has(x.id));
    for (const id of extra) problems.push(`${id.slice(0, 8)} is not in the draw`);
    if (absent.length) problems.push(`${absent.length} drawn items are not on the sheet`);
    if (problems.length) throw new Error(`${p}:\n  ${problems.join("\n  ")}`);
    return labels;
  });
  const items: Item[] = picked.map((p) => {
    const l = byId.get(p.id)!;
    return { id: p.id, stratum: p.stratum, writer: l.writer, call: l.call, gold: sheets[0].get(p.id)!, second: sheets[1].get(p.id)! };
  });
  const calls = lines.filter((l) => isCall(l.call)).length;
  const fixture = toFixture(items, { generated: new Date().toISOString(), note, promptVersion: INFER_PROMPT_VERSION, population: { calls, others: lines.length - calls } });
  writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`froze ${items.length} items → ${relative(REPO, FIXTURE)}`);
}

// ── The report ────────────────────────────────────────────────────────────────

const pct = (s: { n: number; hit: number; share: number | null }) => (s.share === null ? `— (0)` : `${s.share.toFixed(3)} (${s.hit} of ${s.n})`);

/** The report's lines for a fixture: pure, so the self-check reads them. */
export function reportLines(f: Fixture): string[] {
  const { items, problems } = fromFixture(f);
  if (problems.length) return ["the fixture is not sound:", ...problems.map((p) => `  ${p}`)];
  const s: Score = score(items), v = verdict(s);
  const rated = items.filter((i) => i.second !== null);
  const k = (cat: (l: Label) => string) => (rated.length ? kappa(rated.map((i) => cat(i.gold)), rated.map((i) => cat(i.second!))) : null);
  const kl = k(levelCategory), kd = k(dueCategory);
  const registered = f.registration.map((d) => d.toString(16)).join("");
  return [
    `population ${f.population.calls + f.population.others}: ${f.population.calls} calls, ${f.population.others} others (prompt v${f.prompt_version}); sample ${items.length}`,
    `level precision  ${pct(s.level)}   bar ≥ ${BAR.levelPrecisionMin}`,
    `due precision    ${pct(s.due)}   bar ≥ ${BAR.duePrecisionMin}`,
    `High on none     ${pct(s.highOnNone)}   bar < ${BAR.highOnNoneMax}`,
    ...Object.entries(s.writers).map(([w, x]) => `  ${w}: level ${pct(x.level)}, due ${pct(x.due)}`),
    `missed, of the others: level ${pct(s.missed.level)}, due ${pct(s.missed.due)} (no bar)`,
    `κ between the raters: level ${kl === null ? "—" : kl.toFixed(3)}, due ${kd === null ? "—" : kd.toFixed(3)} (${rated.length} items)`,
    registered === registrationHash()
      ? `verdict: ${v.passes ? "PASSES — PR 3 may turn count_inferred on" : `FAILS — ${v.failures.join("; ")}`}`
      : `no verdict: the fixture was labelled under registration ${registered}, not this file's ${registrationHash()}`,
  ];
}

// ── --self-check ──────────────────────────────────────────────────────────────

function selfCheck(): void {
  const { assert, report } = createAssert();
  const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  // The registration.
  assert(registrationHash() === REGISTERED, `the registered section is the pinned one (${registrationHash()} = ${REGISTERED}); a change is a new registration, made before any sheet is drawn`);
  assert(BAR.levelPrecisionMin === 0.8 && BAR.duePrecisionMin === 0.9 && BAR.highOnNoneMax === 0.05 && MIN_CALLS === 10,
    "the bar is the one the maintainer chose on 2026-11-10 (0.80, 0.90, under 0.05, on at least 10 calls): changing it is a decision recorded on SMD-3670");
  assert(DRAW.calls === 60 && DRAW.others === 60, "the draw is the maintainer's 60 calls and 60 others");
  assert(CEILING === 3, "the ceiling is priority-infer.ts's INFERRED_CEILING (High)");
  assert(CONVENTIONS.some((c) => /citation, not a stated level/.test(c)), "the conventions carry the maintainer's call on a quoted ticket label");
  const src = readFileSync(join(HERE, "inferred-priority.ts"), "utf8");
  assert(registrationHash(src.replace("levelPrecisionMin: 0.8", "levelPrecisionMin: 0.7")) !== registrationHash(src), "a moved bar moves the registration");
  assert(registrationHash(src.replace("function kappa", "function kappa ")) === registrationHash(src), "the κ, the sheet and the fixture are outside the registration");
  assert(registrationHash(src.replace(/\n/g, "\r\n")) === registrationHash(src), "a CRLF checkout hashes the same");
  let threw = false;
  try { registeredSection("no markers"); } catch { threw = true; }
  assert(threw, "a file without the section's markers is refused, not hashed empty");
  assert(registrationDigits("0af").join() === "0,10,15", "the fixture records the hash as its hex digits");

  // Days.
  const tue = new Date("2026-11-03T23:30:00Z");
  assert(dayOffset(tue, "2026-11-06") === 3, "Friday is 3 days after a Tuesday capture");
  assert(dayOffset(tue, "2026-11-03") === 0 && dayOffset(tue, "2026-11-02") === -1, "the capture day is 0, the day before -1");
  assert(dayOffset(new Date("2026-03-07T12:00:00Z"), "2026-03-09") === 2, "a day count does not move across a DST change");
  assert(dayOffset(tue, "2026-02-30") === null && dayOffset(tue, "11/06") === null, "a day that does not exist, or another format, is refused");

  // A call from what inferPriority returned.
  const inf = (level: number | null, day: string | null, by: "rule" | "model" = "rule"): Inferred => ({
    level: level === null ? null : { value: level as 0, word: "w", phrase: "p" }, due: day === null ? null : { day, phrase: "p", by },
  });
  assert(JSON.stringify(callOf(inf(3, "2026-11-06"), tue)) === JSON.stringify({ level: 3, due: 3, byRule: true }), "a High due Friday is level 3, due 3, by the rules");
  assert(callOf(inf(5, null), tue).level === 3, "a level past the ceiling is measured at it");
  assert(JSON.stringify(callOf(null, tue)) === JSON.stringify({ level: null, due: null, byRule: null }) && !isCall(callOf(null, tue)), "nothing read is no call");
  assert(callOf(inf(null, "2026-11-04", "model"), tue).byRule === false && isCall(callOf(inf(null, "2026-11-04"), tue)), "a due day alone is a call, and says it was the model's");
  assert(callOf(inf(0, null), tue).level === 0 && isCall(callOf(inf(0, null), tue)), "a level of none is a level call");

  // The draw.
  const rows = Array.from({ length: 300 }, (_, i) => ({ id: id(i), call: i % 5 === 0 ? { level: 2, due: null, byRule: null } : { level: null, due: null, byRule: null } }));
  const d1 = drawSample(rows), d2 = drawSample([...rows].reverse());
  assert(d1.picked.length === 120 && d1.short.length === 0, "the draw takes 60 calls and 60 others");
  assert(d1.picked.filter((p) => p.stratum === "call").length === 60, "60 of the draw are calls");
  assert(JSON.stringify(d1.picked) === JSON.stringify(d2.picked), "the draw does not depend on the rows' order");
  assert(d1.picked.every((p) => (p.stratum === "call") === isCall(rows.find((r) => r.id === p.id)!.call)), "every drawn item is in its own stratum");
  assert(new Set(d1.picked.map((p) => p.id)).size === 120, "no item is drawn twice");
  const firstHalf = d1.picked.slice(0, 60).filter((p) => p.stratum === "call").length;
  assert(firstHalf > 15 && firstHalf < 45, `the sheet mixes the strata (${firstHalf} calls in its first half)`);
  assert(JSON.stringify(drawSample(rows, { ...DRAW, seed: "other" }).picked) !== JSON.stringify(d1.picked), "the seed decides the draw");
  const few = drawSample(rows.slice(0, 50));
  assert(few.picked.filter((p) => p.stratum === "call").length === 10 && few.short.join() === "calls: 10 of 60,others: 40 of 60", "a short stratum is taken whole, and said");

  // Reading a call against a label.
  const L = (levels: number[], dues: number[] = []): Label => ({ levels, dues });
  const C = (level: number | null, due: number | null = null): Call => ({ level, due, byRule: null });
  assert(levelRead(C(3), L([4])) && levelRead(C(3), L([5])), "a label of urgent or critical matches a High call (the ceiling)");
  assert(!levelRead(C(2), L([3])) && !levelRead(C(2), L([])), "a different level, or none read, is not read");
  assert(levelRead(C(1), L([3, 1])), "a call matching any of the levels listed is read");
  assert(!levelRead(C(null), L([2])), "a call with no level reads no level");
  assert(levelRead(C(0), L([0])) && !levelRead(C(0), L([])), "none is a level, distinct from none stated");
  assert(dueRead(C(null, 3), L([], [3])) && dueRead(C(null, 5), L([], [3, 5])) && !dueRead(C(null, 4), L([], [3])) && !dueRead(C(null, null), L([], [3])), "a due day is read when it is one listed");

  // The score and the verdict, at their edges.
  const items = (spec: { level?: [number, number]; due?: [number, number]; high?: number; others?: [number, number] }): Item[] => {
    const out: Item[] = [];
    let n = 0;
    const push = (stratum: "call" | "other", call: Call, gold: Label, writer = "session-hook") => out.push({ id: id(n++), stratum, writer, call, gold, second: gold });
    const [lh, ln] = spec.level ?? [0, 0];
    for (let i = 0; i < ln; i++) push("call", C(2), i < lh ? L([2]) : L([1]));
    for (let i = 0; i < (spec.high ?? 0); i++) push("call", C(3), L([]));
    const [dh, dn] = spec.due ?? [0, 0];
    for (let i = 0; i < dn; i++) push("call", C(null, 1), i < dh ? L([], [1]) : L([], [2]));
    const [om, on] = spec.others ?? [0, 0];
    for (let i = 0; i < on; i++) push("other", C(null), i < om ? L([3], [2]) : L([]), "claude-code");
    return out;
  };
  const sPass = score(items({ level: [16, 20], due: [9, 10], others: [3, 30] }));
  assert(sPass.level.share === 0.8 && sPass.due.share === 0.9, "16 of 20 levels and 9 of 10 days score 0.8 and 0.9");
  assert(verdict(sPass).passes, "exactly at the bar passes");
  assert(sPass.missed.level.share === 0.1 && sPass.missed.due.share === 0.1, "the misses are the others' share the gold reads something in");
  assert(sPass.writers["session-hook"]?.level.n === 20 && sPass.writers["claude-code"] === undefined, "per writer counts the calls only");
  const sLevel = score(items({ level: [15, 20], due: [9, 10] }));
  assert(!verdict(sLevel).passes && verdict(sLevel).failures.length === 1 && /level precision/.test(verdict(sLevel).failures[0]), "0.75 of levels fails on level precision alone");
  const sDue = score(items({ level: [16, 20], due: [17, 20] }));
  assert(verdict(sDue).failures.length === 1 && /due precision/.test(verdict(sDue).failures[0]), "0.85 of days fails on due precision alone");
  const sFew = score(items({ level: [9, 9], due: [10, 10] }));
  assert(verdict(sFew).failures.length === 1 && /measured on 9 calls/.test(verdict(sFew).failures[0]), "a half measured on 9 calls fails as unmeasured, however precise");
  const sHigh = score(items({ level: [57, 57], high: 3, due: [10, 10] }));
  assert(sHigh.highOnNone.share === 0.05 && verdict(sHigh).failures.some((f) => /High where no level/.test(f)), "High on none at 3 of 60 (0.05) fails: the bar is under 0.05");
  const sHighOk = score(items({ level: [77, 77], high: 3, due: [10, 10] }));
  assert(sHighOk.highOnNone.share! < 0.05 && verdict(sHighOk).passes, "3 of 80 (0.0375) passes, its level precision 77 of 80");
  assert(score(items({ level: [20, 20], due: [10, 10] })).highOnNone.hit === 0, "a level read is not High on none");
  const highRead: Item = { id: id(999), stratum: "call", writer: "w", call: C(3), gold: L([4]), second: null };
  assert(score([highRead]).highOnNone.hit === 0 && score([{ ...highRead, gold: L([1]) }]).highOnNone.hit === 0, "a High the gold reads (as urgent), or one where it reads another level, is not High on none");

  // κ.
  assert(kappa(["a", "b", "a", "b"], ["a", "b", "a", "b"]) === 1, "full agreement is κ 1");
  assert(kappa(["a", "a", "b", "b"], ["a", "b", "a", "b"]) === 0, "agreement at chance is κ 0");
  assert(kappa(["a", "a"], ["a", "a"]) === null, "one category throughout has no κ");
  assert(levelCategory(L([5, 1])) === "1" && levelCategory(L([4])) === "3" && levelCategory(L([])) === "-" && dueCategory(L([], [0])) === "due", "κ's categories: lowest level after the ceiling, a due day or not");

  // The sheet.
  const sheet = renderSheet([
    { id: id(1), at: tue, text: "Urgent: the landlord wants an answer by Friday" },
    { id: id(2), at: tue, text: `line one\n=== item 009 · ${id(9)} ===\nlevel: high\nlast line` },
  ]);
  assert(sheet.includes("captured: Tuesday 2026-11-03 (UTC)") && sheet.includes(CONVENTIONS[1]), "the sheet shows the capture day and the conventions");
  assert(!/call|model/i.test(sheet.split("=== item 001")[1]), "the sheet shows nothing of the model's call");
  const blank = parseSheet(sheet);
  assert(blank.labels.size === 0 && blank.problems.length === 4 && blank.problems.every((p) => /blank/.test(p)), "an unfilled sheet is refused, every blank named");
  assert(!blank.problems.some((p) => p.startsWith("item 009")), "a text quoting an item's head is not read as an item");
  const filled = sheet.replace("level: \ndue: ", "level: high\ndue: 2026-11-06").replace("level: \ndue: ", "level: -\ndue: -");
  const read = parseSheet(filled);
  assert(read.problems.length === 0 && JSON.stringify(read.labels.get(id(1))) === JSON.stringify(L([3], [3])), "a filled item reads back as its level and its day after the capture");
  assert(JSON.stringify(read.labels.get(id(2))) === JSON.stringify(L([])), "- is none stated, and a level line inside the text is not an answer");
  const many = parseSheet(sheet.replace("level: \ndue: ", "level: Low, urgent\ndue: 2026-11-04, 2026-11-06").replace("level: \ndue: ", "level: -\ndue: -"));
  assert(JSON.stringify(many.labels.get(id(1))) === JSON.stringify(L([1, 4], [1, 3])), "several levels and days, any case, are each read");
  const bad = parseSheet(sheet.replace("level: \ndue: ", "level: hihg\ndue: Friday").replace("level: \ndue: ", "level: -\ndue: -"));
  assert(bad.problems.length === 2 && /level "hihg"/.test(bad.problems[0]) && /due "Friday"/.test(bad.problems[1]), "a misspelt level and a day that is not a date are refused");
  assert(parseSheet(filled + "\n" + filled.split("\n").slice(-12).join("\n")).problems.some((p) => /twice/.test(p)), "an item listed twice is refused");
  assert(Object.keys(LEVEL_WORDS).join() === "none,low,medium,high,urgent,critical", "the sheet's level words are the scale's six");

  // The fixture.
  const its = items({ level: [16, 20], due: [9, 10], others: [3, 30] });
  const fx = toFixture(its, { generated: "2026-11-10T00:00:00Z", note: "planted", promptVersion: 1, population: { calls: 300, others: 1000 } });
  const strings: string[] = [];
  const walk = (n: unknown, key: string): void => {
    if (typeof n === "string") { if (!["note", "generated"].includes(key) && !/^[0-9a-f-]{36}$/.test(n)) strings.push(`${key}=${n}`); }
    else if (Array.isArray(n)) n.forEach((v) => walk(v, key));
    else if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !/^[0-9a-f-]{36}$/.test(k)) strings.push(`key ${k}`); walk(v, k); }
  };
  walk(fx, "$");
  assert(strings.length === 0, `the fixture holds ids, numbers, note and generated alone, as check 9 requires (${strings.join(", ")})`);
  assert(writerKey("session-hook") === "session_hook" && writerKey("7up") === "w_7up" && writerKey("") === "unknown", "a writer's name becomes a key check 9 takes");
  const back = fromFixture(fx);
  assert(back.problems.length === 0 && JSON.stringify(score(back.items.map((i) => ({ ...i, writer: i.writer })))) === JSON.stringify(score(its.map((i) => ({ ...i, writer: writerKey(i.writer) })))), "a fixture reads back to the same score");
  const twice = structuredClone(fx); twice.strata.other.push(twice.strata.call[0]);
  assert(fromFixture(twice).problems.some((p) => /two strata/.test(p)), "an id in two strata is refused");
  const misfiled = structuredClone(fx); misfiled.items[fx.strata.call[0]].call = { level: null, due: null, by_rule: null };
  assert(fromFixture(misfiled).problems.some((p) => /reads nothing, in the call stratum/.test(p)), "a call stratum item that reads nothing is refused");
  const range = structuredClone(fx); range.items[fx.strata.call[0]].gold = L([6]);
  assert(fromFixture(range).problems.some((p) => /out of range/.test(p)), "a level off the scale is refused");
  const lines = reportLines({ ...fx, registration: registrationDigits() });
  assert(lines.some((l) => /^level precision  0\.800 \(16 of 20\)/.test(l)) && lines.at(-1)!.startsWith("verdict: PASSES"), "the report prints each half and the verdict");
  assert(lines.some((l) => /κ between the raters: level 1\.000, due 1\.000 \(60 items\)/.test(l)), "the report prints the raters' κ");
  assert(reportLines({ ...fx, registration: registrationDigits("ffffffffffffffff") }).at(-1)!.startsWith("no verdict"), "a fixture from another registration gets no verdict");
  threw = false;
  try { outsideRepo(join(REPO, "evals", "run.jsonl"), "the run file"); } catch { threw = true; }
  assert(threw, "a private file inside the repo is refused");
  assert(outsideRepo("/private/tmp/run.jsonl", "the run file") === "/private/tmp/run.jsonl", "one outside it is taken");

  // The committed fixture, once there is one.
  if (existsSync(FIXTURE)) {
    const f = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
    const { items: got, problems } = fromFixture(f);
    assert(problems.length === 0, `the committed fixture is sound (${problems.join("; ")})`);
    assert(got.length === DRAW.calls + DRAW.others || f.population.calls < DRAW.calls, "the committed fixture holds the whole draw");
    assert(got.every((i) => i.second !== null), "every committed item carries the second rater's label");
    assert(f.registration.map((x) => x.toString(16)).join("") === REGISTERED, "the committed fixture was labelled under the pinned registration");
  }
  report();
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  if (args.includes("--self-check")) selfCheck();
  else if (args.includes("--print-sql")) console.log(CAPTURES_SQL.replace(/\s+/g, " "));
  else if (flag("run")) await run(flag("run")!);
  else if (flag("draw")) {
    if (!flag("sheet")) throw new Error("--draw <run.jsonl> needs --sheet <sheet.md>");
    await draw(flag("draw")!, flag("sheet")!);
  } else if (flag("freeze")) {
    const i = args.indexOf("--freeze"), [r, g, s] = args.slice(i + 1, i + 4);
    if (!r || !g || !s || !flag("note")) throw new Error("--freeze <run.jsonl> <gold-sheet.md> <second-sheet.md> --note \"<who labelled, when>\"");
    freeze(r, g, s, flag("note")!);
  } else {
    if (!existsSync(FIXTURE)) throw new Error(`no fixture yet (${relative(REPO, FIXTURE)}): --run, --draw, label, --freeze`);
    for (const l of reportLines(JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture)) console.log(l);
  }
}
