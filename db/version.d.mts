/**
 * version.d.mts — types for version.mjs.
 *
 * version.mjs is plain JavaScript for the same reason config.mjs is: it is
 * imported by migrate.ts, preflight.ts and check-fork-consistency.mjs with no
 * build step between them. A TypeScript consumer would see `any`, which
 * `tsc --noEmit` rejects under `noImplicitAny`; this file is the missing half,
 * checked against the implementation by CI's typecheck so the two cannot drift.
 */

/** One committed release: a version, the migration range it closed, and its shas. */
export interface Release {
  version: string;
  range: [number, number] | null;
  server: string;
  upstream: string;
  date: string;
  tickets?: string[];
  /** Absent for a docs/server-only cut that closed no migration range. */
  frozenShas?: Record<string, string>;
}

/** The upstream commit the fork sits on — FORK.md's pin. */
export const UPSTREAM_PIN: string;

/** The current fork version, `MAJOR.MINOR.PATCH+upstream.<sha>`. */
export const FORK_VERSION: string;

/** First 12 hex of sha256 over a migration template — the ledger's identity. */
export function migrationSha(template: string): string;

/** The committed release manifest; absent or empty means nothing released yet. */
export function readReleases(path?: string): Release[];

/** SemVer 2.0.0 precedence, ignoring build metadata; returns <0, 0 or >0. */
export function semverCompare(a: string, b: string): number;

/** The version whose range covers this migration number, or null (Unreleased). */
export function versionForMigration(n: number | string, releases?: Release[]): string | null;

/** The last released range's upper bound, or 0 when nothing is released. */
export function highestReleasedMigration(releases?: Release[]): number;
