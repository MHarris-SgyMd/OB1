/**
 * inferred-priority.ts — the rules of SMD-3670 PR 2's measurement: does the level and the due day the capture infers
 * (server-portable/priority-infer.ts, PR 1) agree with what the operator reads in the same text?
 *
 * eval-inferred-priority.ts runs these; this file holds what the verdict is decided by, and the part of it from
 * "The registration" to "End of the registered section" is hashed (registrationHash), so a bar, a convention, the
 * draw or the score moved after the labels were read shows as a new registration in the diff.
 *
 * The population is meant to be every current thought written through the capture path on the measured brain, and is
 * read as actor_kind `agent` (CAPTURES_SQL). That kind is the writing key's classification, not the path that wrote
 * the row: on stable it also takes 20 rows db/ingest-records.ts upserted under a key classified agent, which never
 * reach the inference (2 of them in the sample; review pass 1). The registration keeps the SQL as registered, and the
 * README's results state the effect. The inference is run over each, at the thought's own capture
 * time, and the sample is drawn from the result in two strata: CALLS (the model read a level or a due day) and OTHERS
 * (it read neither). The operator labels the drawn texts blind — the text and its capture day, shuffled, never the
 * model's answer — and a second blind rater labels the same sheet for a κ. The operator's labels are the gold.
 *
 * The maintainer's choices (2026-11-10, on SMD-3670): stable's captures; 60 calls and 60 others; a ticket's label
 * quoted beside it is a citation, not a stated level; the precision-led bar below.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Inferred } from "../server-portable/priority-infer.ts";

// ── The registration ──────────────────────────────────────────────────────────

/**
 * The bar PR 3 turns `count_inferred` on by, pre-registered before any label was read (the maintainer, 2026-11-10).
 * All three must hold, and each half must be measured on at least MIN_CALLS of the model's calls in the sample:
 *   - of the model's level calls, at least levelPrecisionMin carry a level the operator read (after the ceiling);
 *   - of its due calls, at least duePrecisionMin carry a day the operator read;
 *   - of its level calls, fewer than highOnNoneMax are High where the operator read no level.
 * A miss leaves the status quo (unknown counts as Medium), so misses are reported and carry no bar. A due day read
 * alone is stated at Medium, which is what unknown counts as, so it is measured by its day and is no level call.
 */
export const BAR = { levelPrecisionMin: 0.8, duePrecisionMin: 0.9, highOnNoneMax: 0.05 } as const;

/**
 * The population: every thought written through the capture path (actor_kind `agent`: an ingested row is a bare upsert
 * the inference never reads) that nothing supersedes, one JSON line each. A superseded capture was read when it landed,
 * but its successor says the same and more, so the frame is the current rows.
 */
export const CAPTURES_SQL = `SELECT json_build_object('id', t.id, 'at', t.created_at, 'writer', coalesce(t.metadata->>'actor_name', 'unknown'), 'text', t.content)::text
  FROM thoughts t
 WHERE t.metadata->>'actor_kind' = 'agent'
   AND NOT EXISTS (SELECT 1 FROM thoughts s WHERE s.supersedes = t.id)
 ORDER BY t.id`;

/** A half measured on fewer of the model's calls than this fails as unmeasured: nothing is turned on unmeasured. */
export const MIN_CALLS = 10;

/** The draw: this many of each stratum, at random by a hash of the seed and the id. A stratum smaller than its count is taken whole. */
export const DRAW = { calls: 60, others: 60, seed: "smd-3670-pr2" } as const;

/** The inferred ceiling (priority-infer.ts's INFERRED_CEILING): a label above it matches a call at it. */
export const CEILING = 3;

/**
 * The conventions both raters label by, the edge cases fixed before the first label (the lesson of SMD-3203). Printed
 * at the head of the sheet. A level or a day is "read" only as the text states it, in the rater's plain reading.
 */
