#!/usr/bin/env bun
/**
 * Journals/Blogger Import for Open Brain — an emitter of ingestion-contract items
 *
 * Parses Google Blogger Atom XML exports and prints one ingestion-contract
 * item per post or comment, one JSON object per line, for the brain's
 * pipeline to write (db/README.md, "Items from a file"). Works with any Atom
 * feed export. It holds no database client and makes no model call: the
 * pipeline owns the row, the fingerprint and the source record, and
 * `db/reembed.ts` embeds at the brain's model (SMD-2493).
 *
 * Usage:
 *   bun import-blogger.mjs /path/to/blogger-exports [--skip N] [--limit N] > items.jsonl
 *
 * Expects a directory containing .atom files (Blogger export format).
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SYSTEM = "blogger";
const SCOPE = "blogger:export";
const USAGE = "Usage: bun import-blogger.mjs /path/to/blogger-exports [--skip N] [--limit N] > items.jsonl";

function parseArgs(argv) {
  const out = { path: undefined, skip: 0, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--skip" || a === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) fail(`${a} takes a whole number`);
      out[a.slice(2)] = n;
    } else if (a === "--dry-run") {
      fail("the emitter writes nothing; count what it emits with the pipeline's own --dry-run (bun db/ingest-records.ts --source items --items items.jsonl --allow blogger:export --dry-run)");
    } else if (a.startsWith("--")) {
      fail(`unknown flag ${a}`);
    } else if (out.path === undefined) {
      out.path = a;
    } else {
      fail(`one export path, not two (${out.path}, ${a})`);
    }
  }
  if (out.path === undefined) fail(USAGE);
  return out;
}

function fail(why) {
  console.error(`import-blogger: ${why}`);
  process.exit(2);
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * The most text one thought holds, in characters. A search hit returns its
 * thought whole and a re-embed sends every one of its windows, so a thought
 * of hundreds of KB was more than a client takes (SMD-2493).
 */
const TEXT_BOUND = 100_000;

/** Text a row can hold: a NUL or a lone surrogate would refuse the whole file at the pipeline, so they go here. */
const clean = (s) => String(s).replaceAll("\u0000", "").toWellFormed();

/** The dates the export gave that this run left out, counted once each and said in the summary. */
const droppedDates = new Set();

/**
 * An instant the pipeline accepts (ISO-8601 in UTC), or undefined, which
 * leaves the date to the pipeline: no date, epoch 0, and a date it would
 * refuse (before year 1, past 9999, more than a day ahead, a day the calendar
 * lacks), since one refused date refuses the whole file. A date and time with
 * no offset is read as UTC, not as the machine's local time.
 */
function instant(v) {
  if (v === undefined || v === null || v === "" || v === 0) return undefined;
  const drop = () => { droppedDates.add(String(v)); return undefined; };
  let s = v;
  if (typeof v === "string") {
    const t = v.trim();
    const ymd = /^(\d{4})-(\d\d)-(\d\d)/.exec(t);
    // February the 30th is left out, not rolled into March as Date.parse does.
    if (ymd) {
      const [y, m, d] = ymd.slice(1).map(Number);
      const day = new Date(Date.UTC(y, m - 1, d));
      if (day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) return drop();
    }
    if (/^\d{4}-\d\d-\d\d$/.test(t)) s = `${t}T00:00:00Z`;
    else if (/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(t)) s = `${t.replace(" ", "T")}Z`;
  }
  const d = new Date(s);
  const ms = d.getTime();
  if (Number.isNaN(ms) || ms === 0 || ms > Date.now() + 86_400_000 || d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999) return drop();
  return d.toISOString();
}

/**
 * A key the pipeline takes: the export's id cleaned and trimmed, within the identity's bound; else a hash of the
 * record as exported. `%` and `#` are escaped, so no id can read as a part's `<key>#k` (an id `abc#2` beside a
 * conversation `abc` in two parts took one key twice, and the file was refused).
 */
function keyFrom(id, record) {
  const k = typeof id === "string" || typeof id === "number" ? clean(String(id)).trim().replaceAll("%", "%25").replaceAll("#", "%23") : "";
  return k && [...k].length <= 480 ? k : `sha256:${sha256(JSON.stringify(record))}`;
}

/** One level of entity escaping undone; `&amp;` last, so `&amp;lt;` stays the text `&lt;`. */
const unescapeEntities = (s) => s
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&");

/**
 * The text of a `type="html"` element: the XML escaping undone first, which
 * gives the post's HTML, then its tags stripped, then the HTML's own entities.
 * Stripping before unescaping left every `<p>` of an escaped post in its text.
 */
