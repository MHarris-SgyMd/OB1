#!/usr/bin/env bun
/**
 * eval-claim-validity.ts — does the validity read agree with the truth? (SMD-3887 PR 2c.)
 *
 * Migration 149's `thought_validity` reads a thought's validity, review and freshness from the records the brain
 * keeps. This measures it against what a person reads in the texts, on a sample of the canary drawn before it is
 * read, by the rules and the bar pre-registered in evals/claim-validity.ts; this file runs them.
 *
 *   bun eval-claim-validity.ts --self-check
 *       Every rule against hand-known answers, the registration against its hash, and the committed fixture, when
 *       there is one, against its shape. No database.
 *
 *   bun eval-claim-validity.ts --print-sql (--salt <comment uuid> | --pilot 1|2)
 *       The snapshot's SQL: the population and its strata, the draw, each drawn item's material and the read's
 *       answer, one JSON line each, in one read-only transaction, for a brain whose database only a container reaches:
 *         podman exec -i open-brain-canary-postgres-1 psql -U postgres -d openbrain -v ON_ERROR_STOP=1 -tA -f - < sql > ~/.cache/<dir>/draw.jsonl
 *       It holds texts, so it lives outside any repo: every step refuses a private file in a git work tree.
 *
 *   bun eval-claim-validity.ts --sheets <draw.jsonl> --out <dir> (--salt <comment uuid> | --pilot 1|2) [--replace]
 *       The draw checked against the population lines (re-drawn here, so the SQL and the rules agree), the
 *       population by stratum and writer, then part A's sheet (validity and freshness) and part B's (review), each
 *       with its reply file, and the maintainer's (the subset's) apart. Never the read's answer.
 *
 *   bun eval-claim-validity.ts --kappa <draw.jsonl> <a-1> <b-1> <a-2> <b-2> (--salt <comment uuid> | --pilot 1|2)
 *       Two raters' filled reply files (each rater's part A, then its part B): κ per axis and each disagreement with both
 *       notes. The pilot's check, before the registration is pinned; it never prints the read.
 *
 *   bun eval-claim-validity.ts --splits <draw.jsonl> <a-1> <b-1> <a-2> <b-2> <m-a> <m-b> --salt <uuid> --out <file> [--replace]
 *       The items and axes the agents split on that the maintainer's subset does not decide: a reply file for the
 *       maintainer, `<id> | <axis> | <truth> | note` a line.
 *
 *   bun eval-claim-validity.ts --freeze <draw.jsonl> <a-1> <b-1> <a-2> <b-2> <m-a> <m-b> [<splits>] --salt <uuid> --note "<who, when>" [--replace]
 *       Every reply file and the read's answers → fixtures/claim-validity.json (ids and numbers only). Refuses a file
 *       with a blank or unknown truth, an id outside the draw, or a drawn item missing, and refuses everything at a
 *       registration other than the pinned one. The maintainer's pair holds their blind subset alone, so the check
 *       scores only blind labels. The splits file decides the agents' open splits, and, when the check makes the
 *       maintainer's labels the gold, carries those labels for every item outside the subset. Over a committed
 *       fixture, which holds the adjudications a freeze would erase, it runs only with --replace.
 *
 *   bun eval-claim-validity.ts --adjudicate <file> [--replace]
 *       Each miss's cause, `<id> <axis> label|record|read fixed|read open|rule <row>` a line, into the fixture frozen
 *       at the pinned registration. A cause already recorded on that axis changes only with --replace.
 *
 *   bun eval-claim-validity.ts
 *       The report from the fixture: per axis the agreement (raw and weighted), the misses with their causes, the
 *       raters' κ, the maintainer's check, and the verdict. No database.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssert } from "../db/test-support.ts";
import {
  AGREES, AXES, CAUSES, CONVENTIONS, DRAW, MAINTAINER_AGREEMENT_MIN, READ_STATES, READABLE_KINDS, SHOW, STRATA, TRUTH,
  agrees, drawKey, drawSample, drawSql, goldOf, kappa, maintainerCheck, noClaim, readableFreshness, registeredSection, registrationDigits,
  registrationHash, score, verdict, type Adjudication, type Axis, type AxisScore, type Cause, type Labels, type Mode, type Scored, type Stratum,
} from "./claim-validity.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const FIXTURE = join(HERE, "fixtures", "claim-validity.json");

/**
 * The registration this measurement is decided on: claim-validity.ts's registered section, hashed. Pinned after the
 * pilots and before the draw (2026-11-21); a change to the section is a new registration, and a verdict holds only at
 * the one its fixture records.
 */
export const REGISTERED: string | null = "0275b08cf87e7bf1";

/**
 * The rows of docs/claim-validity.md the read follows (migration 149: rows 1 to 7 and 9 to 11). A rule divergence can
 * only be "the read follows an accepted row" for one of these. The registered verdict takes any row from 1 to 13, and
 * the runner holds the stricter rule outside the hash, which this run meets (rows 2 and 6) (review pass 6, the
 * maintainer's "fix the findings").
 */
export const READ_ROWS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11];

/**
 * The maintainer's check, failing an axis it measured on no item as well as one under the bar. The registered check
 * passes an axis with no agent-agreed item in the subset, so the agents would be the gold there on no evidence. The
 * runner holds the stricter rule outside the hash, which this run meets (20 items on every axis).
 */
export function checkWithEvidence(items: readonly { a: Labels; b: Labels; m: Labels | null }[]): ReturnType<typeof maintainerCheck> {
  // Each axis on the items whose maintainer label holds that axis: a label left out is no disagreement (review pass 7).
  const per = Object.fromEntries(AXES.map((x) => [x, maintainerCheck(items.filter((i) => i.m !== null && i.m[x] !== null))[x]])) as { [A in Axis]: { n: number; hit: number; share: number | null } };
  const agentsAreGold = AXES.every((x) => per[x].n > 0 && per[x].share! >= MAINTAINER_AGREEMENT_MIN);
  return { ...per, agentsAreGold };
}

/** The UUID shape the salt (the announcing comment's id) and every thought id take. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── The snapshot's lines ──────────────────────────────────────────────────────

/** A population line. */
export type PopLine = { kind: "population"; id: string; stratum: Stratum; writer: string };
/** Another text shown on an item's page. */
export type Other = { id: string; at: string; updated: string; writer: string; chars: number; text: string };
/** A question a judge raised on the item (a supersession proposal), shown in part B. */
export type Question = { other: string; this_is: "older" | "newer"; verdict: string; reason: string | null; judged_at: string | null; status: string; reviewed_at: string | null; reviewed_by_kind: string | null };
/** An item line: what its pages show. */
export type ItemLine = {
  kind: "item"; id: string; stratum: Stratum; at: string; updated: string; writer: string; chars: number; text: string;
  views: { entities: string[]; metadata: { type: unknown; topics: unknown; people: unknown; action_items: unknown }; subject: string[] };
  others: Other[]; questions: Question[];
};
/** A read line: the read's answer for one drawn item. */
export type ReadLine = { kind: "read"; id: string; answer: { id: string; found: boolean; validity?: { state: string }; review?: { state: string }; freshness?: { state: string; kinds: { kind: string; state: string }[] } } | null };
type Line = PopLine | ItemLine | ReadLine;

/** The snapshot's lines split by kind, and what is wrong with them: an id twice, an item or read line outside the population, an item without its read. */
export function splitLines(lines: readonly Line[]): { pop: PopLine[]; items: ItemLine[]; reads: Map<string, ReadLine>; problems: string[] } {
  const pop = lines.filter((l): l is PopLine => l.kind === "population");
  const items = lines.filter((l): l is ItemLine => l.kind === "item");
  const readLines = lines.filter((l): l is ReadLine => l.kind === "read");
  const problems: string[] = [];
  const once = (what: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) { if (seen.has(id)) problems.push(`${what} ${id.slice(0, 8)} listed twice`); seen.add(id); }
  };
  once("population", pop.map((p) => p.id)); once("item", items.map((i) => i.id)); once("read", readLines.map((r) => r.id));
  const members = new Set(pop.map((p) => p.id));
  for (const l of [...items, ...readLines]) if (!members.has(l.id)) problems.push(`${l.kind} ${l.id.slice(0, 8)} is not in the population`);
  const reads = new Map(readLines.map((r) => [r.id, r]));
  for (const i of items) if (!reads.has(i.id)) problems.push(`item ${i.id.slice(0, 8)} has no read line`);
  // A read is its own item's, and an item sits in the stratum its population line gives (review pass 2).
  for (const r of readLines) {
    // A drawn thought exists, so a null answer or one not found is a failed read, not a miss on every axis (review pass 6).
    if (!r.answer || !r.answer.found) problems.push(`read ${r.id.slice(0, 8)}: no answer, or not found (the read failed: thought_validity's ok, its role)`);
    else if (r.answer.id !== r.id) problems.push(`read ${r.id.slice(0, 8)} answers for ${String(r.answer.id).slice(0, 8)}`);
  }
  const stratumOf = new Map(pop.map((p) => [p.id, p.stratum]));
  for (const i of items) if (stratumOf.has(i.id) && stratumOf.get(i.id) !== i.stratum) problems.push(`item ${i.id.slice(0, 8)}: stratum ${i.stratum}, the population's ${stratumOf.get(i.id)}`);
  for (const p of pop) if (!(STRATA as readonly string[]).includes(p.stratum)) problems.push(`population ${p.id.slice(0, 8)}: stratum "${p.stratum}"`);
  return { pop, items, reads, problems };
}

/** The draw's ids for a mode, re-drawn from the population: the pilot's, or the main draw's in sheet order. */
export function drawnIds(pop: readonly PopLine[], mode: Mode): string[] {
  const d = drawSample(pop, "salt" in mode ? mode.salt : DRAW.pilotSalt);
  return "salt" in mode ? d.main.map((m) => m.id) : mode.pilot === 1 ? d.pilot : d.pilot2;
}

/** Whether the SQL's items are the rules' draw: the same ids, every one. */
export function checkDraw(items: readonly ItemLine[], expected: readonly string[]): string[] {
  const have = new Set(items.map((i) => i.id)), want = new Set(expected), problems: string[] = [];
  const extra = items.filter((i) => !want.has(i.id)), missing = expected.filter((id) => !have.has(id));
  if (extra.length) problems.push(`the snapshot holds ${extra.length} items the rules do not draw (${extra[0].id.slice(0, 8)} first): the SQL and the rules disagree, or the salt differs`);
  if (missing.length) problems.push(`the snapshot lacks ${missing.length} items the rules draw (${missing[0].slice(0, 8)} first)`);
  return problems;
}

/** The read's three states for an item, freshness over the readable kinds; unknown on an axis a missing or unfound answer leaves unread. */
export function readStates(r: ReadLine | undefined): { [A in Axis]: string } {
  const a = r?.answer;
  if (!a || !a.found) return { validity: "unknown", review: "unknown", freshness: "unknown" };
  return {
    validity: a.validity?.state ?? "unknown",
    review: a.review?.state ?? "unknown",
    // An axis the read could not read stays unknown: its kinds are empty then, which readableFreshness reads as none.
    freshness: a.freshness && a.freshness.state !== "unknown" ? readableFreshness(a.freshness.kinds ?? []) : "unknown",
  };
}

// ── The sheets ────────────────────────────────────────────────────────────────

