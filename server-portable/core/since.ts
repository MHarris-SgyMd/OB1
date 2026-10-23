// A `since` as the brain's reads take it (SMD-1296; SMD-2280 PR 2b): a module of its own that imports no package, so
// a db/ script — db/tier.ts's --since — reads a start by the brain's rule without reaching zod through core/reads.ts
// (test-server holds every db/ and evals/ file that imports server-portable/ to no package).

import { UUID_RE } from "../store.ts";

/**
 * thought_changes's `since` (SMD-1296): a uuid is a cursor — the audit row a
 * previous page ended with — and anything else must read as an ISO-8601 time
 * (a date at least, so a bare number is not a year), normalised so the reply
 * echoes one spelling. Neither is a refusal, before any call; `value` is the
 * trimmed text refused.
 */
export function parseSince(raw: string | undefined): { since: string | null; after: string | null } | { refused: string } {
  const v = (raw ?? "").trim();
  if (v === "") return { since: null, after: null };
  if (UUID_RE.test(v)) return { since: null, after: v.toLowerCase() };
  const refused = { refused: v };
  // A date, or a date with a clock that names its zone — a clock with no Z or
  // offset would be read in the server's zone (13:00Z for 08:00 on a Chicago
  // laptop, 08:00Z in the container). Any ISO-8601 fraction (Python's
  // isoformat gives six digits) and an hour-only offset (psql prints `+00`)
  // are normalised to what Date parses: a T, three fraction digits, a colon in
  // the offset — completed only when the shape has one, since a bare date's
  // own `-01` is a day, not a zone.
  const shape = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}(?::?\d{2})?))?$/i.exec(v);
  if (!shape) return refused;
  // Upper-cased: the shape is matched case-blind, and a lowercase t or z is
  // ISO-8601 to JSC (Bun) but not to every Date parser the server runs on.
  let iso = v.toUpperCase().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  if (shape[2] && !/^z$/i.test(shape[2])) iso = iso.replace(/([+-]\d{2})(\d{2})$/, "$1:$2").replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(iso);
  // The date part round-trips on its own, whatever the clock or zone beside it
  // (2026-02-30 would otherwise slide to March, at any hour), and the year
  // stays where timestamptz has room: a late time with an offset rolls past
  // 9999, an early one below 1, and either would come back as Postgres's raw
  // error (review passes 1–3).
  const day = new Date(`${shape[1]}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== shape[1]) return refused;
  if (d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999) return refused;
  return { since: d.toISOString(), after: null };
}
