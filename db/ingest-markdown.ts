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
 * Identity: the note's NAME — the file name without `.md`, which is what a
 * wikilink names and how Obsidian itself resolves one, so a link's target and
 * its note's identity meet without a resolver and a note cannot link to itself
 * under another key. A frontmatter `id` is a facet, for a connector to
 * reconcile a rename by (SMD-1813's rule is met there, not here — no wikilink
 * names an id). The cases this cannot cover are ENUMERATED below
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

/** A frontmatter property line: `key:` then whitespace and a value, or the line's end. The value group is empty for a bare `key:`. */
const PROPERTY_RE = /^(?!-\s)([^\s:#][^:]*?):(?:[ \t]+(.*))?$/;
/** A line that belongs to a property block without being a property of its own: an indented continuation (a multi-line scalar, a nested mapping's lines), a list item, a YAML comment, or blank. */
const PROPERTY_CONTINUATION_RE = /^\s+\S|^\s*-\s+|^\s*#|^\s*$/;

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
  // A fence that parses no `key:` line is not frontmatter: a note that opens
  // with a horizontal rule, some text and another rule is body from its first
  // byte (third review pass, independent read — the text lost its first
  // section).
  // …and every non-blank line of it parses as a property (`key: …`) or a list
  // item — what Obsidian reads as properties, this reads as properties; a fence
  // holding a line that is neither is a horizontal rule and prose (fourth
  // review pass: "at least one key" let a bare URL line through as body lost).
  // A property is `key:` followed by whitespace or the line's end — `https://x`
  // is a word and a colon, not a property (the first spelling took it as one).
  // A column-0 line that is neither a property nor a list item nor a comment
  // makes the fence body; an indented line is a continuation (a `>-` scalar's
  // lines, a nested mapping's) and belongs to the block (fifth review pass —
  // "every line a property" refused valid frontmatter Obsidian reads).
  if (!m[1].split(/\r?\n/).every((l) => PROPERTY_RE.test(l) || PROPERTY_CONTINUATION_RE.test(l))) return { fm: {}, body: md, fence: "" };
  const fm: Frontmatter = {};
  // The property an indented or `- ` line continues: a list under a bare
  // `key:`, a block scalar under `key: >-` / `key: |` (its lines joined by a
  // space or a newline), or a nested mapping under a bare `key:` — whose lines
  // are dropped and whose key is dropped with them, rather than left as an
  // empty list that says something the file did not (sixth review pass).
  let open: { key: string; kind: "list" | "fold" | "keep" | "map" } | null = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (open && (open.kind === "fold" || open.kind === "keep") && /^\s+\S/.test(raw)) {
      const cur = fm[open.key] as string;
      fm[open.key] = cur ? `${cur}${open.kind === "fold" ? " " : "\n"}${raw.trim()}` : raw.trim();
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && open && open.kind === "list") { (fm[open.key] as string[]).push(unquote(item[1])); continue; }
    if (open && open.kind === "list" && /^\s+\S/.test(raw)) { delete fm[open.key]; open = { key: open.key, kind: "map" }; continue; }
    if (open && open.kind === "map" && /^\s+\S/.test(raw)) continue;
    const kv = PROPERTY_RE.exec(raw);
    if (!kv) { open = null; continue; }
    const [, key, rawValue = ""] = kv;
    // A trailing YAML comment is not part of an unquoted value (sixth review pass: `[a, b] # c` yielded a tag `[a`).
    const value = /^["']/.test(rawValue.trim()) ? rawValue.trim() : rawValue.replace(/\s+#.*$/, "").trim();
    if (value === "") { fm[key] = []; open = { key, kind: "list" }; continue; }
    if (/^[>|][+-]?$/.test(value)) { fm[key] = ""; open = { key, kind: value.startsWith(">") ? "fold" : "keep" }; continue; }
    open = null;
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
  // Not inside a code fence or span: `[[x]]` there is text about a link, as
  // inlineTags already reads a `#` there (third review pass, independent read).
  for (const m of stripComments(stripCode(md)).matchAll(WIKILINK_RE)) {
    const target = m[2].trim();
    const note = target.split("/").filter(Boolean).at(-1)?.replace(/\.md$/i, "") ?? "";
    out.push({ note, anchor: m[3]?.trim() || null, alias: m[4]?.trim() || null, embed: m[1] === "!", raw: m[0] });
  }
  return out;
}

/** Code fences and spans blanked: what is written there is text about Markdown, not Markdown. */
function stripCode(md: string): string {
  return md.replace(CODE_RE, " ");
}
/** A backtick or tilde fence, or an inline span. */
const CODE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;

/**
 * The text with its code segments set aside and put back unchanged after `fn`
 * ran over the prose — so a `[[link]]` or a `#tag` inside a fence or span is
 * text about Markdown in the projection too, as it is for the link set
 * (fourth review pass: the two disagreed on a fenced `[[…]]`).
 */
function outsideCode(md: string, fn: (prose: string) => string): string {
  const kept: string[] = [];
  const marked = md.replace(CODE_RE, (seg) => { kept.push(seg); return `\u0000${kept.length - 1}\u0000`; });
  return fn(marked).replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)]);
}

