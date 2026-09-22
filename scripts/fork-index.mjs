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
import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const CHANGES_DIR = "changes";
/** The first numbered change with a file; 1–17 are FORK.md's table. */
export const FIRST_FILED = 18;
export const START = "<!-- changes-index:start — generated from changes/ by scripts/fork-index.mjs; do not edit by hand -->";
export const END = "<!-- changes-index:end -->";
export const NUMBERED = /^(\d{3})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
export const FRAGMENT = /^smd-(\d+)\.md$/;
export const H1 = /^# ([1-9]\d*)\. (.+?)\s*$/;

/** `{ n, title }` from a change file's first line, or null when it is not `# N. Title`. */
export function headingOf(text) {
  const m = H1.exec(text.replace(/^\uFEFF/, "").split("\n", 1)[0]); // an editor's byte-order mark is not part of the heading
  return m ? { n: Number(m[1]), title: m[2] } : null;
}

/** The ticket(s) a title ends with — `(SMD-1843)`, `(SMD-1301 / 1302 / 1304)` — as text, or "". */
export function ticketOf(title) {
  const m = /\((SMD-\d+(?:\s*[/,]\s*(?:SMD-)?\d+)*)\)\s*$/.exec(title);
  return m ? m[1].replace(/\s*[/,]\s*/g, ", ").replace(/, (\d)/g, ", SMD-$1") : "";
}

/** The part of a title the index shows: before the first " — " outside a code span, the ticket tail off. */
export function headOf(title) {
  const bare = title.replace(/\s*\((SMD-\d+(?:\s*[/,]\s*(?:SMD-)?\d+)*)\)\s*$/, "");
  let inCode = false;
  for (let i = 0; i < bare.length; i++) {
    if (bare[i] === "`") inCode = !inCode;
    else if (!inCode && bare.startsWith(" — ", i)) return bare.slice(0, i).trim();
  }
  return bare.trim();
}

/** Text safe inside a table cell and a link's text: a pipe or a bracket is escaped, not a delimiter. */
export function cell(text) {
  return text.replace(/[|[\]]/g, "\\$&");
}

const STOP_WORDS = new Set(["of", "so", "the", "and", "a", "an", "its", "not", "to", "is", "was", "as", "be", "for", "with", "on", "in", "at", "that", "which", "into", "s", "it", "by", "or", "no", "only"]);
/**
 * The slug a change file's name carries, from its title: the first clause, ASCII
 * lower-case words joined by dashes, at most 48 characters (a first word longer
 * than that is cut to it) and, when more than one word remains, never ending on
 * a stop word. The release step names a numbered file with it; the split did
 * too, with an earlier cut — the names 18–103 stand as they are.
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
    if (out.length && len + 1 + w.length > 48) break;
    out.push(out.length ? w : w.slice(0, 48));
    len += (out.length > 1 ? 1 : 0) + out[out.length - 1].length;
  }
  while (out.length > 1 && STOP_WORDS.has(out[out.length - 1])) out.pop();
  return out.join("-") || "change";
}

/** The file name a numbered change takes: `NNN-<slug>.md`. */
export function changeFileName(n, title) {
  return `${String(n).padStart(3, "0")}-${slugOf(title)}.md`;
}

/**
 * What changes/ holds: numbered files (with their heading, text, line count and
 * the number their name carries), SMD-1804 fragments, and anything else — an
 * entry whose `text` is null is not a regular file (a directory, a socket) and is
 * "other" whatever its name. Pure over a listing of `{ name, text }`, so the
 * check can hand it an in-memory directory.
 */
export function classifyChanges(entries) {
  const numbered = [];
  const fragments = [];
  const other = [];
  for (const { name, text } of entries) {
    const num = text === null ? null : NUMBERED.exec(name);
    const frag = text === null ? null : FRAGMENT.exec(name);
    const lines = text === null ? 0 : text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
    if (num) numbered.push({ name, n: Number(num[1]), heading: headingOf(text), text, lines });
    else if (frag) fragments.push({ name, ticket: `SMD-${Number(frag[1])}`, text, lines });
    else if (text === null || (name !== "README.md" && !name.startsWith("."))) other.push({ name, text }); // a dotfile is the OS's, not a record
  }
  numbered.sort((a, b) => a.n - b.n || a.name.localeCompare(b.name));
  fragments.sort((a, b) => Number(a.ticket.slice(4)) - Number(b.ticket.slice(4)) || a.name.localeCompare(b.name));
  return { numbered, fragments, other };
}

/**
 * Every entry of changes/ (any extension — a stray is a finding), as
 * `{ name, text }`; a directory or anything else that is not a regular file has
 * `text: null` rather than an EISDIR from the reader.
 */
export function readChangeEntries(root) {
  const dir = join(root, CHANGES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({ name: d.name, text: d.isFile() ? readFileSync(join(dir, d.name), "utf8") : null }));
}

export function readChanges(root) {
  return classifyChanges(readChangeEntries(root));
}

/** The index block, markers excluded. One definition for the writer and the check. */
export function renderIndex({ numbered, fragments }) {
  const hi = numbered.length ? numbered[numbered.length - 1].n : FIRST_FILED - 1;
  const lines = [
    numbered.length
      ? `**${hi} numbered changes** on top of the pin: 1–${FIRST_FILED - 1} are the table above; ` +
        `${FIRST_FILED}–${hi} are one file each under [\`changes/\`](changes/README.md), newest last. ` +
        "A change's record is its file; the review-pass prose behind it is in the commits " +
        "(`(caught: …)` tags, read by `scripts/mechanism-yield.mjs`)."
      : `**${FIRST_FILED - 1} numbered changes** on top of the pin, all in the table above; no change has a file under [\`changes/\`](changes/README.md) yet.`,
    "",
    "| # | Change | Ticket |",
    "| --- | --- | --- |",
  ];
  for (const c of numbered) {
    const title = c.heading?.title ?? c.name;
    lines.push(`| ${c.n} | [${cell(headOf(title))}](${CHANGES_DIR}/${c.name}) | ${ticketOf(title)} |`);
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

/**
 * Where the generated block sits: `{ s, e }` — the offsets just after START and
 * at END. Throws when FORK.md does not carry exactly one pair in order; the check
 * and the writer use the same test.
 */
export function indexSpan(forkText) {
  const s = forkText.indexOf(START);
  const e = forkText.indexOf(END);
  if (s < 0 || e < 0 || e < s || forkText.indexOf(START, s + 1) >= 0 || forkText.indexOf(END, e + 1) >= 0) {
    throw new Error(`FORK.md must carry exactly one \`${START.slice(0, 27)}…\` / \`${END}\` pair`);
  }
  return { s: s + START.length, e };
}

/** FORK.md with the block between the markers replaced. */
export function spliceIndex(forkText, block) {
  const { s, e } = indexSpan(forkText);
  return forkText.slice(0, s) + "\n" + block + forkText.slice(e);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Run as a script (not imported): node resolves the entry through real paths
// while argv[1] keeps the spelling it was given, so compare real paths.
const isMain = (() => { try { return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } })();
if (isMain) {
  const fork = join(ROOT, "FORK.md");
  const changes = readChanges(ROOT);
  writeFileSync(fork, spliceIndex(readFileSync(fork, "utf8"), renderIndex(changes)));
  console.log(`wrote the index into FORK.md (${changes.numbered.length} numbered changes, ${changes.fragments.length} fragments)`);
}
