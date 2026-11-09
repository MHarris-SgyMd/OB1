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
 *   own cue ("no rush"), and a level phrase that is only the deadline's words.
 * - An inferred level is at most High (3): "urgent" costs nothing to write in
 *   a note, and the maintainer's own example reads "Urgent: …" as High.
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
export const INFER_PROMPT_VERSION = 1;
export const INFER_PROMPT = `Read the user's captured note for how much it matters and when it is due. The first line gives the day it was captured. Return JSON with:
- "level": one of "none", "low", "medium", "high", "urgent", or null when the note says nothing about how much it matters
- "level_phrase": the exact words of the note that show that level, or null
- "due_phrase": the exact words of the note that set a deadline, such as "by Friday" or "before the 12th", or null when it sets none
- "due_date": that deadline as YYYY-MM-DD, counted from the capture day, or null
Copy phrases exactly as the note writes them. Only read what the note says.`;

/** The highest level an inferred statement takes: High. */
export const INFERRED_CEILING: PriorityLevel = 3;
/** The level a due phrase with no level phrase is stated at: 116 takes no statement without a level, and Medium is what unknown counts as (decision 3). */
export const DUE_ONLY_LEVEL: PriorityLevel = 2;

/** The model's level words, and the level each is on the scale before the ceiling. */
const LEVEL_WORDS: Readonly<Record<string, PriorityLevel>> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4, critical: 5 };

/** What a text was read to state: a level and a due day, each with the phrase that says it. Null halves were not read. */
export type Inferred = {
  level: { value: PriorityLevel; word: string; phrase: string } | null;
  due: { day: string; phrase: string; by: "rule" | "model" } | null;
};

// ── Phrases ──────────────────────────────────────────────────────────────────

/** A text as a phrase is looked for in it: case-folded, curly quotes made straight, white space collapsed. */
const folded = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/gu, " ").trim();

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
/** The words a phrase about how much something matters carries. A level phrase with none of them that is the deadline's own words says nothing of the level. */
const LEVEL_CUES = /\b(urgent|urgently|urgency|asap|important|importance|unimportant|critical|crucial|priority|emergency|immediately|pressing|vital|essential|rush|hurry|whenever|someday|trivial|minor|optional|idea|low|medium|high|top)\b/;
/** A phrase that negates its own cue ("not urgent", "no rush", "non-critical"), not across an emphasis word: it never says a level of High or more. */
const SELF_NEGATED = new RegExp(`\\b(${NEGATORS}|non)\\b-?(\\s*(?!(?:${EMPHASIS})\\b)[\\p{L}']+){0,2}?\\s*\\b(urgent|urgently|important|critical|crucial|priority|pressing|vital|essential|rush|hurry|emergency)\\b`, "u");

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
/**
 * A weekday's name, or an abbreviation that is no ordinary word ("Tue", "Tues", "Thu", "Thurs", "Fri"; not "sun",
 * "sat", "wed" or "mon": "before the sun goes down" names no day); its day read from its first three letters.
 */
const WEEKDAY_NAMES = "sunday|monday|tue(?:s(?:day)?)?|wednesday|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|saturday";
const WEEKDAY = `(${WEEKDAY_NAMES})`;
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
  const weekdays = [...p.matchAll(new RegExp(`\\b${WEEKDAY}\\b`, "g"))].length;
  const counted = COUNTED.test(p);
  const kinds = [
    weekdays > 0,
    /\b\d{4}-\d{2}-\d{2}\b/.test(p) || new RegExp(`\\b${MONTH}`).test(p) || /\b\d{1,2}(st|nd|rd|th)\b/.test(p),
    counted,
    /\btomorrow\b/.test(p),
    /\bend of (the )?month\b/.test(p),
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
  if (/\bend of (the )?month\b/.test(p)) return plusDays(realDay(cm === 12 ? cy + 1 : cy, cm === 12 ? 1 : cm + 1, 1)!, -1);
  const weekday = new RegExp(`\\b${WEEKDAY}\\b`).exec(p);
  if (weekday) {
    if (WEEKDAY_MOVED.test(p)) return null;
    const ahead = (weekdayIndex(weekday[1]) - new Date(`${today}T00:00:00Z`).getUTCDay() + 7) % 7 || 7;
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
  if (typeof raw !== "string" || !DATE_WORDS.test(folded(phrase)) || NOT_A_DEADLINE.test(folded(phrase))) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  const day = m ? realDay(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  if (day === null || day < captureDay || day > plusDays(captureDay, 366)) return null;
  const named = [...folded(phrase).matchAll(new RegExp(`\\b${WEEKDAY}\\b`, "g"))].map((w) => WEEKDAYS[weekdayIndex(w[1])]);
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
  // it matters, naming a time or holding the due phrase or held by it, says nothing of the level (review pass 2: the local 7B did this
  // on two of four plain deadlines, which made them High, not the due phrase's Medium).
  // Review pass 3: also with no due phrase quoted, or one quoted otherwise: a level phrase with no such word that names
  // a time is a deadline's.
  const deadlineAsLevel = levelPhrase !== null && !LEVEL_CUES.test(folded(levelPhrase)) && (DATE_WORDS.test(folded(levelPhrase))
    || (duePhrase !== null && (folded(levelPhrase).includes(folded(duePhrase)) || folded(duePhrase).includes(folded(levelPhrase)))));
  const negatedHigh = levelPhrase !== null && (LEVEL_WORDS[word] ?? 0) >= 3 && SELF_NEGATED.test(folded(levelPhrase));
  if (Object.hasOwn(LEVEL_WORDS, word) && levelPhrase !== null && !negatedIn(levelPhrase, text) && !deadlineAsLevel && !negatedHigh) {
    level = { value: Math.min(LEVEL_WORDS[word], INFERRED_CEILING) as PriorityLevel, word, phrase: levelPhrase };
  }
  let due: Inferred["due"] = null;
  if (duePhrase !== null) {
    const ruled = resolveDue(duePhrase, captureDay);
    const modelled = ruled === null ? modelDay(a.due_date, captureDay, duePhrase) : null;
    if (ruled !== null) due = { day: ruled, phrase: duePhrase, by: "rule" };
    else if (modelled !== null) due = { day: modelled, phrase: duePhrase, by: "model" };
  }
  return { level, due };
}

/** The user message: the capture day and its weekday on the first line, then the text. */
export const inferMessage = (text: string, captureDay: string) =>
  `Captured: ${captureDay} (${WEEKDAYS[new Date(`${captureDay}T00:00:00Z`).getUTCDay()].replace(/^./, (c) => c.toUpperCase())})\n\n${text}`;

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
