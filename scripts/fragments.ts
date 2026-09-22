/**
 * fragments.ts — read and validate a changes/smd-NNNN.md release fragment
 * (SMD-1804).
 *
 * One definition of what a fragment is — its parts AND its rules
 * (fragmentProblems) — shared by the check that validates them
 * (check-fork-consistency.ts, check 16) and the release step that consumes
 * them (assemble-release.ts), so the two cannot disagree and a cut refuses
 * what CI would (SMD-1917). Plain string work, no Bun API.
 */
import { ticketsOf } from "./fork-index.ts";

/** Front matter as parsed: a scalar per key, or a list for `[a, b]` / `- item` forms. */
export type FragmentFrontMatter = Record<string, string | string[]>;

/** Split `---` front matter and the body of a fragment; null if no front matter. */
export function parseFragment(text: string): { fm: FragmentFrontMatter; body: string } | null {
  // An editor's byte-order mark or CRLF endings are not a missing front matter.
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"));
  if (!m) return null;
  const fm: FragmentFrontMatter = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].replace(/\s+#.*$/, "").trim(); // an inline `# comment` (the README's template carries them) is not the value
    if (val === "") {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(lines[++i].replace(/^\s*-\s+/, "").replace(/\s+#.*$/, "").trim());
      fm[key] = items;
    } else if (val.startsWith("[")) {
      fm[key] = val.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      fm[key] = val.replace(/^["']|["']$/g, "");
    }
  }
  return { fm, body: m[2] };
}

/**
 * A `## <name>` body from a fragment: null when the heading is absent, "" when it
 * is there and empty. `## Changelog` runs to the next `## `; `## FORK` runs to
 * the END of the file — the record may carry `## ` sub-headings of its own, as
 * changes 19 and 79 do, so a second-level heading cannot end it (a Changelog
 * placed after it is refused by fragmentProblems).
 */
export function fragmentSection(body: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\n)## ${name}[ \\t]*(?:\\n|$)([\\s\\S]*?)${name === "FORK" ? "$" : "(?=\\n## |$)"}`).exec(body);
  if (!m) return null;
  const text = m[1].trim();
  return name !== "FORK" && text.startsWith("## ") ? "" : text; // an empty section: the lazy capture ran into the next heading
}

export const FRAGMENT_TYPES = new Set(["added", "changed", "deprecated", "removed", "fixed", "security"]);
export const BUMPS = new Set(["major", "minor", "patch"]);

/**
 * What is wrong with a fragment's text, in words — nothing when it is well
 * formed: front matter naming a Keep a Changelog type, a bump the migrations it
 * lists allow, SMD-#### tickets and three-digit migrations; before the FORK
 * body exactly one `## Changelog` — one to three plain lines (no bullet, heading
 * or list marker; the release step writes the `- `) naming every listed ticket
 * and no other — then `## FORK`, nothing between them (a section there is written
 * nowhere); the FORK body runs to the end of the file, its first line the plain
 * title ending in every ticket the front matter lists (check 17b reads a
 * released ticket from that title once it is a numbered file), nothing on the
 * second line, `## ` sub-headings of its own kept, and no numbered heading.
 */
export function fragmentProblems(text: string, name?: string): string[] {
  const problems: string[] = [];
  const parsed = parseFragment(text);
  if (!parsed) { problems.push("no `---` front matter"); return problems; }
  const { fm, body } = parsed;
  // The name's ticket (changes/smd-NNNN.md) is one the front matter lists: the
  // index and the duplicate rule read the name, the changelog and the pairing the
  // front matter, and the two must not disagree.
  const named = name && /^smd-(\d+)\.md$/.exec(name);
  if (named && Array.isArray(fm.tickets) && !fm.tickets.includes(`SMD-${Number(named[1])}`)) problems.push(`is named for SMD-${Number(named[1])}, which its \`tickets:\` does not list`);
  if (typeof fm.type !== "string" || !FRAGMENT_TYPES.has(fm.type)) problems.push(`type must be one of ${[...FRAGMENT_TYPES].join("|")}, got ${JSON.stringify(fm.type ?? null)}`);
  if (typeof fm.bump !== "string" || !BUMPS.has(fm.bump)) problems.push(`bump must be one of ${[...BUMPS].join("|")}, got ${JSON.stringify(fm.bump ?? null)}`);
  const tickets = Array.isArray(fm.tickets) ? fm.tickets : [];
  if (tickets.length === 0) problems.push("tickets: must list at least one SMD-#### id");
  for (const t of tickets) if (!/^SMD-\d+$/.test(t)) problems.push(`tickets: ${JSON.stringify(t)} is not an SMD-#### id`);
  const migrations = Array.isArray(fm.migrations) ? fm.migrations : [];
  for (const mig of migrations) if (!/^\d{3}$/.test(String(mig))) problems.push(`migrations: ${JSON.stringify(mig)} is not a three-digit number`);
  if (fm.bump === "patch" && migrations.length > 0) problems.push(`bump: patch cannot ship a migration (migrations: ${migrations.join(", ")}) — a migration is additive, at least a MINOR`);
  const changelog = fragmentSection(body, "Changelog");
  const fork = fragmentSection(body, "FORK");
  const forkAt = body.search(/(?:^|\n)## FORK[ \t]*(?:\n|$)/);
  const changelogAt = body.search(/(?:^|\n)## Changelog[ \t]*(?:\n|$)/);
  if (changelog === null) problems.push("missing a `## Changelog` section");
  else if (changelog === "") problems.push("the `## Changelog` section is empty — one to three lines for CHANGELOG.md, ending in the ticket and migration numbers");
  else {
    const n = changelog.split("\n").map((s) => s.trim()).filter(Boolean).length;
    if (n < 1 || n > 3) problems.push(`the \`## Changelog\` body is ${n} line(s); Keep a Changelog wants 1–3`);
    if (changelog.split("\n").some((l) => /^\s*(?:[-*+]\s|#|\d+\.\s)/.test(l))) problems.push("a `## Changelog` line is a bullet, a heading or a list item — the release step writes the `- `; give it plain sentences");
    // The changelog line is what the release pairing (check 17b) reads a version's
    // tickets from: it names every front-matter ticket and no other.
    const named = new Set([...changelog.matchAll(/\bSMD-(\d+)\b/g)].map((m) => `SMD-${m[1]}`));
    const declared = tickets.filter((t) => /^SMD-\d+$/.test(t));
    const missing = declared.filter((t) => !named.has(t));
    const extra = [...named].filter((t) => !declared.includes(t));
    if (missing.length) problems.push(`the \`## Changelog\` body does not name ${missing.join(", ")} — it ends in every ticket the front matter lists; the release pairing reads a version's tickets from it`);
    if (extra.length) problems.push(`the \`## Changelog\` body names ${extra.join(", ")}, which the front matter does not list — CHANGELOG.md would pair a version with a ticket it does not carry; cite the other ticket in the FORK body instead`);
  }
  // One of each section, in order, nothing between: a second `## Changelog` or a
  // `## Notes` before `## FORK` is content the cut writes nowhere.
  const headingsBeforeFork = [...body.slice(0, forkAt < 0 ? body.length : forkAt).matchAll(/(?:^|\n)## ([^\n]*)/g)].map((m) => m[1].trim());
  if (headingsBeforeFork.filter((h) => h === "Changelog").length > 1) problems.push("two `## Changelog` sections — one, of one to three lines");
  for (const h of headingsBeforeFork) if (h !== "Changelog") problems.push(`a \`## ${h}\` section before \`## FORK\` — the cut writes it nowhere; a fragment is \`## Changelog\` then \`## FORK\` (put the rest in the record)`);
  if (fork === null) problems.push("missing a `## FORK` section");
  else if (fork === "") problems.push("the `## FORK` section is empty — its first line is the title, then the record");
  else if (changelogAt > forkAt) problems.push("the `## Changelog` section sits after `## FORK` — the FORK body runs to the end of the file (its own `## ` sub-headings included), so the Changelog comes first");
  else {
    const [first, second = ""] = fork.split("\n");
    if (/^#/.test(first)) problems.push("the `## FORK` body opens with a heading — its first line is the plain title (what follows `# N. ` once numbered); the release step writes the heading");
    else if (second.trim() !== "") problems.push("the `## FORK` body's title runs onto a second line — one line for the title, then a blank line, then the record (a wrapped title would become the file's first paragraph)");
    else {
      const named = new Set(ticketsOf(first));
      const missing = tickets.filter((t) => /^SMD-\d+$/.test(t) && !named.has(t));
      if (missing.length) problems.push(`the \`## FORK\` title does not end in ${missing.join(", ")} — the title names every ticket the front matter lists, as "(SMD-1 / 2)", so the release pairing can read them from the numbered file`);
    }
    const prose = fork.replace(/^```[\s\S]*?^```/gm, ""); // a `# 1. install` comment in a fenced snippet is not a heading
    if (/\n#{1,6} \d+\. |# change \d+/i.test("\n" + prose)) problems.push("the `## FORK` body carries a numbered heading — the release step assigns the change number and writes the `# N.` heading");
  }
  return problems;
}