export const CONVENTIONS: readonly string[] = [
  "LEVEL is how much the text says its own work matters, in its writer's voice: one of none (it says the work does not matter), low, medium, high, urgent, critical; or - when the text states no level.",
  "A label quoted beside a ticket, an item or a source (\"next: SMD-2627 (Medium)\", \"High priority on the board\") is a citation, not a stated level: the item carries its own (the maintainer, 2026-11-10).",
  "Text that discusses priority as a subject (a scale, a rule, a weight, an eval's gold) states no level by doing so.",
  "Emphasis of a need (\"this must land before the release\", \"blocking\") is a level only where it says how much the work matters: urgent or critical words, \"important\", \"no rush\", \"low priority\". A deadline alone is not a level.",
  "DUE is the last day the text sets for work it asks to be done, as YYYY-MM-DD; or - when it sets none. \"by Friday\" is that Friday; \"before Friday\" is the day before it; a time of day is dropped to its day.",
  "A relative day counts from the capture day shown (UTC), the day the inference counts from: \"tomorrow\" on a text captured Tuesday is Wednesday, whatever day the text's events happened.",
  "Not deadlines: a lease, claim, cache or token expiry; a date something happened or was measured; a release or event date the text does not ask work to meet; a date inside quoted material.",
  "A text that states several levels or deadlines (for different work) lists each, comma-separated: a call matching any one of them counts as read.",
];

/** One model call on a thought, as measured: the level on the 0–5 scale (after the ceiling) and the due day as days after the capture's UTC day. Null halves were not read. */
export type Call = { level: number | null; due: number | null; byRule: boolean | null };
/** One rater's label of one text: every level and every due day (days after the capture's UTC day) the text states. Empty arrays: none stated. */
export type Label = { levels: number[]; dues: number[] };
/** One labelled item: its stratum, its writer, the model's call, the gold and the second rater's label. */
export type Item = { id: string; stratum: "call" | "other"; writer: string; call: Call; gold: Label; second: Label | null };

/** Whether the model read anything from a text: a level or a due day. */
export const isCall = (c: Call): boolean => c.level !== null || c.due !== null;

/** The UTC day of an instant, YYYY-MM-DD. */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** Days from the capture's UTC day to a YYYY-MM-DD day; null for a string that is not a real day. */
export function dayOffset(capturedAt: Date, day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (utcDay(new Date(t)) !== day) return null;
  const c = new Date(utcDay(capturedAt) + "T00:00:00Z").getTime();
  return Math.round((t - c) / 86_400_000);
}

/** A call as measured, from what inferPriority returned on a text captured at `capturedAt`. */
export function callOf(inferred: Inferred | null, capturedAt: Date): Call {
  const level = inferred?.level ? Math.min(inferred.level.value, CEILING) : null;
  const due = inferred?.due ? dayOffset(capturedAt, inferred.due.day) : null;
  return { level, due, byRule: inferred?.due ? inferred.due.by === "rule" : null };
}

/** The draw's order key of an id: the first 12 hex digits of sha256(seed:id), as a number. */
const drawKey = (id: string, seed: string): number => parseInt(createHash("sha256").update(`${seed}:${id}`).digest("hex").slice(0, 12), 16);

/**
 * The sample: DRAW.calls of the calls and DRAW.others of the rest, each the lowest by the draw's key, then the two
 * shuffled together by a second key so a rater meets the strata mixed. `short` names a stratum taken whole.
 */
export function drawSample(rows: readonly { id: string; call: Call }[], draw: { calls: number; others: number; seed: string } = DRAW): {
  picked: { id: string; stratum: "call" | "other" }[];
  short: string[];
} {
  const by = (xs: readonly { id: string }[]) => [...xs].sort((a, b) => drawKey(a.id, draw.seed) - drawKey(b.id, draw.seed) || (a.id < b.id ? -1 : 1));
  const calls = by(rows.filter((r) => isCall(r.call))), others = by(rows.filter((r) => !isCall(r.call)));
  const short = [
    ...(calls.length < draw.calls ? [`calls: ${calls.length} of ${draw.calls}`] : []),
    ...(others.length < draw.others ? [`others: ${others.length} of ${draw.others}`] : []),
  ];
  const picked = [
    ...calls.slice(0, draw.calls).map((r) => ({ id: r.id, stratum: "call" as const })),
    ...others.slice(0, draw.others).map((r) => ({ id: r.id, stratum: "other" as const })),
  ];
  const sheetSeed = `${draw.seed}:sheet`;
  picked.sort((a, b) => drawKey(a.id, sheetSeed) - drawKey(b.id, sheetSeed) || (a.id < b.id ? -1 : 1));
  return { picked, short };
}

