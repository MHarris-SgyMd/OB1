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
 * with scripts/fork-index.mjs. Everything a cut can refuse — a directory that is
 * not contiguous or holds a stray, a fragment with no FORK body or a migration
 * outside the range, a FORK.md or CHANGELOG.md it cannot write into — is refused
 * in the plan, before --write touches a file.
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
import { CHANGES_DIR as CHANGES_REL, FIRST_FILED, changeFileName, classifyChanges, readChangeEntries, renderIndex, spliceIndex } from "./fork-index.mjs";

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
  return numbered[numbered.length - 1].n; // buildPlan refuses an empty directory before asking
}

/**
 * Render a fragment's FORK body as a numbered change file: the file's name from
 * the number and the title (its first line), `# N. <title>`, then the body.
 */
export function renderChangeFile(number, forkBody) {
  const lines = forkBody.trim().split("\n");
  const title = lines[0].replace(/^#+\s*/, "").trim(); // check 16 refuses a heading here; the writer strips one anyway
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

/**
 * The fragments, in merge order: git add-time, then ticket number as a tiebreak.
 * Read through fork-index's one reader, so a symlink or a pipe named like a
 * fragment is a stray the plan refuses, not a file this numbers (the check's rule).
 */
function orderedFragments(fragments) {
  const addedAt = (name) => {
    try {
      const out = execFileSync("git", ["log", "--diff-filter=A", "--format=%ct", "--", `changes/${name}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").pop();
      return out ? Number(out) : Number.MAX_SAFE_INTEGER; // unstaged fragment sorts last
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  };
  const ticketNum = (f) => Number(/\d+/.exec(f.name)[0]);
  return [...fragments].sort((a, b) => (addedAt(a.name) - addedAt(b.name)) || (ticketNum(a) - ticketNum(b)));
}

function readMig(n) {
  const f = readdirSync(MIGRATIONS_DIR).find((name) => name.startsWith(pad3(n) + "_"));
  return f ? readFileSync(join(MIGRATIONS_DIR, f), "utf8") : null;
}

function buildPlan() {
  const releases = readReleases();
  const entries = readChangeEntries(ROOT);
  const { numbered: existing, fragments: pending, other } = classifyChanges(entries);
  // The directory this cut builds on must be sound — check 15's rules, applied
  // here too because a local run before CI on a tree two branches both numbered,
  // or with a stray beside the files, would otherwise stack a release on the flaw.
  if (other.length) throw new Error(`${CHANGES_REL}/ holds ${other.map((o) => o.name).join(", ")} — not a change file or a fragment; run check-fork-consistency and clear the directory before cutting a release`);
  if (existing.length === 0) throw new Error(`${CHANGES_REL}/ holds no numbered change file to number after — the first filed change is ${FIRST_FILED}`);
  for (let i = 0; i < existing.length; i++) {
    const want = FIRST_FILED + i;
    if (existing[i].n !== want) throw new Error(`${CHANGES_REL}/ is not contiguous at ${existing[i].name} (expected change ${want}) — run check-fork-consistency and fix the directory before cutting a release`);
  }
  if (pending.length === 0) throw new Error(`nothing to release — no ${CHANGES_REL}/smd-NNNN.md fragment has landed since the last cut`);
  const fragments = orderedFragments(pending).map(({ name, text }) => {
    const parsed = parseFragment(text);
    if (!parsed) throw new Error(`${name}: no front matter (run check-fork-consistency)`);
    const fork = fragmentSection(parsed.body, "FORK");
    if (!fork || !fork.trim()) throw new Error(`${name}: no \`## FORK\` body to number (run check-fork-consistency)`);
    return { name, ...parsed, fork };
  });
  const version = nextVersion(releases, fragments.map((f) => f.fm.bump));
  let n = highestChangeNumber(existing);
  const numbered = fragments.map((f) => ({ number: ++n, ...f, file: renderChangeFile(n, f.fork) }));
  // The index as it will read after the cut, from the plan — rendered (and the
  // marker pair checked) before a single file is written, so a FORK.md this step
  // cannot write into is refused with nothing half-applied.
  const after = classifyChanges([
    ...entries.filter((e) => !numbered.some((f) => f.name === e.name)),
    ...numbered.map((f) => ({ name: f.file.name, text: f.file.text })),
  ]);
  const forkPath = join(ROOT, "FORK.md");
  const forkAfter = spliceIndex(readFileSync(forkPath, "utf8"), renderIndex(after));

  const migNums = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => Number(f.slice(0, 3)));
  const lo = highestReleasedMigration(releases) + 1;
  const hi = Math.max(...migNums);
  const range = hi >= lo ? [lo, hi] : null; // a docs/server-only cut closes no migration
  // Every migration a fragment says it ships lies in the range this cut freezes:
  // one already frozen by an earlier release, or one with no file, is a fragment
  // that lies about its migration and a changelog that would say so.
  for (const f of fragments) {
    for (const mig of f.fm.migrations ?? []) {
      const num = Number(mig);
      if (!range || num < lo || num > hi) throw new Error(`${f.name} lists migration ${pad3(num)}, which is not in this cut's range (${range ? `${pad3(lo)}..${pad3(hi)}` : "none"}) — ${num < lo ? "an earlier release froze it" : "no such file under db/migrations/"}`);
    }
  }
  const tickets = [...new Set(fragments.flatMap((f) => f.fm.tickets))];

  // The changelog and the release entry, rendered here too: every throw the cut
  // can raise — a CHANGELOG.md with no Unreleased section, a migration missing from
  // the range — happens before write() has touched a file.
  // The release's day in the house zone (the one every review pass in the log
  // was committed in and mechanism-yield.mjs defaults to, SMD-1728), not the
  // machine's: a cut at 20:00 in Chicago is not dated tomorrow.
  const date = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const core = version.split("+")[0];
  const changelogAfter = insertChangelogSection(
    readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"),
    renderChangelogSection(version, date, numbered),
    core,
    releases.length ? `${REPO}/compare/v${releases[releases.length - 1].version.split("+")[0]}...v${core}` : `${REPO}/compare/upstream-pin-${UPSTREAM_PIN}...v${core}`,
  );
  const entry = { version, range, server: gitHead(), upstream: UPSTREAM_PIN, date, tickets };
  if (range) entry.frozenShas = frozenShasForRange(range[0], range[1], readMig);
  return { releases, fragments: numbered, version, range, tickets, date, forkAfter, changelogAfter, entry };
}

function printPlan(plan) {
  const core = plan.version.split("+")[0];
  console.log(`Release: ${plan.version}`);
  console.log(`Migration range: ${plan.range ? `${pad3(plan.range[0])}..${pad3(plan.range[1])}` : "none (no schema change)"}`);
  console.log(`Tickets: ${plan.tickets.join(", ")}`);
  console.log(`\nChange files to write (and the fragment each replaces):`);
  for (const f of plan.fragments) console.log(`  ${CHANGES_REL}/${f.file.name}  <-  ${CHANGES_REL}/${f.name}`);
  console.log(`\nCHANGELOG.md [${core}] section:\n`);
  console.log(renderChangelogSection(plan.version, plan.date, plan.fragments).split("\n").map((l) => "  " + l).join("\n"));
  if (plan.range) {
    const shas = plan.entry.frozenShas;
    console.log(`releases.json entry would freeze ${Object.keys(shas).length} migration(s): ${Object.entries(shas).map(([k, v]) => `${k}:${v}`).join(", ")}`);
  }
  console.log(`\n(dry run — nothing written; pass --write to apply, then tag and release out of band)`);
}

function write(plan) {
  // Everything was rendered in buildPlan; this only writes (the release author
  // reviews the diff; this is not run in CI): each fragment becomes the next
  // numbered file and is removed, then FORK.md's index, CHANGELOG.md's section
  // under Unreleased with its compare link, and releases.json's entry.
  for (const f of plan.fragments) {
    writeFileSync(join(CHANGES_DIR, f.file.name), f.file.text);
    unlinkSync(join(CHANGES_DIR, f.name));
  }
  writeFileSync(join(ROOT, "FORK.md"), plan.forkAfter);
  writeFileSync(join(ROOT, "CHANGELOG.md"), plan.changelogAfter);
  writeFileSync(join(ROOT, "releases.json"), JSON.stringify([...plan.releases, plan.entry], null, 2) + "\n");

  console.log(`Wrote ${plan.fragments.length} change file(s), FORK.md's index, CHANGELOG.md and releases.json for ${plan.version}.`);
  console.log(`Next, out of band, in this same commit: bump db/version.mjs's FORK_VERSION to '${plan.version}' and emit a NNN_set_schema_version.sql upserting it as the range's last migration (check-fork holds the two equal, so both move together). Then tag v${plan.version.split("+")[0]}+upstream.${UPSTREAM_PIN} and create the release.`);
}

function gitHead() {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return "unknown"; }
}

function selfCheck() {
  let bad = 0;
  const ok = (cond, label) => { if (!cond) { console.error(`FAIL ${label}`); bad++; } };
  ok(nextVersion([], ["minor"]) === `1.0.0+upstream.${UPSTREAM_PIN}`, "first cut is 1.0.0 whatever the bump");
  ok(nextVersion([{ version: "1.0.0" }], ["patch", "minor"]) === `1.1.0+upstream.${UPSTREAM_PIN}`, "strongest bump wins (minor over patch)");
  ok(nextVersion([{ version: "1.4.2" }], ["major", "minor"]) === `2.0.0+upstream.${UPSTREAM_PIN}`, "a major resets minor and patch");
  ok(bumpVersion("1.2.3+upstream.abc", "patch") === `1.2.4+upstream.${UPSTREAM_PIN}`, "patch increments the patch and re-pins upstream");
  ok(highestChangeNumber([{ n: 18 }, { n: 100 }]) === 100, "highest change number from the directory (an empty directory is refused before this is asked)");
  const cf = renderChangeFile(101, "A title — a consequence (SMD-1)\n\nBody line.");
  ok(cf.name === "101-a-title.md" && cf.text === "# 101. A title — a consequence (SMD-1)\n\nBody line.\n", "a change file from a fragment body: name from the title's first clause, `# N.` heading, the body");
  ok(renderChangeFile(102, "Only a title (SMD-2)").text === "# 102. Only a title (SMD-2)\n", "a body of one line is a heading alone");
  ok(renderChangeFile(103, "### A title (SMD-3)\n\nBody.").text.startsWith("# 103. A title (SMD-3)\n"), "a heading mark on the title line is stripped, not doubled");
  ok(changeFileName(104, "A".repeat(200) + " (SMD-4)").length <= 60, "one long word is cut to the slug budget");
  ok(changeFileName(105, ["B".repeat(60), "C".repeat(60), "D".repeat(60)].join(" ") + " (SMD-5)").length <= 60, "three long words: the budget applies from the first");
  ok(changeFileName(106, "Only the (SMD-6)") === "106-only.md" && changeFileName(107, "The (SMD-7)") === "107-the.md", "a trailing stop word goes while a word remains");
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
  try {
    const plan = buildPlan();
    if (args.includes("--write")) write(plan);
    else printPlan(plan);
  } catch (e) {
    // Nothing to release, a fragment this step cannot number, a FORK.md it cannot
    // write into: a sentence, not a stack trace, and a non-zero exit so a release
    // job stops here (SMD-1805).
    console.error(`assemble-release: ${e.message}`);
    process.exit(1);
  }
}
