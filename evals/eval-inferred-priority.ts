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
 *         podman exec open-brain-postgres-1 psql -U postgres -d openbrain -At -c "<that SQL>" > ~/.cache/<dir>/texts.jsonl
 *       It holds every text, so it lives outside any repo: the eval refuses a texts file in a git work tree.
 *
 *   bun eval-inferred-priority.ts --run <run.jsonl> (--texts <texts.jsonl> | with DATABASE_URL)
 *       The shipped inferPriority over every text, at its own capture time, through the egress gate and the
 *       metadata model the environment names (OB1_LLM_BASE_URL, OB1_METADATA_MODEL, OB1_LLM_LOCAL). One line per
 *       id, appended, so a stopped run resumes; a call the provider failed is left out, to be retried by the next
 *       run, never recorded as reading nothing. The file holds the model's phrases, so it must sit outside any repo.
 *       --shard k/n takes every n-th text from the k-th, so n runs started together share the file.
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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssert } from "../db/test-support.ts";
import { resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { INFER_PROMPT_VERSION, INFERRED_CEILING, inferPriority, type Inferred } from "../server-portable/priority-infer.ts";
import {
  BAR, CAPTURES_SQL, CEILING, CONVENTIONS, DRAW, LEVEL_WORDS, MIN_CALLS, callOf, dayOffset, drawSample, dueCategory, dueRead, fromFixture, isCall, kappa,
  levelCategory, levelRead, parseSheet, registeredSection, registrationDigits, registrationHash, renderSheet, score, toFixture, verdict,
  utcDay, writerKey, type Call, type Fixture, type Item, type Label, type Score,
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
type RunLine = {
  id: string; at: string; writer: string; call: Call; level_phrase: string | null; due_phrase: string | null; ms: number; prompt_version: number;
  /** The model, its endpoint and its temperature, as `model@base t=temperature` (absent on lines from before review pass 1). */
  model?: string;
};

/** The message inferPriority logs when the model's own answer was not JSON: the live capture states nothing then, so the run records nothing. */
export const NON_JSON = "inferPriority: model content was not valid JSON";

/**
 * What one call came to: the model's reading, or a fault to leave out of the run (to be retried, never recorded as
 * reading nothing). inferPriority answers null for a provider that failed (logged), an answer with no content (not
 * logged) and a non-JSON answer (logged as NON_JSON); readAnswer never answers null. So only NON_JSON's null is the
 * model's reading of nothing, and any other line it logs is a fault.
 */
export function outcomeOf(got: Inferred | null, threw: unknown, said: readonly string[]): { fault: string } | { got: Inferred | null } {
  if (threw !== null) return { fault: String(threw) };
  const fault = said.find((s) => /^inferPriority: /.test(s) && s !== NON_JSON);
  if (fault) return { fault };
  if (got === null && !said.includes(NON_JSON)) return { fault: "inferPriority answered nothing and logged nothing: an answer with no content" };
  return { got };
}

/** A run's lines checked: no id twice, one prompt version (this one), one model where recorded, and the whole population when given. */
export function checkRunLines(lines: readonly RunLine[], population: readonly { id: string }[] | null): string[] {
  const problems: string[] = [];
  const seen = new Set<string>(), twice = lines.filter((l) => seen.size === seen.add(l.id).size);
  if (twice.length) problems.push(`the run holds ${twice.length} ids twice (${twice[0].id.slice(0, 8)} first): shards started apart from each other overlap`);
  const versions = new Set(lines.map((l) => l.prompt_version));
  if (versions.size !== 1 || !versions.has(INFER_PROMPT_VERSION)) problems.push(`the run holds prompt versions ${[...versions].join(", ")}, not ${INFER_PROMPT_VERSION} alone`);
  const models = new Set(lines.map((l) => l.model ?? "unrecorded"));
  if (models.size > 1) problems.push(`the run mixes models: ${[...models].join("; ")}`);
  if (population) {
    const have = new Set(lines.map((l) => l.id)), missing = population.filter((t) => !have.has(t.id));
    if (missing.length) problems.push(`the run lacks ${missing.length} of the population's ${population.length} texts: finish it with --run first`);
    const members = new Set(population.map((t) => t.id)), gone = lines.filter((l) => !members.has(l.id));
    if (gone.length) problems.push(`the run holds ${gone.length} ids the population no longer does (${gone[0].id.slice(0, 8)} first): a thought superseded or removed since the run`);
  }
  return problems;
}

/** The sheet for a run: the draw over its lines, each drawn text with its capture day. Pure, so the self-check can hold it blind. */
export function drawSheet(lines: readonly RunLine[], population: readonly Text[]): { sheet: string; picked: { id: string; stratum: "call" | "other" }[]; short: string[] } {
  const { picked, short } = drawSample(lines);
  const byId = new Map(population.map((t) => [t.id, t]));
  return { sheet: renderSheet(picked.map((p) => ({ id: p.id, at: new Date(byId.get(p.id)!.at), text: byId.get(p.id)!.text }))), picked, short };
}

/**
 * A filled sheet's labels, refusing one with a problem of its own, an id outside the draw, a drawn item missing, or an
 * item whose captured day is not its run line's UTC day (its due days are counted from the day the sheet shows).
 */
export function sheetLabels(text: string, picked: readonly { id: string; at: string }[]): { labels: Map<string, Label>; problems: string[] } {
  const { labels, days, problems } = parseSheet(text);
  const drawn = new Set(picked.map((x) => x.id));
  for (const p of picked) {
    const shown = days.get(p.id);
    if (shown !== undefined && shown !== utcDay(new Date(p.at))) problems.push(`${p.id.slice(0, 8)}: captured ${shown} on the sheet, ${utcDay(new Date(p.at))} in the run`);
  }
  for (const id of labels.keys()) if (!drawn.has(id)) problems.push(`${id.slice(0, 8)} is not in the draw`);
  const absent = picked.filter((x) => !labels.has(x.id));
  if (absent.length) problems.push(`${absent.length} drawn items are not on the sheet`);
  return { labels, problems };
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * Refuse a private file inside a git work tree: a texts file holds the text, a run file the model's phrases, and a
 * sheet both. Any work tree, not only this checkout: from a worktree, the canonical checkout is a repo too.
 */
export function outsideRepo(path: string, what: string): string {
  const abs = resolve(path);
  for (let d = dirname(abs); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) throw new Error(`${what} (${path}) is inside the git work tree at ${d}: it holds thought text, so it lives outside any repo`);
    if (dirname(d) === d) return abs;
  }
}

const readJsonl = <T>(path: string): T[] => readFileSync(path, "utf8").split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l) as T);