/** A time as a sheet shows it, in UTC whatever offset the database wrote it with (review pass 3). */
export const day = (at: string) => {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
};
const n = (x: number) => x.toLocaleString("en-US");
/** A line a sheet prints as its own structure: an item head, a section rule, a view line, another text's head. */
const MARKER = /^(=== item \d{3} · |--- |\[\d+\] written |written \d{4}-|# SMD-3887|entities: |metadata: type |subjects: )/;
/** A text as a sheet shows it: CRLF as LF, any line that reads as the page's own structure indented, so it is not (review pass 6). */
export const body = (t: string) => t.split(/\r\n|\r|\n/).map((l) => (MARKER.test(l) ? ` ${l}` : l)).join("\n");
/** A view's value as a rater reads it: a string as it is, anything else as JSON, never "[object Object]" (review pass 4). */
export const shown = (x: unknown): string => (typeof x === "string" ? x : JSON.stringify(x) ?? String(x)).replace(/\s*[\r\n]+\s*/g, " ");
export const list = (x: unknown): string => (Array.isArray(x) ? (x.length ? x.map(shown).join("; ") : "-") : x === null || x === undefined || x === "" ? "-" : shown(x));
/** A text's last edit as a sheet shows it, when it falls in another minute than its writing: a ticket's text is edited in place. */
const edited = (at: string, updated: string | undefined) => (updated && day(updated) !== day(at) ? `, last edited ${day(updated)}` : "");
const shownOf = (chars: number, cap: number) => (chars > cap ? `${n(chars)} characters, the first ${n(cap)} shown` : `${n(chars)} characters`);

/** Part A's page for an item: its text, its views and the other texts, numbered; never a record's verdict nor the read. */
export function pageA(it: ItemLine, num: number): string {
  const m = it.views.metadata;
  const others = it.others.map((o, k) => [`[${k + 1}] written ${day(o.at)}${edited(o.at, o.updated)} by ${o.writer} (${shownOf(o.chars, SHOW.otherChars)})`, body(o.text), ""].join("\n"));
  return [
    `=== item ${String(num).padStart(3, "0")} · ${it.id} ===`,
    `written ${day(it.at)}${edited(it.at, it.updated)} by ${it.writer} (${shownOf(it.chars, SHOW.itemChars)})`,
    "--- the item's text ---",
    body(it.text),
    "--- its views ---",
    `entities: ${list(it.views.entities)}`,
    `metadata: type ${list(m.type)}; topics ${list(m.topics)}; people ${list(m.people)}; action items ${list(m.action_items)}`,
    `subjects: ${list(it.views.subject)}`,
    `--- other texts (${it.others.length}) ---`,
    ...(others.length ? others : ["(none)", ""]),
  ].join("\n");
}

/** Part B's page for an item: the questions judges raised on it, each other side named by its number on part A where shown. */
export function pageB(it: ItemLine, num: number): string {
  const numOf = new Map(it.others.map((o, k) => [o.id, k + 1]));
  const qs = it.questions.map((q) => {
    const other = numOf.has(q.other) ? `text [${numOf.get(q.other)}] on part A` : `thought ${q.other} (not shown on part A)`;
    const asked = q.verdict === "newer_supersedes_older" ? `whether the newer of the two replaces the older (this item is the ${q.this_is})` : `"${q.verdict}" (this item is the ${q.this_is})`;
    const review = q.reviewed_at ? `, reviewed ${day(q.reviewed_at)}${q.reviewed_by_kind ? ` (reviewer: ${q.reviewed_by_kind})` : ""}` : "";
    return `- ${q.judged_at ? day(q.judged_at) : "undated"}: a judge asked, of this item and ${other}, ${asked}. Its reason: ${q.reason ? body(q.reason).replace(/\n+/g, " ") : "-"}. Status: ${q.status}${review}.`;
  });
  return [`=== item ${String(num).padStart(3, "0")} · ${it.id} ===`, ...(qs.length ? qs : ["(no question was raised by a judge)"]), ""].join("\n");
}

const SHEET_HEAD = (part: "A" | "B", what: string) => [
  `# SMD-3887 PR 2c, part ${part}: ${what}`,
  "",
  part === "A"
    ? "Label every item's VALIDITY and FRESHNESS in the part A reply file, before opening part B."
    : "Label every item's REVIEW in the part B reply file. Keep your part A labels as they are; part B is for review alone.",
  `Texts are capped (the item at ${n(SHOW.itemChars)} characters, the others at ${n(SHOW.otherChars)}); each says when it is cut.`,
  "",
  ...CONVENTIONS.map((c, i) => `${i + 1}. ${c}`),
  "",
].join("\n");

/** A reply file: one line per item, in the sheet's order, its truths blank. */
export function renderReplies(part: "A" | "B", ids: readonly string[]): string {
  const cols = part === "A" ? `validity (${TRUTH.validity.join("/")}) | freshness (${TRUTH.freshness.join("/")}) | note` : `review (${TRUTH.review.join("/")}) | note`;
  return [`# SMD-3887 PR 2c, part ${part} replies: NNN <id> | ${cols}. Leave no truth blank.`, ...ids.map((id, i) => `${String(i + 1).padStart(3, "0")} ${id} | ${part === "A" ? " |  | " : " | "}`), ""].join("\n");
}

/** One part's sheet and reply file over items in order. */
export function renderPart(part: "A" | "B", items: readonly ItemLine[]): { sheet: string; replies: string } {
  const pages = items.map((it, i) => (part === "A" ? pageA(it, i + 1) : pageB(it, i + 1)));
  return { sheet: [SHEET_HEAD(part, part === "A" ? "validity and freshness" : "review"), ...pages].join("\n"), replies: renderReplies(part, items.map((i) => i.id)) };
}

// ── The reply files ───────────────────────────────────────────────────────────

/**
 * A filled reply file read back, against the draw's ids: each id's truths for its part (A: validity, freshness; B:
 * review) and its note. Refuses, naming each, a line that is not a reply line, an id outside the draw or given twice,
 * a blank or unknown truth, and a drawn id missing when `all` (a maintainer's file holds only the subset).
 */
export function parseReplies(text: string, part: "A" | "B", drawn: readonly string[], all = true): { labels: Map<string, Partial<Labels>>; notes: Map<string, string>; problems: string[] } {
  const labels = new Map<string, Partial<Labels>>(), notes = new Map<string, string>(), problems: string[] = [];
  const inDraw = new Set(drawn), axes: Axis[] = part === "A" ? ["validity", "freshness"] : ["review"];
  for (const [k, raw] of text.replace(/\r\n/g, "\n").split("\n").entries()) {
    if (raw.trim() === "" || raw.startsWith("#")) continue;
    const m = /^(\d{3}) ([0-9a-f-]{36}) \|(.*)$/.exec(raw);
    if (!m) { problems.push(`line ${k + 1}: not "NNN <id> | …"`); continue; }
    const id = m[2], where = `item ${m[1]} (${id.slice(0, 8)})`;
    if (!inDraw.has(id)) { problems.push(`${where}: not in the draw`); continue; }
    if (labels.has(id)) { problems.push(`${where}: listed twice`); continue; }
    const cells = m[3].split("|").map((c) => c.trim());
    if (cells.length < axes.length) { problems.push(`${where}: ${axes.length} truths and a note expected`); continue; }
    const got: Partial<Labels> = {};
    let ok = true;
    axes.forEach((x, j) => {
      const v = cells[j].toLowerCase();
      if (v === "") { problems.push(`${where}: ${x} is blank`); ok = false; }
      else if (!(TRUTH[x] as readonly string[]).includes(v)) { problems.push(`${where}: ${x} "${cells[j]}" is not ${TRUTH[x].join("/")}`); ok = false; }
      else got[x] = v;
    });
    if (ok) { labels.set(id, got); notes.set(id, cells.slice(axes.length).join(" | ")); }
  }
  if (all) {
    const absent = drawn.filter((id) => !labels.has(id));
    if (absent.length) problems.push(`${absent.length} drawn items are not in the part ${part} reply file`);
  }
  return { labels, notes, problems };
}

/** One rater's two reply files as Labels per id (null where the file left a part out). */
export function mergeParts(a: Map<string, Partial<Labels>>, b: Map<string, Partial<Labels>>): Map<string, Labels> {
  const out = new Map<string, Labels>();
  for (const id of new Set([...a.keys(), ...b.keys()])) out.set(id, { validity: a.get(id)?.validity ?? null, review: b.get(id)?.review ?? null, freshness: a.get(id)?.freshness ?? null });
  return out;
}

/** A splits file read back: `<id> | <axis> | <truth> | note` a line, each id in the draw and each truth its axis's. */
export function parseSplits(text: string, drawn: readonly string[]): { labels: Map<string, Partial<Labels>>; problems: string[] } {
  const labels = new Map<string, Partial<Labels>>(), problems: string[] = [], inDraw = new Set(drawn);
  for (const [k, raw] of text.replace(/\r\n/g, "\n").split("\n").entries()) {
    if (raw.trim() === "" || raw.startsWith("#")) continue;
    const [id, axis, truth] = raw.split("|").map((c) => c.trim());
    const where = `line ${k + 1}`;
    if (!inDraw.has(id)) { problems.push(`${where}: ${id?.slice(0, 8)} not in the draw`); continue; }
    if (!(AXES as readonly string[]).includes(axis)) { problems.push(`${where}: axis "${axis}"`); continue; }
    if (!(TRUTH[axis as Axis] as readonly string[]).includes((truth ?? "").toLowerCase())) { problems.push(`${where}: ${axis} "${truth ?? ""}" is not ${TRUTH[axis as Axis].join("/")}`); continue; }
    const got = labels.get(id) ?? {};
    if (got[axis as Axis]) { problems.push(`${where}: ${id.slice(0, 8)} ${axis} given twice`); continue; }
    got[axis as Axis] = truth.toLowerCase();
    labels.set(id, got);
  }
  return { labels, problems };
}

// ── The fixture ───────────────────────────────────────────────────────────────

/**
 * The committed fixture: ids and numbers only (check-consistency 9). A truth and a read state are their index in
 * claim-validity.ts's lists (TRUTH, READ_STATES), -1 for none; an adjudication is [cause index, detail] with the detail
 * the record's row for a rule, 1 or 0 for a read bug fixed or not, 0 otherwise.
 */
export type Fixture = {
  generated: string;
  note: string;
  registration: number[];
  salt: string;
  population: Record<Stratum, number>;
  strata: Record<Stratum, string[]>;
  subset: string[];
  items: Record<string, { read: number[]; a1: number[]; a2: number[]; m: number[] | null; s: number[] | null }>;
  adjudication: Record<string, Partial<Record<Axis, number[]>>>;
};

const toIdx = (axis: Axis, v: string | null) => (v === null ? -1 : (TRUTH[axis] as readonly string[]).indexOf(v));
const fromIdx = (axis: Axis, i: number) => (i < 0 ? null : (TRUTH[axis][i] ?? null));
const labelsTo = (l: Labels | null) => (l === null ? null : AXES.map((x) => toIdx(x, l[x])));
const labelsFrom = (xs: number[] | null): Labels | null => (xs === null ? null : { validity: fromIdx("validity", xs[0]), review: fromIdx("review", xs[1]), freshness: fromIdx("freshness", xs[2]) });

/** Adjudication to and from its fixture form. */
export const adjTo = (a: Adjudication): number[] => [CAUSES.indexOf(a.cause), a.cause === "rule" ? (a.row ?? 0) : a.cause === "read" ? (a.fixed ? 1 : 0) : 0];
export const adjFrom = (xs: number[]): Adjudication | null => {
  const cause = CAUSES[xs[0]] as Cause | undefined;
  if (!cause) return null;
  return cause === "rule" ? { cause, row: xs[1] } : cause === "read" ? { cause, fixed: xs[1] === 1 } : { cause };
};

/** One frozen item, read back. */
export type FrozenItem = { id: string; stratum: Stratum; read: { [A in Axis]: string }; a1: Labels; a2: Labels; m: Labels | null; s: Labels | null };

/** The items of a fixture, and what is wrong with it: an id in two strata or none, an index off its list, a subset id outside the draw. */
export function fromFixture(f: Fixture): { items: FrozenItem[]; adjudicated: Map<string, Partial<Record<Axis, Adjudication>>>; problems: string[] } {
  const problems: string[] = [], items: FrozenItem[] = [];
  // A fixture missing a top-level list is named, not thrown on (review pass 7).
  const lists = { items: f.items && typeof f.items === "object", strata: f.strata && typeof f.strata === "object", subset: Array.isArray(f.subset), registration: Array.isArray(f.registration), population: !!f.population && STRATA.every((st) => Number.isInteger(f.population[st])) };
  const missing = Object.entries(lists).filter(([, ok]) => !ok).map(([k]) => k);
  if (missing.length) return { items, adjudicated: new Map(), problems: [`the fixture lacks ${missing.join(", ")}`] };
  const stratumOf = new Map<string, Stratum>();
  for (const s of STRATA) for (const id of f.strata[s] ?? []) {
    if (stratumOf.has(id)) problems.push(`${id} is in two strata`);
    stratumOf.set(id, s);
  }
  for (const [id, it] of Object.entries(f.items)) {
    const stratum = stratumOf.get(id);
    if (!stratum) { problems.push(`${id} is in no stratum`); continue; }
    const bad = (xs: number[] | null, lists: readonly (readonly string[])[]) => xs !== null && (xs.length !== 3 || xs.some((v, k) => !Number.isInteger(v) || v < -1 || v >= lists[k].length));
    const truthLists = AXES.map((x) => TRUTH[x]), readLists = AXES.map((x) => READ_STATES[x]);
    if (!Array.isArray(it.read) || !Array.isArray(it.a1) || !Array.isArray(it.a2)) { problems.push(`${id}: a read or an agent's labels missing`); continue; }
    if (bad(it.read, readLists) || it.read.includes(-1)) { problems.push(`${id}: a read state off its list`); continue; }
    // An item without the maintainer's or the splits' key holds neither (review pass 7).
    const m = it.m ?? null, s = it.s ?? null;
    if ([it.a1, it.a2, m, s].some((l) => bad(l, truthLists))) { problems.push(`${id}: a truth off its list`); continue; }
    items.push({
      id, stratum,
      read: { validity: READ_STATES.validity[it.read[0]], review: READ_STATES.review[it.read[1]], freshness: READ_STATES.freshness[it.read[2]] },
      a1: labelsFrom(it.a1)!, a2: labelsFrom(it.a2)!, m: labelsFrom(m), s: labelsFrom(s),
    });
  }
  for (const id of stratumOf.keys()) if (!(id in f.items)) problems.push(`${id} is in a stratum with no item`);
  for (const id of f.subset) if (!(id in f.items)) problems.push(`subset ${id} is not an item`);
  const adjudicated = new Map<string, Partial<Record<Axis, Adjudication>>>();
  for (const [id, per] of Object.entries(f.adjudication ?? {})) {
    if (!(id in f.items)) { problems.push(`adjudication ${id} is not an item`); continue; }
    if (!per || typeof per !== "object") { problems.push(`adjudication ${id} is not an object`); continue; }
    const out: Partial<Record<Axis, Adjudication>> = {};
    for (const [x, v] of Object.entries(per)) {
      const a = (AXES as readonly string[]).includes(x) && Array.isArray(v) ? adjFrom(v) : null;
      if (!a) problems.push(`adjudication ${id} ${x}: not a cause`); else out[x as Axis] = a;
    }
    adjudicated.set(id, out);
  }
  return { items, adjudicated, problems };
}

/**
 * The gold and its gaps for frozen items: the agents' agreement, the maintainer's label (the subset's blind one, else
 * the split decision) where they split, or the maintainer's alone on every item once the check says the agents are
 * not the gold.
 */
export function goldFor(items: readonly FrozenItem[], subset: ReadonlySet<string>): { scored: Scored[]; agentsAreGold: boolean; check: ReturnType<typeof maintainerCheck>; splits: number; unlabelled: number } {
  const check = checkWithEvidence(items.filter((i) => subset.has(i.id)).map((i) => ({ a: i.a1, b: i.a2, m: i.m })));
  let splits = 0, unlabelled = 0;
  const scored = items.map((i): Scored => {
    // The maintainer's label per axis: the blind one where the subset holds it, else the splits file's (review pass 4).
    const decider: Labels = { validity: i.m?.validity ?? i.s?.validity ?? null, review: i.m?.review ?? i.s?.review ?? null, freshness: i.m?.freshness ?? i.s?.freshness ?? null };
    if (!check.agentsAreGold) {
      if (AXES.some((x) => decider[x] === null)) unlabelled++;
      return { id: i.id, stratum: i.stratum, read: i.read, gold: decider };
    }
    const { gold, splits: open } = goldOf(i.a1, i.a2, decider);
    splits += open.length;
    return { id: i.id, stratum: i.stratum, read: i.read, gold };
  });
  return { scored, agentsAreGold: check.agentsAreGold, check, splits, unlabelled };
}

// ── The report ────────────────────────────────────────────────────────────────

const f3 = (x: number | null) => (x === null ? "—" : x.toFixed(3));

/** The report's lines for a fixture, at the rules file's registration (`current`, its hash by default): pure, so the self-check reads them. */
export function reportLines(f: Fixture, current: string = registrationHash(), pinned: string | null = REGISTERED): string[] {
  const { items, adjudicated, problems } = fromFixture(f);
  if (problems.length) return ["the fixture is not sound:", ...problems.map((p) => `  ${p}`)];
  const { scored, agentsAreGold, check, splits, unlabelled } = goldFor(items, new Set(f.subset));
  const s: Record<Axis, AxisScore> = score(scored, f.population);
  // The registered score counts a read that makes no single claim (unresolved, legacy) as agreeing; this is the same
  // score over the reads that commit to a state alone (review pass 1). It moves no verdict: a no-claim read is no miss.
  const committed = (x: Axis) => score(scored.map((i) => (noClaim(x, i.read[x]) ? { ...i, gold: { ...i.gold, [x]: null } } : i)), f.population)[x];
  // A stratum with nothing scored drops out of the registered weighting, which then covers the rest alone: say which
  // strata a weighted figure covers when one is missing (review pass 6). Nothing in this run.
  const covers = (x: Axis, commitOnly: boolean) => {
    const has = STRATA.filter((st) => scored.some((i) => i.stratum === st && i.gold[x] !== null && i.gold[x] !== "unclear" && !(commitOnly && noClaim(x, i.read[x]))));
    return has.length === STRATA.length ? "" : `, over ${has.join(" and ") || "no stratum"} only`;
  };
  const byRules = verdict(s, adjudicated, { splits, unlabelled });
  // The runner's stricter rule on the fixture as committed, not only at --adjudicate: a rule divergence naming a row the
  // read does not follow explains nothing (review pass 7). None in this run.
  const offRows = [...adjudicated].flatMap(([id, per]) => AXES.flatMap((x) => (per[x]?.cause === "rule" && !READ_ROWS.includes(per[x]!.row ?? 0) && s[x].misses.includes(id) ? [`${x} ${id.slice(0, 8)}: rule row ${per[x]!.row}, which the read does not follow`] : [])));
  const v = offRows.length ? { state: "fails" as const, reasons: [...offRows, ...byRules.reasons] } : byRules;
  const k = (x: Axis) => {
    const both = items.filter((i) => i.a1[x] !== null && i.a2[x] !== null);
    return both.length ? kappa(both.map((i) => i.a1[x]!), both.map((i) => i.a2[x]!)) : null;
  };
  const causes = (x: Axis) => {
    const by = new Map<string, number>();
    for (const id of s[x].misses) {
      const a = adjudicated.get(id)?.[x], key = !a ? "not adjudicated" : a.cause === "rule" ? `rule (row ${a.row})` : a.cause === "read" ? `read (${a.fixed ? "fixed" : "open"})` : a.cause;
      by.set(key, (by.get(key) ?? 0) + 1);
    }
    return [...by].map(([c, m]) => `${c} ${m}`).join(", ") || "none";
  };
  const registered = f.registration.map((d) => d.toString(16)).join("");
  const atPin = pinned !== null && registered === pinned && current === pinned;
  const pop = STRATA.map((st) => `${st} ${f.population[st]}`).join(", ");
  return [
    `population ${STRATA.reduce((a, st) => a + f.population[st], 0)} (${pop}); sample ${items.length}; salt ${f.salt}`,
    ...AXES.map((x) => `${x.padEnd(9)} agrees on ${s[x].agree} of ${s[x].scored} scored (weighted ${f3(s[x].weighted)}${covers(x, false)}); ${s[x].misses.length} misses: ${causes(x)}; unclear ${s[x].unclear}; no claim ${s[x].noClaim}\n${" ".repeat(10)}on the reads that commit to a state: ${committed(x).agree} of ${committed(x).scored} (weighted ${f3(committed(x).weighted)}${covers(x, true)})`),
    `κ between the agents: ${AXES.map((x) => `${x} ${f3(k(x))}`).join(", ")}`,
    `the maintainer's check (subset ${f.subset.length}, bar ${MAINTAINER_AGREEMENT_MIN}): ${AXES.map((x) => `${x} ${check[x].hit} of ${check[x].n}`).join(", ")}: ${agentsAreGold ? "the agents are the gold" : "the maintainer's labels are the gold"}`,
    !atPin
      ? `no verdict: the fixture was labelled under registration ${registered}; this file's is ${current}, the pinned one ${pinned ?? "not yet set"}`
      : `verdict: ${v.state.toUpperCase()}${v.reasons.length ? ` — ${v.reasons.join("; ")}` : ""}`,
  ];
}

// ── Files ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
/** The plain arguments after a step's flag, up to the next flag. */
const after = (name: string): string[] => {
  const i = args.indexOf(`--${name}`), out: string[] = [];
  for (let j = i + 1; i >= 0 && j < args.length && !args[j].startsWith("--"); j++) out.push(args[j]);
  return out;
};

/**
 * Refuse a private file inside a git work tree: the snapshot holds texts and the read's answers, a sheet texts, a
 * reply file a rater's notes. Any work tree, not only this checkout: from a worktree, the canonical checkout is a repo too.
 */
export function outsideRepo(path: string, what: string): string {
  const abs = resolve(path);
  // A private file is never a symlink, whether its target exists or not: a dangling one passes existsSync and a write
  // then creates its target, wherever that is (review pass 8, after passes 6 and 7 each closed one symlink case).
  let link = false;
  try { link = lstatSync(abs).isSymbolicLink(); } catch { link = false; }
  if (link) throw new Error(`${what} (${path}) is a symlink: a private file is written only at a real path`);
  // The real path of the nearest directory that exists, so a symlinked directory into a work tree is seen as one.
  let near = dirname(abs);
  while (!existsSync(near) && dirname(near) !== near) near = dirname(near);
  for (let d = realpathSync(near); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) throw new Error(`${what} (${path}) is inside the git work tree at ${d}: it holds thought text, so it lives outside any repo`);
    if (dirname(d) === d) return abs;
  }
}