/** The level words a rater writes, on the 0–5 scale (docs/priority.md's). */
export const LEVEL_WORDS: Readonly<Record<string, number>> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4, critical: 5 };

/** Whether a call's level is one the rater read: equal after the ceiling. A call with no level is not a level call. */
export const levelRead = (c: Call, l: Label): boolean => c.level !== null && l.levels.some((v) => Math.min(v, CEILING) === Math.min(c.level!, CEILING));
/** Whether a call's due day is one the rater read. */
export const dueRead = (c: Call, l: Label): boolean => c.due !== null && l.dues.includes(c.due);

/** A share, with its count. */
export type Share = { n: number; hit: number; share: number | null };
const share = (hit: number, n: number): Share => ({ n, hit, share: n === 0 ? null : hit / n });

/** The measurement: each half's precision over the model's calls in the sample, High where none was read, and the misses among the others. */
export type Score = {
  level: Share;
  due: Share;
  highOnNone: Share;
  /** Of the OTHERS stratum, the share the gold reads a level or a day in: the model's misses, as a share of the texts it read nothing from. */
  missed: { level: Share; due: Share };
  /** Per writer, each half's precision over the calls in the sample. */
  writers: Record<string, { level: Share; due: Share }>;
};

/** Score a labelled sample. */
export function score(items: readonly Item[]): Score {
  const calls = items.filter((i) => i.stratum === "call"), others = items.filter((i) => i.stratum === "other");
  const halves = (xs: readonly Item[]) => {
    const lv = xs.filter((i) => i.call.level !== null), du = xs.filter((i) => i.call.due !== null);
    return { level: share(lv.filter((i) => levelRead(i.call, i.gold)).length, lv.length), due: share(du.filter((i) => dueRead(i.call, i.gold)).length, du.length) };
  };
  const levelCalls = calls.filter((i) => i.call.level !== null);
  const writers: Score["writers"] = {};
  for (const w of [...new Set(calls.map((i) => i.writer))].sort()) writers[w] = halves(calls.filter((i) => i.writer === w));
  return {
    ...halves(calls),
    highOnNone: share(levelCalls.filter((i) => i.call.level === CEILING && i.gold.levels.length === 0).length, levelCalls.length),
    missed: { level: share(others.filter((i) => i.gold.levels.length > 0).length, others.length), due: share(others.filter((i) => i.gold.dues.length > 0).length, others.length) },
    writers,
  };
}

/** The verdict: whether PR 3 may turn `count_inferred` on, and every condition that failed. */
export function verdict(s: Score): { passes: boolean; failures: string[] } {
  const failures: string[] = [];
  const precise = (name: string, x: Share, min: number) => {
    if (x.n < MIN_CALLS) failures.push(`${name}: measured on ${x.n} calls, under ${MIN_CALLS}`);
    else if (x.share! < min) failures.push(`${name}: ${x.hit} of ${x.n} read (${x.share!.toFixed(3)}), under ${min}`);
  };
  precise("level precision", s.level, BAR.levelPrecisionMin);
  precise("due precision", s.due, BAR.duePrecisionMin);
  if (s.highOnNone.n >= MIN_CALLS && s.highOnNone.share! >= BAR.highOnNoneMax)
    failures.push(`High where no level is read: ${s.highOnNone.hit} of ${s.highOnNone.n} (${s.highOnNone.share!.toFixed(3)}), not under ${BAR.highOnNoneMax}`);
  return { passes: failures.length === 0, failures };
}

// ── End of the registered section ────────────────────────────────────────────

/** Cohen's κ between two raters' categories over the same items; null when chance agreement is total. */
export function kappa(a: readonly string[], b: readonly string[]): number | null {
  if (a.length !== b.length || a.length === 0) throw new Error("kappa: two ratings of the same, non-empty items");
  const n = a.length, cats = [...new Set([...a, ...b])];
  const po = a.filter((x, i) => x === b[i]).length / n;
  const pe = cats.reduce((s, c) => s + (a.filter((x) => x === c).length / n) * (b.filter((x) => x === c).length / n), 0);
  return pe === 1 ? null : (po - pe) / (1 - pe);
}

