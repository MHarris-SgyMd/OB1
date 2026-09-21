#!/usr/bin/env bun
/**
 * assemble-release.mjs — cut a release from the changes/ fragments (SMD-1804).
 *
 * The fork's change counter used to be assigned by hand at PR time, so a merge of
 * `main` while a PR was in review renumbered a FORK.md section and its
 * cross-references. This is the other half of the fix: a PR ships a fragment
 * (changes/smd-NNNN.md) citing ticket and migration numbers, and the release step
 * assembles the accumulated fragments in merge order — assigning the change
 * numbers and the release version once, at assembly, with nothing able to land
 * between assembly and tag. Since SMD-1917 a numbered change is a file,
 * changes/NNN-<slug>.md, not a FORK.md section: the step writes each fragment as
 * the next numbered file, removes the fragment, and re-renders FORK.md's index
 * with scripts/fork-index.mjs.
 *
 *   bun scripts/assemble-release.mjs              # DRY RUN: print the plan, touch nothing
 *   bun scripts/assemble-release.mjs --write      # write changes/NNN-*.md, FORK.md's index, CHANGELOG.md, releases.json
 *   bun scripts/assemble-release.mjs --self-check  # exercise the pure functions
 *
 * The pieces this computes — the next version, the change numbering, the section
 * and changelog rendering, the frozen shas over the new migration range — are pure
 * functions, self-checked below. --write is the glue that applies them; it is what
 * SMD-1805's release job invokes, and is never run in CI's checks.
 *
 * Not this script's job: creating the git tag or the GitHub release, or publishing
 * images. Those are the release job's (SMD-1805) and are gated on approval.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FORK_VERSION, UPSTREAM_PIN, migrationSha, readReleases, highestReleasedMigration } from "../db/version.mjs";
import { parseFragment, fragmentSection } from "./fragments.mjs";
import { CHANGES_DIR as CHANGES_REL, changeFileName, readChanges, renderIndex, spliceIndex } from "./fork-index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGES_DIR = join(ROOT, "changes");
const MIGRATIONS_DIR = join(ROOT, "db", "migrations");
const BUMP_RANK = { patch: 0, minor: 1, major: 2 };
const TYPE_HEADING = { added: "Added", changed: "Changed", deprecated: "Deprecated", removed: "Removed", fixed: "Fixed", security: "Security" };
const REPO = "https://github.com/MHarris-SgyMd/OB1";
const pad3 = (n) => String(n).padStart(3, "0");

// ── Pure functions (self-checked) ────────────────────────────────────────────

/** Bump a version by kind, keeping the +upstream build metadata. */
export function bumpVersion(version, kind) {
  const [core] = String(version).split("+");
  const [maj, min, pat] = core.split("-")[0].split(".").map(Number);
  const next = kind === "major" ? [maj + 1, 0, 0] : kind === "minor" ? [maj, min + 1, 0] : [maj, min, pat + 1];
  return `${next.join(".")}+upstream.${UPSTREAM_PIN}`;
}

/**
 * The version the cut deserves. The first release (nothing released yet) is
 * 1.0.0 — SemVer's "the public API is now defined" — whatever the fragments'
 * bumps; after that, the previous version bumped by the strongest bump present.
 */
export function nextVersion(releases, bumps) {
  const strongest = bumps.reduce((a, b) => (BUMP_RANK[b] > BUMP_RANK[a] ? b : a), "patch");
  if (releases.length === 0) return `1.0.0+upstream.${UPSTREAM_PIN}`;
  return bumpVersion(releases[releases.length - 1].version, strongest);
}

/** The highest numbered change file today (0 when there is none). */
export function highestChangeNumber(numbered) {
  return numbered.length ? numbered[numbered.length - 1].n : 0;
}

/**
 * Render a fragment's FORK body as a numbered change file: the file's name from
 * the number and the title (its first line), `# N. <title>`, then the body.
 */