/**
 * Write a private file at 0600, refusing to write over one that exists unless `replace`: a reply or splits file may
 * already hold a rater's or the maintainer's answers (review pass 6). The mode is set again, as writeFileSync's applies
 * only when it creates the file.
 */
export function writePrivate(path: string, text: string, replace: boolean): void {
  // Every private write is guarded here, so no caller can write one file of several unchecked (review pass 8).
  outsideRepo(path, "a private file");
  if (existsSync(path) && !replace) throw new Error(`${path} exists, and may hold filled answers: give --replace to write over it`);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

const readJsonl = <T>(path: string): T[] => readFileSync(path, "utf8").split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l) as T);

/** The draw a step runs: the main draw by the announcing comment's uuid, or pilot 1 or 2. Refuses neither and both. */
export function modeOf(salt: string | undefined, pilot: string | undefined): Mode {
  if (pilot !== undefined && salt !== undefined) throw new Error("give --salt or --pilot, not both");
  if (pilot !== undefined) {
    if (pilot !== "1" && pilot !== "2") throw new Error(`--pilot ${pilot}: write 1 or 2`);
    return { pilot: pilot === "1" ? 1 : 2 };
  }
  if (salt === undefined || !UUID.test(salt)) throw new Error("give --salt <the announcing comment's uuid> or --pilot 1|2");
  return { salt };
}

/** The main draw's salt, refusing a pilot: a step only the main draw has (the splits, the freeze). */
export function mainSalt(mode: Mode): string {
  if (!("salt" in mode)) throw new Error("this step is the main draw's: give --salt, not --pilot");
  return mode.salt;
}

/** Refuse a step that reads the registration once it is not the pinned one (the main draw, the freeze). The pilot runs before the pin. */
function refuseUnpinned(step: string): void {
  if (REGISTERED === null) throw new Error(`the registration is not pinned yet: ${step} only once it is (after the pilot)`);
  if (registrationHash() !== REGISTERED) throw new Error(`the registration is ${registrationHash()}, not the pinned ${REGISTERED}: ${step} only at the pinned registration`);
}

/**
 * A snapshot with no population, or a draw of nothing, is a failed query, not an empty sheet: psql without
 * ON_ERROR_STOP exits clean on an error and leaves BEGIN and ROLLBACK alone (review pass 3).
 */
export function emptySnapshot(population: number, drawn: number): string[] {
  if (population === 0) return ["the snapshot holds no population line: the query failed (run psql with -v ON_ERROR_STOP=1)"];
  if (drawn === 0) return ["the draw takes no item from this population"];
  return [];
}

/** The snapshot read and checked: its lines, and the draw's ids in sheet order, refused on any problem. */
function snapshot(path: string, mode: Mode): { pop: PopLine[]; items: ItemLine[]; reads: Map<string, ReadLine>; ids: string[] } {
  const { pop, items, reads, problems } = splitLines(readJsonl<Line>(outsideRepo(path, "the snapshot")));
  const ids = drawnIds(pop, mode);
  problems.push(...checkDraw(items, ids), ...emptySnapshot(pop.length, ids.length));
  if (problems.length) throw new Error(problems.join("\n"));
  const byId = new Map(items.map((i) => [i.id, i]));
  return { pop, items: ids.map((id) => byId.get(id)!), reads, ids };
}

/** The population by stratum and writer, printed before a sheet goes out: what the frame took. */
export function makeupLines(pop: readonly PopLine[]): string[] {
  return STRATA.map((s) => {
    const of = pop.filter((p) => p.stratum === s), by = new Map<string, number>();
    for (const p of of) by.set(p.writer, (by.get(p.writer) ?? 0) + 1);
    return `  ${s}: ${of.length} (${[...by].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([w, c]) => `${w} ${c}`).join(", ")})`;
  });
}