function stripHtml(html) {
  return unescapeEntities(
    unescapeEntities(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<p(\s[^>]*)?>/gi, "\n")
      .replace(/<\/p>/gi, "")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseAtomFile(xml) {
  const entries = [];
  const entryBlocks = xml.split(/<entry>/);

  for (let i = 1; i < entryBlocks.length; i++) {
    const block = entryBlocks[i];
    const endIdx = block.indexOf("</entry>");
    if (endIdx === -1) continue;
    const entry = block.substring(0, endIdx);

    // Check if it's a POST or COMMENT (skip settings, templates, etc.)
    const categoryMatch = entry.match(/term=["']http:\/\/schemas\.google\.com\/blogger\/2008\/kind#(\w+)["']/);
    const kind = categoryMatch ? categoryMatch[1] : "";
    if (kind !== "post" && kind !== "comment") continue;

    // Extract fields
    const titleMatch = entry.match(/<title[^>]*>([^<]*)<\/title>/);
    const title = titleMatch ? clean(unescapeEntities(titleMatch[1])).trim() : "";

    const contentMatch = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/);
    const rawContent = contentMatch ? contentMatch[1] : "";
    const content = clean(stripHtml(rawContent));

    const publishedMatch = entry.match(/<published>([^<]+)<\/published>/);
    const published = publishedMatch ? publishedMatch[1] : "";

    // The entry's Atom id (tag:blogger.com,1999:blog-….post-…) survives a re-export.
    const idMatch = entry.match(/<id>([^<]+)<\/id>/);
    const xmlEntry = `<entry>${entry}</entry>`;
    const key = keyFrom(idMatch?.[1], xmlEntry);

    // Skip very short entries
    if (content.length < 20) continue;
    // The canonical is the entry's bytes, which a NUL would refuse at the pipeline (and the whole file with it).
    if (xmlEntry.includes("\u0000")) { console.error(`entry ${key} holds a NUL byte; skipped`); continue; }

    entries.push({ key, xml: xmlEntry, title, content, published, kind });
  }

  return entries;
}

async function findAtomFiles(dir) {
  const results = [];

  async function walk(d, depth) {
    if (depth > 3) return;
    const entries = (await readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const fullPath = join(d, e.name);
      if (e.isFile() && (e.name.endsWith(".atom") || e.name === "feed.atom")) {
        results.push(fullPath);
      } else if (e.isDirectory() && !e.name.startsWith(".")) {
        await walk(fullPath, depth + 1);
      }
    }
  }

  try {
    await walk(dir, 0);
  } catch {
    fail(`${dir}: no such folder`);
  }
  return results;
}

async function main() {
  const { path, skip, limit } = parseArgs(process.argv.slice(2));

  const atomFiles = await findAtomFiles(path);
  console.error(`Found ${atomFiles.length} Atom files`);

  const allPosts = [];
  for (const file of atomFiles) {
    const xml = await readFile(file, "utf-8");
    const entries = parseAtomFile(xml);
    console.error(`  ${file}: ${entries.length} entries`);
    allPosts.push(...entries);
  }

  const toProcess = allPosts.slice(skip, skip + limit);
  const seen = new Set();
  let emitted = 0, skipped = 0;

  for (const post of toProcess) {
    const thoughtContent = post.title
      ? `Blog post: ${post.title}\nPublished: ${post.published}\n\n${post.content}`
      : post.content;

    if (thoughtContent.trim().length < 50) { skipped++; continue; }
    // Two lines of one identity refuse the whole file, so an entry two export files both hold is emitted once.
    if (seen.has(post.key)) { console.error(`entry ${post.key} appears twice; emitted once`); skipped++; continue; }
    seen.add(post.key);

    const createdAt = instant(post.published);
    const title = post.title || `Blog ${post.kind}${createdAt ? ` (${createdAt.slice(0, 10)})` : ""}`;
    const item = {
      identity: { system: SYSTEM, key: post.key },
      scope: SCOPE,
      canonical: { form: post.xml, mediaType: "application/atom+xml" },
      // A post past the bound is cut, and says so; its <entry> keeps it whole.
      text: thoughtContent.length > TEXT_BOUND ? `${clean(thoughtContent.slice(0, TEXT_BOUND - 60))} [… cut here; the source record holds it whole]` : thoughtContent,
      links: [],
      mentions: [],
      facets: { title, kind: post.kind, type: "journal", source_type: "blogger_import", importance: 3, quality_score: 60, sensitivity_tier: "standard" },
    };
    if (createdAt) item.createdAt = createdAt;
    process.stdout.write(`${JSON.stringify(item)}\n`);
    emitted++;
  }

  console.error(`Emitted ${emitted} item(s), skipped ${skipped} (of ${toProcess.length}; skip=${skip}, limit=${limit === Infinity ? "all" : limit})`);
  if (droppedDates.size) console.error(`${droppedDates.size} date(s) left out, not ones the brain accepts (it dates those thoughts when it writes them): ${[...droppedDates].slice(0, 5).map((d) => JSON.stringify(d.slice(0, 40))).join(", ")}`);
}

await main();
