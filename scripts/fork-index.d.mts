/**
 * fork-index.d.mts — types for fork-index.mjs.
 *
 * fork-index.mjs is plain JavaScript on purpose (see fragments.d.mts). This
 * declares the string-level exports a TypeScript consumer reaches for —
 * db/ingest-records.ts reads a numbered change's heading and tickets through
 * `headingOf` and `ticketsOf` (SMD-1806) — so `tsc --noEmit` over db/ does not
 * see `any` (SMD-1932). The directory readers and the index renderer are not
 * declared here; a TypeScript caller of one adds its declaration beside these,
 * and db/'s typecheck holds the file to the implementation.
 */

/** The directory the change files live in, relative to the repository root. */
export const CHANGES_DIR: string;
/** The first change number that is a file (1–17 are FORK.md's table). */
export const FIRST_FILED: number;
/** The two marker comments the generated index sits between in FORK.md. */
export const START: string;
export const END: string;
/** File-name and heading shapes: `NNN-<slug>.md`, `smd-NNNN.md`, `# N. Title`. */
export const NUMBERED: RegExp;
export const FRAGMENT: RegExp;
export const H1: RegExp;

/** `{ n, title }` from a change file's first line, or null when it is not `# N. Title`. */
export function headingOf(text: string): { n: number; title: string } | null;

/** The ticket(s) a title ends with — `(SMD-1843)`, `(SMD-1301 / 1302)` — as text, or "". */
export function ticketOf(title: string): string;

/** The tickets a title ends with, as ids — ["SMD-1301", "SMD-1302"]; [] for none. */
export function ticketsOf(title: string): string[];

/** Three digits: 18 → "018". */
export const pad3: (n: number) => string;