function sheets(path: string, out: string, mode: Mode): void {
  if ("salt" in mode) refuseUnpinned("the main sheets are drawn");
  const dir = dirname(outsideRepo(join(out, "sheet-a.md"), "the sheets' directory"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { pop, items } = snapshot(path, mode);
  const short = drawSample(pop, "salt" in mode ? mode.salt : DRAW.pilotSalt).short;
  if ("salt" in mode && short.length) console.log(`short strata, taken whole: ${short.join("; ")}`);
  console.log(`population ${pop.length}, by stratum and writer:`);
  for (const l of makeupLines(pop)) console.log(l);
  const write = (name: string, text: string) => writePrivate(join(dir, name), text, args.includes("--replace"));
  for (const part of ["A", "B"] as const) {
    const r = renderPart(part, items);
    write(`sheet-${part.toLowerCase()}.md`, r.sheet);
    write(`replies-${part.toLowerCase()}.txt`, r.replies);
  }
  if ("salt" in mode) {
    const sub = new Set(drawSample(pop, mode.salt).subset), mine = items.filter((i) => sub.has(i.id));
    for (const part of ["A", "B"] as const) {
      const r = renderPart(part, mine);
      write(`maintainer-sheet-${part.toLowerCase()}.md`, r.sheet);
      write(`maintainer-replies-${part.toLowerCase()}.txt`, r.replies);
    }
  }
  const chars = items.map((i) => i.text.length + i.others.reduce((a, o) => a + o.text.length, 0));
  console.log(`drew ${items.length} → ${dir}: part A ${n(chars.reduce((a, b) => a + b, 0))} characters (median item ${n([...chars].sort((a, b) => a - b)[Math.floor(chars.length / 2)] ?? 0)}), cut items ${items.filter((i) => i.chars > SHOW.itemChars).length}`);
}

/** A rater's two files read as Labels, refused on any problem. */
function rater(aPath: string, bPath: string, ids: readonly string[], all = true): { labels: Map<string, Labels>; notes: Map<string, string> } {
  const read = (p: string, part: "A" | "B") => {
    const r = parseReplies(readFileSync(outsideRepo(p, "a reply file"), "utf8"), part, ids, all);
    if (r.problems.length) throw new Error(`${p}:\n  ${r.problems.join("\n  ")}`);
    return r;
  };
  const a = read(aPath, "A"), b = read(bPath, "B");
  const notes = new Map<string, string>();
  for (const id of ids) {
    const t = [a.notes.get(id), b.notes.get(id)].filter((x) => x).join(" / ");
    if (t) notes.set(id, t);
  }
  return { labels: mergeParts(a.labels, b.labels), notes };
}

/** κ per axis between two raters, and each disagreement with both notes. Pure, so the self-check reads it. */
export function kappaLines(ids: readonly string[], r1: { labels: Map<string, Labels>; notes: Map<string, string> }, r2: { labels: Map<string, Labels>; notes: Map<string, string> }): string[] {
  const out: string[] = [];
  for (const x of AXES) {
    const both = ids.filter((id) => r1.labels.get(id)?.[x] && r2.labels.get(id)?.[x]);
    const k = both.length ? kappa(both.map((id) => r1.labels.get(id)![x]!), both.map((id) => r2.labels.get(id)![x]!)) : null;
    const same = both.filter((id) => r1.labels.get(id)![x] === r2.labels.get(id)![x]).length;
    out.push(`${x}: κ ${f3(k)}, the same on ${same} of ${both.length}`);
    for (const id of both) if (r1.labels.get(id)![x] !== r2.labels.get(id)![x])
      out.push(`  ${String(ids.indexOf(id) + 1).padStart(3, "0")} ${id.slice(0, 8)}: ${r1.labels.get(id)![x]} / ${r2.labels.get(id)![x]}  [${r1.notes.get(id) ?? "-"}] [${r2.notes.get(id) ?? "-"}]`);
  }
  return out;
}

/** The items and axes the agents split on that the maintainer's own labels do not decide. */
export function openSplits(ids: readonly string[], a1: Map<string, Labels>, a2: Map<string, Labels>, m: Map<string, Labels>): { id: string; axis: Axis }[] {
  const out: { id: string; axis: Axis }[] = [];
  for (const id of ids) for (const x of AXES) if (a1.get(id)?.[x] !== a2.get(id)?.[x] && !m.get(id)?.[x]) out.push({ id, axis: x });
  return out;
}

/**
 * The splits file the maintainer fills: the agents' open splits while the check makes the agents the gold; else a line
 * for every axis of every item outside the subset, since the maintainer's labels are then the gold (review pass 5).
 */
export function splitsTemplate(ids: readonly string[], subset: readonly string[], a1: Map<string, Labels>, a2: Map<string, Labels>, m: Map<string, Labels>): { lines: string[]; fallback: boolean } {
  const fallback = !checkWithEvidence(subset.map((id) => ({ a: a1.get(id)!, b: a2.get(id)!, m: m.get(id)! }))).agentsAreGold;
  const sub = new Set(subset);
  const cells = fallback
    ? ids.filter((id) => !sub.has(id)).flatMap((id) => AXES.map((axis) => ({ id, axis })))
    : openSplits(ids, a1, a2, m);
  const head = fallback
    ? "# SMD-3887 PR 2c: the maintainer's check fails, so the maintainer labels every item outside their blind 20: <id> | <axis> | <truth> | note."
    : "# SMD-3887 PR 2c, the agents' splits: <id> | <axis> | <truth> | note. The item's number is its number on the sheets.";
  return { lines: [head, ...cells.map((o) => `${o.id} | ${o.axis} |  | item ${String(ids.indexOf(o.id) + 1).padStart(3, "0")}`)], fallback };
}

/**
 * A splits file's decisions that decide no open split: an axis the agents agreed on, or one the maintainer's own label
 * already decides. goldOf would drop them silently, so the maintainer would think a gold moved that did not (review pass 2).
 */
export function strayDecisions(decided: ReadonlyMap<string, Partial<Labels>>, open: readonly { id: string; axis: Axis }[]): string[] {
  const isOpen = new Set(open.map((o) => `${o.id} ${o.axis}`));
  const out: string[] = [];
  for (const [id, per] of decided) for (const x of AXES) if (per[x] && !isOpen.has(`${id} ${x}`)) out.push(`${id.slice(0, 8)} ${x}: no open split there (the agents agree, or the maintainer's 20 decide it)`);
  return out;
}

function freeze(path: string, salt: string, files: string[], splitsPath: string | undefined, note: string, replace: boolean): void {
  refuseUnpinned("labels are frozen");
  // A freeze writes no adjudication: over a fixture that holds causes it would erase them (review pass 3).
  if (existsSync(FIXTURE) && !replace) throw new Error(`${relative(REPO, FIXTURE)} exists, with its adjudications: give --replace to freeze over it, then adjudicate again`);
  const { pop, reads, ids } = snapshot(path, { salt });
  const d = drawSample(pop, salt);
  const [a1, a2] = [rater(files[0], files[1], ids), rater(files[2], files[3], ids)];
  // The maintainer's pair holds the blind subset alone, so the check scores only blind labels: a label made later, with
  // the agents' context in view, goes in the splits file (review pass 4).
  const m = rater(files[4], files[5], d.subset, true);
  const s = splitsPath ? parseSplits(readFileSync(outsideRepo(splitsPath, "the splits file"), "utf8"), ids) : { labels: new Map<string, Partial<Labels>>(), problems: [] };
  // While the agents are the gold, the splits file decides open splits alone. When the check makes the maintainer's
  // labels the gold, it carries them for every item outside the subset.
  const agentsAreGold = checkWithEvidence(d.subset.map((id) => ({ a: a1.labels.get(id)!, b: a2.labels.get(id)!, m: m.labels.get(id)! }))).agentsAreGold;
  if (agentsAreGold) s.problems.push(...strayDecisions(s.labels, openSplits(ids, a1.labels, a2.labels, m.labels)));
  else s.problems.push(...[...s.labels.keys()].filter((id) => d.subset.includes(id)).map((id) => `${id.slice(0, 8)}: a subset item, which the blind labels decide`));
  if (s.problems.length) throw new Error(`${splitsPath}:\n  ${s.problems.join("\n  ")}`);
  if (d.short.length) console.log(`short strata, taken whole: ${d.short.join("; ")}`);
  const stratumOf = new Map(d.main.map((x) => [x.id, x.stratum]));
  const population = Object.fromEntries(STRATA.map((st) => [st, pop.filter((p) => p.stratum === st).length])) as Record<Stratum, number>;
  const fixture: Fixture = {
    generated: new Date().toISOString(), note, registration: registrationDigits(), salt, population,
    strata: Object.fromEntries(STRATA.map((st) => [st, ids.filter((id) => stratumOf.get(id) === st)])) as Record<Stratum, string[]>,
    subset: d.subset,
    items: Object.fromEntries(ids.map((id) => {
      const r = readStates(reads.get(id));
      const sp = s.labels.get(id);
      return [id, {
        read: AXES.map((x) => (READ_STATES[x] as readonly string[]).indexOf(r[x])),
        a1: labelsTo(a1.labels.get(id)!)!, a2: labelsTo(a2.labels.get(id)!)!,
        m: d.subset.includes(id) ? labelsTo(m.labels.get(id)!) : null,
        s: sp ? labelsTo({ validity: sp.validity ?? null, review: sp.review ?? null, freshness: sp.freshness ?? null }) : null,
      }];
    })),
    adjudication: {},
  };
  const back = fromFixture(fixture);
  if (back.problems.length) throw new Error(`the fixture is not sound:\n  ${back.problems.join("\n  ")}`);
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`froze ${ids.length} items → ${relative(REPO, FIXTURE)}`);
}

/** An adjudication file read: `<id> <axis> label|record|read fixed|read open|rule <row>` a line. */
export function parseAdjudications(text: string): { per: Map<string, Partial<Record<Axis, Adjudication>>>; problems: string[] } {
  const per = new Map<string, Partial<Record<Axis, Adjudication>>>(), problems: string[] = [];
  for (const [k, raw] of text.replace(/\r\n/g, "\n").split("\n").entries()) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const m = /^([0-9a-f-]{36}) (validity|review|freshness) (label|record|read (?:fixed|open)|rule (\d+))$/.exec(line);
    if (!m) { problems.push(`line ${k + 1}: not "<id> <axis> label|record|read fixed|read open|rule <row>"`); continue; }
    const cause = m[3].split(" ")[0] as Cause;
    const a: Adjudication = cause === "rule" ? { cause, row: Number(m[4]) } : cause === "read" ? { cause, fixed: m[3].endsWith("fixed") } : { cause };
    const got = per.get(m[1]) ?? {};
    if (got[m[2] as Axis]) { problems.push(`line ${k + 1}: ${m[1].slice(0, 8)} ${m[2]} given twice`); continue; }
    got[m[2] as Axis] = a;
    per.set(m[1], got);
  }
  return { per, problems };
}

/** The committed fixture, refused when there is none or it was frozen at another registration than the pinned one (review pass 4). */
function fixtureAtPin(): Fixture {
  if (!existsSync(FIXTURE)) throw new Error(`no ${relative(REPO, FIXTURE)} yet: freeze the labels first`);
  const f = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
  // The fixture is sound before its registration is read, so a malformed one is named, not thrown on (review pass 9).
  const sound = fromFixture(f).problems;
  if (sound.length) throw new Error(`the fixture is not sound:\n  ${sound.join("\n  ")}`);
  const at = f.registration.map((d) => d.toString(16)).join("");
  if (at !== REGISTERED) throw new Error(`the fixture was frozen at registration ${at}, not the pinned ${REGISTERED}`);
  return f;
}

/**
 * Adjudications merged into a fixture, axis by axis: an earlier file's cause on another axis of the same item stays.
 * Refuses, naming each, an id that is no item and an axis the read does not miss on that item.
 */
export function applyAdjudications(f: Fixture, per: ReadonlyMap<string, Partial<Record<Axis, Adjudication>>>, replace = false): { fixture: Fixture; problems: string[] } {
  const problems: string[] = [];
  const { items } = fromFixture(f);
  const s = score(goldFor(items, new Set(f.subset)).scored, f.population);
  const out: Fixture = structuredClone(f);
  out.adjudication ??= {};
  for (const [id, axes] of per) {
    if (!(id in f.items)) { problems.push(`${id.slice(0, 8)} is not an item`); continue; }
    for (const [x, a] of Object.entries(axes) as [Axis, Adjudication][]) {
      if (!s[x].misses.includes(id)) { problems.push(`${id.slice(0, 8)} ${x}: not a miss`); continue; }
      if (a.cause === "rule" && !READ_ROWS.includes(a.row ?? 0)) { problems.push(`${id.slice(0, 8)} ${x}: rule row ${a.row} is not one the read follows (${READ_ROWS.join(", ")})`); continue; }
      const had = out.adjudication[id]?.[x];
      if (had && !replace && had.join() !== adjTo(a).join()) { problems.push(`${id.slice(0, 8)} ${x}: adjudicated already, as ${adjFrom(had)?.cause ?? "?"} (give --replace to change a confirmed cause)`); continue; }
      out.adjudication[id] = { ...out.adjudication[id], [x]: adjTo(a) };
    }
  }
  return { fixture: out, problems };
}

