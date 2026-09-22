/**
 * fragments.d.mts — types for fragments.mjs.
 *
 * fragments.mjs is plain JavaScript on purpose: check-fork-consistency.mjs and
 * assemble-release.mjs run it under node and bun alike with no build step. A
 * TypeScript consumer — db/ingest-records.ts reads fragments into the stable
 * tier (SMD-1806) — sees `any` without this file, which `tsc --noEmit` refuses
 * under `noImplicitAny` now that db/ is type-checked (SMD-1932). Declares what
 * the module exports; checked against the implementation by db/'s typecheck.
 */

/** Front matter as parsed: a scalar per key, or a list for `[a, b]` / `- item` forms. */
export type FragmentFrontMatter = Record<string, string | string[]>;

/** Split `---` front matter and the body of a fragment; null if no front matter. */
export function parseFragment(text: string): { fm: FragmentFrontMatter; body: string } | null;

/**
 * A `## <name>` body from a fragment: null when the heading is absent, "" when
 * it is there and empty. `## FORK` runs to the end of the file.
 */
export function fragmentSection(body: string, name: string): string | null;

/** Keep a Changelog's six types; the three bumps. */
export const FRAGMENT_TYPES: Set<string>;
export const BUMPS: Set<string>;

/** Every rule a fragment breaks, in words; empty when it is well-formed (check 16). */
export function fragmentProblems(text: string, name?: string): string[];
