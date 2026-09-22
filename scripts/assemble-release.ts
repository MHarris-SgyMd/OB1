#!/usr/bin/env bun
/**
 * assemble-release.ts — cut a release from the changes/ fragments (SMD-1804).
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
 * with scripts/fork-index.ts. Everything a cut can refuse by reading — a
 * directory that is not contiguous or holds a stray or two fragments for one
 * ticket, a fragment check 16 would refuse (one function, fragments.ts) or one
 * naming a migration outside the range, a FORK.md with no marker pair or a
 * CHANGELOG.md with no Unreleased section or a hand-written note under it, a
 * half-applied earlier cut (its numbered files, changelog section or release
 * entry already present), a shallow clone — is refused in the plan, before
 * --write touches a file, and --write itself refuses a working tree that is
 * not clean. An I/O failure during --write is not planned for: revert the
 * working tree and run again.
 *
 *   bun scripts/assemble-release.ts              # DRY RUN: print the plan, touch nothing
 *   bun scripts/assemble-release.ts --write      # write changes/NNN-*.md, FORK.md's index, CHANGELOG.md, releases.json
 *   bun scripts/assemble-release.ts --self-check  # exercise the pure functions
 *
 * The pieces this computes — the next version, the change numbering, the section
 * and changelog rendering, the frozen shas over the new migration range — are pure
 * functions, self-checked below. --write is the glue that applies them; a
 * maintainer runs it on a branch, and it is never run in CI's checks.
 *
 * A cut is two commits on one branch, in this order (SMD-1860): first the version
 * — the dry run names it — bumped in db/version.mjs's FORK_VERSION and written by
 * a new `NNN_schema_version.sql` upserting it, the highest migration on disk, so
 * the range this cut freezes ends on the migration that names the release and a
 * brain that applies the range reports the version (check 17d holds the two
 * equal; db/README.md's map and the suites' migration counts move with it); then
 * --write, which refuses a tree whose FORK_VERSION or highest migration does not
 * say the version it is about to record. The PR lands the two; the maintainer
 * tags the merge commit `v<core>` and pushes the tag, and
 * .github/workflows/release.yml publishes the images and the release from it.
 *
 * Not this script's job: creating the git tag or the GitHub release, or publishing
 * images. Those are the release job's (scripts/release-artifacts.ts, SMD-1860).
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FORK_VERSION, REPO_URL, UPSTREAM_PIN, migrationSha, readReleases, highestReleasedMigration, schemaVersionValue, type Release } from "../db/version.mjs";
import { parseFragment, fragmentSection, fragmentProblems, type FragmentFrontMatter } from "./fragments.ts";
import { CHANGES_DIR as CHANGES_REL, FIRST_FILED, changeFileName, classifyChanges, pad3, readChangeEntries, renderIndex, spliceIndex, type FragmentChange } from "./fork-index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGES_ABS = join(ROOT, "changes");
const MIGRATIONS_DIR = join(ROOT, "db", "migrations");
const BUMP_RANK: Record<string, number> = { patch: 0, minor: 1, major: 2 };
const TYPE_HEADING: Record<string, string> = { added: "Added", changed: "Changed", deprecated: "Deprecated", removed: "Removed", fixed: "Fixed", security: "Security" };

/** A fragment's front matter once fragmentProblems has passed it: type and bump strings from their sets, tickets a list, migrations a list or absent (a scalar is refused). */
type CheckedFrontMatter = FragmentFrontMatter & { type: string; bump: string; tickets: string[]; migrations?: string[] };

// ── Pure functions (self-checked) ────────────────────────────────────────────

