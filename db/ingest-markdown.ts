/**
 * ingest-markdown.ts — the Markdown / Obsidian adapter: the second
 * implementation of the ingestion contract, and the one that proves the
 * round-trip rule (SMD-1867's Verify; SMD-1814's connector reads through it).
 *
 * One file → one thought. The CANONICAL is the file's bytes, decoded strictly
 * — a file that is not UTF-8 or holds NUL is refused (AdapterRefusal), never
 * stored with a replacement character where the source had a byte. The text
 * is a clean projection: the frontmatter gone, a title line, `[[wikilinks]]`
 * flattened to their alias or note name, embeds to their name, block ids,
 * callout markers and `%%comments%%` removed, highlights unwrapped; the rest
 * of the Markdown is kept — it is human-readable. The structure becomes edges
 * and facets with no model call:
 *
 *   [[Note]], [[Note#heading|alias]], ![[Note]]   →  references Note
 *   #tag (inline) and frontmatter `tags:`         →  mentions (topic)
 *   frontmatter                                   →  facets.frontmatter, title, tags
 *
 * Identity (SMD-1813's rule): the frontmatter `id` when the note has one,
 * else the note's NAME — the file name without `.md`, which is how Obsidian
 * itself resolves a wikilink, so a link's target and its note's identity meet
 * without a resolver. The cases this cannot cover are ENUMERATED below
 * (MARKDOWN_LOSSY / MARKDOWN_LIMITS), each with a self-check that shows the
 * canonical unharmed where the text is not.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { AdapterRefusal, decodeUtf8Strict, IDENTITY_MAX, normaliseLinks, normaliseMentions, type Adapter, type Ingested, type Link, type Mention } from "./ingest-contract.ts";

/**
 * What Obsidian embeds that is not a note: images, audio, video, PDFs and
 * canvases. A wikilink to one of these is a file reference, not an edge to a
 * note. An explicit list, not "anything with a dot and letters": a note may be
 * called `v1.2` or `Plan Q3.2026` (first review pass).
 */
export const NON_NOTE_EXTENSIONS = /\.(?:png|jpe?g|gif|svg|webp|bmp|avif|mp3|wav|m4a|ogg|3gp|flac|mp4|webm|ogv|mov|mkv|pdf|canvas|base)$/i;

export const MARKDOWN_SYSTEM = "markdown";
export const MARKDOWN_MEDIA_TYPE = "text/markdown";

/** One file of a vault: its vault-relative path (posix), its bytes, and the vault root — the scope. */
export type MarkdownFile = { path: string; bytes: Uint8Array; root: string };

/** A frontmatter value as this reader yields it: a scalar string or a list of strings. */
export type Frontmatter = Record<string, string | string[]>;

/**
 * The leading `---` fence, read minimally: `key: value`, `key: [a, b]`, and a
 * block list (`key:` then `- item` lines). Not a YAML parser — vault
 * frontmatter is flat and mostly machine-written; a value this reader does
 * not understand is kept as its raw text. Returns the body after the fence and
 * the fence's own text, so the text projection can drop exactly it.
 */
