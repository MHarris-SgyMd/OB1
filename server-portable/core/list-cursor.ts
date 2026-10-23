// list_thoughts' cursor (SMD-2995), on its own: the core makes and reads it,
// and render.ts's structuredContent guard lets one through by the same rule
// that reads it — a sort word, a timestamp's text and a uuid, so no sentence
// can ride it (review pass 1: the guard took any `cursor` for a uuid and
// nulled this one, so a program reading structuredContent stopped at page one).

import { UUID_RE, type ListSort } from "../store.ts";

/**
 * list_thoughts' cursor (SMD-2995): the sort it was made under and the place
 * the page ended, as base64url of `[sort, at, id]` — opaque to a caller, who
 * passes it back as it came. `at` is Postgres's own text of `created_at`, or
 * null for an undated row (store.ts ListPosition).
 */
export function listCursor(sort: ListSort, at: string | null, id: string): string {
  return Buffer.from(JSON.stringify([sort, at, id])).toString("base64url");
}

/**
 * A list_thoughts cursor read back, or null for anything that is not one: the
 * sort a word of the two, the id a uuid, and `at` null or timestamptz's text
 * as Postgres writes it (a date, a clock to the microsecond, an offset, a BC,
 * or ±infinity), held to a shape and a date that exists before it reaches the
 * SQL. One that still makes Postgres's cast fail — a year 0, past its range,
 * an offset past ±15:59:59 — is the store's to refuse (ListCursorRefused in
 * store.ts, review pass 1): the bounds depend on the offset.
 */
export function parseListCursor(raw: string): { sort: ListSort; at: string | null; id: string } | null {
  const text = raw.trim();
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(text)) return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length !== 3) return null;
  const [sort, at, id] = v as unknown[];
  if (sort !== "newest" && sort !== "oldest") return null;
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  if (at === null) return { sort, at: null, id: id.toLowerCase() };
  if (typeof at !== "string") return null;
  if (at === "infinity" || at === "-infinity") return { sort, at, id: id.toLowerCase() };
  const m = /^(\d{4,})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?[+-]\d{2}(?::\d{2}){0,2}( BC)?$/.exec(at);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const day = new Date(Date.UTC(2000, mo - 1, d));
  // The day exists in its month (a leap day checked against a leap year's calendar), the clock is a clock.
  if (mo < 1 || mo > 12 || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || (mo === 2 && d === 29 && !leap(y, Boolean(m[8]))) || h > 23 || mi > 59 || s > 59) return null;
  return { sort, at, id: id.toLowerCase() };
}

/** Whether year `y` (BC when `bc`) is a leap year in Postgres's proleptic Gregorian calendar: 1 BC is year 0. */
const leap = (y: number, bc: boolean) => {
  const n = bc ? 1 - y : y;
  return n % 4 === 0 && (n % 100 !== 0 || n % 400 === 0);
};

