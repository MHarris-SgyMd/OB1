/**
 * priority-infer.ts — the priority and due time a captured text states in its
 * own words (SMD-3670): "Urgent: the landlord wants an answer by Friday" says
 * a level and a deadline that no field carries. One chat call over the text,
 * its own prompt beside the tags' (METADATA_PROMPT stays as it is), opt-in per
 * brain (OB1_INFER_PRIORITY) and through the egress gate's chat decision, as
 * the tags' call is.
 *
 * What the answer is held to, so a model's guess never passes for the text's:
 * - A level or a due time stands only on a phrase the text holds as whole
 *   words (case-folded, white space collapsed). A phrase the model made up
 *   drops its half of the answer, and so does a level word the text negates
 *   ("not very urgent" read as urgent), a High read off a phrase negating its
 *   own cue ("no rush"), and a level phrase that is only the deadline's
 *   words. A label cited for another item ("SMD-2627 (Medium)") is marked,
 *   and dropped only for an agent-kind writer (forWriter, SMD-4226). A due
 *   phrase that is the earliest something can happen ("can't happen before
 *   11-03") drops its half for every writer (SMD-4226).
 * - An inferred level is at most High (3): "urgent" costs nothing to write in
 *   a note, and the maintainer's own example reads "Urgent: …" as High
 *   (confirmed by the maintainer, 2026-11-09, with the two rules below and in
 *   core/writes.ts: a due phrase alone states Medium, and only a fresh capture
 *   is read).
 * - A due phrase is resolved by the rules below from the capture's UTC day
 *   ("by Friday" captured on Tuesday 2026-11-03 is 2026-11-06). Only a phrase
 *   the rules can't read takes the model's date, and only a real day from the
 *   capture's to a year after it, on a phrase that names a time, on the weekday
 *   it names if it names one.
 *
 * What the capture does with it (core/writes.ts): a statement at tier 4,
 * flagged inferred (docs/priority.md, decisions 4 and 6), under the capturing
 * key, its reason quoting the phrases. Nothing ranks on it: effective_priority
 * passes inferred statements over until SMD-3670's measurement clears its bar
 * (decision 5, `count_inferred`).
 */

import { providerCall, providerDown, ProviderError, type EmbedConfig } from "./embed.ts";
import type { EgressSubject } from "./egress.ts";
import { endOfDay, type PriorityLevel } from "./priority-scale.ts";

/** The prompt's version, bumped by hand when its meaning moves; the reason a statement carries names it. */
export const INFER_PROMPT_VERSION = 2;
/**
 * Version 2 (SMD-4226): v1 read a label quoted beside a ticket, priority discussed as a subject and an expiry as the
 * note's own level and deadline, and agreed with the operator on 0.188 of its level reads (SMD-3670 PR 2). v2 says
 * whose work a level and a deadline must be about, and names what is neither.
 */
export const INFER_PROMPT = `Read the user's captured note for how much its writer says their own work matters, and for a deadline it sets for that work. The first line gives the day it was captured. Return JSON with:
- "level": one of "none", "low", "medium", "high", "urgent", only when the writer says how much the work they mean matters ("urgent", "important", "no rush", "low priority"); else null
- "level_phrase": the exact words of the note that say it, or null
- "due_phrase": the exact words that set a deadline for work the note asks to be done, such as "by Friday" or "before the 12th", or null
- "due_date": that deadline as YYYY-MM-DD, counted from the capture day, or null
A note that is itself a ticket or task record carries its own priority field ("Priority: High") as its level.
Not a level: a priority or label quoted beside another ticket, task or item ("ABC-12 (High)", "Medium, Design team", "Backlog, Low"); where one item ranks among others ("the highest-priority open issue", "one of two High-priority tickets"); text about priorities, scales or rankings; how severe a bug or finding is; a deadline on its own.
Not a deadline: when a lease, claim, token or cache expires; the earliest something can happen ("not before 11-03", "can't happen before Friday", "can go on tomorrow at the earliest"); a time to watch or measure something; a date already past or one something happened on; dates in quoted material.
Most notes say neither: then every field is null. Copy phrases exactly as the note writes them.`;

/** The highest level an inferred statement takes: High (the maintainer, 2026-11-09). */
export const INFERRED_CEILING: PriorityLevel = 3;
/** The level a due phrase with no level phrase is stated at: 116 takes no statement without a level, and Medium is what unknown counts as (decision 3; the maintainer, 2026-11-09). */
export const DUE_ONLY_LEVEL: PriorityLevel = 2;

/** The model's level words, and the level each is on the scale before the ceiling. */
const LEVEL_WORDS: Readonly<Record<string, PriorityLevel>> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4, critical: 5 };

/** What a text was read to state: a level and a due day, each with the phrase that says it. Null halves were not read. */
export type Inferred = {
  /** `cited`: the phrase is a label cited for another item (citedIn); forWriter drops it for an agent-kind writer. */
  level: { value: PriorityLevel; word: string; phrase: string; cited?: boolean } | null;
  due: { day: string; phrase: string; by: "rule" | "model" } | null;
};