/** Obsidian resolves a note name case-insensitively (a vault on a case-insensitive filesystem has one `Self.md` whatever the case a link wrote); the identity and every link target are folded so they meet. */
export function noteKey(name: string): string {
  // NFC first: a macOS walk hands back NFD file names while Obsidian writes a
  // link's text NFC, and `Café` in the two forms would not meet (fifth review pass).
  return name.normalize("NFC").toLowerCase();
}

/** `#tag` and `#nested/tag` in prose — not a heading (`# Title`), not inside a code span or fence, not a bare `#`. */
export function inlineTags(md: string): string[] {
  const out: string[] = [];
  // Code first, then comments: a `%%` inside a fence must not pair with one in prose (fifth review pass).
  const text = stripComments(stripCode(md));
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
  const text = outsideCode(body, (prose) => {
    let t = stripComments(prose).replace(WIKILINK_RE, (_raw, embed: string, target: string, anchor?: string, alias?: string) => {
      const note = target.trim().split("/").filter(Boolean).at(-1)?.replace(/\.md$/i, "") ?? "";
      if (alias?.trim()) return alias.trim();
      const a = anchor?.trim() ?? "";
      // A block reference (`#^id`) names a position, not a section: the note
      // alone — and nothing at all for a same-note one (`[[#^id]]`).
      if (a.startsWith("^")) return note;
      if (embed === "!" || !a) return note || a;
      return note ? `${note} › ${a}` : a;
    });
    t = t.replace(/^(>\s*)\[!([A-Za-z-]+)\][+-]?\s?/gm, "$1");
    t = t.replace(/[ \t]+\^[A-Za-z0-9-]+$/gm, "");
    t = t.replace(/==([^=\n]+)==/g, "$1");
    return t;
  });
  return `${title}\n\n${text.trim()}`.trim();
}

/** The note name a path resolves to: the file name without `.md`. */
export function noteNameOf(path: string): string {
  return path.split("/").filter(Boolean).at(-1)!.replace(/\.md$/i, "");
}

