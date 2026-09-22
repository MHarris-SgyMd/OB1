/**
 * fork-index.d.mts — types for fork-index.mjs.
 *
 * fork-index.mjs is plain JavaScript on purpose (see fragments.d.mts): the check
 * and the release step run it under node and bun alike. A TypeScript consumer
 * — db/ingest-records.ts reads a numbered change's heading and tickets through
 * `headingOf` and `ticketsOf` (SMD-1806) — sees `any` without this file, which
 * `tsc --noEmit` over db/ refuses (SMD-1932). Every export is declared, so a
 * TypeScript caller of any of them compiles; db/'s typecheck holds the file to
 * the implementation through the imports it exercises.
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

/** The part of a title the index shows: before the first " — " outside a code span, the ticket tail off. */
export function headOf(title: string): string;

/** Text safe inside a table cell and a link's text: a pipe or a bracket is escaped. */
export function cell(text: string): string;

/** The slug a change file's name carries, from its title (at most 48 characters, never ending on a stop word). */
export function slugOf(title: string): string;

/** The file name a numbered change takes: `NNN-<slug>.md`. */
export function changeFileName(n: number, title: string): string;

/** A directory entry as the readers hand it over; `text` is null for anything that is not a regular file. */
export type ChangeEntry = { name: string; text: string | null };

/** A numbered change file, classified. */
export type NumberedChange = { name: string; n: number; heading: { n: number; title: string } | null; text: string; lines: number };

/** A release fragment, classified. */
export type FragmentChange = { name: string; ticket: string; text: string; lines: number };

/** Numbered files, fragments, and anything else (a stray is a finding). */
export type ClassifiedChanges = { numbered: NumberedChange[]; fragments: FragmentChange[]; other: ChangeEntry[] };

/** Pure over a listing of `{ name, text }`, so the check can hand it an in-memory directory. */
export function classifyChanges(entries: ChangeEntry[]): ClassifiedChanges;

/** Every entry of `<root>/changes/`; a non-regular file has `text: null`. Empty when the directory is absent. */
export function readChangeEntries(root: string): ChangeEntry[];

/** `classifyChanges(readChangeEntries(root))`. */
export function readChanges(root: string): ClassifiedChanges;

/** The index block FORK.md carries between the markers, markers excluded; ends in a newline. */
export function renderIndex(changes: { numbered: NumberedChange[]; fragments: FragmentChange[] }): string;

/** Offsets just after START and at END; throws when FORK.md does not carry exactly one pair in order. */
export function indexSpan(forkText: string): { s: number; e: number };

/** FORK.md with the block between the markers replaced. */
export function spliceIndex(forkText: string, block: string): string;