// ── --self-check ──────────────────────────────────────────────────────────────

function selfCheck(): void {
  const { assert, report } = createAssert();
  const id = (k: number) => `10000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
  const salt = "20000000-0000-4000-8000-000000000001";
  let threw = false;
  const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };

  // The registration.
  const src = readFileSync(join(HERE, "claim-validity.ts"), "utf8");
  assert(REGISTERED === null || registrationHash() === REGISTERED, `the registered section is the pinned one (${registrationHash()} = ${REGISTERED}); a change is a new registration, made before any sheet is drawn`);
  assert(DRAW.perStratum === 40 && DRAW.subset === 20 && DRAW.pilot === 10 && DRAW.pilot2 === 3 && MAINTAINER_AGREEMENT_MIN === 0.8,
    "the draw and the maintainer's check are the maintainer's (40 a stratum, a subset of 20, pilots of 10 and 3 a stratum, 0.8): changing them is a decision recorded on SMD-3887");
  assert(CONVENTIONS.some((c) => /contradicted by the text/.test(c) && /plainly implies/.test(c)), "freshness counts as stale only what the text contradicts or does not discuss (the maintainer, 2026-11-21)");
  assert(registrationHash(src.replace("perStratum: 40", "perStratum: 30")) !== registrationHash(src), "a moved draw moves the registration");
  assert(registrationHash(src.replace('unchallenged: ["holds"]', 'unchallenged: ["holds", "contested"]')) !== registrationHash(src), "a moved mapping moves the registration");
  assert(registrationHash(src.replace("function kappa", "function kappa ")) === registrationHash(src), "κ is outside the registration");
  assert(registrationHash(src.replace(/\n/g, "\r\n")) === registrationHash(src), "a CRLF checkout hashes the same");
  assert(throws(() => registeredSection("no markers")), "a file without the section's markers is refused, not hashed empty");
  assert(registrationDigits("0af").join() === "0,10,15", "the fixture records the hash as its hex digits");

  // The mapping.
  for (const x of AXES) {
    const truths = TRUTH[x].filter((t) => t !== "unclear");
    assert(READ_STATES[x].every((r) => r in AGREES[x]), `every ${x} state the read can give has a mapping`);
    assert(Object.values(AGREES[x]).every((ts) => ts.every((t) => (truths as readonly string[]).includes(t))), `the ${x} mapping names only truths a rater can give`);
    assert(truths.every((t) => READ_STATES[x].some((r) => agrees(x, r, t) && !noClaim(x, r))), `every ${x} truth is claimed by some read state, so a miss can show`);
    assert(!READ_STATES[x].some((r) => agrees(x, r, "unclear")), `unclear agrees with no ${x} state: an unclear gold is not scored`);
    assert(AGREES[x].unknown.length === 0, `unknown ${x} agrees with no truth: an unread axis is a miss`);
  }
  assert(agrees("validity", "unchallenged", "holds") && !agrees("validity", "unchallenged", "superseded") && !agrees("validity", "unchallenged", "contested"), "unchallenged claims it holds: a superseded or contested truth is a miss");
  assert(agrees("validity", "supported", "holds") && !agrees("validity", "superseded", "holds") && !agrees("validity", "contested", "holds"), "supported holds; superseded and contested do not");
  assert(noClaim("validity", "unresolved") && noClaim("freshness", "legacy") && !noClaim("validity", "unchallenged") && !noClaim("review", "pending"), "unresolved and legacy make no claim; the others do");
  assert(agrees("review", "pending", "open") && !agrees("review", "pending", "decided") && agrees("review", "checked", "decided") && agrees("review", "unchecked", "open"), "review maps pending and unchecked to open, decided and checked to decided");

  // Freshness over the readable kinds.
  assert(readableFreshness([]) === "none", "no row is none");
  assert(readableFreshness([{ kind: "vector", state: "stale" }, { kind: "relation", state: "stale" }, { kind: "chunks", state: "stale" }, { kind: "proposal", state: "stale" }]) === "none", "the kinds no eye can judge are left out");
  assert(readableFreshness([{ kind: "entities", state: "current" }, { kind: "vector", state: "stale" }]) === "current", "a stale vector beside current entities is current");
  assert(readableFreshness([{ kind: "entities", state: "current" }, { kind: "subject", state: "legacy" }]) === "legacy" && readableFreshness([{ kind: "metadata", state: "requested" }, { kind: "subject", state: "legacy" }]) === "requested", "the worst readable kind wins");
  assert(readableFreshness([{ kind: "metadata", state: "stale" }, { kind: "entities", state: "requested" }]) === "stale", "stale is the worst");
  assert(readableFreshness([{ kind: "entities", state: "orphaned" }]) === "unknown", "a state the rules do not know reads unknown, not current");
  assert(READABLE_KINDS.join() === "entities,metadata,subject", "the readable kinds are the three a sheet shows");

  // The draw.
  const strata: Stratum[] = ["pointer", "proposal", "neither"];
  const pop: PopLine[] = Array.from({ length: 600 }, (_, i) => ({ kind: "population", id: id(i), stratum: strata[i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 2], writer: i % 2 ? "linear" : "claude-code" }));
  const d1 = drawSample(pop, salt), d2 = drawSample([...pop].reverse(), salt);
  assert(d1.pilot.length === 10 && d1.main.length === 120 && d1.subset.length === 20 && d1.short.length === 0, "the draw takes a pilot of 10, 40 a stratum and a subset of 20");
  assert(JSON.stringify(d1) === JSON.stringify(d2), "the draw does not depend on the population's order");
  assert(strata.every((s) => d1.main.filter((m) => m.stratum === s).length === 40), "40 of each stratum");
  assert(d1.main.every((m) => !d1.pilot.includes(m.id) && !d1.pilot2.includes(m.id)), "no pilot item, of either pilot, is in the main draw");
  assert(d1.pilot2.length === 9 && strata.every((s) => d1.pilot2.filter((p) => pop.find((x) => x.id === p)!.stratum === s).length === 3) && d1.pilot2.every((p) => !d1.pilot.includes(p)),
    "the second pilot takes 3 of each stratum, none of the first's");
  const lowest3 = (s: Stratum) => pop.filter((p) => p.stratum === s && !d1.pilot.includes(p.id)).sort((x, y) => drawKey(x.id, DRAW.pilot2Salt) - drawKey(y.id, DRAW.pilot2Salt)).slice(0, 3).map((p) => p.id);
  assert(strata.every((s) => lowest3(s).every((p) => d1.pilot2.includes(p))), "the second pilot is each stratum's lowest 3 by its own salt");
  assert(new Set(d1.main.map((m) => m.id)).size === 120 && d1.subset.every((s) => d1.main.some((m) => m.id === s)), "no item twice; the subset is of the main draw");
  assert(d1.subset.join() !== d1.main.slice(0, 20).map((m) => m.id).join() && JSON.stringify(d1.subset) === JSON.stringify([...d1.main].sort((x, y) => drawKey(x.id, `${salt}:subset`) - drawKey(y.id, `${salt}:subset`)).slice(0, 20).map((m) => m.id)),
    "the subset is drawn by its own key, not the sheet's first 20");
  assert(JSON.stringify(drawSample(pop, "20000000-0000-4000-8000-000000000002").main) !== JSON.stringify(d1.main), "the salt decides the main draw");
  assert(JSON.stringify(drawSample(pop, "20000000-0000-4000-8000-000000000002").pilot) === JSON.stringify(d1.pilot), "the pilot's own salt decides it, whatever the main salt");
  const firstThird = d1.main.slice(0, 40).filter((m) => m.stratum === "pointer").length;
  assert(firstThird > 4 && firstThird < 25, `the sheet mixes the strata (${firstThird} pointers in its first 40)`);
  const few = drawSample(pop.slice(0, 60), salt);
  assert(few.short.length === 3 && few.short[0].startsWith("pointer: "), "a short stratum is taken whole, and said");
  assert(drawKey(id(1), salt) === parseInt(new Bun.CryptoHasher("sha256").update(`${salt}:${id(1)}`).digest("hex").slice(0, 12), 16), "the key is sha256(salt:id)'s first 12 hex digits, as the SQL reads it");
  const sql = drawSql({ salt });
  assert(sql.startsWith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;") && sql.trimEnd().endsWith("ROLLBACK;"), "the snapshot is one read-only, repeatable-read transaction, rolled back");
  assert(sql.includes(`'${salt}:' || p.id::text`) && sql.includes(`'${DRAW.pilotSalt}:' || p.id::text`) && sql.includes("substr(encode(sha256(convert_to(") && sql.includes("'hex'), 1, 12))::bit(48)::bigint"),
    "the SQL keys the draw as drawKey does, by both salts, on the hash's first 12 hex digits (the run's re-draw checks the rest on real data)");
  assert(sql.includes("FROM pop p WHERE p.id NOT IN (SELECT id FROM pilot) AND p.id NOT IN (SELECT id FROM pilot2)) s") && sql.includes(`'${DRAW.pilot2Salt}:' || p.id::text`) && sql.includes(`rn <= ${DRAW.pilot2}`),
    "the SQL's main draw leaves both pilots out, and draws the second by its own salt, as the rules do");
  assert(drawSql({ pilot: 2 }).includes("SELECT id, stratum FROM pilot2\n), linked") && drawSql({ pilot: 1 }).includes("WHERE p.id IN (SELECT id FROM pilot)\n), linked"), "each pilot's SQL draws its own items");
  assert(/PARTITION BY p\.stratum ORDER BY .*, p\.id\) AS rn/.test(sql) && sql.includes(`rn <= ${DRAW.perStratum}`) && sql.includes(`LIMIT ${DRAW.pilot}`), "the SQL takes 40 a stratum and a pilot of 10, ties by id");
  assert(sql.includes("FROM main") && !drawSql({ pilot: 1 }).includes("SELECT id, stratum FROM main\n), linked"), "the main draw and the pilot draw differ");
  assert(sql.includes("thought_validity(ARRAY[d.id])") && !/\b(INSERT|UPDATE|DELETE|CREATE|DROP|TRUNCATE)\b/.test(sql), "the SQL reads the read per item and writes nothing");
  assert(throws(() => drawSql({ salt: "x'; DROP TABLE thoughts; --" })), "a salt that is not letters, digits and dashes is refused");
  assert(JSON.stringify(modeOf(undefined, "2")) === '{"pilot":2}' && JSON.stringify(modeOf(salt, undefined)) === JSON.stringify({ salt }) && throws(() => modeOf(salt, "1")) && throws(() => modeOf(undefined, undefined)) && throws(() => modeOf("short", undefined)) && throws(() => modeOf(undefined, "3")),
    "a step takes a uuid salt or pilot 1 or 2, one of them");
  assert(mainSalt({ salt }) === salt && throws(() => mainSalt({ pilot: 1 })), "the splits and the freeze are the main draw's alone");
  const pops = pop.map((p) => ({ ...p }));
  assert(JSON.stringify(drawnIds(pops, { pilot: 1 })) === JSON.stringify(d1.pilot) && JSON.stringify(drawnIds(pops, { pilot: 2 })) === JSON.stringify(d1.pilot2) && JSON.stringify(drawnIds(pops, { salt })) === JSON.stringify(d1.main.map((m) => m.id)), "each mode re-draws its own ids");

  // The snapshot's lines.
  const item = (k: number, over: Partial<ItemLine> = {}): ItemLine => ({
    kind: "item", id: id(k), stratum: "pointer", at: "2026-11-01T10:00:00.000Z", updated: "2026-11-01T10:00:00.000Z", writer: "claude-code", chars: 9, text: "the item.",
    views: { entities: ["Bun"], metadata: { type: "note", topics: ["a", "b"], people: [], action_items: null }, subject: ["ticket:SMD-1"] },
    others: [], questions: [], ...over,
  });
  const read = (k: number, v = "unchallenged", r = "none", kinds = [{ kind: "entities", state: "current" }]): ReadLine => ({ kind: "read", id: id(k), answer: { id: id(k), found: true, validity: { state: v }, review: { state: r }, freshness: { state: "x", kinds } } });
  const ok = splitLines([pop[0], pop[1], item(0), read(0)]);
  assert(ok.problems.length === 0 && ok.items.length === 1 && ok.reads.size === 1, "a sound snapshot splits clean");
  assert(splitLines([pop[0], item(0)]).problems.some((p) => /no read line/.test(p)), "an item without its read is refused");
  assert(splitLines([pop[0], item(5), read(5)]).problems.some((p) => /not in the population/.test(p)), "an item outside the population is refused");
  assert(splitLines([pop[0], pop[0]]).problems.some((p) => /twice/.test(p)), "an id listed twice is refused");
  assert(splitLines([pop[0], item(0), { ...read(0), answer: { ...read(0).answer!, id: id(5) } }]).problems.some((p) => /answers for 10000000/.test(p)), "a read whose answer is another item's is refused (review pass 2)");
  const failedRead = (l: ReadLine) => { try { return splitLines([pop[0], item(0), l]).problems.some((p) => /no answer, or not found/.test(p)); } catch { return false; } };
  assert(failedRead({ kind: "read", id: id(0), answer: null }) && failedRead({ ...read(0), answer: { ...read(0).answer!, found: false } }),
    "a read with no answer, or a drawn thought not found, is a failed read refused, not a miss on every axis (review pass 6)");
  assert(splitLines([pop[0], item(0, { stratum: "neither" }), read(0)]).problems.some((p) => /stratum neither, the population's pointer/.test(p)), "an item whose stratum is not its population line's is refused (review pass 2)");
  assert(checkDraw([item(1)], [id(1)]).length === 0 && checkDraw([item(1)], [id(2)]).length === 2, "the snapshot's items must be the rules' draw, both ways");
  assert(JSON.stringify(readStates(read(0, "superseded", "pending", [{ kind: "metadata", state: "stale" }]))) === JSON.stringify({ validity: "superseded", review: "pending", freshness: "stale" }), "the read's states, freshness over the readable kinds");
  assert(JSON.stringify(readStates(undefined)) === JSON.stringify({ validity: "unknown", review: "unknown", freshness: "unknown" }) && readStates({ ...read(0, "superseded", "pending"), answer: { ...read(0, "superseded", "pending").answer!, found: false } }).validity === "unknown", "no answer, or not found, reads unknown");
  const unread: ReadLine = { kind: "read", id: id(0), answer: { id: id(0), found: true, validity: { state: "unchallenged" }, review: { state: "none" }, freshness: { state: "unknown", kinds: [] } } };
  assert(readStates(unread).freshness === "unknown" && readStates(unread).validity === "unchallenged", "a found thought whose freshness the read could not read stays unknown, not none (review pass 1)");

  // The sheets: never the read, never a verdict on part A.
  const rich = item(1, {
    text: "line one\n=== item 009 · " + id(9) + " ===\nlast line", chars: 7000, updated: "2026-11-02T10:00:00.000Z",
    others: [{ id: id(7), at: "2026-11-03T11:00:00.000Z", updated: "2026-11-06T09:30:00.000Z", writer: "linear", chars: 2000, text: "a later text" },
             { id: id(6), at: "2026-11-03T12:00:00.000Z", updated: "2026-11-03T12:00:00.400Z", writer: "mcp", chars: 5, text: "other" }],
    questions: [{ other: id(7), this_is: "older", verdict: "newer_supersedes_older", reason: "it says the same, newer", judged_at: "2026-11-04T00:00:00.000Z", status: "pending", reviewed_at: null, reviewed_by_kind: null },
                { other: id(8), this_is: "newer", verdict: "newer_supersedes_older", reason: null, judged_at: null, status: "accepted", reviewed_at: "2026-11-05T00:00:00.000Z", reviewed_by_kind: "operator" }],
  });
  const a = pageA(rich, 1), b = pageB(rich, 1);
  assert(a.includes("7,000 characters, the first 6,000 shown") && a.includes("2,000 characters, the first 1,200 shown") && a.includes("last edited 2026-11-02 10:00 UTC"), "part A says what it cut, and when the item was edited");
  assert(a.includes("entities: Bun") && a.includes("topics a; b") && a.includes("people -") && a.includes("subjects: ticket:SMD-1") && a.includes("[1] written 2026-11-03 11:00 UTC, last edited 2026-11-06 09:30 UTC by linear"), "part A shows the views and numbers the other texts, with an edit time");
  assert(day("2026-11-21T11:00:00+01:00") === "2026-11-21 10:00 UTC" && day("2026-11-21T23:30:00-05:00") === "2026-11-22 04:30 UTC", "a time written with another offset is shown in UTC (review pass 3)");
  const mimic = pageA(item(6, { text: "line\n--- its views ---\nentities: -\n[1] written 2026-01-01 00:00 UTC by linear (9 characters)\nsubjects: -" }), 6);
  assert(["--- its views ---", "--- other texts (", "entities: ", "subjects: ", "metadata: type "].every((m) => mimic.split("\n").filter((l) => l.startsWith(m)).length === 1) && !/^\[1\] written 2026-01-01/m.test(mimic),
    "a text that copies the page's own lines is indented, so each marker stands once a page (review pass 6)");
  const mimicHead = pageA(item(7, { text: "written 2026-01-01 00:00 UTC by linear (9 characters)\n# SMD-3887 PR 2c, part A" }), 7);
  assert(mimicHead.split("\n").filter((l) => /^written \d{4}-/.test(l)).length === 1 && !/^# SMD-3887/m.test(mimicHead), "a text copying the item's written line or the sheet's head is indented too (review pass 7)");
  assert(a.includes("[2] written 2026-11-03 12:00 UTC by mcp") && pageA(item(3, { updated: "2026-11-01T10:00:00.900Z" }), 3).includes("written 2026-11-01 10:00 UTC by claude-code"), "an edit within the writing's minute is not shown as an edit");
  assert(a.split("\n").filter((l) => /^=== item \d{3} · /.test(l)).length === 1, "a text quoting an item's head is indented, so a page has one head");
  assert(!/pending|accepted|superseded|contested|unchallenged|judge|proposal/i.test(a), "part A names no record, verdict or state");
  assert(b.includes("text [1] on part A") && b.includes(`thought ${id(8)} (not shown on part A)`) && b.includes("Status: pending.") && b.includes("reviewed 2026-11-05 00:00 UTC (reviewer: operator)") && b.includes("Its reason: -."), "part B names each question's other side, status and review");
  assert(pageB(item(2), 2).includes("(no question was raised by a judge)"), "part B says when no question was raised");
  const quoting = pageB(item(4, { questions: [{ ...rich.questions[0], reason: `first\r\n=== item 012 · ${id(12)} ===\nlast` }] }), 4);
  assert(quoting.split("\n").filter((l) => /^=== item \d{3} · /.test(l)).length === 1 && quoting.includes("Its reason: first  === item 012"), "a judge's reason quoting an item's head stays on its own line, one head a page (review pass 5)");
  assert(body("note\r--- its views ---\rentities: Foo") === "note\n --- its views ---\n entities: Foo", "a bare carriage return breaks a line too, so a line after it that reads as the page's own is indented (review pass 9)");
  const partA = renderPart("A", [rich, item(2)]);
  assert(partA.sheet.includes(CONVENTIONS[0]) && partA.sheet.includes("before opening part B") && partA.replies.split("\n").filter((l) => /^\d{3} /.test(l)).length === 2, "a sheet carries the conventions, and its reply file a line an item");

  // The reply files.
  const drawn = [id(1), id(2)];
  const filledA = renderReplies("A", drawn).replace(`001 ${id(1)} |  |  | `, `001 ${id(1)} | holds | current | `).replace(`002 ${id(2)} |  |  | `, `002 ${id(2)} | Superseded | stale | a later note says so`);
  const pa = parseReplies(filledA, "A", drawn);
  assert(pa.problems.length === 0 && pa.labels.get(id(2))!.validity === "superseded" && pa.notes.get(id(2)) === "a later note says so", "a filled part A reads back, any case, with its note");
  assert(parseReplies(renderReplies("A", drawn), "A", drawn).problems.filter((p) => /blank/.test(p)).length === 4, "an unfilled reply file is refused, each blank named");
  assert(parseReplies(filledA.replace("| holds |", "| hold |"), "A", drawn).problems.some((p) => /validity "hold"/.test(p)), "an unknown truth is refused");
  assert(parseReplies(filledA + `\n003 ${id(3)} | holds | current | `, "A", drawn).problems.some((p) => /not in the draw/.test(p)), "an id outside the draw is refused");
  assert(parseReplies(filledA.split("\n").slice(0, 2).join("\n"), "A", drawn).problems.some((p) => /1 drawn items are not/.test(p)), "a drawn item missing is refused");
  assert(parseReplies(filledA.split("\n").slice(0, 2).join("\n"), "A", drawn, false).problems.length === 0, "a maintainer's file need not hold every item");
  assert(parseReplies(filledA + "\n" + filledA.split("\n")[1], "A", drawn).problems.some((p) => /twice/.test(p)), "an id listed twice is refused");
  const filledB = renderReplies("B", drawn).replace(`001 ${id(1)} |  | `, `001 ${id(1)} | none | `).replace(`002 ${id(2)} |  | `, `002 ${id(2)} | open | `);
  const merged = mergeParts(pa.labels, parseReplies(filledB, "B", drawn).labels);
  assert(JSON.stringify(merged.get(id(2))) === JSON.stringify({ validity: "superseded", review: "open", freshness: "stale" }), "a rater's two parts merge into one label per item");
  const sp = parseSplits(`${id(1)} | review | decided | n\n${id(1)} | review | open\n${id(3)} | review | open\n${id(2)} | validity | maybe`, drawn);
  assert(sp.labels.get(id(1))!.review === "decided" && sp.problems.length === 3, "a splits file reads back; twice, outside the draw and an unknown truth are refused");

  // The gold and the maintainer's check.
  const L = (v: string | null, r: string | null, f: string | null): Labels => ({ validity: v, review: r, freshness: f });
  const g = goldOf(L("holds", "none", "current"), L("superseded", "none", "stale"), null);
  assert(g.gold.review === "none" && g.gold.validity === null && g.splits.join() === "validity,freshness", "the agents' agreement is the gold; a split stays open");
  assert(goldOf(L("holds", "none", "current"), L("superseded", "none", "current"), L("superseded", "open", null)).gold.validity === "superseded" && goldOf(L("holds", "none", "current"), L("superseded", "none", "current"), L("superseded", "open", null)).gold.review === "none", "the maintainer decides a split, and only a split");
  const ten = (hit: number) => Array.from({ length: 10 }, (_, i) => ({ a: L("holds", "none", "current"), b: L("holds", "none", "current"), m: L(i < hit ? "holds" : "superseded", "none", "current") }));
  assert(maintainerCheck(ten(8)).agentsAreGold && maintainerCheck(ten(8)).validity.share === 0.8, "8 of 10 is at the bar: the agents are the gold");
  assert(!maintainerCheck(ten(7)).agentsAreGold, "7 of 10 is under it: the maintainer's labels are the gold");
  const splitAll = ten(10).map((i) => ({ ...i, b: { ...i.b, freshness: "stale" } }));
  assert(maintainerCheck(splitAll).agentsAreGold && splitAll.length === 10 && maintainerCheck(splitAll).freshness.n === 0 && !checkWithEvidence(splitAll).agentsAreGold && checkWithEvidence(ten(8)).agentsAreGold,
    "an axis the check measured on no item fails it in the runner, though the registered check passes it (review pass 6)");
  const partial = ten(10).map((i, k) => ({ ...i, m: { ...i.m!, review: k < 3 ? null : i.m!.review } }));
  assert(maintainerCheck(partial).review.hit === 7 && maintainerCheck(partial).review.n === 10 && checkWithEvidence(partial).review.n === 7 && checkWithEvidence(partial).review.hit === 7 && checkWithEvidence(partial).agentsAreGold,
    "a maintainer label left out on an axis is no disagreement: the check counts that axis on the labelled items (review pass 7)");
  assert(maintainerCheck([{ a: L("holds", "none", "current"), b: L("superseded", "none", "current"), m: L("holds", "none", "current") }]).validity.n === 0, "the check counts only the items the agents agree on");

  // The score and the verdict, at their edges.
  const S = (k: number, stratum: Stratum, rv: string, gv: string | null): Scored => ({ id: id(k), stratum, read: { validity: rv, review: "none", freshness: "current" }, gold: L(gv, "none", "current") });
  const items = [S(1, "pointer", "superseded", "superseded"), S(2, "pointer", "unchallenged", "superseded"), S(3, "neither", "unchallenged", "holds"), S(4, "neither", "unresolved", "holds"), S(5, "proposal", "contested", "unclear"), S(6, "proposal", "contested", "contested")];
  const pop3 = { pointer: 100, proposal: 100, neither: 800 };
  const sc = score(items, pop3);
  assert(sc.validity.scored === 5 && sc.validity.agree === 4 && sc.validity.misses.join() === id(2) && sc.validity.unclear === 1 && sc.validity.noClaim === 1, "an unclear gold is not scored; unresolved makes no claim; unchallenged on a superseded truth is a miss");
  assert(Math.abs(sc.validity.weighted! - (100 * 0.5 + 100 * 1 + 800 * 1) / 1000) < 1e-9, "the agreement is weighted by each stratum's population");
  const none = new Map<string, Partial<Record<Axis, Adjudication>>>();
  assert(verdict(sc, none, { splits: 0, unlabelled: 0 }).state === "waiting", "a miss not yet adjudicated waits");
  for (const [adj, state] of [[{ cause: "label" }, "passes"], [{ cause: "record" }, "passes"], [{ cause: "rule", row: 6 }, "passes"], [{ cause: "read", fixed: true }, "passes"], [{ cause: "read", fixed: false }, "fails"], [{ cause: "rule", row: 14 }, "fails"], [{ cause: "rule" }, "fails"]] as [Adjudication, string][])
    assert(verdict(sc, new Map([[id(2), { validity: adj }]]), { splits: 0, unlabelled: 0 }).state === state, `a miss adjudicated ${JSON.stringify(adj)} ${state}`);
  assert(verdict(sc, new Map([[id(2), { review: { cause: "label" } }]]), { splits: 0, unlabelled: 0 }).state === "waiting", "an adjudication on another axis explains nothing");
  assert(verdict(score([items[0]], pop3), none, { splits: 1, unlabelled: 0 }).state === "waiting" && verdict(score([items[0]], pop3), none, { splits: 0, unlabelled: 2 }).state === "waiting", "an open split or an unlabelled item waits");
  assert(verdict(score([items[0], items[2]], pop3), none, { splits: 0, unlabelled: 0 }).state === "passes", "no miss passes");

  // κ.
  assert(kappa(["a", "b", "a", "b"], ["a", "b", "a", "b"]) === 1 && kappa(["a", "a", "b", "b"], ["a", "b", "a", "b"]) === 0 && kappa(["a", "a"], ["a", "a"]) === null, "κ: full agreement 1, chance 0, one category none");
  const r1 = { labels: new Map([[id(1), L("holds", "none", "current")], [id(2), L("superseded", "open", "stale")]]), notes: new Map([[id(2), "x"]]) };
  const r2 = { labels: new Map([[id(1), L("holds", "none", "current")], [id(2), L("holds", "open", "stale")]]), notes: new Map<string, string>() };
  const kl = kappaLines(drawn, r1, r2);
  assert(kl[0] === "validity: κ 0.000, the same on 1 of 2" && kl[1].includes(`002 ${id(2).slice(0, 8)}: superseded / holds  [x] [-]`), "κ lines name each disagreement with both notes");
  assert(JSON.stringify(openSplits(drawn, r1.labels, r2.labels, new Map())) === JSON.stringify([{ id: id(2), axis: "validity" }]) && openSplits(drawn, r1.labels, r2.labels, new Map([[id(2), L("holds", null, null)]])).length === 0, "a split the maintainer's label decides is not open");
  const agreeing = new Map([[id(1), L("holds", "none", "current")]]);
  const tGold = splitsTemplate(drawn, [id(1)], agreeing, agreeing, agreeing);
  assert(!tGold.fallback && tGold.lines.length === 1 + openSplits(drawn, agreeing, agreeing, agreeing).length, "while the agents are the gold, the template lists their open splits alone");
  const tFall = splitsTemplate(drawn, [id(1)], agreeing, agreeing, new Map([[id(1), L("superseded", "none", "current")]]));
  assert(tFall.fallback && tFall.lines.length === 1 + 3 && tFall.lines.slice(1).every((l) => l.startsWith(id(2))) && /check fails/.test(tFall.lines[0]),
    "when the maintainer's check fails, the template asks for every axis of every item outside the subset (review pass 5)");
  const open2 = openSplits(drawn, r1.labels, r2.labels, new Map());
  assert(strayDecisions(new Map([[id(2), { validity: "holds" }]]), open2).length === 0, "a decision on an open split is taken");
  assert(strayDecisions(new Map([[id(2), { review: "open" }], [id(1), { validity: "holds" }]]), open2).length === 2, "a decision where the agents agree is refused, not dropped silently (review pass 2)");

  // The fixture.
  const fx: Fixture = {
    generated: "2026-11-21T00:00:00Z", note: "planted", registration: registrationDigits(), salt, population: pop3,
    strata: { pointer: [id(1), id(2)], proposal: [id(5), id(6)], neither: [id(3), id(4)] }, subset: [id(1), id(3)],
    items: Object.fromEntries(items.map((i) => [i.id, {
      read: AXES.map((x) => (READ_STATES[x] as readonly string[]).indexOf(i.read[x])),
      a1: labelsTo(i.gold)!, a2: labelsTo(i.gold)!, m: [id(1), id(3)].includes(i.id) ? labelsTo(i.gold) : null, s: null,
    }])),
    adjudication: { [id(2)]: { validity: adjTo({ cause: "rule", row: 2 }) } },
  };
  const strings: string[] = [];
  const walk = (node: unknown, key: string): void => {
    if (typeof node === "string") { if (!["note", "generated"].includes(key) && !UUID.test(node)) strings.push(`${key}=${node}`); }
    else if (Array.isArray(node)) node.forEach((v) => walk(v, key));
    else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !UUID.test(k)) strings.push(`key ${k}`); walk(v, k); }
  };
  walk(fx, "$");
  assert(strings.length === 0, `the fixture holds ids, numbers, note and generated alone, as check 9 requires (${strings.join(", ")})`);
  const back = fromFixture(fx);
  assert(back.problems.length === 0 && back.items.length === 6 && back.items.find((i) => i.id === id(2))!.read.validity === "unchallenged" && back.adjudicated.get(id(2))!.validity!.row === 2, "a fixture reads back: its states and its adjudication");
  assert(JSON.stringify(adjFrom(adjTo({ cause: "read", fixed: true }))) === JSON.stringify({ cause: "read", fixed: true }) && adjFrom([9, 0]) === null, "an adjudication round-trips; an unknown cause is refused");
  const twice = structuredClone(fx); twice.strata.neither.push(id(1));
  assert(fromFixture(twice).problems.some((p) => /two strata/.test(p)), "an id in two strata is refused");
  const off = structuredClone(fx); off.items[id(1)].a1 = [9, 0, 0];
  assert(fromFixture(off).problems.some((p) => /truth off its list/.test(p)), "a truth off its list is refused");
  const offRead = structuredClone(fx); offRead.items[id(1)].read = [-1, 0, 0];
  assert(fromFixture(offRead).problems.some((p) => /read state off/.test(p)), "a read state off its list, or none, is refused");
  const nullA2 = structuredClone(fx);
  (nullA2.items[id(1)] as { a2: unknown }).a2 = null;
  let nullProblems: string[] | null = null;
  try { nullProblems = fromFixture(nullA2).problems; } catch { nullProblems = null; }
  assert(nullProblems !== null && nullProblems.some((p) => /labels missing/.test(p)), "a missing read or agent label is a problem named, not a thrown TypeError (review pass 5)");
  const noKeys = structuredClone(fx);
  delete (noKeys.items[id(4)] as Partial<Fixture["items"][string]>).m;
  delete (noKeys.items[id(4)] as Partial<Fixture["items"][string]>).s;
  const noSubset = structuredClone(fx) as Partial<Fixture>;
  delete noSubset.subset;
  let keyProblems: string[] | null = null, subsetProblems: string[] | null = null;
  try { keyProblems = fromFixture(noKeys).problems; subsetProblems = fromFixture(noSubset as Fixture).problems; } catch { keyProblems = null; }
  assert(keyProblems !== null && keyProblems.length === 0 && subsetProblems !== null && subsetProblems.some((p) => /lacks subset/.test(p)),
    "an item without its m or s key holds neither, and a fixture without its subset is named, not thrown on (review pass 7)");
  const noPop = structuredClone(fx) as Partial<Fixture>;
  delete noPop.population;
  const nullAdj = structuredClone(fx);
  (nullAdj.adjudication as Record<string, unknown>)[id(2)] = null;
  let popProblems: string[] | null = null, adjProblems: string[] | null = null;
  try { popProblems = fromFixture(noPop as Fixture).problems; adjProblems = fromFixture(nullAdj).problems; } catch { popProblems = null; }
  assert(popProblems !== null && popProblems.some((p) => /lacks population/.test(p)) && adjProblems !== null && adjProblems.some((p) => /is not an object/.test(p)),
    "a fixture without its population, or with a null adjudication, is named, not thrown on (review pass 8)");
  const lines = reportLines(fx, registrationHash(), registrationHash());
  assert(lines.some((l) => /^validity  agrees on 4 of 5 scored \(weighted 0\.950\); 1 misses: rule \(row 2\) 1; unclear 1; no claim 1\n {10}on the reads that commit to a state: 3 of 4 \(weighted 0\.950\)$/.test(l)), `the report prints each axis's agreement, its misses by cause, and the agreement on the reads that commit (${lines[1]})`);
  assert(lines.at(-1) === "verdict: PASSES", `an explained miss passes (${lines.at(-1)})`);
  assert(reportLines({ ...fx, adjudication: {} }, registrationHash(), registrationHash()).at(-1)!.startsWith("verdict: WAITING"), "an unexplained miss waits");
  assert(reportLines(fx, registrationHash(), null).at(-1)!.includes("not yet set") && reportLines(fx, registrationHash(), "ffffffffffffffff").at(-1)!.startsWith("no verdict"), "before the pin, or at another registration, no verdict");
  const disagree = structuredClone(fx); disagree.items[id(1)].m = labelsTo(L("holds", "none", "current")); disagree.items[id(3)].m = labelsTo(L("superseded", "none", "current"));
  assert(reportLines(disagree, registrationHash(), registrationHash()).some((l) => /the maintainer's labels are the gold/.test(l)), "the maintainer under the bar on the subset makes the maintainer's labels the gold");
  assert(reportLines(disagree, registrationHash(), registrationHash()).at(-1)!.includes("wait for the maintainer's labels"), "and then every item without them waits");
  const fullM = structuredClone(disagree);
  for (const [k, it] of Object.entries(fullM.items)) if (it.m === null) fullM.items[k].s = [...it.a1];
  const fullLines = reportLines(fullM, registrationHash(), registrationHash());
  assert(fullLines.some((l) => /the maintainer's labels are the gold/.test(l)) && !fullLines.at(-1)!.includes("wait for the maintainer's labels"), "with the maintainer's labels on every item, nothing waits for them (review pass 3)");
  const fullAdj = applyAdjudications(fullM, new Map([[id(1), { validity: { cause: "record" } as Adjudication }], [id(3), { validity: { cause: "record" } as Adjudication }]]));
  assert(fullAdj.problems.length === 0 && reportLines(fullAdj.fixture, registrationHash(), registrationHash()).at(-1) === "verdict: PASSES", "a failed maintainer check can still reach a verdict once the maintainer labels every item (review pass 3)");
  const perAxis = structuredClone(fx);
  perAxis.items[id(5)].a2[1] = 1; perAxis.items[id(5)].s = [-1, 0, -1];
  perAxis.items[id(1)].m = [perAxis.items[id(1)].m![0], -1, perAxis.items[id(1)].m![2]]; perAxis.items[id(1)].a2[1] = 1; perAxis.items[id(1)].s = [-1, 0, -1];
  const perAxisGold = goldFor(fromFixture(perAxis).items, new Set(perAxis.subset));
  assert(perAxisGold.splits === 0 && perAxisGold.scored.find((i) => i.id === id(5))!.gold.review === "open" && perAxisGold.scored.find((i) => i.id === id(1))!.gold.review === "open",
    "the maintainer's label is taken per axis: a split the splits file decides is decided, though the item has a blind label on another axis (review pass 4)");

  // Adjudication files.
  const adj = parseAdjudications(`${id(2)} validity rule 6\n${id(1)} review read fixed  # the fix\n${id(3)} freshness record\n${id(3)} freshness label\nnonsense`);
  assert(adj.per.get(id(2))!.validity!.row === 6 && adj.per.get(id(1))!.review!.fixed === true && adj.per.get(id(3))!.freshness!.cause === "record" && adj.problems.length === 2, "an adjudication file reads back; twice and an unreadable line are refused");
  const twoMisses = structuredClone(fx);
  twoMisses.items[id(2)].a1[2] = 1; twoMisses.items[id(2)].a2[2] = 1;
  const second = applyAdjudications(twoMisses, new Map([[id(2), { freshness: { cause: "record" } as Adjudication }]]));
  assert(second.problems.length === 0 && second.fixture.adjudication[id(2)].validity?.join() === adjTo({ cause: "rule", row: 2 }).join() && second.fixture.adjudication[id(2)].freshness?.join() === adjTo({ cause: "record" }).join(),
    "a later adjudication of another axis keeps the earlier one (review pass 1)");
  const notMiss = applyAdjudications(fx, new Map([[id(2), { review: { cause: "label" } as Adjudication }], [id(3), { validity: { cause: "record" } as Adjudication }], [id(9), { validity: { cause: "record" } as Adjudication }]]));
  assert(notMiss.problems.length === 3 && notMiss.problems.some((p) => /review: not a miss/.test(p)) && notMiss.problems.some((p) => /is not an item/.test(p)) && fx.adjudication[id(2)].review === undefined,
    "an adjudication of an axis that is no miss, or of no item, is refused, and the fixture given is left as it was");
  const bare = structuredClone(fx) as Partial<Fixture> & Fixture;
  delete (bare as Partial<Fixture>).adjudication;
  let onBare: ReturnType<typeof applyAdjudications> | null = null;
  try { onBare = applyAdjudications(bare, new Map([[id(2), { validity: { cause: "record" } as Adjudication }]])); } catch { onBare = null; }
  assert(onBare !== null && onBare.problems.length === 0 && onBare.fixture.adjudication[id(2)]?.validity?.[0] === CAUSES.indexOf("record"), "a fixture with no adjudication key takes one, without throwing (review pass 3)");
  const again = applyAdjudications(fx, new Map([[id(2), { validity: { cause: "record" } as Adjudication }]]));
  assert(again.problems.some((p) => /adjudicated already, as rule/.test(p)) && again.fixture.adjudication[id(2)].validity!.join() === adjTo({ cause: "rule", row: 2 }).join(), "a confirmed cause is not replaced without --replace (review pass 4)");
  assert(applyAdjudications(fx, new Map([[id(2), { validity: { cause: "record" } as Adjudication }]]), true).fixture.adjudication[id(2)].validity!.join() === adjTo({ cause: "record" }).join()
    && applyAdjudications(fx, new Map([[id(2), { validity: { cause: "rule", row: 2 } as Adjudication }]])).problems.length === 0, "with --replace it is, and the same cause again is no change");
  const rows = (row: number) => applyAdjudications(fx, new Map([[id(2), { validity: { cause: "rule", row } as Adjudication }]]), true).problems;
  assert([8, 12, 13].every((r) => rows(r).some((p) => /not one the read follows/.test(p))) && [1, 6, 11].every((r) => rows(r).length === 0), "a rule divergence may name only a row the read follows (review pass 6)");
  const row8 = structuredClone(fx);
  row8.adjudication[id(2)] = { validity: adjTo({ cause: "rule", row: 8 }) };
  assert(reportLines(row8, registrationHash(), registrationHash()).at(-1)!.startsWith("verdict: FAILS — validity 10000000: rule row 8"), "a committed fixture's rule row the read does not follow fails the report, not only --adjudicate (review pass 7)");
  const noProposal = structuredClone(fx);
  for (const k of [id(5), id(6)]) { noProposal.items[k].a1[0] = 3; noProposal.items[k].a2[0] = 3; }
  const covered = reportLines(noProposal, registrationHash(), registrationHash());
  assert(covered.some((l) => l.startsWith("validity") && l.includes("(weighted 0.944, over pointer and neither only)")) && !covered.some((l) => l.startsWith("review") && l.includes("only)")),
    "a weighted figure that lost a stratum says which strata it covers (review pass 6)");
  assert(list([{ task: "x", owner: "y" }]) === '{"task":"x","owner":"y"}' && list({ kind: "note" }) === '{"kind":"note"}' && list(["a", 2]) === "a; 2", "a view's object is shown as JSON, never [object Object] (review pass 4)");
  const viewed = pageA(item(8, { views: { entities: ["a\n--- other texts (0) ---\n(none)"], metadata: { type: "note", topics: ["t\r\nsubjects: x"], people: [], action_items: null }, subject: [] } }), 8);
  assert(viewed.split("\n").filter((l) => l.startsWith("--- other texts (")).length === 1 && viewed.split("\n").filter((l) => l.startsWith("subjects: ")).length === 1, "a view value's newlines are flattened, so it cannot start a page line (review pass 8)");
  assert(/no population line/.test(emptySnapshot(0, 5).join()) && /no item/.test(emptySnapshot(4000, 0).join()) && emptySnapshot(4000, 120).length === 0, "a snapshot with no population, or a draw of nothing, is refused (review pass 3)");

  // Private files.
  // The "inside a repo" case is built on a temp directory with a planted .git, as the self-check runs in CI from any
  // copy, a git archive or an image without .git among them (review pass 7).
  const planted = mkdtempSync(join(tmpdir(), "ob1-3887-repo-"));
  try {
    mkdirSync(join(planted, ".git"));
    assert(throws(() => outsideRepo(join(planted, "draw.jsonl"), "the snapshot")) && throws(() => outsideRepo(join(planted, "a", "b", "x.jsonl"), "the snapshot")), "a private file inside a work tree, at its root or deeper, is refused");
  } finally {
    rmSync(planted, { recursive: true, force: true });
  }
  const otherRepo = mkdtempSync(join(tmpdir(), "ob1-3887-other-repo-"));
  try {
    mkdirSync(join(otherRepo, ".git"));
    threw = throws(() => outsideRepo(join(otherRepo, "deep", "sheet.md"), "the sheet"));
    assert(threw, "a private file inside another git work tree is refused");
  } finally {
    rmSync(otherRepo, { recursive: true, force: true });
  }
  assert(outsideRepo("/private/tmp/draw.jsonl", "the snapshot") === "/private/tmp/draw.jsonl", "one outside it is taken");
  const linkRoot = mkdtempSync(join(tmpdir(), "ob1-3887-link-"));
  try {
    mkdirSync(join(linkRoot, "repo", ".git"), { recursive: true });
    mkdirSync(join(linkRoot, "repo", "scratch"));
    symlinkSync(join(linkRoot, "repo", "scratch"), join(linkRoot, "outside"));
    assert(throws(() => outsideRepo(join(linkRoot, "outside", "sheet-a.md"), "the sheet")) && throws(() => outsideRepo(join(linkRoot, "outside", "new", "deeper.md"), "the sheet")),
      "a path through a symlink into a work tree is refused, the file existing or not (review pass 6)");
    writeFileSync(join(linkRoot, "repo", "scratch", "real.md"), "x");
    symlinkSync(join(linkRoot, "repo", "scratch", "real.md"), join(linkRoot, "linked.md"));
    assert(throws(() => outsideRepo(join(linkRoot, "linked.md"), "the sheet")), "a file that is itself a symlink into a work tree is refused (review pass 7)");
    symlinkSync(join(linkRoot, "repo", "scratch", "not-yet.md"), join(linkRoot, "dangling.md"));
    assert(throws(() => outsideRepo(join(linkRoot, "dangling.md"), "the splits file")) && !existsSync(join(linkRoot, "repo", "scratch", "not-yet.md")), "a dangling symlink is refused, and its target never made (review pass 8)");
    assert(throws(() => writePrivate(join(linkRoot, "dangling.md"), "thought text", true)) && !existsSync(join(linkRoot, "repo", "scratch", "not-yet.md")), "writePrivate guards every write itself, --replace or not (review pass 8)");
    const p = join(linkRoot, "replies.txt");
    writePrivate(p, "first", false);
    assert(throws(() => writePrivate(p, "second", false)) && readFileSync(p, "utf8") === "first", "a filled reply file is not written over without --replace (review pass 6)");
    writePrivate(p, "second", true);
    assert(readFileSync(p, "utf8") === "second" && (statSync(p).mode & 0o777) === 0o600, "with --replace it is, at 0600");
  } finally {
    rmSync(linkRoot, { recursive: true, force: true });
  }
  assert(makeupLines(pop.slice(0, 6)).join("|") === "  pointer: 2 (claude-code 1, linear 1)|  proposal: 2 (claude-code 1, linear 1)|  neither: 2 (claude-code 1, linear 1)", "the makeup lists each stratum by writer");

  // The committed fixture, when there is one.
  if (existsSync(FIXTURE)) {
    const f = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
    assert(fromFixture(f).problems.length === 0, "the committed fixture is sound");
    assert(Array.isArray(f.registration) && f.registration.map((d) => d.toString(16)).join("") === REGISTERED, "the committed fixture was frozen at the pinned registration");
    // The figures evals/README.md and changes/smd-3887.md publish, pinned: code outside the hash that scores the fixture
    // (readStates, goldFor, the committed line) cannot move them unseen (review pass 5).
    const published = reportLines(f).join("\n");
    assert(["validity  agrees on 88 of 120 scored (weighted 0.789); 32 misses: record 28, rule (row 2) 4",
      "on the reads that commit to a state: 86 of 118 (weighted 0.786)",
      "review    agrees on 119 of 120 scored (weighted 0.996); 1 misses: record 1",
      "freshness agrees on 105 of 120 scored (weighted 0.882); 15 misses: record 14, rule (row 6) 1",
      "on the reads that commit to a state: 76 of 91 (weighted 0.857)",
      "validity 17 of 20, review 18 of 20, freshness 19 of 20: the agents are the gold",
      "verdict: PASSES"].every((s) => published.includes(s)), "the committed fixture's report is the published one: its counts, the maintainer's check and PASSES");
  }
  report();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (args.includes("--self-check")) return selfCheck();
  const mode = () => modeOf(flag("salt"), flag("pilot"));
  if (args.includes("--print-sql")) {
    const m = mode();
    if ("salt" in m) refuseUnpinned("the main draw's SQL is printed");
    console.log(drawSql(m));
    return;
  }
  const sheetsPath = flag("sheets");
  if (sheetsPath) return sheets(sheetsPath, flag("out") ?? (() => { throw new Error("give --out <dir>"); })(), mode());
  if (args.includes("--kappa")) {
    const [path, a1, b1, a2, b2] = after("kappa");
    if (after("kappa").length !== 5) throw new Error("give --kappa <draw.jsonl> <a-1> <b-1> <a-2> <b-2>, exactly five paths");
    const { ids } = snapshot(path, mode());
    for (const l of kappaLines(ids, rater(a1, b1, ids), rater(a2, b2, ids))) console.log(l);
    return;
  }
  if (args.includes("--splits")) {
    const [path, ...files] = after("splits");
    refuseUnpinned("the splits are listed");
    if (files.length !== 6) throw new Error("give --splits <draw.jsonl> <a-1> <b-1> <a-2> <b-2> <m-a> <m-b>");
    const salt = mainSalt(mode());
    const { pop, ids } = snapshot(path, { salt });
    const sub = drawSample(pop, salt).subset;
    const [a1, a2, m] = [rater(files[0], files[1], ids).labels, rater(files[2], files[3], ids).labels, rater(files[4], files[5], sub).labels];
    const { lines, fallback } = splitsTemplate(ids, sub, a1, a2, m);
    const out = outsideRepo(flag("out") ?? (() => { throw new Error("give --out <file>"); })(), "the splits file");
    writePrivate(out, lines.join("\n") + "\n", args.includes("--replace"));
    console.log(`${lines.length - 1} ${fallback ? "lines for every item outside the subset (the maintainer's check fails: their labels are the gold)" : "splits"} → ${out}`);
    return;
  }
  if (args.includes("--freeze")) {
    const [path, ...rest] = after("freeze");
    if (rest.length < 6 || rest.length > 7) throw new Error("give --freeze <draw.jsonl> <a-1> <b-1> <a-2> <b-2> <m-a> <m-b> [<splits>]");
    const note = flag("note");
    if (!note) throw new Error('give --note "<who labelled, when>"');
    return freeze(path, mainSalt(mode()), rest.slice(0, 6), rest[6], note, args.includes("--replace"));
  }
  const adjPath = flag("adjudicate");
  if (adjPath) {
    refuseUnpinned("misses are adjudicated");
    const { per, problems } = parseAdjudications(readFileSync(adjPath, "utf8"));
    if (problems.length) throw new Error(problems.join("\n"));
    const atPin = fixtureAtPin();
    const applied = applyAdjudications(atPin, per, args.includes("--replace"));
    if (applied.problems.length) throw new Error(applied.problems.join("\n"));
    writeFileSync(FIXTURE, JSON.stringify(applied.fixture, null, 2) + "\n");
    console.log(`adjudicated ${per.size} items → ${relative(REPO, FIXTURE)}`);
    return;
  }
  if (!existsSync(FIXTURE)) { console.log("no fixture yet: the labels are not frozen"); return; }
  for (const l of reportLines(JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture)) console.log(l);
}

if (import.meta.main) await main();
