/**
 * fragments.mjs — read a changes/<ticket>.md release fragment (SMD-1804).
 *
 * One definition of what a fragment is, shared by the check that validates them
 * (check-fork-consistency.mjs, check 16) and the assembler that consumes them
 * (assemble-release.mjs), so the two cannot disagree. Plain string work — node
 * and bun both run it.
 */

/** Split `---` front matter and the body of a fragment; null if no front matter. */
export function parseFragment(text) {
  // An editor's byte-order mark or CRLF endings are not a missing front matter.
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"));
  if (!m) return null;
  const fm = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (val === "") {
      const items = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(lines[++i].replace(/^\s*-\s+/, "").trim());
      fm[key] = items;
    } else if (val.startsWith("[")) {
      fm[key] = val.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      fm[key] = val.replace(/^["']|["']$/g, "");
    }
  }
  return { fm, body: m[2] };
}

/** A `## <name>` body from a fragment (up to the next `## ` or the end). */
export function fragmentSection(body, name) {
  const m = new RegExp(`(?:^|\\n)## ${name}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(body);
  return m ? m[1].trim() : null;
}