/** A label's categories for κ: its lowest level after the ceiling (or "-"), and whether it states a due day at all. */
export const levelCategory = (l: Label): string => (l.levels.length === 0 ? "-" : String(Math.min(Math.min(...l.levels), CEILING)));
export const dueCategory = (l: Label): string => (l.dues.length === 0 ? "-" : "due");

// ── The sheet ─────────────────────────────────────────────────────────────────

/** The line that opens an item on the sheet; its number and id are read back by parseSheet. */
const ITEM_HEAD = /^=== item (\d{3}) · ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) ===$/;
const TEXT_MARK = "--- text ---";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The labelling sheet: the conventions, then each item's head, its capture day, two blank answers and its text. Never the model's call. */
export function renderSheet(items: readonly { id: string; at: Date; text: string }[]): string {
  const head = [
    "# SMD-3670 PR 2: the labelling sheet",
    "",
    "Fill in `level:` and `due:` for every item. Leave nothing blank: write - for none stated.",
    "",
    ...CONVENTIONS.map((c, i) => `${i + 1}. ${c}`),
    "",
  ];
  const body = items.map((it, i) => [
    `=== item ${String(i + 1).padStart(3, "0")} · ${it.id} ===`,
    `captured: ${WEEKDAYS[it.at.getUTCDay()]} ${utcDay(it.at)} (UTC)`,
    "level: ",
    "due: ",
    TEXT_MARK,
    it.text.replace(/\r\n/g, "\n").split("\n").map((l) => (ITEM_HEAD.test(l) ? ` ${l}` : l)).join("\n"),
    "",
  ].join("\n"));
  return [...head, ...body].join("\n");
}

/**
 * A filled sheet read back: each item's id and label, its due days counted from its capture day, and that day, for the
 * caller to tie to the run. Refuses, naming each, an item with a blank or unreadable answer, a field given twice, no
 * captured line, or no text marker before the next item, and an id listed twice.
 */
export function parseSheet(text: string): { labels: Map<string, Label>; days: Map<string, string>; problems: string[] } {
  const labels = new Map<string, Label>(), days = new Map<string, string>(), problems: string[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = ITEM_HEAD.exec(lines[i]);
    if (!m) continue;
    const [num, id] = [m[1], m[2]];
    const fields: Record<string, string> = {};
    const repeated: string[] = [];
    let j = i + 1;
    for (; j < lines.length && lines[j] !== TEXT_MARK && !ITEM_HEAD.test(lines[j]); j++) {
      const f = /^(captured|level|due):(.*)$/.exec(lines[j]);
      if (f) {
        if (f[1] in fields) repeated.push(f[1]);
        fields[f[1]] = f[2].trim();
      }
    }
    const where = `item ${num} (${id.slice(0, 8)})`;
    // Without its marker an item's field scan runs on into its text, where a line can read as an answer.
    if (lines[j] !== TEXT_MARK) { problems.push(`${where}: no "${TEXT_MARK}" line before the next item`); continue; }
    if (repeated.length) { problems.push(`${where}: ${repeated.join(", ")} given twice`); continue; }
    if (labels.has(id)) { problems.push(`${where}: listed twice`); continue; }
    const cap = /^\w+ (\d{4}-\d{2}-\d{2}) \(UTC\)$/.exec(fields.captured ?? "");
    if (!cap) { problems.push(`${where}: no captured line`); continue; }
    const at = new Date(cap[1] + "T00:00:00Z");
    const read = readAnswer(fields.level, fields.due, at, where);
    if ("label" in read) { labels.set(id, read.label); days.set(id, cap[1]); } else problems.push(...read.problems);
  }
  return { labels, days, problems };
}

/**
 * One item's two answers read, its due days counted from `at` (its capture day): the label, or what is wrong with each
 * answer, under `where`. The sheet and the reply file read answers alike.
 */