// ── Phrases ──────────────────────────────────────────────────────────────────

/** A text as a phrase is looked for in it: case-folded, curly quotes made straight, white space collapsed. */
const folded = (s: string) => s.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/gu, " ").trim();

/** Where a phrase stands in a text as whole words: the start of each match of its folded form, bounded by no letter or digit. */
function wholeWordAt(phrase: string, text: string): number[] {
  const p = folded(phrase), t = folded(text), at: number[] = [];
  const edge = (c: string | undefined) => c === undefined || !/[\p{L}\p{N}]/u.test(c);
  for (let i = t.indexOf(p); i !== -1; i = t.indexOf(p, i + 1)) if (edge(t[i - 1]) && edge(t[i + p.length])) at.push(i);
  return at;
}

/**
 * The phrase, trimmed, when the text holds it as whole words ("rush" is not in "brush") and it is 1 to 200
 * characters with a letter or a digit in it; else null.
 */
export function quotedIn(phrase: unknown, text: string): string | null {
  if (typeof phrase !== "string") return null;
  const p = phrase.replace(/\s+/gu, " ").trim();
  if (p.length > 200 || !/[\p{L}\p{N}]/u.test(p)) return null;
  return wholeWordAt(p, text).length > 0 ? p : null;
}

/** The words that negate what follows them. */
const NEGATORS = "not|no|never|hardly|isn't|aren't|wasn't|don't|doesn't|nothing|nothing's";
/** Words that turn a negation into emphasis ("never been more urgent", "nothing is more important", "not only urgent"). */
const EMPHASIS = "more|only|ever";
/** A negating word, up to two words before the phrase ("not urgent", "not very urgent", "not all that important"), or "non-" on it; never across an emphasis word. */
const NEGATED_BEFORE = new RegExp(`(\\b(${NEGATORS})(\\s+(?!(?:${EMPHASIS})\\b)[\\p{L}']+){0,2}\\s+|\\bnon-?\\s*)$`, "u");
/** The words a phrase about how much something matters carries. A level phrase with none of them that names a time or is the deadline's own words says nothing of the level. */
const LEVEL_CUES = /\b(urgent|urgently|urgency|asap|important|importance|unimportant|critical|crucial|priority|emergency|immediately|pressing|vital|essential|rush|hurry|whenever|someday|trivial|minor|optional|idea|low|medium|high|top)\b/;
/** A phrase that negates its own cue ("not urgent", "no rush", "non-critical"), not across an emphasis word: it never says a level of High or more. */
const SELF_NEGATED = new RegExp(`\\b(${NEGATORS}|non)\\b-?(\\s*(?!(?:${EMPHASIS})\\b)[\\p{L}']+){0,2}?\\s*\\b(urgent|urgently|important|critical|crucial|priority|pressing|vital|essential|rush|hurry|emergency)\\b`, "u");

/** A ticket's key: two to ten capitals and digits from a capital, a hyphen, digits ("SMD-2627", "ABC-12"). */
const TICKET_KEY = /\b([A-Z][A-Z0-9]{1,9})-\d{1,6}\b/g;
/** Prefixes of that shape that name no ticket: a disease, a standard, an encoding, a model, a flight, a fiscal year (review pass 1). */
const NOT_TICKETS = new Set(["COVID", "ISO", "UTF", "GPT", "SHA", "MD5", "RFC", "CVE", "IPV4", "IPV6", "HTTP", "TLS", "SSL", "USB", "PCI", "ECMA", "FY", "UA", "AA", "DL", "BA", "LH", "AF", "WN", "B6", "US", "EU", "UK", "SA", "PM", "AM", "Q1", "Q2", "Q3", "Q4", "H1", "H2"]);
/** Where the last ticket key in a stretch of text ends, or -1: a token of a key's shape that names no ticket is passed over. */
function lastKeyEnd(s: string): number {
  let end = -1;
  for (const m of s.matchAll(TICKET_KEY)) if (!NOT_TICKETS.has(m[1])) end = m.index! + m[0].length;
  return end;
}
/** A level word as a label carries it, in its three cases: the key beside it stays case-sensitive (review pass 2: "mid-2025 high"). */
const LEVEL = "[Nn]one|NONE|[Ll]ow|LOW|[Mm]edium|MEDIUM|[Hh]igh|HIGH|[Uu]rgent|URGENT|[Cc]ritical|CRITICAL";
/** A board's statuses, capitalised as a board shows them. */
const STATUS = "Backlog|Todo|To Do|In Progress|In Review|Done|Canceled|Cancelled|Triage|Started|Unstarted";
/** A ticket key directly beside a level word in the quoted phrase ("SMD-2627 (Medium)", "ABC-12: High", "SMD-12 [Low]"). */
const KEY_BESIDE_LEVEL = new RegExp(`\\b([A-Z][A-Z0-9]{1,9})-\\d{1,6}\\s*[(\\[:,·—–-]?\\s*[(\\[]?\\s*(?:${LEVEL})\\b`);
/** A board status, then a level ("Backlog, Low", "In Progress, High"). */
const STATUS_THEN_LEVEL = new RegExp(`\\b(?:${STATUS}),\\s*(?:${LEVEL})\\b`);
/** A level, then a board status ("High, Todo in cycle 21"). */
const LEVEL_THEN_STATUS = new RegExp(`^(?:[- ]priority)?,\\s*(?:${STATUS})\\b`);
/** A board's field name, capitalised, just before the level ("Owner, Urgent priority and cycle unchanged"). */
const BOARD_FIELD = /\b(Owner|Assignee|Status|Cycle|Estimate|Labels?),\s*$/;
/** An item ranked among others by its level: "the only High-priority open child", "one of two High-priority tickets". */
const RANKED_BY_LEVEL = new RegExp(`\\b(the only|one of (?:two|three|four|five|six|\\d+))\\s+(?:open\\s+)?(?:${LEVEL})[- ]priority\\s+(?:open\\s+)?(tickets?|issues?|child|children|items?|bugs?|tasks?)\\b`, "i");
/** An item ranked among others by priority or value: "the highest-priority open child", "the top-priority ticket". */
const RANKED_TOP = /\bthe (highest|lowest|top)[- ](priority|value)\s+(?:open\s+)?(tickets?|issues?|child|children|items?|bugs?|tasks?)\b/i;
/** How far back citedIn reads a clause, and how far forward a line: bounded, so a long capture costs its length, not its square (review pass 2: 12.8 s on 389 KB). */
const CLAUSE_SPAN = 240;
const ROW_SPAN = 400;