/** Bump a version by kind, keeping the +upstream build metadata. */
export function bumpVersion(version: string, kind: string): string {
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
export function nextVersion(releases: { version: string }[], bumps: string[]): string {
  const strongest = bumps.reduce((a, b) => (BUMP_RANK[b] > BUMP_RANK[a] ? b : a), "patch");
  if (releases.length === 0) return `1.0.0+upstream.${UPSTREAM_PIN}`;
  return bumpVersion(releases[releases.length - 1].version, strongest);
}

/** The highest numbered change file today (buildPlan refuses an empty directory before asking). */
export function highestChangeNumber(numbered: { n: number }[]): number {
  return numbered[numbered.length - 1].n; // buildPlan refuses an empty directory before asking
}

/**
 * Render a fragment's FORK body as a numbered change file: the file's name from
 * the number and the title (its first line), `# N. <title>`, then the body.
 */
export function renderChangeFile(number: number, forkBody: string): { name: string; title: string; text: string } {
  const lines = forkBody.trim().split("\n");
  const title = lines[0].replace(/^#+\s*/, "").trim(); // check 16 refuses a heading here; the writer strips one anyway
  const rest = lines.slice(1).join("\n").trim();
  return { name: changeFileName(number, title), title, text: `# ${number}. ${title}` + (rest ? `\n\n${rest}` : "") + "\n" };
}

/** Render the CHANGELOG version section: entries grouped under the six headings. */
export function renderChangelogSection(version: string, date: string, fragments: { fm: { type: string }; body: string }[]): string {
  const core = version.split("+")[0];
  const byHeading = new Map<string, string[]>();
  for (const f of fragments) {
    const heading = TYPE_HEADING[f.fm.type];
    if (!byHeading.has(heading)) byHeading.set(heading, []);
    byHeading.get(heading)!.push(fragmentSection(f.body, "Changelog")!.trim()); // has(heading) was ensured the line above; fragmentProblems (and the self-check fixture) guarantee the section
  }
  let out = `## [${core}] - ${date}\n`;
  for (const heading of Object.values(TYPE_HEADING)) {
    if (!byHeading.has(heading)) continue;
    out += `\n### ${heading}\n`;
    for (const entry of byHeading.get(heading)!) out += `- ${entry.replace(/\n+/g, " ")}\n`; // has(heading) was checked the line above
  }
  return out;
}

/**
 * Insert a rendered version section under `## [Unreleased]` (newest first) and add
 * its compare link beside the Unreleased one. Throws if there is no Unreleased
 * section to insert under.
 */
export function insertChangelogSection(clText: string, sectionText: string, core: string, compareUrl: string): string {
  const withSection = clText.replace(/(## \[Unreleased\]\n)([\s\S]*?)(?=\n## \[|\n\[Unreleased\]:)/, `$1\n${sectionText}`);
  if (withSection === clText) throw new Error("CHANGELOG.md has no ## [Unreleased] section to insert under");
  // The Unreleased compare link now runs from this version's tag; the version's own link follows it.
  return withSection.replace(/\[Unreleased\]:\s*(\S+?)\/compare\/\S+\n/, `[Unreleased]: $1/compare/v${core}...HEAD\n[${core}]: ${compareUrl}\n`);
}

/** The frozen shas for a migration range, computed from the templates on disk. */
export function frozenShasForRange(lo: number, hi: number, readMig: (n: number) => string | null): Record<string, string> {
  const shas: Record<string, string> = {};
  for (let n = lo; n <= hi; n++) {
    const tpl = readMig(n);
    if (tpl === null) throw new Error(`no migration file for ${pad3(n)} in the release range ${pad3(lo)}..${pad3(hi)}`);
    shas[pad3(n)] = migrationSha(tpl);
  }
  return shas;
}

// ── I/O and the plan ─────────────────────────────────────────────────────────

/**
 * The fragments in merge order — when each ARRIVED on this branch's first-parent
 * line (the merge commit that brought it, or the commit that added it here),
 * not when its author committed it on a branch; a fragment created in a merge
 * shows no diff without --first-parent, a renamed one is an R without
 * --no-renames; the newest add is the one that counts (a name a cut deleted and
 * a later PR re-created has two). Ticket number breaks a tie. A fragment git
 * does not track has no arrival and sorts last; the plan says so and --write
 * refuses it. Read
 * through fork-index's one reader, so a symlink or a pipe named like a fragment
 * is a stray the plan refuses, not a file this numbers (the check's rule).
 */
function landedAt(name: string): number | null {
  try {
    // Tracked at all? An uncommitted re-creation of a name a cut once deleted
    // still has the old path's history; git ls-files answers for the file.
    execFileSync("git", ["ls-files", "--error-unmatch", "--", `changes/${name}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    // The NEWEST add on the first-parent line is this file's arrival (a name
    // deleted by a cut and re-created later has two).
    const out = execFileSync("git", ["log", "-1", "--first-parent", "--diff-filter=A", "--no-renames", "--format=%ct", "--", `changes/${name}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out ? Number(out) : null;
  } catch {
    return null; // untracked, or no repository (a copied tree)
  }
}
function orderedFragments(fragments: FragmentChange[]) {
  const at = new Map(fragments.map((f) => [f.name, landedAt(f.name)])); // one child process per fragment, not per comparison
  const key = (f: FragmentChange) => at.get(f.name) ?? Number.MAX_SAFE_INTEGER;
  const ticketNum = (f: FragmentChange) => Number(/\d+/.exec(f.name)![0]); // a fragment's name is smd-NNNN.md — classifyChanges matched it
  return [...fragments].sort((a, b) => (key(a) - key(b)) || (ticketNum(a) - ticketNum(b))).map((f) => ({ ...f, landed: at.get(f.name) }));
}

/** number → file name under db/migrations, listed once when first asked (an import runs no I/O). */
let migrationFilesCache: Map<number, string> | null = null;
function migrationFiles() {
  return (migrationFilesCache ??= new Map(readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => [Number(f.slice(0, 3)), f])));
}
function readMig(n: number): string | null {
  const f = migrationFiles().get(n);
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
  const byTicket = new Map<string, string>();
  for (const f of pending) {
    if (byTicket.has(f.ticket)) throw new Error(`${CHANGES_REL}/${f.name} is a second fragment for ${f.ticket} beside ${CHANGES_REL}/${byTicket.get(f.ticket)} — one PR, one fragment`);
    byTicket.set(f.ticket, f.name);
  }
  const fragments = orderedFragments(pending).map(({ name, text, landed }) => {
    // Check 16's rules, the same function: a cut refuses what CI would.
    const problems = fragmentProblems(text, name);
    if (problems.length) throw new Error(`${name}: ${problems.join("; ")} (check-fork-consistency, check 16)`);
    const parsed = parseFragment(text) as { fm: CheckedFrontMatter; body: string }; // fragmentProblems passed it: front matter present, type and bump strings from their sets, tickets a list
    return { name, landed, ...parsed, fork: fragmentSection(parsed.body, "FORK")! }; // fragmentProblems refused a fragment without a FORK section
  });
  // A previous --write that stopped after writing the numbered files (before the
  // overwrites) leaves their record beside the fragments it came from; a second
  // run would number it again. The signature is the TITLE: an existing file's
  // heading, number off, equal to a pending fragment's title — which survives a
  // typo fixed in the body afterwards, and which a legitimate second change for
  // the same ticket (SMD-1805's steps) never shares.
  for (const f of fragments) {
    const planned = renderChangeFile(0, f.fork).title;
    for (const e of existing) {
      if ((e.heading?.title ?? "") === planned) {
        throw new Error(`${CHANGES_REL}/${e.name} already carries ${f.name}'s record (same title) — a previous --write stopped half-way; delete the numbered files it wrote, restore FORK.md, CHANGELOG.md and releases.json from version control, and run again`);
      }
    }
  }
  // Merge order comes from each fragment's add commit; a shallow clone has one
  // commit and would order by ticket number, silently. Refuse it.
  if (isShallow()) throw new Error("this checkout is shallow, so the fragments' merge order cannot be read — fetch the full history (actions/checkout: fetch-depth: 0) and run again");
  const version = nextVersion(releases, fragments.map((f) => f.fm.bump));
  let n = highestChangeNumber(existing);
  const numbered = fragments.map((f) => ({ number: ++n, ...f, file: renderChangeFile(n, f.fork) }));
  const changeRange: [number, number] = [numbered[0].number, numbered[numbered.length - 1].number]; // pending is non-empty (refused above)
  // The index as it will read after the cut, from the plan — rendered (and the
  // marker pair checked) before a single file is written, so a FORK.md this step
  // cannot write into is refused with nothing half-applied.
  const after = classifyChanges([
    ...entries.filter((e) => !numbered.some((f) => f.name === e.name)),
    ...numbered.map((f) => ({ name: f.file.name, text: f.file.text })),
  ]);
  const forkPath = join(ROOT, "FORK.md");
  const forkAfter = spliceIndex(readFileSync(forkPath, "utf8"), renderIndex(after));

  const migNums = [...migrationFiles().keys()];
  const lo = highestReleasedMigration(releases) + 1;
  const hi = Math.max(...migNums);
  const range: [number, number] | null = hi >= lo ? [lo, hi] : null; // never null since SMD-1860 — every cut adds the migration that writes its version (the precondition below) — and kept as the type says for the manifest entries the reader still accepts
  // Before --write: the tree says the version it is about to record. The brain
  // reports FORK_VERSION through the highest schema_version migration (044 at
  // the baseline), so a cut bumps the constant and adds that migration FIRST,
  // as the highest on disk — inside the range this cut freezes, so a brain that
  // applies the range reports the version, and no later cut has to close a
  // one-migration gap. The dry run prints these as the next step; --write
  // refuses on them (SMD-1860).
  const before: string[] = [];
  if (FORK_VERSION !== version) before.push(`db/version.mjs's FORK_VERSION is '${FORK_VERSION}'; this cut is ${version} — bump it`);
  const writes = readMig(hi) === null ? null : schemaVersionValue(readMig(hi)!); // hi is a key of migrationFiles()
  if (writes !== version) before.push(`the highest migration, ${pad3(hi)}, ${writes === null ? "writes no schema_version" : `writes schema_version '${writes}'`} — add db/migrations/${pad3(hi + (writes === null ? 1 : 0))}_schema_version.sql upserting '${version}' (044's shape), with db/README.md's map and the suites' migration counts moved (check-fork holds them); the range below then ends on it`);
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
  // was committed in and mechanism-yield.ts defaults to, SMD-1728), not the
  // machine's: a cut at 20:00 in Chicago is not dated tomorrow. Built from the
  // date's parts, so the YYYY-MM-DD shape check 17a wants is asserted, not a
  // locale's habit.
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const core = version.split("+")[0];
  const changelogBefore = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  // A previous --write that stopped half-way leaves CHANGELOG.md or releases.json
  // already carrying this cut while the fragments still sit in changes/; a second
  // write would double the section. The signatures: CHANGELOG.md already has this
  // version's section, or the last release entry was written from this very HEAD
  // (a committed cut moves HEAD past the commit it recorded). A ticket shared
  // with the last release is NOT one: a ticket may ship a second fragment.
  const last = releases[releases.length - 1];
  if (changelogBefore.includes(`## [${core}]`) || (last && last.server === gitHead())) {
    throw new Error(`CHANGELOG.md or releases.json already carries this cut while its fragments are still in ${CHANGES_REL}/ — a previous --write stopped half-way; restore FORK.md, CHANGELOG.md and releases.json from version control and run again`);
  }
  // Whatever sits under ## [Unreleased] is replaced by the version section; a
  // hand-written note there would vanish. Only the placeholder paragraph may sit there.
  const unreleased = /## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|\n\[Unreleased\]:)/.exec(changelogBefore);
  const placeholder = (unreleased?.[1] ?? "").trim(); // empty, or one italic paragraph (_…_ with a closing mark), possibly wrapped
  if (placeholder && !(/^_[\s\S]*_[.!]?$/.test(placeholder) && !/\n\s*\n/.test(placeholder))) {
    throw new Error("CHANGELOG.md carries hand-written lines under ## [Unreleased]; the release step replaces that body — move them into a fragment's ## Changelog first");
  }
  const changelogAfter = insertChangelogSection(
    changelogBefore,
    renderChangelogSection(version, date, numbered),
    core,
    releases.length ? `${REPO_URL}/compare/v${releases[releases.length - 1].version.split("+")[0]}...v${core}` : `${REPO_URL}/compare/upstream-pin-${UPSTREAM_PIN}...v${core}`,
  );
  const entry: Release = { version, range, server: gitHead(), upstream: UPSTREAM_PIN, date, tickets, changes: changeRange };
  if (range) entry.frozenShas = frozenShasForRange(range[0], range[1], readMig);
  return { releases, fragments: numbered, version, range, tickets, date, forkAfter, changelogAfter, entry, before };
}

/** What buildPlan renders: everything --write applies, and everything the dry run prints. */
type Plan = ReturnType<typeof buildPlan>;

function printPlan(plan: Plan) {
  const core = plan.version.split("+")[0];
  console.log(`Release: ${plan.version}`);
  console.log(`Migration range: ${plan.range ? `${pad3(plan.range[0])}..${pad3(plan.range[1])}` : "none (no schema change)"}`);
  console.log(`Tickets: ${plan.tickets.join(", ")}`);
  console.log(`\nChange files to write (and the fragment each replaces), in the order the fragments landed on this branch:`);
  for (const f of plan.fragments) console.log(`  ${CHANGES_REL}/${f.file.name}  <-  ${CHANGES_REL}/${f.name}  (${f.landed ? `landed ${new Date(f.landed * 1000).toISOString().slice(0, 16)}Z` : "not committed — ordered last"})`);
  console.log(`\nCHANGELOG.md [${core}] section:\n`);
  console.log(renderChangelogSection(plan.version, plan.date, plan.fragments).split("\n").map((l) => "  " + l).join("\n"));
  if (plan.range) {
    const shas = plan.entry.frozenShas!; // buildPlan sets it whenever range is
    console.log(`releases.json entry would freeze ${Object.keys(shas).length} migration(s): ${Object.entries(shas).map(([k, v]) => `${k}:${v}`).join(", ")}`);
  }
  if (plan.before.length) {
    console.log(`\nBefore --write, in one commit (the tree must say the version it records):`);
    for (const b of plan.before) console.log(`  - ${b}`);
    console.log(`(dry run — nothing written; --write refuses until the above is done)`);
  } else console.log(`\n(dry run — nothing written; pass --write to apply, commit, and open the PR; the tag comes after the merge)`);
}

function write(plan: Plan) {
  // Everything was rendered in buildPlan; this only writes (the release author
  // reviews the diff; this is not run in CI). The new numbered files first —
  // pure additions — then the three overwrites (FORK.md's index, CHANGELOG.md's
  // section under Unreleased with its compare link, releases.json's entry), and
  // the fragments are removed last. A failure part-way is recovered by reverting
  // the working tree to the commit before the cut and running again; buildPlan
  // refuses to run on top of a half-applied cut rather than double it.
  for (const f of plan.fragments) writeFileSync(join(CHANGES_ABS, f.file.name), f.file.text);
  writeFileSync(join(ROOT, "FORK.md"), plan.forkAfter);
  writeFileSync(join(ROOT, "CHANGELOG.md"), plan.changelogAfter);
  writeFileSync(join(ROOT, "releases.json"), JSON.stringify([...plan.releases, plan.entry], null, 2) + "\n");
  for (const f of plan.fragments) unlinkSync(join(CHANGES_ABS, f.name));

  console.log(`Wrote ${plan.fragments.length} change file(s), FORK.md's index, CHANGELOG.md and releases.json for ${plan.version}${plan.range ? ` (migrations ${pad3(plan.range[0])}..${pad3(plan.range[1])} frozen)` : ""}.`);
  console.log(`Next: commit this as the cut's second commit, run check-fork-consistency, and open the PR. Once it has merged, tag the merge commit — git tag -a v${plan.version.split("+")[0]} <merge sha> -m '${plan.version}' && git push origin v${plan.version.split("+")[0]} — and .github/workflows/release.yml publishes the images and the release from it (scripts/release-artifacts.ts refuses a tag that does not name this cut).`);
}

function gitStatus() {
  try { return execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; } // no repository (a copied tree)
}

function isShallow() {
  try { return execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true"; }
  catch { return false; } // no repository at all (a copied tree): a dry run orders by ticket number, as landedAt says; --write refuses
}

function gitHead() {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return "unknown"; }
}

function selfCheck() {
  let bad = 0;
  const ok = (cond: boolean, label: string) => { if (!cond) { console.error(`FAIL ${label}`); bad++; } };
  ok(nextVersion([], ["minor"]) === `1.0.0+upstream.${UPSTREAM_PIN}`, "first cut is 1.0.0 whatever the bump");
  ok(nextVersion([{ version: "1.0.0" }], ["patch", "minor"]) === `1.1.0+upstream.${UPSTREAM_PIN}`, "strongest bump wins (minor over patch)");
  ok(nextVersion([{ version: "1.4.2" }], ["major", "minor"]) === `2.0.0+upstream.${UPSTREAM_PIN}`, "a major resets minor and patch");
  ok(bumpVersion("1.2.3+upstream.abc", "patch") === `1.2.4+upstream.${UPSTREAM_PIN}`, "patch increments the patch and re-pins upstream");
  ok(highestChangeNumber([{ n: 18 }, { n: 100 }]) === 100, "highest change number from the directory (an empty directory is refused before this is asked)");
  const cf = renderChangeFile(101, "A title — a consequence (SMD-1)\n\nBody line.");
  ok(cf.name === "101-a-title.md" && cf.text === "# 101. A title — a consequence (SMD-1)\n\nBody line.\n", "a change file from a fragment body: name from the title's first clause, `# N.` heading, the body");
  ok(renderChangeFile(102, "Only a title (SMD-2)").text === "# 102. Only a title (SMD-2)\n", "a body of one line is a heading alone");
  ok(renderChangeFile(103, "### A title (SMD-3)\n\nBody.").text.startsWith("# 103. A title (SMD-3)\n"), "a heading mark on the title line is stripped, not doubled");
  ok(fragmentSection("## Changelog\nx\n\n## FORK\nT (SMD-1)\n\nBody.\n\n## Measured after\n\nKept.\n", "FORK")!.endsWith("## Measured after\n\nKept."), "a FORK body keeps its own ## sub-headings to the end of the file");
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
  ok(schemaVersionValue("INSERT INTO ob1_config (key, value) VALUES\n  ('schema_version', '1.0.0+upstream.abc')\nON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;") === "1.0.0+upstream.abc" && schemaVersionValue("CREATE INDEX x ON y (z);") === null, "the version migration's value is read through db/version.mjs's one reader (a cut's precondition)");
  // The mutation helper: the changelog section lands under Unreleased with its link.
  const clOut = insertChangelogSection("# Changelog\n\n## [Unreleased]\n\n_placeholder_\n\n[Unreleased]: https://x/compare/upstream-pin-abc...HEAD\n", "## [1.0.0] - 2026-09-30\n### Added\n- x (SMD-1)\n", "1.0.0", "COMPARE");
  ok(clOut.indexOf("## [Unreleased]") < clOut.indexOf("## [1.0.0] - 2026-09-30") && /\[1\.0\.0\]: COMPARE/.test(clOut) && /\[Unreleased\]: https:\/\/x\/compare\/v1\.0\.0\.\.\.HEAD/.test(clOut) && !/_placeholder_/.test(clOut), "a changelog section lands under Unreleased, with its compare link, replacing the placeholder; Unreleased now compares from this version's tag");
  let clThrew = false;
  try { insertChangelogSection("# Changelog\n\nno unreleased\n", "x", "1.0.0", "u"); } catch { clThrew = true; }
  ok(clThrew, "insertChangelogSection throws when there is no Unreleased section");
  if (bad === 0) console.log("assemble-release.ts self-check PASS");
  return bad === 0 ? 0 : 1;
}

// ── Entry ────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--self-check")) process.exit(selfCheck());
  try {
    const plan = buildPlan();
    if (args.includes("--write")) {
      // A cut is committed whole. A tree with changes already in it — a
      // half-applied earlier cut, an uncommitted fragment, anything — is refused,
      // so the recovery from a failed --write is always "revert and run again".
      const dirty = gitStatus();
      if (dirty === null) throw new Error("--write needs the repository: the fragments' order and the tree's state are read from it, and a copied tree has neither");
      if (dirty) throw new Error(`the working tree is not clean:\n${dirty}\n--write cuts a release from a committed tree — commit or revert first`);
      const uncommitted = plan.fragments.filter((f) => !f.landed).map((f) => f.name);
      if (uncommitted.length) throw new Error(`${uncommitted.join(", ")}: not committed, so the order it landed in is unknown — commit it first`);
      if (plan.before.length) throw new Error(`the tree does not yet say the version this cut records:\n  - ${plan.before.join("\n  - ")}\n(one commit, before --write; the dry run prints the same)`);
      write(plan);
    } else printPlan(plan);
  } catch (e) {
    // Nothing to release, a fragment this step cannot number, a FORK.md it cannot
    // write into: a sentence, not a stack trace, and a non-zero exit so a release
    // job stops here (SMD-1805).
    console.error(`assemble-release: ${(e as Error).message}`); // buildPlan and write throw Errors
    process.exit(1);
  }
}
