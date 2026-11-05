// The brain's one priority scale and each source's mapping onto it (SMD-3666):
// docs/priority.md's decision 3 and its "The scale's mapping" table, in one
// place, read by the ingestion pipeline (db/ingest-records.ts), board-sync
// (db/sync-linear.ts) and, through the plugin SDK, the plugins. A source added
// later states its mapping and its default here, with a test row each.
//
// Six points, 0 none to 5 critical, and unknown (null): no statement counts
// for the item, which is not low. A source's default is not a statement — a
// mapped value equal to the source's default, where the source cannot tell a
// choice from a default, is unknown. Upstream's `importance` has no row: it is
// retired (decision 8).

/** A level on the scale: 0 none, 1 low, 2 medium, 3 high, 4 urgent, 5 critical. */
export type PriorityLevel = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * The sources whose own value maps onto the scale, each by its table row: Linear's `priorityLabel`, a markdown
 * note's frontmatter `priority:`, GitHub-style labels (P0 to P3), and home-maintenance's `priority` column.
 */
export const PRIORITY_SCALES = ["linear", "frontmatter", "github", "home-maintenance"] as const;
export type PriorityScale = (typeof PRIORITY_SCALES)[number];

/** Each source's words, exactly as the source writes them, and the level each maps to; any other word is unknown. */
const MAPPINGS: Record<PriorityScale, Readonly<Record<string, PriorityLevel>>> = {
  // Linear's "No priority" is unknown, not low, and Linear has no critical.
  linear: { Low: 1, Medium: 2, High: 3, Urgent: 4 },
  // Any case and white space around it, as a person types a note; any other value is kept raw in the item, unknown here.
  frontmatter: { none: 0, low: 1, medium: 2, high: 3, urgent: 4, critical: 5 },
  github: { P3: 1, P2: 2, P1: 3, P0: 5 },
  // The column's default, medium, is unknown unless the plugin records that someone chose it (`chosen`).
  "home-maintenance": { low: 1, medium: 2, high: 3, urgent: 4 },
};

/** A source's default, where it cannot tell a choice from a default: that word is unknown unless the source says it was chosen. */
const DEFAULTS: Partial<Record<PriorityScale, string>> = { "home-maintenance": "medium" };

/**
 * The level a source's own value maps to, or null for unknown: no value, a word the source's row does not hold, or
 * the source's default not marked `chosen`. Frontmatter is read in any case with white space trimmed, as a person
 * types it; the other sources' words are machine-written and read exactly.
 */
export function levelOf(scale: PriorityScale, value: string | null | undefined, opts: { chosen?: boolean } = {}): PriorityLevel | null {
  if (typeof value !== "string") return null;
  const word = scale === "frontmatter" ? value.trim().toLowerCase() : value;
  if (DEFAULTS[scale] === word && opts.chosen !== true) return null;
  return Object.hasOwn(MAPPINGS[scale], word) ? MAPPINGS[scale][word] : null;
}

/** Each scale's name as a reason says it. */
const SCALE_NAMES: Record<PriorityScale, string> = { linear: "Linear", frontmatter: "frontmatter", github: "GitHub label", "home-maintenance": "home-maintenance" };

/** The reason a mapped statement carries: the source and its own word, so a read says where the level came from ("Linear priority: High"). */
// 116 refuses a reason holding a control character: each is a space here, white space collapsed.
export const reasonOf = (scale: PriorityScale, value: string) => `${SCALE_NAMES[scale]} priority: ${value.replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 200)}`;

/** Whether a string names one of the scales. */
export const isPriorityScale = (s: unknown): s is PriorityScale => typeof s === "string" && (PRIORITY_SCALES as readonly string[]).includes(s);

/**
 * A due time as 116 takes it, or null: a date alone is the start of that day in UTC, so `2027-03-01` means one
 * instant whatever the database's time zone; a time with its offset is that instant. Anything else — a time with no
 * offset, which the database would read in its own zone, or text that is no time — is null.
 */
export function dueInstant(t: string | null | undefined): string | null {
  if (typeof t !== "string") return null;
  const s = t.trim();
  const m = /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(s);
  // A calendar day that is one (2026-02-30 is not): the day read back from its own midnight in UTC.
  if (!m || Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`)) || new Date(`${m[1]}T00:00:00Z`).toISOString().slice(0, 10) !== m[1]) return null;
  if (m[2] === undefined) return `${m[1]}T00:00:00Z`;
  return Number.isNaN(Date.parse(s)) ? null : s;
}
