#!/usr/bin/env node
/**
 * fork-index.mjs — renders FORK.md's index of numbered changes from changes/
 * (SMD-1917).
 *
 * FORK.md is the front door: the pin, what the fork is for, the 1–17 table, the
 * standing sections. Every numbered change from 18 on is one file,
 * changes/NNN-<slug>.md, and this writes the one-line-per-change index FORK.md
 * carries between two marker comments, so the count and the list are never kept
 * by hand. check-fork-consistency.mjs (check 15) renders the same block in memory
 * and fails when the committed one differs — the round-trip tools.json has.
 *
 *   bun scripts/fork-index.mjs        # rewrite the block in FORK.md
 *   node scripts/fork-index.mjs       # the same; plain fs, no Bun API
 *
 * A change file's first line is `# N. <title>`; the index shows the part of the
 * title before " — " (the house shape is "Thing — consequence") and the ticket
 * its title ends with. A changes/smd-NNNN.md file is SMD-1804's release
 * fragment — a change that has landed and takes its number at the next release —
 * and is listed after the numbered ones, by ticket.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const CHANGES_DIR = "changes";
/** The first numbered change with a file; 1–17 are FORK.md's table. */
export const FIRST_FILED = 18;
export const START = "<!-- changes-index:start — generated from changes/ by scripts/fork-index.mjs; do not edit by hand -->";
export const END = "<!-- changes-index:end -->";
export const NUMBERED = /^(\d{3})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
export const FRAGMENT = /^smd-(\d+)\.md$/;
export const H1 = /^# (\d+)\. (.+?)\s*$/;

/** `{ n, title }` from a change file's first line, or null when it is not `# N. Title`. */
export function headingOf(text) {
  const m = H1.exec(text.split("\n", 1)[0]);
  return m ? { n: Number(m[1]), title: m[2] } : null;
}

/** The ticket(s) a title ends with — `(SMD-1843)`, `(SMD-1301 / 1302 / 1304)` — as text, or "". */
export function ticketOf(title) {
  const m = /\((SMD-\d+(?:\s*[/,]\s*(?:SMD-)?\d+)*)\)\s*$/.exec(title);
  return m ? m[1].replace(/\s*[/,]\s*/g, ", ").replace(/, (\d)/g, ", SMD-$1") : "";
}

/** The part of a title the index shows: before the first " — ", the ticket tail off. */
export function headOf(title) {
  return title.replace(/\s*\((SMD-\d+(?:\s*[/,]\s*(?:SMD-)?\d+)*)\)\s*$/, "").split(" — ")[0].trim();
}

const STOP_WORDS = new Set(["of", "so", "the", "and", "a", "an", "its", "not", "to", "is", "was", "as", "be", "for", "with", "on", "in", "at", "that", "which", "into", "s", "it", "by", "or", "no", "only"]);
/**
 * The slug a change file's name carries, from its title: the first clause, ASCII
 * lower-case words joined by dashes, cut around 48 characters and never ending on
 * a stop word. The release step names a numbered file with it; the split did too.
 */
export function slugOf(title) {
  const words = headOf(title)
    .replace(/`/g, "")
    .replace(/→/g, " to ")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const out = [];
  let len = 0;
  for (const w of words) {
    if (len + w.length + 1 > 48 && out.length >= 3) break;
    out.push(w);
    len += w.length + 1;
  }
  while (out.length > 3 && STOP_WORDS.has(out[out.length - 1])) out.pop();
  return out.join("-") || "change";
}

/** The file name a numbered change takes: `NNN-<slug>.md`. */
export function changeFileName(n, title) {
  return `${String(n).padStart(3, "0")}-${slugOf(title)}.md`;
}

/**
 * What changes/ holds: numbered files (with their heading, line count and the
 * number their name carries), SMD-1804 fragments, and anything else. Pure over
 * a listing of `{ name, text }`, so the check can hand it an in-memory directory.
 */
export function classifyChanges(entries) {
  const numbered = [];
  const fragments = [];
  const other = [];
  for (const { name, text } of entries) {
    const num = NUMBERED.exec(name);
    const frag = FRAGMENT.exec(name);
    const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
    if (num) numbered.push({ name, n: Number(num[1]), heading: headingOf(text), lines });
    else if (frag) fragments.push({ name, ticket: `SMD-${frag[1]}`, lines });
    else if (name !== "README.md") other.push(name);
  }
  numbered.sort((a, b) => a.n - b.n || a.name.localeCompare(b.name));
  fragments.sort((a, b) => a.name.localeCompare(b.name));
  return { numbered, fragments, other };
}

export function readChanges(root) {
  const dir = join(root, CHANGES_DIR);
  if (!existsSync(dir)) return classifyChanges([]);
  return classifyChanges(
    readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") })),
  );
}

/** The index block, markers excluded. One definition for the writer and the check. */
export function renderIndex({ numbered, fragments }) {
  const hi = numbered.length ? numbered[numbered.length - 1].n : FIRST_FILED - 1;
  const lines = [
    `**${hi} numbered changes** on top of the pin: 1–${FIRST_FILED - 1} are the table above; ` +
      `${FIRST_FILED}–${hi} are one file each under [\`changes/\`](changes/README.md), newest last. ` +
      "A change's record is its file; the review-pass prose behind it is in the commits " +
      "(`(caught: …)` tags, read by `scripts/mechanism-yield.mjs`).",
    "",
    "| # | Change | Ticket |",
    "| --- | --- | --- |",
  ];
  for (const c of numbered) {
    const title = c.heading?.title ?? c.name;
    lines.push(`| ${c.n} | [${headOf(title)}](${CHANGES_DIR}/${c.name}) | ${ticketOf(title)} |`);
  }
  if (fragments.length) {
    lines.push("");
    lines.push(
      "Landed since the last release and numbered at the next one (SMD-1804): " +
        fragments.map((f) => `[${f.ticket}](${CHANGES_DIR}/${f.name})`).join(", ") + ".",
    );
  }
  return lines.join("\n") + "\n";
}

/** FORK.md with the block between the markers replaced; throws when the markers are not exactly one pair. */
export function spliceIndex(forkText, block) {
  const s = forkText.indexOf(START);
  const e = forkText.indexOf(END);
  if (s < 0 || e < 0 || e < s || forkText.indexOf(START, s + 1) >= 0 || forkText.indexOf(END, e + 1) >= 0) {
    throw new Error(`FORK.md must carry exactly one \`${START.slice(0, 27)}…\` / \`${END}\` pair`);
  }
  return forkText.slice(0, s + START.length) + "\n" + block + forkText.slice(e);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fork = join(ROOT, "FORK.md");
  const changes = readChanges(ROOT);
  writeFileSync(fork, spliceIndex(readFileSync(fork, "utf8"), renderIndex(changes)));
  console.log(`wrote the index into FORK.md (${changes.numbered.length} numbered changes, ${changes.fragments.length} fragments)`);
}