/** A character lower-cased only when that keeps its length ("İ" grows under toLowerCase and is kept), so places index both copies alike. */
const lowerKeep = (s: string) => [...s].map((c) => { const l = c.toLowerCase(); return l.length === c.length ? l : c; }).join("");
/** Curly quotes made straight, in a text and in a phrase alike (review pass 2: a phrase's curly quote found no place). */
const straight = (s: string) => s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');

/**
 * A text as citedIn reads it: quotes made straight, each run of white space one space (a run holding a line break,
 * U+2028 or U+2029 recorded as a break), trimmed; its case kept, beside a copy lower-cased place for place.
 */
function linesOf(text: string): { kept: string; lower: string; breaks: number[] } {
  let kept = "";
  const breaks: number[] = [];
  for (const m of straight(text).matchAll(/(\s+)|(\S+)/gu)) {
    if (m[2] !== undefined) { kept += m[2]; continue; }
    if (kept === "") continue;
    if (/[\n\r\u2028\u2029]/.test(m[1])) breaks.push(kept.length);
    kept += " ";
  }
  if (kept.endsWith(" ")) kept = kept.slice(0, -1);
  return { kept, lower: lowerKeep(kept), breaks };
}

/** The last of sorted breaks at or before i, or 0; and the first at or after j, or the end. */
function lineAround(breaks: readonly number[], i: number, j: number, end: number): [number, number] {
  let lo = 0, hi = breaks.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (breaks[mid] <= i) lo = mid + 1; else hi = mid; }
  const start = lo > 0 ? breaks[lo - 1] : 0;
  let k = lo;
  while (k < breaks.length && breaks[k] < j) k++;
  return [start, k < breaks.length ? breaks[k] : end];
}

/**
 * Whether every place the text holds the level phrase is a label cited for another item (SMD-4226), in a shape that
 * cites, never by nearness alone:
 * - a ticket key earlier in the same clause, its words ending in "(", "[", ",", ":", "·" or a dash just before the
 *   phrase ("SMD-1768 (Medium)", "SMD-2742 — Medium, Release Engineering", "SMD-2368, `platform`, High");
 * - a key beside the level inside the phrase ("SMD-2627 (Medium):");
 * - a table's cell on a row that holds a key ("| SMD-1 | … | Medium |");
 * - on a line that holds a key, a board status before or after the level ("Backlog, Low", "High, Todo in cycle 21");
 * - a board field's name before it ("Owner, Urgent priority");
 * - a level directly before a ticket key ("the High-priority SMD-1350");
 * - an item ranked among others by its level or by priority ("the only High-priority open child", "the
 *   highest-priority open issue").
 * The model read a tag, not what the writer says of their own work: v1 did so on 10 of the 38 level reads it made on
 * session summaries. readAnswer marks such a level, and only an agent-kind writer's is dropped (forWriter, the
 * maintainer's choice after review pass 2): syntax cannot tell another ticket's label from a person's own "Fix SMD-12
 * (urgent)" or "Done, urgent: call mom". A ticket's own export ("SMD-944 · Status: Todo · Priority: High") keeps its
 * "Priority:" field, whatever precedes it.
 */
