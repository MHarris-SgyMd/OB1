/**
 * priority-infer.ts — the priority and due time a captured text states in its
 * own words (SMD-3670): "Urgent: the landlord wants an answer by Friday" says
 * a level and a deadline that no field carries. One chat call over the text,
 * its own prompt beside the tags' (METADATA_PROMPT stays as it is), opt-in per
 * brain (OB1_INFER_PRIORITY) and through the egress gate's chat decision, as
 * the tags' call is.
 *
 * What the answer is held to, so a model's guess never passes for the text's:
 * - A level or a due time stands only on a phrase the text holds (compared
 *   case-folded, white space collapsed). A phrase the model made up drops its
 *   half of the answer.
 * - An inferred level is at most High (3): "urgent" costs nothing to write in
 *   a note, and the maintainer's own example reads "Urgent: …" as High.
 * - A due phrase is resolved by the rules below from the capture's UTC day
 *   ("by Friday" captured on Tuesday 2026-11-03 is 2026-11-06). Only a phrase
 *   the rules can't read takes the model's date, and only a real day from the
 *   capture's to a year after it.
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

/** The phrase, trimmed, when the text holds it and it is 1 to 200 characters; else null. */
export function quotedIn(phrase: unknown, text: string): string | null {
  if (typeof phrase !== "string") return null;
  const p = phrase.replace(/\s+/gu, " ").trim();
  if (p === "" || p.length > 200) return null;
  return folded(text).includes(folded(p)) ? p : null;
}

// ── Due days ─────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const NUMBER_WORDS: Readonly<Record<string, number>> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** A calendar day as YYYY-MM-DD when it is one (2026-02-30 is not), else null. */
export function realDay(y: number, m: number, d: number): string | null {
  const t = Date.UTC(y, m - 1, d);
  const s = new Date(t).toISOString().slice(0, 10);
  return y >= 1000 && y <= 9999 && s === `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` ? s : null;
}
const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The capture's UTC day, YYYY-MM-DD. */
export const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/**
 * The day a due phrase names, counted from the capture day, or null when the rules can't read it (the model's date
 * is then asked for). Read, in this order:
 * - a date written out: 2026-11-06; "November 6", "Nov 6th", "6 November" (the next such day on or after the
 *   capture day);
 * - "today", "tonight", "end of (the) day"; "day after tomorrow"; "tomorrow";
 * - "in N days" or "within N days", "in N weeks" (a number up to 366, or a word up to ten, "a" and "an" one);
 * - "end of (the) month";
 * - a weekday ("by Friday", "on Friday", "this Friday"): the next one after the capture day, a week on when it is
 *   the capture's own weekday. "next Friday" is left to the model: people read it two ways.
 * "before" a day is due the day ahead of it.
 */
export function resolveDue(phrase: string, captureDay: string): string | null {
  const p = folded(phrase);
  const day = namedDay(p, captureDay);
  if (day === null) return null;
  return /\bbefore\b/.test(p) ? plusDays(day, -1) : day;
}

function namedDay(p: string, today: string): string | null {
  const [cy, cm, cd] = today.split("-").map(Number);
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(p);
  if (iso) return realDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const month = `(${MONTHS.map((m) => `${m.slice(0, 3)}${m.length > 3 ? `(?:${m.slice(3)})?` : ""}`).join("|")})\\.?`;
  const md = new RegExp(`\\b${month}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(p);
  const dm = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${month}`).exec(p);
  if (md || dm) {
    const [mWord, dText] = md ? [md[1], md[2]] : [dm![2], dm![1]];
    const m = MONTHS.findIndex((name) => name.startsWith(mWord.slice(0, 3))) + 1;
    const d = Number(dText);
    const thisYear = realDay(cy, m, d);
    if (thisYear !== null && thisYear >= today) return thisYear;
    return realDay(cy + 1, m, d);
  }
  if (/\b(today|tonight)\b|\bend of (the )?day\b/.test(p)) return today;
  if (/\bday after tomorrow\b/.test(p)) return plusDays(today, 2);
  if (/\btomorrow\b/.test(p)) return plusDays(today, 1);
  const within = /\b(?:in|within)\s+(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week)s?\b/.exec(p);
  if (within) {
    const n = /^\d+$/.test(within[1]) ? Number(within[1]) : NUMBER_WORDS[within[1]];
    const days = within[2] === "week" ? 7 * n : n;
    return days >= 1 && days <= 366 ? plusDays(today, days) : null;
  }
  if (/\bend of (the )?month\b/.test(p)) return plusDays(realDay(cm === 12 ? cy + 1 : cy, cm === 12 ? 1 : cm + 1, 1)!, -1);
  const weekday = new RegExp(`\\b(next\\s+)?(${WEEKDAYS.join("|")})\\b`).exec(p);
  if (weekday) {
    if (weekday[1]) return null;
    const ahead = (WEEKDAYS.indexOf(weekday[2]) - new Date(`${today}T00:00:00Z`).getUTCDay() + 7) % 7 || 7;
    return plusDays(today, ahead);
  }
  return null;
}

/**
 * The model's date, when it is a real day from the capture day to a year after it, and on the weekday the phrase
 * names when it names one (the local 7B gave "next Friday", captured on a Tuesday, as the next Tuesday); else null.
 */
export function modelDay(raw: unknown, captureDay: string, phrase = ""): string | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  const day = m ? realDay(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  if (day === null || day < captureDay || day > plusDays(captureDay, 366)) return null;
  const named = WEEKDAYS.filter((w) => new RegExp(`\\b${w}\\b`).test(folded(phrase)));
  return named.length === 0 || named.includes(WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]) ? day : null;
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
  if (Object.hasOwn(LEVEL_WORDS, word) && levelPhrase !== null) {
    level = { value: Math.min(LEVEL_WORDS[word], INFERRED_CEILING) as PriorityLevel, word, phrase: levelPhrase };
  }
  let due: Inferred["due"] = null;
  const duePhrase = quotedIn(a.due_phrase, text);
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
    inf.level ? `${inf.level.word} from "${inf.level.phrase}"` : `no level stated (medium, the default)`,
    ...(inf.due ? [`due ${inf.due.day} from "${inf.due.phrase}"${inf.due.by === "model" ? " (the model's date)" : ""}`] : []),
  ];
  return {
    level: inf.level?.value ?? DUE_ONLY_LEVEL,
    ...(inf.due ? { dueAt: endOfDay(inf.due.day) } : {}),
    reason: `inferred from the text (v${INFER_PROMPT_VERSION}): ${parts.join("; ")}`.replace(/\p{Cc}/gu, " "),
  };
}