export function renderChangeFile(number, forkBody) {
  const lines = forkBody.trim().split("\n");
  const title = lines[0].trim();
  const rest = lines.slice(1).join("\n").trim();
  return { name: changeFileName(number, title), title, text: `# ${number}. ${title}` + (rest ? `\n\n${rest}` : "") + "\n" };
}

/** Render the CHANGELOG version section: entries grouped under the six headings. */
export function renderChangelogSection(version, date, fragments) {
  const core = version.split("+")[0];
  const byHeading = new Map();
  for (const f of fragments) {
    const heading = TYPE_HEADING[f.fm.type];
    if (!byHeading.has(heading)) byHeading.set(heading, []);
    byHeading.get(heading).push(fragmentSection(f.body, "Changelog").trim());
  }
  let out = `## [${core}] - ${date}\n`;
  for (const heading of Object.values(TYPE_HEADING)) {
    if (!byHeading.has(heading)) continue;
    out += `\n### ${heading}\n`;
    for (const entry of byHeading.get(heading)) out += `- ${entry.replace(/\n+/g, " ")}\n`;
  }
  return out;
}

/**
 * Insert a rendered version section under `## [Unreleased]` (newest first) and add
 * its compare link beside the Unreleased one. Throws if there is no Unreleased
 * section to insert under.
 */