export function parseFrontmatter(md: string): { fm: Frontmatter; body: string; fence: string } {
  if (!md.startsWith("---\n") && !md.startsWith("---\r\n")) return { fm: {}, body: md, fence: "" };
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md);
  if (!m) return { fm: {}, body: md, fence: "" };
  const fm: Frontmatter = {};
  let listKey: string | null = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && listKey) { (fm[listKey] as string[]).push(unquote(item[1])); continue; }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (!kv) { listKey = null; continue; }
    const [, key, value] = kv;
    if (value === "") { fm[key] = []; listKey = key; continue; }
    listKey = null;
    const list = /^\[(.*)\]$/.exec(value);
    fm[key] = list ? list[1].split(",").map((s) => unquote(s)).filter(Boolean) : unquote(value);
  }
  return { fm, body: md.slice(m[0].length), fence: m[0] };
}
function unquote(s: string): string {
  const t = s.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/** A wikilink as written: the note it names (path segments dropped, `.md` dropped), the heading or block after `#`, the alias after `|`, and whether it was an embed. */
export type Wikilink = { note: string; anchor: string | null; alias: string | null; embed: boolean; raw: string };

const WIKILINK_RE = /(!?)\[\[([^\[\]|#]*)(?:#([^\[\]|]*))?(?:\|([^\[\]]*))?\]\]/g;

/** Every wikilink in the text, in order, embeds included. */
export function wikilinks(md: string): Wikilink[] {
  const out: Wikilink[] = [];
  for (const m of stripComments(md).matchAll(WIKILINK_RE)) {
    const target = m[2].trim();
    const note = target.split("/").filter(Boolean).at(-1)?.replace(/\.md$/i, "") ?? "";
    out.push({ note, anchor: m[3]?.trim() || null, alias: m[4]?.trim() || null, embed: m[1] === "!", raw: m[0] });
  }
  return out;
}

/** `#tag` and `#nested/tag` in prose — not a heading (`# Title`), not inside a code span or fence, not a bare `#`. */
export function inlineTags(md: string): string[] {
  const out: string[] = [];
  const text = stripComments(md).replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  for (const m of text.matchAll(/(?:^|[\s(])#([A-Za-z_][\w\/-]*)/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Obsidian's `%%comment%%` — never shown, never text. */
function stripComments(md: string): string {
  return md.replace(/%%[\s\S]*?%%/g, "");
}

/**
 * The clean projection. Title line (frontmatter `title`, else the note name),
 * blank, then the body with the markup below flattened. Whitespace at the
 * ends trimmed; interior Markdown kept.
 */
export function markdownText(md: string, noteName: string): string {
  const { fm, body } = parseFrontmatter(md);
  const title = typeof fm.title === "string" && fm.title ? fm.title : noteName;
  let text = stripComments(body);
  text = text.replace(WIKILINK_RE, (_raw, embed: string, target: string, anchor?: string, alias?: string) => {
    const note = target.trim().split("/").filter(Boolean).at(-1)?.replace(/\.md$/i, "") ?? "";
    if (alias?.trim()) return alias.trim();
    if (embed === "!" || !anchor?.trim()) return note || anchor?.trim() || "";
    return note ? `${note} › ${anchor.trim()}` : anchor.trim();
  });
  text = text.replace(/^(>\s*)\[!([A-Za-z-]+)\][+-]?\s?/gm, "$1");
  text = text.replace(/[ \t]+\^[A-Za-z0-9-]+$/gm, "");
  text = text.replace(/==([^=\n]+)==/g, "$1");
  return `${title}\n\n${text.trim()}`.trim();
}

/** The identity: frontmatter `id` (or `uuid`), else the note name. */
export function markdownIdentity(fm: Frontmatter, noteName: string): string {
  const id = typeof fm.id === "string" ? fm.id : typeof fm.uuid === "string" ? fm.uuid : "";
  return id.trim() || noteName;
}

/** The note name a path resolves to: the file name without `.md`. */
export function noteNameOf(path: string): string {
  return path.split("/").filter(Boolean).at(-1)!.replace(/\.md$/i, "");
}

/** The tags a note carries, frontmatter and inline, `#` dropped, each once. */
export function noteTags(fm: Frontmatter, body: string): string[] {
  const fmTags = Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === "string" ? fm.tags.split(/[,\s]+/) : [];
  const out: string[] = [];
  for (const t of [...fmTags, ...inlineTags(body)]) { const tag = t.replace(/^#/, "").trim(); if (tag && !out.includes(tag)) out.push(tag); }
  return out;
}

/** A frontmatter date the timestamptz cast accepts (a date or an ISO timestamp), or nothing. */
const DATE_RE = /^\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?)?$/;
export function noteCreatedAt(fm: Frontmatter): string | undefined {
  for (const k of ["created", "date", "created_at"]) {
    const v = fm[k];
    if (typeof v === "string" && DATE_RE.test(v.trim())) return v.trim();
  }
  return undefined;
}

/** The adapter. */
export const markdownAdapter: Adapter<MarkdownFile> = {
  system: MARKDOWN_SYSTEM,
  map(file: MarkdownFile): Ingested {
    const noteName = noteNameOf(file.path);
    const decoded = decodeUtf8Strict(file.bytes);
    if (!decoded.ok) throw new AdapterRefusal({ system: MARKDOWN_SYSTEM, key: noteName }, `${file.path} ${decoded.reason}`);
    const md = decoded.text;
    const { fm, body } = parseFrontmatter(md);
    const key = markdownIdentity(fm, noteName);
    if (key.length > IDENTITY_MAX) throw new AdapterRefusal({ system: MARKDOWN_SYSTEM, key: key.slice(0, 40) + "…" }, `${file.path} has an identity of ${key.length} characters; thought_sources.identity holds ${IDENTITY_MAX}`);
    const tags = noteTags(fm, body);
    const links: Link[] = wikilinks(body).filter((w) => w.note && !NON_NOTE_EXTENSIONS.test(w.note)).map((w) => ({ relation: "references", target: w.note }));
    const mentions: Mention[] = tags.map((t) => ({ name: t, type: "topic" as const }));
    const { id: _id, uuid: _uuid, ...rest } = fm;
    return {
      identity: { system: MARKDOWN_SYSTEM, key },
      scope: file.root,
      canonical: { form: md, mediaType: MARKDOWN_MEDIA_TYPE },
      text: markdownText(md, noteName),
      links: normaliseLinks(links, key).links,
      mentions: normaliseMentions(mentions),
      facets: { path: file.path, note: noteName, title: typeof fm.title === "string" ? fm.title : noteName, tags, ...(Object.keys(rest).length ? { frontmatter: rest } : {}) },
      createdAt: noteCreatedAt(fm),
    };
  },
};

/** Every `.md` file under a vault root, `.obsidian/`, `.trash/`, `.git/` and `node_modules/` skipped, paths vault-relative and posix. */
export function markdownFiles(root: string): MarkdownFile[] {
  const out: MarkdownFile[] = [];
  const skip = new Set([".obsidian", ".trash", ".git", "node_modules"]);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (skip.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.md$/i.test(name)) out.push({ path: relative(root, full).split(sep).join("/"), bytes: new Uint8Array(readFileSync(full)), root });
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// What the text cannot reproduce, enumerated — each a case the canonical holds
// ---------------------------------------------------------------------------

/** A construct the clean text flattens: the canonical keeps it, the text does not, and `export` is the canonical — so the round trip is exact and the loss is the projection's alone. */
export const MARKDOWN_LOSSY: { name: string; input: string; text: RegExp }[] = [
  { name: "frontmatter", input: "---\ntitle: A note\ntags: [x]\n---\nbody", text: /^A note\n\nbody$/ },
  { name: "wikilink alias", input: "see [[Target|the alias]]", text: /see the alias$/ },
  { name: "wikilink heading anchor", input: "see [[Target#Section]]", text: /see Target › Section$/ },
  { name: "path in a wikilink", input: "see [[folder/sub/Target.md]]", text: /see Target$/ },
  { name: "embed marker", input: "![[Diagram]]", text: /\n\nDiagram$/ },
  { name: "block id", input: "a claim ^abc123", text: /a claim$/ },
  { name: "callout kind", input: "> [!warning] Mind the gap\n> text", text: /> Mind the gap\n> text$/ },
  { name: "folded callout", input: "> [!note]- Folded\n> text", text: /> Folded\n> text$/ },
  { name: "comment", input: "shown %%hidden%% shown", text: /shown  shown$/ },
  { name: "highlight", input: "a ==marked== word", text: /a marked word$/ },
];

/** A limit of the identity or the link rule, stated rather than discovered. */
export const MARKDOWN_LIMITS: readonly string[] = [
  "A note without a frontmatter `id` is identified by its name: renaming it is a new identity (the old row stays; a connector reconciles), and two notes of one name in different folders collide — the first in walk order keeps the identity, the ingester refuses the rest by name, and the fix is a frontmatter id.",
  "A file that is not UTF-8, or holds a NUL byte, is refused, not stored: a text column cannot hold it byte for byte. So is an identity over 512 characters, the column's bound.",
  "A wikilink to an image, audio, video, PDF or canvas file (NON_NOTE_EXTENSIONS) is a file reference, not an edge to a note; a note named `v1.2` is still a note.",
  "Frontmatter is read minimally (scalars, `[a, b]`, `- item` lists); a nested mapping is kept as raw text under its key.",
];

export function selfCheck(): number {
  let bad = 0;
  const ok = (cond: boolean, label: string) => { if (!cond) { console.error(`FAIL ${label}`); bad++; } };
  const bytes = (s: string) => new TextEncoder().encode(s);
  const file = (path: string, s: string): MarkdownFile => ({ path, bytes: bytes(s), root: "/vault" });

  const md = "---\nid: note-1\ntitle: Ingestion contract\ntags: [design, ingest]\ncreated: 2026-09-21\naliases:\n  - contract\n---\n# Heading\n\nSee [[Adapter|the adapter]] and [[Pipeline#Writes]], then ![[Diagram]] and ![[img.png]]. #linear #wiki/sync %%todo%%\n\n> [!note] Why\n> because ^blk1\n";
  const out = markdownAdapter.map(file("design/Ingestion contract.md", md));
  ok(out.identity.key === "note-1" && out.identity.system === "markdown", "identity is the frontmatter id");
  ok(out.canonical.form === md && out.canonical.mediaType === "text/markdown", "the canonical is the file, byte for byte");
  ok(out.text === "Ingestion contract\n\n# Heading\n\nSee the adapter and Pipeline › Writes, then Diagram and img.png. #linear #wiki/sync \n\n> Why\n> because", `the text: title, body with links flattened, comment and block id and callout marker gone (${JSON.stringify(out.text)})`);
  ok(JSON.stringify(out.links) === JSON.stringify([{ relation: "references", target: "Adapter" }, { relation: "references", target: "Diagram" }, { relation: "references", target: "Pipeline" }]), `links: the notes named, embeds included, the image not (${JSON.stringify(out.links)})`);
  ok(JSON.stringify(out.mentions.map((m) => m.name)) === JSON.stringify(["design", "ingest", "linear", "wiki/sync"]), `mentions: frontmatter and inline tags as topics (${JSON.stringify(out.mentions)})`);
  ok(out.scope === "/vault" && out.createdAt === "2026-09-21" && out.facets.title === "Ingestion contract" && out.facets.note === "Ingestion contract" && JSON.stringify((out.facets.frontmatter as Frontmatter).aliases) === '["contract"]', "scope is the root; created, title and the rest of the frontmatter are facets");
  ok(!("id" in (out.facets.frontmatter as Frontmatter)), "the id is the identity, not a facet");

  const plain = markdownAdapter.map(file("a/Plain note.md", "Just text with a #tag."));
  ok(plain.identity.key === "Plain note" && plain.text === "Plain note\n\nJust text with a #tag." && plain.mentions[0]?.name === "tag" && plain.links.length === 0 && plain.createdAt === undefined, "a note with no frontmatter: the name is the identity and the title");
  ok(markdownAdapter.map(file("Self.md", "[[Self]] and [[Other]]")).links.map((l) => l.target).join(",") === "Other", "a link to the note itself is dropped");
  ok(markdownAdapter.map(file("N.md", "[[v1.2]] [[Plan Q3.2026]] ![[photo.JPG]] [[deck.pdf]] [[board.canvas]]")).links.map((l) => l.target).join(",") === "Plan Q3.2026,v1.2", "a dotted note name is a note; an image, a PDF and a canvas are files (first review pass)");
  let tooLong = "";
  try { markdownAdapter.map(file("long.md", `---\nid: ${"x".repeat(513)}\n---\nbody`)); } catch (e) { tooLong = (e as Error).message; }
  ok(/513 characters/.test(tooLong), `an identity over the column's bound is refused by the adapter, not by the write (${tooLong.slice(0, 60)})`);

  for (const c of MARKDOWN_LOSSY) {
    const r = markdownAdapter.map(file("N.md", c.input));
    ok(r.canonical.form === c.input, `lossy case "${c.name}": the canonical is the input byte for byte`);
    ok(c.text.test(r.text) && r.text !== c.input, `lossy case "${c.name}": the text flattens it (${JSON.stringify(r.text)})`);
  }
  ok(MARKDOWN_LIMITS.length >= 4, "the limits are enumerated");

  let refused = "";
  try { markdownAdapter.map({ path: "bad.md", bytes: new Uint8Array([0x61, 0xff, 0x62]), root: "/v" }); } catch (e) { refused = (e as Error).message; }
  ok(/not valid UTF-8/.test(refused), `invalid UTF-8 is refused (${refused})`);
  refused = "";
  try { markdownAdapter.map({ path: "nul.md", bytes: new Uint8Array([0x61, 0x00, 0x62]), root: "/v" }); } catch (e) { refused = (e as Error).message; }
  ok(/NUL/.test(refused), `a NUL byte is refused (${refused})`);
  const bom = markdownAdapter.map({ path: "bom.md", bytes: new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]), root: "/v" });
  ok(bom.canonical.form === "\ufeffhi", "a BOM is a byte of the source and stays in the canonical");

  const fm = parseFrontmatter("---\ntitle: \"Quoted\"\nlist:\n  - a\n  - b\nempty:\n---\nbody\n");
  ok(fm.fm.title === "Quoted" && JSON.stringify(fm.fm.list) === '["a","b"]' && JSON.stringify(fm.fm.empty) === "[]" && fm.body === "body\n", "frontmatter: quotes dropped, block lists read, an empty key is an empty list");
  ok(parseFrontmatter("---\nno closing fence").fence === "" && parseFrontmatter("text\n---\nnot frontmatter\n---\n").fence === "", "an unclosed or non-leading fence is body");
  ok(inlineTags("# Heading\n#tag1 and (#tag2) `#not` and ```\n#nor\n``` and a#b").join(",") === "tag1,tag2", "inline tags: not headings, not code, not mid-word");
  ok(wikilinks("[[A]] ![[B|b]] [[C#h|c]]").map((w) => `${w.embed ? "!" : ""}${w.note}${w.anchor ? "#" + w.anchor : ""}${w.alias ? "|" + w.alias : ""}`).join(" ") === "A !B|b C#h|c", "wikilinks parsed with anchor, alias and embed");

  if (bad === 0) console.log("ingest-markdown.ts self-check PASS");
  return bad === 0 ? 0 : 1;
}

if (import.meta.main) {
  if (process.argv.includes("--self-check")) process.exit(selfCheck());
  console.error("ingest-markdown.ts is a library — the Markdown/Obsidian adapter for db/ingest-records.ts. `--self-check` runs its pure rules.");
  process.exit(2);
}