export function readAnswer(levelRaw: string | undefined, dueRaw: string | undefined, at: Date, where: string): { label: Label } | { problems: string[] } {
  const problems: string[] = [];
  const levels = readList(levelRaw, (w) => LEVEL_WORDS[w.toLowerCase()] ?? null);
  const dues = readList(dueRaw, (d) => dayOffset(at, d));
  if (levels === "blank") problems.push(`${where}: level is blank (write - for none stated)`);
  else if (levels === "bad") problems.push(`${where}: level "${levelRaw}" is not - or ${Object.keys(LEVEL_WORDS).join("/")}, comma-separated`);
  if (dues === "blank") problems.push(`${where}: due is blank (write - for none stated)`);
  else if (dues === "bad") problems.push(`${where}: due "${dueRaw}" is not - or YYYY-MM-DD, comma-separated`);
  return Array.isArray(levels) && Array.isArray(dues) ? { label: { levels, dues } } : { problems };
}

/** One answer read: "-" for none, else comma-separated values each read by `one`. */
function readList(raw: string | undefined, one: (s: string) => number | null): number[] | "blank" | "bad" {
  const s = (raw ?? "").trim();
  if (s === "") return "blank";
  if (s === "-") return [];
  const out = s.split(",").map((x) => one(x.trim()));
  return out.some((x) => x === null) ? "bad" : [...new Set(out as number[])].sort((a, b) => a - b);
}

// ── The reply file ────────────────────────────────────────────────────────────

/** A line of the reply file: the sheet's item number, the item's id, then the two answers. */
const ANSWER_LINE = /^(\d{3}) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) \|(.*)\|(.*)$/;

/**
 * The reply file drawn beside a sheet: one line per item, in the sheet's order, `NNN <id> | level | due`, its answers
 * blank. A rater fills it in instead of the sheet, so no one copies answers between the two by hand.
 */
export function renderAnswers(ids: readonly string[]): string {
  return [
    "# SMD-3670 PR 2 replies: fill in each line's level and due, as the sheet's item with that number says.",
    `# level: - or ${Object.keys(LEVEL_WORDS).join("/")}; due: - or YYYY-MM-DD; several comma-separated. Leave nothing blank.`,
    ...ids.map((id, i) => `${String(i + 1).padStart(3, "0")} ${id} |  | `),
    "",
  ].join("\n");
}

/**
 * A filled reply file read back, each item's due days counted from its run line's capture day (`atById`). Refuses, naming
 * each, a line that is not a reply line, an id listed twice or not in `atById`, and a blank or unreadable answer.
 */
export function parseAnswers(text: string, atById: ReadonlyMap<string, string>): { labels: Map<string, Label>; problems: string[] } {
  const labels = new Map<string, Label>(), problems: string[] = [];
  for (const [n, line] of text.replace(/\r\n/g, "\n").split("\n").entries()) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const m = ANSWER_LINE.exec(line);
    if (!m) { problems.push(`line ${n + 1}: not "NNN <id> | level | due"`); continue; }
    const [num, id] = [m[1], m[2]], where = `item ${num} (${id.slice(0, 8)})`;
    const at = atById.get(id);
    if (at === undefined) { problems.push(`${where}: not in the draw`); continue; }
    if (labels.has(id)) { problems.push(`${where}: listed twice`); continue; }
    const read = readAnswer(m[3].trim(), m[4].trim(), new Date(at), where);
    if ("label" in read) labels.set(id, read.label); else problems.push(...read.problems);
  }
  return { labels, problems };
}

/** Whether a filled file is a sheet (its item heads) rather than a reply file. */
export const isSheet = (text: string): boolean => text.split("\n").some((l) => ITEM_HEAD.test(l));

// ── The fixture ───────────────────────────────────────────────────────────────

/**
 * The committed fixture: ids and numbers only (check-consistency 9). A stratum and a writer are lists of ids, a call's
 * and a label's halves numbers, and the provenance is under `note` and `generated`. The text stays in the brain.
 */
export type Fixture = {
  generated: string;
  note: string;
  prompt_version: number;
  registration: number[];
  population: { calls: number; others: number };
  strata: { call: string[]; other: string[] };
  writers: Record<string, string[]>;
  items: Record<string, { call: { level: number | null; due: number | null; by_rule: boolean | null }; gold: Label; second: Label | null }>;
};