/** The population's texts: from a texts file, or from DATABASE_URL in a read-only session. */
async function texts(): Promise<Text[]> {
  const file = flag("texts");
  if (file) return readJsonl<Text>(outsideRepo(file, "the texts file"));
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

/**
 * A run's shard, `k/n` (k from 0): every n-th text still to run, from the k-th, so n runs started together over one
 * file take disjoint texts and the provider answers n at a time. No flag is the whole run, 0/1.
 */
export function shardOf(raw: string | undefined): [number, number] {
  if (raw === undefined) return [0, 1];
  const m = /^(\d+)\/(\d+)$/.exec(raw);
  if (!m || Number(m[2]) < 1 || Number(m[1]) >= Number(m[2])) throw new Error(`--shard ${raw}: write k/n, 0 <= k < n`);
  return [Number(m[1]), Number(m[2])];
}

async function run(out: string): Promise<void> {
  const path = outsideRepo(out, "the run file");
  const cfg = resolveEmbedConfig(process.env as EmbedEnv);
  const done = new Set(existsSync(path) ? readJsonl<RunLine>(path).map((l) => l.id) : []);
  const [k, n] = shardOf(flag("shard"));
  const todo = (await texts()).filter((t) => !done.has(t.id)).filter((_, i) => i % n === k);
  const model = `${cfg.metadataModel}@${cfg.chat.base} t=${cfg.metadataTemperature}`;
  console.log(`model ${model}; ${done.size} done, ${todo.length} to run`);
  let failed = 0;
  for (const [j, t] of todo.entries()) {
    const at = new Date(t.at), t0 = performance.now();
    // What inferPriority logs is caught here, so outcomeOf can tell a fault (left out, to be retried) from the
    // model's own reading of nothing.
    const said: string[] = [];
    const log = console.error;
    console.error = (...xs: unknown[]) => { said.push(xs.map(String).join(" ")); };
    let got: Inferred | null = null, threw: unknown = null;
    try {
      // The subject as the live capture gives it: the writing key's name as the actor (core/writes.ts).
      got = await inferPriority(t.text, at, { kind: "capture", actor: t.writer, content: t.text }, cfg);
    } catch (e) {
      threw = e;
    } finally {
      console.error = log;
    }
    const outcome = outcomeOf(got, threw, said);
    if ("fault" in outcome) {
      failed++;
      console.error(`${t.id}: left out (${outcome.fault.slice(0, 160)})`);
      continue;
    }
    const line: RunLine = {
      id: t.id, at: t.at, writer: t.writer, call: callOf(outcome.got, at),
      level_phrase: outcome.got?.level?.phrase ?? null, due_phrase: outcome.got?.due?.phrase ?? null,
      ms: Math.round(performance.now() - t0), prompt_version: INFER_PROMPT_VERSION, model,
    };
    appendFileSync(path, JSON.stringify(line) + "\n", { mode: 0o600 });
    if ((j + 1) % 50 === 0) console.log(`${j + 1} of ${todo.length}`);
  }
  console.log(`ran ${todo.length - failed}; ${failed} left out for a re-run`);
  if (failed) process.exitCode = 1;
}

// ── --draw ────────────────────────────────────────────────────────────────────

/** The run's lines, refused on any of checkRunLines's problems. */
function runLines(path: string, population: readonly Text[] | null): RunLine[] {
  const lines = readJsonl<RunLine>(path);
  const problems = checkRunLines(lines, population);
  if (problems.length) throw new Error(problems.join("\n"));
  return lines;
}

/** Refuse a step that reads the registration once it is not the pinned one. */
function refuseUnpinned(step: string): void {
  if (registrationHash() !== REGISTERED) throw new Error(`the registration is ${registrationHash()}, not the pinned ${REGISTERED}: ${step} only at the pinned registration`);
}

async function draw(runPath: string, sheetPath: string): Promise<void> {
  const out = outsideRepo(sheetPath, "the sheet");
  refuseUnpinned("a sheet is drawn");
  const population = await texts();
  const lines = runLines(outsideRepo(runPath, "the run file"), population);
  const { sheet, picked, short } = drawSheet(lines, population);
  writeFileSync(out, sheet, { mode: 0o600 });
  const calls = lines.filter((l) => isCall(l.call)).length;
  console.log(`population ${lines.length}: ${calls} calls, ${lines.length - calls} others; drew ${picked.length}${short.length ? ` (short: ${short.join("; ")})` : ""} → ${out}`);
}

// ── --freeze ──────────────────────────────────────────────────────────────────

function freeze(runPath: string, goldPath: string, secondPath: string, note: string): void {
  refuseUnpinned("labels are frozen");
  const lines = runLines(outsideRepo(runPath, "the run file"), null);
  const { picked } = drawSample(lines);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const pickedAt = picked.map((p) => ({ id: p.id, at: byId.get(p.id)!.at }));
  const sheets = [goldPath, secondPath].map((p) => {
    const { labels, problems } = sheetLabels(readFileSync(outsideRepo(p, "a filled sheet"), "utf8"), pickedAt);
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

/** The report's lines for a fixture, at the rules file's registration (`current`, its hash by default): pure, so the self-check reads them. */
export function reportLines(f: Fixture, current: string = registrationHash()): string[] {
  const { items, problems } = fromFixture(f);
  if (problems.length) return ["the fixture is not sound:", ...problems.map((p) => `  ${p}`)];
  const s: Score = score(items), v = verdict(s);
  const rated = items.filter((i) => i.second !== null);
  const k = (cat: (l: Label) => string) => (rated.length ? kappa(rated.map((i) => cat(i.gold)), rated.map((i) => cat(i.second!))) : null);
  const kl = k(levelCategory), kd = k(dueCategory);
  // κ on due reads only whether a day is stated; of the items where both raters state days, how many state the same ones.
  const bothDue = rated.filter((i) => i.gold.dues.length > 0 && i.second!.dues.length > 0);
  const sameDays = bothDue.filter((i) => JSON.stringify(i.gold.dues) === JSON.stringify(i.second!.dues)).length;
  const registered = f.registration.map((d) => d.toString(16)).join("");
  const pinned = registered === REGISTERED && current === REGISTERED && f.prompt_version === INFER_PROMPT_VERSION;
  return [
    `population ${f.population.calls + f.population.others}: ${f.population.calls} calls, ${f.population.others} others (prompt v${f.prompt_version}); sample ${items.length}`,
    `level precision  ${pct(s.level)}   bar ≥ ${BAR.levelPrecisionMin}`,
    `due precision    ${pct(s.due)}   bar ≥ ${BAR.duePrecisionMin}`,
    `High on none     ${pct(s.highOnNone)}   bar < ${BAR.highOnNoneMax}`,
    ...Object.entries(s.writers).map(([w, x]) => `  ${w}: level ${pct(x.level)}, due ${pct(x.due)}`),
    `missed, of the others: level ${pct(s.missed.level)}, due ${pct(s.missed.due)} (no bar)`,
    `κ between the raters: level ${kl === null ? "—" : kl.toFixed(3)}, whether a due day is stated ${kd === null ? "—" : kd.toFixed(3)} (${rated.length} items); the same days on ${sameDays} of the ${bothDue.length} both date`,
    pinned
      ? `verdict: ${v.passes ? "PASSES — PR 3 may turn count_inferred on" : `FAILS — ${v.failures.join("; ")}`}`
      : `no verdict: the fixture was labelled under registration ${registered} on prompt v${f.prompt_version}; this file's registration is ${current}, the pinned one ${REGISTERED}, the prompt v${INFER_PROMPT_VERSION}`,
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
  assert(CEILING === INFERRED_CEILING, "the ceiling is priority-infer.ts's INFERRED_CEILING, so the measurement reads a call as the live capture states it");
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
  assert(score([{ ...highRead, call: C(2), gold: L([]) }]).highOnNone.hit === 0, "a Medium where the gold reads no level is not High on none");
  assert(score([{ ...highRead, stratum: "other", call: C(null), gold: L([0]) }]).missed.level.hit === 1, "a level of none the gold reads among the others is a miss");

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
  const blank = parseSheet(sheet);
  assert(blank.labels.size === 0 && blank.problems.length === 4 && blank.problems.every((p) => /blank/.test(p)), "an unfilled sheet is refused, every blank named");
  assert(!blank.problems.some((p) => p.startsWith("item 009")), "a text quoting an item's head is not read as an item");
  const filled = sheet.replace("level: \ndue: ", "level: high\ndue: 2026-11-06").replace("level: \ndue: ", "level: -\ndue: -");
  const read = parseSheet(filled);
  assert(read.problems.length === 0 && JSON.stringify(read.labels.get(id(1))) === JSON.stringify(L([3], [3])), "a filled item reads back as its level and its day after the capture");
  assert(JSON.stringify(read.labels.get(id(2))) === JSON.stringify(L([])), "- is none stated, and a level line inside the text is not an answer");
  const twoDays = renderSheet([{ id: id(1), at: tue, text: "a" }, { id: id(2), at: new Date("2026-11-05T09:00:00Z"), text: "b" }])
    .replace("level: \ndue: ", "level: -\ndue: 2026-11-06").replace("level: \ndue: ", "level: -\ndue: 2026-11-06");
  const td = parseSheet(twoDays);
  assert(td.labels.get(id(1))!.dues[0] === 3 && td.labels.get(id(2))!.dues[0] === 1 && td.days.get(id(2)) === "2026-11-05", "each item's due day counts from its own capture day");
  const many = parseSheet(sheet.replace("level: \ndue: ", "level: Low, urgent\ndue: 2026-11-04, 2026-11-06").replace("level: \ndue: ", "level: -\ndue: -"));
  assert(JSON.stringify(many.labels.get(id(1))) === JSON.stringify(L([1, 4], [1, 3])), "several levels and days, any case, are each read");
  const bad = parseSheet(sheet.replace("level: \ndue: ", "level: hihg\ndue: Friday").replace("level: \ndue: ", "level: -\ndue: -"));
  assert(bad.problems.length === 2 && /level "hihg"/.test(bad.problems[0]) && /due "Friday"/.test(bad.problems[1]), "a misspelt level and a day that is not a date are refused");
  assert(parseSheet(filled + "\n" + filled.split("\n").slice(-12).join("\n")).problems.some((p) => /twice/.test(p)), "an item listed twice is refused");
  const noMark = parseSheet(filled.replace("level: high\ndue: 2026-11-06\n--- text ---\n", "level: high\ndue: 2026-11-06\n"));
  assert(noMark.problems.some((p) => /item 001 .*no "--- text ---" line/.test(p)) && !noMark.labels.has(id(1)), "an item that lost its text marker is refused, not read on into its text");
  const twiceField = parseSheet(filled.replace("level: high\ndue: 2026-11-06", "level: high\nlevel: low\ndue: 2026-11-06"));
  assert(twiceField.problems.some((p) => /item 001 .*level given twice/.test(p)), "a field given twice is refused");
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
  assert(lines.some((l) => /κ between the raters: level 1\.000, whether a due day is stated 1\.000 \(60 items\); the same days on 13 of the 13 both date/.test(l)), "the report prints the raters' κ and their same-day count");
  const split = structuredClone(fx); split.items[fx.strata.other[0]].second = L([3], [5]);
  assert(reportLines({ ...split, registration: registrationDigits() }).some((l) => /the same days on 12 of the 13 both date/.test(l)), "two raters dating one item differently are not the same days");
  const overlap = structuredClone(fx); overlap.items[fx.strata.call[fx.strata.call.length - 1]].second = L([], [2, 6]);
  assert(reportLines({ ...overlap, registration: registrationDigits() }).some((l) => /the same days on 12 of the 13 both date/.test(l)), "lists that share a day but differ are not the same days");
  assert(reportLines({ ...fx, registration: registrationDigits("ffffffffffffffff") }).at(-1)!.startsWith("no verdict"), "a fixture from another registration gets no verdict");
  assert(JSON.stringify(shardOf(undefined)) === "[0,1]" && JSON.stringify(shardOf("2/3")) === "[2,3]", "no shard is the whole run; k/n is read");
  for (const bad of ["3/3", "1/0", "a/b", "1"]) {
    threw = false;
    try { shardOf(bad); } catch { threw = true; }
    assert(threw, `--shard ${bad} is refused`);
  }
  threw = false;
  try { outsideRepo("texts.jsonl", "the texts file"); } catch { threw = true; }
  assert(threw, "a private file inside the repo is refused");
  threw = false;
  try { outsideRepo(join(REPO, "run.jsonl"), "the run file"); } catch { threw = true; }
  assert(threw, "a private file at the repo's root is refused");
  const otherRepo = mkdtempSync(join(tmpdir(), "ob1-3670-other-repo-"));
  try {
    mkdirSync(join(otherRepo, ".git"));
    threw = false;
    try { outsideRepo(join(otherRepo, "deep", "sheet.md"), "the sheet"); } catch { threw = true; }
    assert(threw, "a private file inside another git work tree is refused, the canonical checkout from a worktree among them");
  } finally {
    rmSync(otherRepo, { recursive: true, force: true });
  }
  assert(outsideRepo("/private/tmp/run.jsonl", "the run file") === "/private/tmp/run.jsonl", "one outside it is taken");

  // A call's outcome: only the model's own non-JSON answer is a reading of nothing; every other silence or log is a fault.
  const got = inf(3, null);
  assert("got" in outcomeOf(got, null, []) && (outcomeOf(got, null, []) as { got: Inferred }).got === got, "an answer is the model's reading");
  assert(JSON.stringify(outcomeOf(null, null, [NON_JSON])) === JSON.stringify({ got: null }), "a non-JSON answer is a reading of nothing, as the live capture states nothing");
  assert("fault" in outcomeOf(null, null, []), "null with nothing logged (an answer with no content) is a fault, not nothing");
  assert("fault" in outcomeOf(null, null, ["inferPriority: the request timed out (OB1_LLM_TIMEOUT)"]), "a provider failure is a fault");
  assert("fault" in outcomeOf(null, null, ["inferPriority: HTTP 500: the body was not valid JSON"]), "a provider failure whose body says not valid JSON is still a fault");
  assert("fault" in outcomeOf(null, new Error("boom"), []), "a thrown error is a fault");
  assert("got" in outcomeOf(got, null, ["capture: something else"]), "a line another module logs is not inferPriority's fault");

  // A run's lines.
  const rl = (n: number, over: Partial<{ prompt_version: number; model: string }> = {}) =>
    ({ id: id(n), at: tue.toISOString(), writer: "w", call: C(null), level_phrase: null, due_phrase: null, ms: 1, prompt_version: INFER_PROMPT_VERSION, ...over });
  assert(checkRunLines([rl(1), rl(2)], [{ id: id(1) }, { id: id(2) }]).length === 0, "a whole run of one version and one model is sound");
  assert(checkRunLines([rl(1), rl(1)], null).some((p) => /ids twice/.test(p)), "a run listing an id twice is refused");
  assert(checkRunLines([rl(1), rl(2, { prompt_version: INFER_PROMPT_VERSION + 1 })], null).some((p) => /prompt versions/.test(p)), "a run of two prompt versions is refused");
  assert(checkRunLines([rl(1, { model: "a@x t=0" }), rl(2, { model: "b@x t=0" })], null).some((p) => /mixes models/.test(p)), "a run of two models is refused");
  assert(checkRunLines([rl(1, { model: "a@x t=0" }), rl(2)], null).some((p) => /mixes models/.test(p)), "a recorded model beside unrecorded lines is refused");
  assert(checkRunLines([rl(1)], [{ id: id(1) }, { id: id(2) }]).some((p) => /lacks 1 of the population's 2/.test(p)), "a run short of the population is refused");
  assert(checkRunLines([rl(1), rl(2)], [{ id: id(1) }]).some((p) => /1 ids the population no longer does/.test(p)), "a run holding a thought the population no longer does is refused");

  // The drawn sheet is blind: nothing of a call or its phrases reaches it.
  const runRows = Array.from({ length: 30 }, (_, i) => ({ ...rl(i), call: i < 10 ? C(3, 2) : C(null), level_phrase: i < 10 ? "QQLEVELPHRASE" : null, due_phrase: i < 10 ? "QQDUEPHRASE" : null }));
  const pop = runRows.map((r) => ({ id: r.id, at: r.at, writer: "w", text: `text of ${r.id}` }));
  const drawn = drawSheet(runRows, pop);
  assert(drawn.picked.length === 30 && drawn.short.length === 2, "the sheet takes a short population whole");
  assert(!/QQLEVELPHRASE|QQDUEPHRASE|stratum/.test(drawn.sheet), "the sheet holds nothing of the calls' phrases or the strata");
  assert(drawn.sheet === renderSheet(drawn.picked.map((p) => ({ id: p.id, at: tue, text: `text of ${p.id}` }))), "the sheet is the drawn ids, capture days and texts alone, in the draw's order");
  assert(runRows.every((r) => drawn.sheet.includes(`text of ${r.id}`)), "the sheet holds every drawn text");

  // A filled sheet is tied to the draw.
  const fill = (sheet: string) => sheet.replaceAll("level: \ndue: ", "level: -\ndue: -");
  const pickedAt = drawn.picked.map((p) => ({ id: p.id, at: tue.toISOString() }));
  const fine = sheetLabels(fill(drawn.sheet), pickedAt);
  assert(fine.problems.length === 0 && fine.labels.size === 30, "a filled sheet of the draw is taken");
  assert(sheetLabels(fill(drawn.sheet), pickedAt.slice(1)).problems.some((p) => /not in the draw/.test(p)), "a sheet item outside the draw is refused");
  assert(sheetLabels(fill(drawn.sheet), [...pickedAt, { id: id(99), at: tue.toISOString() }]).problems.some((p) => /1 drawn items are not on the sheet/.test(p)), "a drawn item missing from the sheet is refused");
  const moved = fill(drawn.sheet).replace("captured: Tuesday 2026-11-03 (UTC)", "captured: Monday 2026-11-02 (UTC)");
  assert(sheetLabels(moved, pickedAt).problems.some((p) => /captured 2026-11-02 on the sheet, 2026-11-03 in the run/.test(p)), "a sheet item whose captured day is not the run's is refused");

  // A report only at the pinned registration, on this prompt version.
  assert(!reportLines({ ...fx, registration: registrationDigits(), prompt_version: INFER_PROMPT_VERSION + 1 }).at(-1)!.startsWith("verdict"), "a fixture measured on another prompt version gets no verdict");
  assert(!reportLines({ ...fx, registration: registrationDigits("ffffffffffffffff") }).at(-1)!.startsWith("verdict"), "a fixture labelled under another registration gets no verdict");
  assert(!reportLines({ ...fx, registration: registrationDigits("eeeeeeeeeeeeeeee") }, "eeeeeeeeeeeeeeee").at(-1)!.startsWith("verdict"), "a fixture and a rules file moved together, away from the pinned registration, get no verdict");

  // The committed fixture, once there is one.
  if (existsSync(FIXTURE)) {
    const f = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
    const { items: got, problems } = fromFixture(f);
    assert(problems.length === 0, `the committed fixture is sound (${problems.join("; ")})`);
    assert(got.length === DRAW.calls + DRAW.others || f.population.calls < DRAW.calls, "the committed fixture holds the whole draw");
    assert(got.every((i) => i.second !== null), "every committed item carries the second rater's label");
    assert(f.registration.map((x) => x.toString(16)).join("") === REGISTERED, "the committed fixture was labelled under the pinned registration");
    assert(f.prompt_version === INFER_PROMPT_VERSION, "the committed fixture was measured on the shipped prompt version");
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