export function citedIn(phrase: string, text: string): boolean {
  const { kept, lower, breaks } = linesOf(text);
  const p = lowerKeep(straight(phrase).replace(/\s+/gu, " ").trim());
  if (p === "") return false;
  const edge = (c: string | undefined) => c === undefined || !/[\p{L}\p{N}]/u.test(c);
  const at: number[] = [];
  for (let i = lower.indexOf(p); i !== -1; i = lower.indexOf(p, i + 1)) if (edge(lower[i - 1]) && edge(lower[i + p.length])) at.push(i);
  return at.length > 0 && at.every((i) => {
    const [lineStart, nextBreak] = lineAround(breaks, i, i + p.length, kept.length);
    const said = kept.slice(i, i + p.length);
    const lineBefore = kept.slice(Math.max(lineStart, i - CLAUSE_SPAN), i), lineAfter = kept.slice(i + p.length, Math.min(nextBreak, i + p.length + 120));
    const row = kept.slice(Math.max(lineStart, i - ROW_SPAN), Math.min(nextBreak, i + p.length + ROW_SPAN));
    // The clause before the phrase: from the line's start, or from the last sentence's end in it.
    let cut = 0;
    for (const m of lineBefore.matchAll(/[.!?;]\s/g)) cut = m.index! + m[0].length;
    const clauseBefore = lineBefore.slice(cut);
    // A ticket's own "Priority:" field is the text's own, even after a key and a "·" or ":" (a short export).
    if (/^priority\b/i.test(said) || /\bpriority\s*:?\s*$/i.test(clauseBefore)) return false;
    const keyEnd = lastKeyEnd(clauseBefore);
    if (keyEnd >= 0 && clauseBefore.length - keyEnd <= 60 && /[(\[,:·—–-]\s*$/.test(clauseBefore)) return true;
    const besideLevel = KEY_BESIDE_LEVEL.exec(said);
    if (besideLevel && !NOT_TICKETS.has(besideLevel[1])) return true;
    const rowKey = lastKeyEnd(row) >= 0;
    if (rowKey && /\|\s*$/.test(lineBefore) && /^\s*\|/.test(lineAfter)) return true;
    if (rowKey && (STATUS_THEN_LEVEL.test(`${clauseBefore.slice(-30)}${said}`) || LEVEL_THEN_STATUS.test(lineAfter))) return true;
    if (BOARD_FIELD.test(clauseBefore) || /^(Owner|Assignee|Status|Cycle|Estimate|Labels?),\s*/.test(said)) return true;
    // A level directly before a ticket key labels that ticket ("under the High-priority SMD-1350").
    const keyNext = /^(?:[- ]priority)?\s+([A-Z][A-Z0-9]{1,9})-\d/.exec(lineAfter);
    if (keyNext && !NOT_TICKETS.has(keyNext[1])) return true;
    const window = `${clauseBefore.slice(-60)}${said}${lineAfter.slice(0, 60)}`, from = Math.min(60, clauseBefore.length);
    return [RANKED_BY_LEVEL, RANKED_TOP].some((re) => {
      const m = re.exec(window);
      return m !== null && m.index <= from + said.length && m.index + m[0].length >= from;
    });
  });
}

/** A negation that can open a floor (review pass 2 added the contractions: "doesn't open until Monday"). */
const FLOOR_NEG = "not|never|can't|cannot|can not|won't|don't|doesn't|isn't|aren't|wasn't|weren't|shouldn't|mustn't|hasn't|haven't|hadn't|wouldn't|couldn't|didn't";
/** A negation, up to two words, then "before", "until" or "till"; the words between are group 2. */
const FLOOR_LEAD = new RegExp(`\\b(${FLOOR_NEG})\\s+((?:[\\p{L}']+\\s+){0,2}?)(before|until|till)\\b`, "gu");
/** The same lead with its floor word left to the quoted phrase ("which can't happen" + "before 11-03"). */
const FLOOR_LEAD_OPEN = new RegExp(`\\b(${FLOOR_NEG})((?:\\s+[\\p{L}']+){0,2})\\s+$`, "u");
/** Words between the negation and "before" that make a deadline of it ("do not forget before Friday", "not urgent but before Friday"). */
const NOT_FLOOR_BETWEEN = /\b(but|forget|forgetting|miss|missing|wait|waiting|leave|leaving|delay|let|slip|pass)\b/;
/** A condition ahead of the negation makes a deadline of it ("if it's not paid before the 15th"). */
const CONDITION_BEFORE = /\b(if|unless|when|whether|in case)\s+(?:[\p{L}']+\s+){0,4}$/u;
/** "no sooner than", "no earlier than", "not earlier than", just before a time. */
const FLOOR_THAN = /\b(no sooner|no earlier|not earlier|not sooner) than\s*$/;
/** Words just before a time that make it the start of something ("starting Monday", "only after Friday", "from the 12th"). */
const FLOOR_FROM = /\b(starting|starts|start|beginning|begins|from|only after|after)\s+$/;
/** The words that make a time a floor when they follow it ("tomorrow at the earliest", "Monday earliest", "the 12th onwards"). */
const FLOOR_AFTER = /^[\s,)]*(at the earliest|at earliest|earliest|or later|at the soonest|onwards|onward)\b/;
/** The floor's words inside a quoted phrase. */
const FLOOR_SAID = /\b(at the earliest|at earliest|or later|at the soonest|onwards|onward|(no sooner|no earlier|not earlier|not sooner) than)\b|^(starting|starts|beginning|from|only after|after)\b/;

/** Whether a negation-then-"before" lead in a stretch is a floor: no deadline word between, no condition ahead; `atEnd` when it must end the stretch. */
function floorLead(s: string, atEnd: boolean): boolean {
  for (const m of s.matchAll(FLOOR_LEAD)) {
    if (atEnd && s.slice(m.index! + m[0].length).trim() !== "") continue;
    if (NOT_FLOOR_BETWEEN.test(m[2]) || CONDITION_BEFORE.test(s.slice(0, m.index!))) continue;
    return true;
  }
  return false;
}

/**
 * Whether every place the text holds the due phrase is the earliest something can happen, not a deadline (SMD-4226). It
 * applies to every writer, and takes the floor's own construction, never a negation alone:
 * - a negation, up to two words, then "before", "until" or "till" — before the phrase, inside it, or split across
 *   them ("which can't happen" + "before 11-03") — unless the words between make a deadline of it ("do not forget
 *   before Friday", "not urgent but before Friday") or a condition comes first ("if it's not paid before the 15th");
 * - "no sooner than" or "no earlier than" before it;
 * - "starting", "from" or "(only) after" just before it;
 * - "at the earliest", "earliest", "or later", "at the soonest" or "onwards" after it;
 * - any of those words inside it.
 * A deadline with a negation elsewhere stands ("not later than 15 November", "can't wait past Friday"). The model quoted
 * the time and left the floor's words out: v1 read "before 11-03" in "can't happen before 11-03" as a deadline.
 */
export function flooredIn(phrase: string, text: string): boolean {
  const t = folded(text), p = folded(phrase);
  const at = wholeWordAt(phrase, text);
  if (at.length === 0) return false;
  if (floorLead(p, false) || FLOOR_SAID.test(p)) return true;
  return at.every((i) => {
    const before = t.slice(Math.max(0, i - 60), i), after = t.slice(i + p.length, i + p.length + 30);
    const open = FLOOR_LEAD_OPEN.exec(before);
    return floorLead(before, true)
      || (open !== null && /^(before|until|till)\b/.test(p) && !NOT_FLOOR_BETWEEN.test(open[2]) && !CONDITION_BEFORE.test(before.slice(0, open.index)))
      || FLOOR_THAN.test(before) || FLOOR_FROM.test(before) || FLOOR_AFTER.test(after);
  });
}

/**
 * Whether every place the text holds the phrase follows a negating word, up to two words before it ("urgent" in
 * "this is not very urgent", "non-urgent"): the model read the word, not what the text says of it. A phrase that
 * carries its own negation ("not urgent") is read as written, and readAnswer holds it to a level below High.
 */
export function negatedIn(phrase: string, text: string): boolean {
  const t = folded(text);
  const at = wholeWordAt(phrase, text);
  return at.length > 0 && at.every((i) => NEGATED_BEFORE.test(t.slice(Math.max(0, i - 40), i)));
}

// ── Due days ─────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const NUMBER_WORDS: Readonly<Record<string, number>> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
/** A month's name or its first three letters. */
const MONTH_NAMES = MONTHS.map((m) => `${m.slice(0, 3)}${m.length > 3 ? `(?:${m.slice(3)})?` : ""}`).join("|");
/** A month as a whole word, captured, an abbreviation's full stop allowed. */
const MONTH = `(${MONTH_NAMES})\\b\\.?`;
const MONTH_WORD = new RegExp(`\\b${MONTH}`);
/**
 * A weekday's name, or an abbreviation that is no ordinary word ("Tue", "Tues", "Thu", "Thurs", "Fri"; not "sun",
 * "sat", "wed" or "mon": "before the sun goes down" names no day); its day read from its first three letters.
 */
const WEEKDAY_NAMES = "sunday|monday|tue(?:s(?:day)?)?|wednesday|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|saturday";
const WEEKDAY = `(${WEEKDAY_NAMES})`;
/** A weekday as a whole word: the first (`exec`) or every one (`matchAll`, which copies the pattern, so no state is shared). */
const WEEKDAY_WORD = new RegExp(`\\b${WEEKDAY}\\b`, "g");
const weekdayIndex = (word: string) => WEEKDAYS.findIndex((w) => w.startsWith(word.slice(0, 3)));
const COUNT = "(\\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten)";
/** A phrase that says when something may start, not when it is due: no due time. */
const NOT_A_DEADLINE = /\b(not before|not until|not till|no earlier than|no sooner than|starting|once)\b|\bafter\b(?!\s+(next|tomorrow)\b)/;
/** A time of day in the phrase: "before 5pm Friday" is due on Friday. */
const TIME_OF_DAY = /\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{1,2}:\d{2}\b|\b(noon|midnight|eod|cob|close of business)\b|\bend of (the )?day\b/;
/** A boundary the phrase already names: "before the end of the month" is due on the month's last day. */
const END_OF = /\bend of (the )?(day|week|month|year)\b/;
/** A count of days before a day ("2 days before the 20th"): the rules don't subtract counts; the model's to read. */
const COUNTED_BEFORE = new RegExp(`\\b${COUNT}\\s+(day|week)s?\\s+before\\b`);
/** The month's end, a day the rules read and an anchor of its own. */
const END_OF_MONTH = /\bend of (the )?month\b/;
/** "in N days", "within N weeks", "N days from today": a count of days or weeks from the capture day. */
const COUNTED = new RegExp(`\\b(?:in|within)\\s+${COUNT}\\s+(day|week)s?\\b|\\b${COUNT}\\s+(day|week)s?\\s+from\\s+(?:today|now)\\b`);

/**
 * Whether the phrase names its day one way only, so a rule can read it: at most one weekday, and at most one kind
 * of anchor among a weekday, a written date or ordinal, a count of days, tomorrow, the end of the month and today.
 * Two kinds ("Fri 20th", "by Friday in two weeks", "the Friday before the 20th"), two weekdays ("Monday's meeting by
 * Friday"), a "from" that is not a count from today ("a month from today", "a week from the 12th"), or a weekday
 * picked by its place ("the second Friday") is the model's (review pass 3: each rule read one anchor and dropped the
 * other, beating the model's right date).
 */
export function oneAnchor(p: string): boolean {
  const weekdays = [...p.matchAll(WEEKDAY_WORD)].length;
  const counted = COUNTED.test(p);
  const kinds = [
    weekdays > 0,
    /\b\d{4}-\d{2}-\d{2}\b/.test(p) || MONTH_WORD.test(p) || /\b\d{1,2}(st|nd|rd|th)\b/.test(p),
    counted,
    /\btomorrow\b/.test(p),
    END_OF_MONTH.test(p),
    /\b(today|tonight)\b/.test(p) && !counted,
  ].filter(Boolean).length;
  if (weekdays > 1 || kinds > 1) return false;
  if (/\bfrom\b/.test(p) && !counted) return false;
  return !(weekdays > 0 && /\b(first|second|third|fourth|fifth|last|every|each|other)\b/.test(p));
}

/** Words that move a weekday on ("Friday next week", "the Friday after next", "a week from Friday"): the model's to read. */
const WEEKDAY_MOVED = /\b(next|after|following|week|weeks|from|fortnight)\b/;
/** What a due phrase must hold for the model's date to stand on it: a digit, or a word that names a time. */
const DATE_WORDS = new RegExp(`\\d|\\b(today|tonight|tomorrow|week|weeks|weekend|fortnight|month|months|year|day|days|noon|midnight|eod|${WEEKDAY_NAMES}|${MONTH_NAMES})\\b`);

/** A calendar day as YYYY-MM-DD when it is one (2026-02-30 is not), else null. */
export function realDay(y: number, m: number, d: number): string | null {
  const t = Date.UTC(y, m - 1, d);
  const s = new Date(t).toISOString().slice(0, 10);
  return y >= 1000 && y <= 9999 && s === `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` ? s : null;
}
const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (day: string) => WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];

/** The capture's UTC day, YYYY-MM-DD. */
export const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/**
 * The day a due phrase names, counted from the capture day, or null when the rules can't read it (the model's date
 * is then asked for). Only a phrase that names its day one way (oneAnchor) is read, the most specific reading first:
 * - a date written out: 2026-11-06; "November 6", "March the 5th", "Nov 6th, 2027", "6 November" (with no year, the
 *   next such day on or after the capture day); "the 12th" with nothing after it but punctuation (this month's, else
 *   next month's: "the 3rd week", "the 2nd meeting" are the model's);
 * - "day after tomorrow"; "tomorrow";
 * - "in N days", "within N weeks", "N days from today" (a number up to 366 days, or a word up to ten, "a" one);
 * - "end of (the) month";
 * - a weekday ("by Friday", "this Fri", "EOD Friday"): the next one after the capture day, a week on when it is
 *   the capture's own weekday. A weekday moved on ("next Friday", "Friday next week", "a week from Friday") is left
 *   to the model, its date held to that weekday;
 * - last, "today", "tonight", "end of (the) day", "EOD".
 * "before" is due the day ahead ("before Friday", "before the trip on Friday": Thursday), unless a time of day or an
 * end is named ("before 5pm Friday": Friday; "before the end of the month": its last day); a count before it ("2
 * days before the 20th") is the model's. A phrase that says when something may start ("not before", "not until",
 * "starting", "once", "after" but for "after next" and "after tomorrow") is no due time. Neither is a day before the
 * capture's: the text is telling of the past.
 */
export function resolveDue(phrase: string, captureDay: string): string | null {
  const p = folded(phrase);
  if (NOT_A_DEADLINE.test(p) || COUNTED_BEFORE.test(p) || !oneAnchor(p)) return null;
  const named = namedDay(p, captureDay);
  if (named === null) return null;
  const due = /\bbefore\b/.test(p) && !TIME_OF_DAY.test(p) && !END_OF.test(p) ? plusDays(named, -1) : named;
  return due >= captureDay ? due : null;
}

function namedDay(p: string, today: string): string | null {
  const [cy, cm, cd] = today.split("-").map(Number);
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(p);
  if (iso) return realDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const md = new RegExp(`\\b${MONTH}\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`).exec(p);
  const dm = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4})\\b)?`).exec(p);
  if (md || dm) {
    const [mWord, dText, yText] = md ? [md[1], md[2], md[3]] : [dm![2], dm![1], dm![3]];
    const m = MONTHS.findIndex((name) => name.startsWith(mWord.slice(0, 3))) + 1;
    const d = Number(dText);
    if (yText !== undefined) return realDay(Number(yText), m, d);
    const thisYear = realDay(cy, m, d);
    return thisYear !== null && thisYear >= today ? thisYear : realDay(cy + 1, m, d);
  }
  const ordinal = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b(?!\s*[\p{L}\p{N}])/u.exec(p);
  if (ordinal) {
    const d = Number(ordinal[1]);
    const thisMonth = d >= cd ? realDay(cy, cm, d) : null;
    return thisMonth ?? realDay(cm === 12 ? cy + 1 : cy, cm === 12 ? 1 : cm + 1, d);
  }
  if (/\bday after tomorrow\b/.test(p)) return plusDays(today, 2);
  if (/\btomorrow\b/.test(p)) return plusDays(today, 1);
  const within = COUNTED.exec(p);
  if (within) {
    const [count, unit] = within[1] !== undefined ? [within[1], within[2]] : [within[3], within[4]];
    const n = /^\d+$/.test(count) ? Number(count) : NUMBER_WORDS[count];
    const days = unit === "week" ? 7 * n : n;
    return days >= 1 && days <= 366 ? plusDays(today, days) : null;
  }
  if (END_OF_MONTH.test(p)) return plusDays(realDay(cm === 12 ? cy + 1 : cy, cm === 12 ? 1 : cm + 1, 1)!, -1);
  const [weekday] = p.matchAll(WEEKDAY_WORD);
  if (weekday) {
    if (WEEKDAY_MOVED.test(p)) return null;
    const ahead = (weekdayIndex(weekday[1]) - WEEKDAYS.indexOf(weekdayOf(today)) + 7) % 7 || 7;
    return plusDays(today, ahead);
  }
  if (/\b(today|tonight|eod|cob)\b|\bend of (the )?day\b|\bclose of business\b/.test(p)) return today;
  return null;
}

/**
 * The model's date, when the phrase it stands on names a time at all (a digit, or a word such as "week" or a
 * weekday: a phrase of "by" names none), when it is a real day from the capture day to a year after it, and when it
 * falls on the weekday the phrase names, if it names one (the local 7B gave "next Friday", captured on a Tuesday, as
 * the next Tuesday). Else null.
 */
export function modelDay(raw: unknown, captureDay: string, phrase: string): string | null {
  const p = folded(phrase);
  if (typeof raw !== "string" || !DATE_WORDS.test(p) || NOT_A_DEADLINE.test(p)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  const day = m ? realDay(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  if (day === null || day < captureDay || day > plusDays(captureDay, 366)) return null;
  const named = [...p.matchAll(WEEKDAY_WORD)].map((w) => WEEKDAYS[weekdayIndex(w[1])]);
  return named.length === 0 || named.includes(weekdayOf(day)) ? day : null;
}

// ── The answer ───────────────────────────────────────────────────────────────

/**
 * A model's answer read against the text: each half kept only on a phrase the text holds, the level capped at High,
 * the due day the rules' or, failing them, the model's. An answer that is not an object reads as nothing.
 */
export function readAnswer(answer: unknown, text: string, captureDay: string): Inferred {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return { level: null, due: null };
  const a = answer as Record<string, unknown>;
  let level: Inferred["level"] = null;
  const word = typeof a.level === "string" ? a.level.trim().toLowerCase() : "";
  const levelPhrase = quotedIn(a.level_phrase, text);
  const duePhrase = quotedIn(a.due_phrase, text);
  // The deadline quoted as the level ("I need the slides by Friday" read High): a phrase with no word about how much
  // it matters that names a time, or holds the due phrase or is held by it, says nothing of the level, whether or not
  // a due phrase was quoted. Review pass 2: the local 7B did this on two of four plain deadlines, which made them
  // High, not the due phrase's Medium; pass 3: with no due phrase quoted, the guard had held nothing.
  const deadlineAsLevel = levelPhrase !== null && !LEVEL_CUES.test(folded(levelPhrase)) && (DATE_WORDS.test(folded(levelPhrase))
    || (duePhrase !== null && (folded(levelPhrase).includes(folded(duePhrase)) || folded(duePhrase).includes(folded(levelPhrase)))));
  const negatedHigh = levelPhrase !== null && (LEVEL_WORDS[word] ?? 0) >= 3 && SELF_NEGATED.test(folded(levelPhrase));
  if (Object.hasOwn(LEVEL_WORDS, word) && levelPhrase !== null && !negatedIn(levelPhrase, text) && !deadlineAsLevel && !negatedHigh) {
    level = { value: Math.min(LEVEL_WORDS[word], INFERRED_CEILING) as PriorityLevel, word, phrase: levelPhrase };
    if (citedIn(levelPhrase, text)) level.cited = true;
  }
  let due: Inferred["due"] = null;
  if (duePhrase !== null && !flooredIn(duePhrase, text)) {
    const ruled = resolveDue(duePhrase, captureDay);
    const modelled = ruled === null ? modelDay(a.due_date, captureDay, duePhrase) : null;
    if (ruled !== null) due = { day: ruled, phrase: duePhrase, by: "rule" };
    else if (modelled !== null) due = { day: modelled, phrase: duePhrase, by: "model" };
  }
  return { level, due };
}

/**
 * What a reading states for its writer (SMD-4226, the maintainer's choice after review pass 2): an agent-kind writer's
 * level cited for another item is dropped, since a session summary's "SMD-2627 (Medium)" is a tag; anyone else's is kept,
 * since a person's own "Fix SMD-12 (urgent)" or "Done, urgent: call mom" reads the same to the guard. The `cited` mark is
 * not carried on.
 */
export function forWriter(inf: Inferred | null, kind: string | null): Inferred | null {
  if (inf === null) return null;
  const level = inf.level === null || (inf.level.cited && kind === "agent") ? null : { value: inf.level.value, word: inf.level.word, phrase: inf.level.phrase };
  return { level, due: inf.due };
}

/** The user message: the capture day and its weekday on the first line, then the text. */
export const inferMessage = (text: string, captureDay: string) =>
  `Captured: ${captureDay} (${weekdayOf(captureDay).replace(/^./, (c) => c.toUpperCase())})\n\n${text}`;

/**
 * The text's level and due day, read by the metadata model. Null when the call failed in any way the provider
 * answers (a refusal by the egress gate, an outage, a status, a body that is not JSON, an answer that is not): an
 * inference is never worth failing a capture for, and an empty one states nothing. The runtime's own error (a
 * refused connection) is thrown, as extractMetadata throws it; the capture catches it.
 */
export async function inferPriority(text: string, capturedAt: Date, subject: EgressSubject, cfg: EmbedConfig): Promise<Inferred | null> {
  const day = dayOf(capturedAt);
  let d: { choices?: [{ message?: { content?: string } }] };
  try {
    d = await providerCall(cfg, "/chat/completions", {
      model: cfg.metadataModel,
      response_format: { type: "json_object" },
      temperature: cfg.metadataTemperature,
      ...cfg.metadataReasoning,
      messages: [
        { role: "system", content: INFER_PROMPT },
        { role: "user", content: inferMessage(text, day) },
      ],
    }, subject);
  } catch (e) {
    if (e instanceof ProviderError) {
      console.error(`inferPriority: ${providerDown(e)?.detail ?? e.message}`);
      return null;
    }
    throw e;
  }
  const content = d?.choices?.[0]?.message?.content;
  if (typeof content !== "string") return null;
  try {
    return readAnswer(JSON.parse(content), text, day);
  } catch {
    console.error("inferPriority: model content was not valid JSON");
    return null;
  }
}

/**
 * What a capture states from an inference, or null when it read neither half: the level (Medium for a due phrase
 * alone), the due time as 116 takes a day (its end, SMD-3778), and a reason quoting each phrase. 116 refuses a reason
 * past 1000 characters or holding a control character; each phrase is at most 200 and collapsed.
 */
export function inferredStatement(inf: Inferred | null): { level: PriorityLevel; dueAt?: string; reason: string } | null {
  if (inf === null || (inf.level === null && inf.due === null)) return null;
  const parts = [
    inf.level ? `${inf.level.word} from "${inf.level.phrase}"` : `no level read (medium, the default)`,
    ...(inf.due ? [`due ${inf.due.day} from "${inf.due.phrase}"${inf.due.by === "model" ? " (the model's date)" : ""}`] : []),
  ];
  return {
    level: inf.level?.value ?? DUE_ONLY_LEVEL,
    ...(inf.due ? { dueAt: endOfDay(inf.due.day) } : {}),
    reason: `inferred from the text (v${INFER_PROMPT_VERSION}): ${parts.join("; ")}`.replace(/\p{Cc}/gu, " "),
  };
}