/** A writer's name as a fixture key: check 9 takes a key of letters, digits and underscores. */
export const writerKey = (w: string): string => w.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(?=\d)/, "w_") || "unknown";

/** The fixture of a labelled sample. */
export function toFixture(items: readonly Item[], meta: { generated: string; note: string; promptVersion: number; population: { calls: number; others: number } }): Fixture {
  const writers: Record<string, string[]> = {};
  for (const i of items) (writers[writerKey(i.writer)] ??= []).push(i.id);
  return {
    generated: meta.generated,
    note: meta.note,
    prompt_version: meta.promptVersion,
    registration: registrationDigits(),
    population: meta.population,
    strata: { call: items.filter((i) => i.stratum === "call").map((i) => i.id), other: items.filter((i) => i.stratum === "other").map((i) => i.id) },
    writers,
    items: Object.fromEntries(items.map((i) => [i.id, { call: { level: i.call.level, due: i.call.due, by_rule: i.call.byRule }, gold: i.gold, second: i.second }])),
  };
}

/** The items of a fixture, and what is wrong with it: an id in two strata or none, an item without a writer, a label out of range. */
export function fromFixture(f: Fixture): { items: Item[]; problems: string[] } {
  const problems: string[] = [], items: Item[] = [];
  const stratumOf = new Map<string, "call" | "other">();
  for (const s of ["call", "other"] as const) for (const id of f.strata[s]) {
    if (stratumOf.has(id)) problems.push(`${id} is in two strata`);
    stratumOf.set(id, s);
  }
  const writerOf = new Map<string, string>();
  for (const [w, ids] of Object.entries(f.writers)) for (const id of ids) {
    if (writerOf.has(id)) problems.push(`${id} has two writers`);
    writerOf.set(id, w);
  }
  const labelSound = (l: Label | null) => l === null || (l.levels.every((v) => Number.isInteger(v) && v >= 0 && v <= 5) && l.dues.every(Number.isInteger));
  for (const [id, it] of Object.entries(f.items)) {
    const stratum = stratumOf.get(id), writer = writerOf.get(id);
    if (!stratum) { problems.push(`${id} is in no stratum`); continue; }
    if (!writer) { problems.push(`${id} has no writer`); continue; }
    const call: Call = { level: it.call.level, due: it.call.due, byRule: it.call.by_rule };
    if ((stratum === "call") !== isCall(call)) problems.push(`${id}: its call ${isCall(call) ? "reads something" : "reads nothing"}, in the ${stratum} stratum`);
    if (!labelSound(it.gold) || !labelSound(it.second)) problems.push(`${id}: a label out of range`);
    items.push({ id, stratum, writer, call, gold: it.gold, second: it.second });
  }
  for (const id of stratumOf.keys()) if (!(id in f.items)) problems.push(`${id} is in a stratum with no item`);
  return { items, problems };
}

// ── The registration's hash ───────────────────────────────────────────────────

/** The registered section of a copy of this file's text, CRLF read as LF. */
export function registeredSection(text: string): string {
  const src = text.replace(/\r\n/g, "\n");
  // At a line's start, so the markers this function names inside its own quotes are not them.
  const from = src.indexOf("\n// ── The registration ─"), to = src.indexOf("\n// ── End of the registered section ─");
  if (from < 0 || to < from) throw new Error("inferred-priority.ts: the registered section's markers are missing");
  return src.slice(from, to);
}

let sectionCache: string | null = null;
/** The registration's hash: the first 16 hex digits of sha256 over the registered section, verbatim. */
export function registrationHash(text?: string): string {
  const section = text === undefined ? (sectionCache ??= registeredSection(readFileSync(fileURLToPath(import.meta.url), "utf8"))) : registeredSection(text);
  return createHash("sha256").update(section).digest("hex").slice(0, 16);
}

/** The registration's hash as the fixture records it: its 16 hex digits as numbers (check 9 takes no other string). */
export const registrationDigits = (hash: string = registrationHash()): number[] => [...hash].map((c) => parseInt(c, 16));