export function insertChangelogSection(clText, sectionText, core, compareUrl) {
  const withSection = clText.replace(/(## \[Unreleased\]\n)([\s\S]*?)(?=\n## \[|\n\[Unreleased\]:)/, `$1\n${sectionText}`);
  if (withSection === clText) throw new Error("CHANGELOG.md has no ## [Unreleased] section to insert under");
  return withSection.replace(/(\[Unreleased\]:.*\n)/, `$1[${core}]: ${compareUrl}\n`);
}

/** The frozen shas for a migration range, computed from the templates on disk. */
export function frozenShasForRange(lo, hi, readMig) {
  const shas = {};
  for (let n = lo; n <= hi; n++) {
    const tpl = readMig(n);
    if (tpl === null) throw new Error(`no migration file for ${pad3(n)} in the release range ${pad3(lo)}..${pad3(hi)}`);
    shas[pad3(n)] = migrationSha(tpl);
  }
  return shas;
}

// ── I/O and the plan ─────────────────────────────────────────────────────────

/** Fragment files, in merge order: git add-time, then ticket number as a tiebreak. */
function fragmentFiles() {
  if (!existsSync(CHANGES_DIR)) return [];
  const names = readdirSync(CHANGES_DIR).filter((n) => /^smd-\d+\.md$/i.test(n));
  const addedAt = (name) => {
    try {
      const out = execFileSync("git", ["log", "--diff-filter=A", "--format=%ct", "--", `changes/${name}`], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").pop();
      return out ? Number(out) : Number.MAX_SAFE_INTEGER; // unstaged fragment sorts last
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  };
  const ticketNum = (name) => Number(/\d+/.exec(name)[0]);
  return names.sort((a, b) => (addedAt(a) - addedAt(b)) || (ticketNum(a) - ticketNum(b)));
}

function readMig(n) {
  const f = readdirSync(MIGRATIONS_DIR).find((name) => name.startsWith(pad3(n) + "_"));
  return f ? readFileSync(join(MIGRATIONS_DIR, f), "utf8") : null;
}

function buildPlan() {
  const releases = readReleases();
  const files = fragmentFiles();
  if (files.length === 0) throw new Error("no changes/*.md fragments to assemble");
  const fragments = files.map((name) => {
    const parsed = parseFragment(readFileSync(join(CHANGES_DIR, name), "utf8"));
    if (!parsed) throw new Error(`${name}: no front matter (run check-fork-consistency)`);
    return { name, ...parsed };
  });
  const version = nextVersion(releases, fragments.map((f) => f.fm.bump));
  let n = highestChangeNumber(readChanges(ROOT).numbered);
  const numbered = fragments.map((f) => ({ number: ++n, ...f, file: renderChangeFile(n, fragmentSection(f.body, "FORK")) }));

  const migNums = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => Number(f.slice(0, 3)));
  const lo = highestReleasedMigration(releases) + 1;
  const hi = Math.max(...migNums);
  const range = hi >= lo ? [lo, hi] : null; // a docs/server-only cut closes no migration
  const tickets = [...new Set(fragments.flatMap((f) => f.fm.tickets))];

  return { releases, fragments: numbered, version, range, tickets };
}

function printPlan(plan) {
  const core = plan.version.split("+")[0];
  console.log(`Release: ${plan.version}`);
  console.log(`Migration range: ${plan.range ? `${pad3(plan.range[0])}..${pad3(plan.range[1])}` : "none (no schema change)"}`);
  console.log(`Tickets: ${plan.tickets.join(", ")}`);
  console.log(`\nChange files to write (and the fragment each replaces):`);
  for (const f of plan.fragments) console.log(`  ${CHANGES_REL}/${f.file.name}  <-  ${CHANGES_REL}/${f.name}`);
  console.log(`\nCHANGELOG.md [${core}] section:\n`);
  console.log(renderChangelogSection(plan.version, new Date().toISOString().slice(0, 10), plan.fragments).split("\n").map((l) => "  " + l).join("\n"));
  if (plan.range) {
    const shas = frozenShasForRange(plan.range[0], plan.range[1], readMig);
    console.log(`releases.json entry would freeze ${Object.keys(shas).length} migration(s): ${Object.entries(shas).map(([k, v]) => `${k}:${v}`).join(", ")}`);
  }
  console.log(`\n(dry run — nothing written; pass --write to apply, then tag and release out of band)`);
}

function write(plan) {
  const date = new Date().toISOString().slice(0, 10);
  const core = plan.version.split("+")[0];

  // changes/: each fragment becomes the next numbered file and is removed; then
  // FORK.md's index is re-rendered from the directory (the release author reviews
  // the diff; this is not run in CI).
  for (const f of plan.fragments) {
    writeFileSync(join(CHANGES_DIR, f.file.name), f.file.text);
    unlinkSync(join(CHANGES_DIR, f.name));
  }
  const forkPath = join(ROOT, "FORK.md");
  writeFileSync(forkPath, spliceIndex(readFileSync(forkPath, "utf8"), renderIndex(readChanges(ROOT))));

  // CHANGELOG.md: the version section under Unreleased, with its compare link.
  const cl = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  const section = renderChangelogSection(plan.version, date, plan.fragments);
  const compare = plan.releases.length ? `${REPO}/compare/v${plan.releases[plan.releases.length - 1].version.split("+")[0]}...v${core}` : `${REPO}/compare/upstream-pin-${UPSTREAM_PIN}...v${core}`;
  writeFileSync(join(ROOT, "CHANGELOG.md"), insertChangelogSection(cl, section, core, compare));

  // releases.json: append this cut.
  const entry = { version: plan.version, range: plan.range, server: gitHead(), upstream: UPSTREAM_PIN, date, tickets: plan.tickets };
  if (plan.range) entry.frozenShas = frozenShasForRange(plan.range[0], plan.range[1], readMig);
  writeFileSync(join(ROOT, "releases.json"), JSON.stringify([...plan.releases, entry], null, 2) + "\n");

  console.log(`Wrote ${plan.fragments.length} change file(s), FORK.md's index, CHANGELOG.md and releases.json for ${plan.version}.`);
  console.log(`Next, out of band, in this same commit: bump db/version.mjs's FORK_VERSION to '${plan.version}' and emit a NNN_set_schema_version.sql upserting it as the range's last migration (check-fork holds the two equal, so both move together). Then tag v${core}+upstream.${UPSTREAM_PIN} and create the release.`);
}

function gitHead() {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

function selfCheck() {
  let bad = 0;
  const ok = (cond, label) => { if (!cond) { console.error(`FAIL ${label}`); bad++; } };
  ok(nextVersion([], ["minor"]) === `1.0.0+upstream.${UPSTREAM_PIN}`, "first cut is 1.0.0 whatever the bump");
  ok(nextVersion([{ version: "1.0.0" }], ["patch", "minor"]) === `1.1.0+upstream.${UPSTREAM_PIN}`, "strongest bump wins (minor over patch)");
  ok(nextVersion([{ version: "1.4.2" }], ["major", "minor"]) === `2.0.0+upstream.${UPSTREAM_PIN}`, "a major resets minor and patch");
  ok(bumpVersion("1.2.3+upstream.abc", "patch") === `1.2.4+upstream.${UPSTREAM_PIN}`, "patch increments the patch and re-pins upstream");
  ok(highestChangeNumber([{ n: 18 }, { n: 100 }]) === 100 && highestChangeNumber([]) === 0, "highest change number from the directory");
  const cf = renderChangeFile(101, "A title — a consequence (SMD-1)\n\nBody line.");
  ok(cf.name === "101-a-title.md" && cf.text === "# 101. A title — a consequence (SMD-1)\n\nBody line.\n", "a change file from a fragment body: name from the title's first clause, `# N.` heading, the body");
  ok(renderChangeFile(102, "Only a title (SMD-2)").text === "# 102. Only a title (SMD-2)\n", "a body of one line is a heading alone");
  const frags = [
    { fm: { type: "fixed" }, body: "## Changelog\nfixed a thing (SMD-2)\n" },
    { fm: { type: "added" }, body: "## Changelog\nadded a thing (SMD-1)\n" },
  ];
  const section = renderChangelogSection("1.0.0+upstream.x", "2026-09-30", frags);
  ok(section.includes("## [1.0.0] - 2026-09-30"), "changelog section header (no build metadata)");
  ok(section.indexOf("### Added") < section.indexOf("### Fixed"), "headings in Keep a Changelog order, not fragment order");
  ok(/- added a thing \(SMD-1\)/.test(section), "an entry is a bullet");
  const shas = frozenShasForRange(1, 2, (n) => (n === 1 ? "SELECT 1;\n" : "SELECT 2;\n"));
  ok(shas["001"] === migrationSha("SELECT 1;\n") && shas["002"] === migrationSha("SELECT 2;\n"), "frozen shas over a range");
  let threw = false;
  try { frozenShasForRange(1, 1, () => null); } catch { threw = true; }
  ok(threw, "a missing migration in the range throws");
  // The mutation helper: the changelog section lands under Unreleased with its link.
  const clOut = insertChangelogSection("# Changelog\n\n## [Unreleased]\n\n_placeholder_\n\n[Unreleased]: u\n", "## [1.0.0] - 2026-09-30\n### Added\n- x (SMD-1)\n", "1.0.0", "COMPARE");
  ok(clOut.indexOf("## [Unreleased]") < clOut.indexOf("## [1.0.0] - 2026-09-30") && /\[1\.0\.0\]: COMPARE/.test(clOut) && !/_placeholder_/.test(clOut), "a changelog section lands under Unreleased, with its compare link, replacing the placeholder");
  let clThrew = false;
  try { insertChangelogSection("# Changelog\n\nno unreleased\n", "x", "1.0.0", "u"); } catch { clThrew = true; }
  ok(clThrew, "insertChangelogSection throws when there is no Unreleased section");
  if (bad === 0) console.log("assemble-release.mjs self-check PASS");
  return bad === 0 ? 0 : 1;
}

// ── Entry ────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--self-check")) process.exit(selfCheck());
  const plan = buildPlan();
  if (args.includes("--write")) write(plan);
  else printPlan(plan);
}
