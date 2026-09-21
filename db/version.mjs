/**
 * version.mjs — the fork's version, and the release ranges that freeze migrations.
 *
 * SMD-1804. The fork ships continuously from `main`, so until this file nothing
 * named what shipped: a brain's identity was "the highest migration its ledger
 * records" plus whichever server happened to be checked out. The scheme is
 *
 *   MAJOR.MINOR.PATCH+upstream.<sha>
 *
 * the build metadata carrying the upstream pin, so a version says both what the
 * fork is and what it sits on. The rules that pick the bump live in FORK.md's
 * "Versioning" section and are checked, not remembered (check-fork-consistency).
 *
 * This module is node-only on purpose. It reads the filesystem and hashes files,
 * and it is imported by migrate.ts, preflight.ts and check-fork-consistency.mjs —
 * none of which is bundled for Cloudflare Workers. config.mjs IS in that bundle
 * (server-portable/embed.ts imports it), so the sha rule lives here rather than
 * there: a top-level `node:crypto` import would break the Workers build.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** The upstream commit the fork sits on — FORK.md's pin, `upstream-pin-9543c29`. */
export const UPSTREAM_PIN = "9543c29";

/**
 * The current fork version. `0.0.0` is the pre-first-release baseline: the
 * versioning machinery is present but no release has been cut, so a brain reports
 * this rather than a perpetual "no version" warning. The first release replaces
 * it with the number that cut deserves (`1.0.0`), assembled and tagged by the
 * release step, not by hand. Migration 044 writes this exact string into
 * ob1_config.schema_version; check-fork's checkSchemaVersion holds the two equal.
 */
export const FORK_VERSION = `0.0.0+upstream.${UPSTREAM_PIN}`;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASES_PATH = join(ROOT, "releases.json");

/**
 * Hash a migration TEMPLATE (not the substituted SQL) — first 12 hex of sha256,
 * the identity migrate.ts records in schema_migrations and refuses to see change.
 * One definition, shared: the frozen-range check recomputes it to catch an edit
 * to a migration inside a released range, and it must match what the ledger holds.
 */
export function migrationSha(template) {
  return createHash("sha256").update(template).digest("hex").slice(0, 12);
}

/**
 * The committed release manifest — the machine-readable version↔range map the
 * release step appends to. `git tag`/`gh release` name a release for people; this
 * is what CI reads with no network. Absent or empty means no release cut yet.
 *
 * Each entry: { version, range: [lo, hi], server: <sha>, upstream, date,
 * frozenShas: { "NNN": "<sha12>" } } — the shas letting checkFrozenMigrations
 * catch an edit to an in-range migration.
 */
export function readReleases(path = RELEASES_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${path}: expected a JSON array of releases`);
  return parsed;
}

const CORE_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Split a version into its semver parts, discarding build metadata (`+…`). */
function parseVersion(v) {
  const noBuild = String(v).split("+", 1)[0];
  const [core, ...pre] = noBuild.split("-");
  const m = CORE_RE.exec(core);
  if (!m) throw new Error(`not a semantic version: ${v}`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: pre.join("-") };
}

/**
 * Compare two versions by SemVer 2.0.0 precedence, ignoring build metadata.
 * Returns <0, 0 or >0. A pre-release (`1.0.0-rc.1`) precedes its release
 * (`1.0.0`); pre-release identifiers compare field by field, numeric before
 * alphanumeric. Enough for the fork's own numbers, and self-checked below.
 */
export function semverCompare(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (x.major !== y.major) return x.major - y.major;
  if (x.minor !== y.minor) return x.minor - y.minor;
  if (x.patch !== y.patch) return x.patch - y.patch;
  if (x.pre === y.pre) return 0;
  if (x.pre === "") return 1; // no pre-release outranks a pre-release
  if (y.pre === "") return -1;
  const xs = x.pre.split(".");
  const ys = y.pre.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (i === xs.length) return -1; // shorter prefix has lower precedence
    if (i === ys.length) return 1;
    const xi = xs[i];
    const yi = ys[i];
    const xn = /^\d+$/.test(xi);
    const yn = /^\d+$/.test(yi);
    if (xn && yn) {
      const d = +xi - +yi;
      if (d !== 0) return d;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers rank below alphanumeric
    } else if (xi !== yi) {
      return xi < yi ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The version of the release whose migration range covers this migration number,
 * or null when the number is past the last released range (i.e. Unreleased).
 * migrate.ts --dry-run names it per pending migration; preflight uses the last
 * range's upper bound to warn when a brain has run past its version.
 */
export function versionForMigration(n, releases = readReleases()) {
  const num = Number(n);
  for (const r of releases) {
    if (!r.range) continue; // a docs/server-only release closed no migration range
    const [lo, hi] = r.range;
    if (num >= lo && num <= hi) return r.version;
  }
  return null;
}

/** The last released range's upper bound, or 0 when nothing is released. */
export function highestReleasedMigration(releases = readReleases()) {
  let hi = 0;
  for (const r of releases) if (r.range && r.range[1] > hi) hi = r.range[1];
  return hi;
}

function selfCheck() {
  const eq = (got, want, label) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g !== w) {
      console.error(`FAIL ${label}: got ${g}, want ${w}`);
      return 1;
    }
    return 0;
  };
  const sign = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0);
  let bad = 0;
  bad += eq(sign(semverCompare("1.0.0", "1.0.0")), 0, "1.0.0 == 1.0.0");
  bad += eq(sign(semverCompare("1.2.0", "1.10.0")), -1, "minor is numeric, not lexical");
  bad += eq(sign(semverCompare("2.0.0", "1.9.9")), 1, "major dominates");
  bad += eq(sign(semverCompare("1.0.0+upstream.9543c29", "1.0.0+upstream.deadbee")), 0, "build metadata ignored");
  bad += eq(sign(semverCompare("1.0.0-rc.1", "1.0.0")), -1, "pre-release precedes release");
  bad += eq(sign(semverCompare("1.0.0-rc.2", "1.0.0-rc.10")), -1, "numeric pre-release fields");
  bad += eq(sign(semverCompare("0.0.0", FORK_VERSION)), 0, "FORK_VERSION core is 0.0.0");
  const rel = [{ version: "1.0.0", range: [1, 44] }];
  bad += eq(versionForMigration(44, rel), "1.0.0", "44 is in 1.0.0's range");
  bad += eq(versionForMigration(45, rel), null, "45 is unreleased");
  bad += eq(versionForMigration(20, []), null, "nothing released → null");
  bad += eq(highestReleasedMigration(rel), 44, "highest released is 44");
  const withDocsOnly = [{ version: "1.0.0", range: [1, 44] }, { version: "1.0.1", range: null }];
  bad += eq(versionForMigration(44, withDocsOnly), "1.0.0", "a docs-only release (range null) is skipped, not crashed");
  bad += eq(highestReleasedMigration(withDocsOnly), 44, "a docs-only release does not lower the high-water mark");
  bad += eq(migrationSha("SELECT 1;\n"), migrationSha("SELECT 1;\n"), "sha is deterministic");
  if (migrationSha("a").length !== 12) {
    console.error("FAIL sha length is not 12");
    bad++;
  }
  if (bad === 0) console.log("version.mjs self-check PASS");
  return bad === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(selfCheck());