/** The tags a note carries, frontmatter and inline, `#` dropped, each once. */
export function noteTags(fm: Frontmatter, body: string): string[] {
  const fmTags = Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === "string" ? fm.tags.split(/[,\s]+/) : [];
  const out: string[] = [];
  // One tag per spelling case-insensitively — Obsidian treats `#Linear` and
  // `#linear` as one tag, and the mentions dedupe so already; the first
  // spelling seen is kept (third review pass, independent read).
  const seen = new Set<string>();
  for (const t of [...fmTags, ...inlineTags(body)]) {
    const tag = t.replace(/^#/, "").trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
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
    const key = noteKey(noteName);
    if (key.length > IDENTITY_MAX) throw new AdapterRefusal({ system: MARKDOWN_SYSTEM, key: key.slice(0, 40) + "…" }, `${file.path} has an identity of ${key.length} characters; thought_sources.identity holds ${IDENTITY_MAX}`);
    const tags = noteTags(fm, body);
    const links: Link[] = wikilinks(body).filter((w) => w.note && !NON_NOTE_EXTENSIONS.test(w.note)).map((w) => ({ relation: "references", target: noteKey(w.note) }));
    const mentions: Mention[] = tags.map((t) => ({ name: t, type: "topic" as const }));
    return {
      identity: { system: MARKDOWN_SYSTEM, key },
      scope: file.root,
      canonical: { form: md, mediaType: MARKDOWN_MEDIA_TYPE },
      text: markdownText(md, noteName),
      links: normaliseLinks(links, key).links,
      mentions: normaliseMentions(mentions),
      facets: { path: file.path, note: noteName, title: typeof fm.title === "string" ? fm.title : noteName, tags, ...(Object.keys(fm).length ? { frontmatter: fm } : {}) },
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
  "A note's identity is its NAME, Unicode-normalised (NFC) and folded to lower case — the file name without `.md`, which is what a wikilink names and how Obsidian resolves one, case-insensitively and whatever form the filesystem hands back — so a link's target and its note's identity meet with no resolver, and a note can never link to itself under another spelling. The `note` facet keeps the name as written. The cost: renaming a note is a new identity (the old row stays), and two notes of one name in different folders collide — the first in walk order keeps the identity and the ingester refuses the rest by name. A frontmatter `id` is kept as a facet for a connector (SMD-1814) to reconcile a rename by; it is not the identity, because no wikilink names it.",
  "A file that is not UTF-8, or holds a NUL byte, is refused, not stored: a text column cannot hold it byte for byte. So is a name over 512 characters, the column's bound.",
  "A wikilink to an image, audio, video, PDF or canvas file (NON_NOTE_EXTENSIONS) is a file reference, not an edge to a note; a note named `v1.2` is still a note. A `[[link]]` inside a code fence or span is text about a link, not one.",
  "Frontmatter is read minimally (scalars, `[a, b]`, `- item` lists, `>` / `|` block scalars joined by a space or a newline, a trailing `# comment` dropped from an unquoted value); a nested mapping's lines belong to the block but are dropped from the frontmatter facet along with their key — the canonical keeps them. A leading `---` fence is frontmatter when every column-0 line in it is a property (`key:` then a space or the line's end; the key may hold dots and spaces), a list item or a `#` comment, indented lines being continuation; a fence holding a prose line or a bare URL at column 0 is a horizontal rule and body. A prose line that happens to read `Word: rest` inside such a fence is a property to Obsidian's YAML too, and here.",
];

export function selfCheck(): number {
  let bad = 0;
  const ok = (cond: boolean, label: string) => { if (!cond) { console.error(`FAIL ${label}`); bad++; } };
  const bytes = (s: string) => new TextEncoder().encode(s);
  const file = (path: string, s: string): MarkdownFile => ({ path, bytes: bytes(s), root: "/vault" });

  const md = "---\nid: note-1\ntitle: Ingestion contract\ntags: [design, ingest]\ncreated: 2026-09-21\naliases:\n  - contract\n---\n# Heading\n\nSee [[Adapter|the adapter]] and [[Pipeline#Writes]], then ![[Diagram]] and ![[img.png]]. #linear #wiki/sync %%todo%%\n\n> [!note] Why\n> because ^blk1\n";
  const out = markdownAdapter.map(file("design/Ingestion contract.md", md));
  ok(out.identity.key === "ingestion contract" && out.identity.system === "markdown" && out.facets.note === "Ingestion contract", "identity is the note's name, NFC then lower case — what a wikilink names, as Obsidian resolves it — even with a frontmatter id; the note facet keeps the case (third, fourth and fifth review passes)");
  ok(out.canonical.form === md && out.canonical.mediaType === "text/markdown", "the canonical is the file, byte for byte");
  ok(out.text === "Ingestion contract\n\n# Heading\n\nSee the adapter and Pipeline › Writes, then Diagram and img.png. #linear #wiki/sync \n\n> Why\n> because", `the text: title, body with links flattened, comment and block id and callout marker gone (${JSON.stringify(out.text)})`);
  ok(JSON.stringify(out.links) === JSON.stringify([{ relation: "references", target: "adapter" }, { relation: "references", target: "diagram" }, { relation: "references", target: "pipeline" }]), `links: the notes named, embeds included, the image not; targets folded as identities are (${JSON.stringify(out.links)})`);
  ok(JSON.stringify(out.mentions.map((m) => m.name)) === JSON.stringify(["design", "ingest", "linear", "wiki/sync"]), `mentions: frontmatter and inline tags as topics (${JSON.stringify(out.mentions)})`);
  ok(out.scope === "/vault" && out.createdAt === "2026-09-21" && out.facets.title === "Ingestion contract" && out.facets.note === "Ingestion contract" && JSON.stringify((out.facets.frontmatter as Frontmatter).aliases) === '["contract"]', "scope is the root; created, title and the rest of the frontmatter are facets");
  ok((out.facets.frontmatter as Frontmatter).id === "note-1", "the frontmatter id is a facet, for a connector to reconcile a rename by");
  const withId = markdownAdapter.map(file("Self.md", "---\nid: n1\n---\n[[Self]] and [[Other]] and [[Self#^blk]]"));
  ok(withId.identity.key === "self" && withId.links.map((l) => l.target).join(",") === "other" && /\n\nSelf and Other and Self$/.test(withId.text), `a note with an id: links to itself by name are dropped, a block reference flattens to the note alone (${JSON.stringify(withId.links)} ${JSON.stringify(withId.text)})`);
  const cased = markdownAdapter.map(file("Self.md", "[[self]] [[SELF#Heading]] [[Other]] [[OTHER|o]] [[#^blk]] see"));
  ok(cased.links.map((l) => l.target).join(",") === "other" && cased.text === "Self\n\nself SELF › Heading Other o  see", `wikilinks resolve case-insensitively: every spelling of the note's own name is dropped from the links, two spellings of another are one link; the text keeps each spelling as written; a same-note block reference flattens to nothing (${JSON.stringify(cased.links)} ${JSON.stringify(cased.text)})`);
  const rule = markdownAdapter.map(file("Rule.md", "---\n\nSome text the reader must keep\n\n---\n\nmore"));
  ok(rule.text === "Rule\n\n---\n\nSome text the reader must keep\n\n---\n\nmore" && !("frontmatter" in rule.facets), `a leading horizontal rule is body, not frontmatter (${JSON.stringify(rule.text)})`);
  const urlRule = markdownAdapter.map(file("U.md", "---\ntitle: kept\nhttps://example.com\n---\nmore"));
  ok(/https:\/\/example\.com/.test(urlRule.text) && !("frontmatter" in urlRule.facets), `a fence holding a line that is not a property is body, even beside one that is (fourth review pass) (${JSON.stringify(urlRule.text)})`);
  const propsOnly = markdownAdapter.map(file("P.md", "---\ntitle: T\ntags:\n  - a\n---\nbody"));
  ok(propsOnly.facets.title === "T" && JSON.stringify(propsOnly.facets.tags) === '["a"]', "a fence of properties and list items alone is frontmatter");
  const yaml = markdownAdapter.map(file("Y.md", "---\ntitle: T\ncreated: 2026-09-21\n# generated by templater\ndescription: >-\n  a long\n  value\nmeta:\n  sub: v\nmy key: with spaces\ndc.title: dotted\ntags: [a]\n---\nbody"));
  ok(yaml.facets.title === "T" && yaml.createdAt === "2026-09-21" && JSON.stringify(yaml.facets.tags) === '["a"]' && (yaml.facets.frontmatter as Frontmatter)["my key"] === "with spaces" && (yaml.facets.frontmatter as Frontmatter)["dc.title"] === "dotted" && yaml.text === "T\n\nbody", `frontmatter with a multi-line scalar, a nested mapping, a comment and keys with a space and a dot is frontmatter (fifth review pass) (${JSON.stringify(yaml.facets.frontmatter)} ${JSON.stringify(yaml.text)})`);
  const yfm = yaml.facets.frontmatter as Frontmatter;
  ok(yfm.description === "a long value" && !("meta" in yfm), `a folded block scalar is joined by spaces; a nested mapping's key is dropped with its lines, not left as an empty list (sixth review pass) (${JSON.stringify(yfm)})`);
  const blockTitle = markdownAdapter.map(file("B.md", "---\ntitle: >-\n  A long\n  title\nnotes: |\n  line one\n  line two\ntags: [a, b] # trailing comment\n-x: v\n---\nbody"));
  ok(blockTitle.facets.title === "A long title" && blockTitle.text === "A long title\n\nbody" && (blockTitle.facets.frontmatter as Frontmatter).notes === "line one\nline two" && JSON.stringify(blockTitle.facets.tags) === '["a","b"]' && (blockTitle.facets.frontmatter as Frontmatter)["-x"] === "v", `a block-scalar title is the title, not '>-'; a literal block keeps its newlines; a trailing comment is not part of a list; a hyphen-led key is a key (sixth review pass) (${JSON.stringify(blockTitle.facets)} ${JSON.stringify(blockTitle.text)})`);
  ok(noteKey("Café") === noteKey("Café") && noteKey("Café") === "café", "a note name meets its link whatever the Unicode form the filesystem handed back (NFC, then lower case)");
  const fenceComment = markdownAdapter.map(file("F.md", "```\nx %% y\n```\nprose %% z"));
  ok(fenceComment.text === "F\n\n```\nx %% y\n```\nprose %% z", `a %% inside a fence does not pair with one in prose (${JSON.stringify(fenceComment.text)})`);
  const coded = markdownAdapter.map(file("Code.md", "```\n[[NotALink]]\n```\n`[[Inline]]` [[Real]] #Linear #linear"));
  ok(coded.links.map((l) => l.target).join(",") === "real" && JSON.stringify(coded.facets.tags) === '["Linear"]', `a wikilink inside code is not a link; tags dedupe case-insensitively (${JSON.stringify(coded.links)} ${JSON.stringify(coded.facets.tags)})`);
  ok(/```\n\[\[NotALink\]\]\n```\n`\[\[Inline\]\]` Real/.test(coded.text), `…and the text keeps a fenced or spanned [[…]] verbatim, as the link set does (fourth review pass) (${JSON.stringify(coded.text)})`);
  const tilde = markdownAdapter.map(file("T.md", "~~~\n[[InTilde]] #notatag\n~~~\n[[Out]]"));
  ok(tilde.links.map((l) => l.target).join(",") === "out" && (tilde.facets.tags as string[]).length === 0 && /~~~\n\[\[InTilde\]\] #notatag\n~~~/.test(tilde.text), `a tilde fence is code too (${JSON.stringify(tilde.links)} ${JSON.stringify(tilde.text)})`);

  const plain = markdownAdapter.map(file("a/Plain note.md", "Just text with a #tag."));
  ok(plain.identity.key === "plain note" && plain.text === "Plain note\n\nJust text with a #tag." && plain.mentions[0]?.name === "tag" && plain.links.length === 0 && plain.createdAt === undefined, "a note with no frontmatter: the name is the identity and the title");
  ok(markdownAdapter.map(file("Self.md", "[[Self]] and [[Other]]")).links.map((l) => l.target).join(",") === "other", "a link to the note itself is dropped");
  ok(markdownAdapter.map(file("N.md", "[[v1.2]] [[Plan Q3.2026]] ![[photo.JPG]] [[deck.pdf]] [[board.canvas]]")).links.map((l) => l.target).join(",") === "plan q3.2026,v1.2", "a dotted note name is a note; an image, a PDF and a canvas are files (first review pass)");
  let tooLong = "";
  try { markdownAdapter.map(file(`${"x".repeat(513)}.md`, "body")); } catch (e) { tooLong = (e as Error).message; }
  ok(/513 characters/.test(tooLong), `a name over the column's bound is refused by the adapter, not by the write (${tooLong.slice(0, 60)})`);

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
