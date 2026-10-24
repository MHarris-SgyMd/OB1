#!/usr/bin/env bun
/**
 * Grok Export Import for Open Brain — an emitter of ingestion-contract items
 *
 * Parses xAI Grok conversation exports (JSON with MongoDB-style dates) and
 * prints one ingestion-contract item per conversation, one JSON object per
 * line, for the brain's pipeline to write (db/README.md, "Items from a file").
 * It holds no database client and makes no model call: the pipeline owns the
 * row, the fingerprint and the source record, and `db/reembed.ts` embeds at
 * the brain's model (SMD-2493).
 *
 * Usage:
 *   bun import-grok.mjs /path/to/grok-export.json [--skip N] [--limit N] > items.jsonl
 *   bun import-grok.mjs /path/to/a-folder                  # one export: its *.json at the top, or one folder down
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const SYSTEM = "grok";
const SCOPE = "grok:export";
const USAGE = "Usage: bun import-grok.mjs /path/to/grok-export.json|folder [--skip N] [--limit N] [--if-present] > items.jsonl";

function parseArgs(argv) {
  const out = { path: undefined, skip: 0, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--skip" || a === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) fail(`${a} takes a whole number`);
      out[a.slice(2)] = n;
    } else if (a === "--if-present") {
      ifPresent = true;
    } else if (a === "--dry-run") {
      fail("the emitter writes nothing; count what it emits with the pipeline's own --dry-run (bun db/ingest-records.ts --source items --items items.jsonl --allow grok:export --dry-run)");
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

/** A name every walk passes over: a dot-file or dot-folder, __MACOSX and the `._*` AppleDouble files a zip made on a Mac carries. */
const skipped = (name) => name.startsWith(".") || name === "__MACOSX";

/**
 * `--if-present`: a path that is not there is no export yet, not a mistake, so
 * nothing is emitted and the run succeeds. The import runner passes it, since
 * a pipeline's folder need not exist until an export is put in it (SMD-2493 PR 2).
 */
let ifPresent = false;

/**
 * The export's path, checked before anything reads it. One that is not there
 * is "no export yet" under --if-present (nothing emitted, exit 0) and a
 * mistake otherwise. One there but unreadable is refused, naming why: a green
 * run that read nothing would hide it.
 */
async function exportRoot(path) {
  try {
    return await stat(path);
  } catch (e) {
    if (e.code === "ENOENT" && ifPresent) { console.error(`${path}: no export there yet; nothing emitted`); process.exit(0); }
    fail(e.code === "ENOENT" ? `${path}: no such file or folder` : `${path}: cannot be read (${e.code ?? e.message})`);
  }
}

function fail(why) {
  console.error(`import-grok: ${why}`);
  process.exit(2);
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

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

/**
 * A conversation's date: MongoDB's `$date` (an ISO string, or `$numberLong`
 * milliseconds), a string, or a number. A bare number below 10^11 is epoch
 * seconds (grok.com writes `create_time` so); read as milliseconds it would
 * date the conversation in January 1970.
 */
function parseMongoDate(dateObj) {
  if (!dateObj) return null;
  if (dateObj.$date) {
    if (typeof dateObj.$date === "string") return dateObj.$date;
    if (dateObj.$date.$numberLong) return Number(dateObj.$date.$numberLong);
  }
  if (typeof dateObj === "number") return Math.abs(dateObj) < 1e11 ? dateObj * 1000 : dateObj;
  if (typeof dateObj === "string") return dateObj;
  return null;
}

/**
 * The conversation's header and its messages. grok.com's export nests the
 * header under `.conversation` and each message under `.responses[].response`;
 * other exports put both on the conversation itself.
 */
function shapeOf(conv) {
  const nested = conv.conversation && typeof conv.conversation === "object" && !Array.isArray(conv.conversation);
  const head = nested ? conv.conversation : conv;
  const raw = nested ? conv.responses : conv.conversation || conv.messages || conv.responses;
  return { head, raw: Array.isArray(raw) ? raw : [] };
}

/** The conversation's own id, which survives a re-export; a hash of the conversation as exported when it carries none. */
function conversationKey(conv, head) {
  return keyFrom(head.id ?? head.conversation_id ?? head.uuid ?? head._id?.$oid ?? head._id, conv);
}

function normalizeConversation(conv) {
  const { head, raw } = shapeOf(conv);
  // Bounded: the title is in every part's header and facet, outside the text bound.
  const title = clean(head.title || head.name || "Untitled Grok Chat").slice(0, 500);
  const createdAt = instant(parseMongoDate(head.create_time || head.createdAt));

  const messages = [];
  for (const entry of raw) {
    const msg = entry?.response ?? entry;
    if (!msg || typeof msg !== "object") continue;
    const body = msg.message ?? msg.text ?? msg.content;
    const text = typeof body === "string" ? clean(body).trim() : "";
    if (!text) continue;
    const sender = String(msg.sender || msg.role || "unknown").toLowerCase();
    messages.push({
      role: sender === "user" || sender === "human" ? "USER" : "ASSISTANT",
      text,
      raw: entry,
    });
  }

  // A conversation past the bound is in parts, its earlier parts fixed as it grows.
  const header = (p) => `Conversation title: ${title}${partLabel(p)}\n${createdAt ? `Conversation created at: ${createdAt}\n` : ""}\n`;
  const all = parts(conversationKey(conv, head), messages, (m) => `${m.role}: ${m.text}`, "\n\n");
  return all.map((p) => ({
    key: p.key,
    title: `${title}${partLabel(p)}`,
    createdAt,
    content: `${header(p)}${p.text}`,
    // One part: the conversation as exported. Several: each part's messages as exported.
    canonical: JSON.stringify(p.of === 1 ? conv : p.members.map((m) => m.raw)),
  }));
}

/**
 * The most text one thought holds, in characters. A search hit returns its
 * thought whole and a re-embed sends every one of its windows, so a thought
 * of hundreds of KB (a long conversation) was more than a client takes and
 * was re-embedded whole at every change (SMD-2493).
 */
const TEXT_BOUND = 100_000;

/**
 * A group's members as thoughts within TEXT_BOUND, packed greedily in order:
 * members appended (a conversation that grew) only extend the last part or
 * start a new one, so earlier parts keep their text and their key. The first
 * part's key is the group's own, the k-th's `<key>#k`. A member with no line
 * is left out; one whose line alone passes the bound is cut, and says so (its
 * source record keeps it whole).
 */
function parts(key, members, lineOf, sep) {
  const out = [];
  let cur = null;
  for (const m of members) {
    let line = lineOf(m);
    if (!line) continue;
    if (line.length > TEXT_BOUND) line = `${clean(line.slice(0, TEXT_BOUND - 60))} [… cut here; the source record holds it whole]`;
    if (cur && cur.size + sep.length + line.length > TEXT_BOUND) cur = null;
    if (cur) cur.size += sep.length;
    else out.push((cur = { members: [], lines: [], size: 0 }));
    cur.members.push(m);
    cur.lines.push(line);
    cur.size += line.length;
  }
  return out.map((p, i) => ({ key: i ? `${key}#${i + 1}` : key, part: i + 1, of: out.length, members: p.members, text: p.lines.join(sep) }));
}

/** A part's label in its header and title: nothing for the first, so a conversation that grows a second part leaves the first one's text as it was. */
const partLabel = (p) => (p.part > 1 ? ` (part ${p.part})` : "");

/** The export files: the path itself, or the one export's *.json at the top of the folder or one folder down (the import runner hands an emitter its folder). */
async function exportFiles(path) {
  const s = await exportRoot(path);
  if (!s.isDirectory()) return [path];
  const list = async (dir, opts) => {
    try {
      return await readdir(dir, opts);
    } catch (e) {
      // A folder it cannot read is refused, not passed over: an export may be in it.
      fail(`${dir}: cannot be read (${e.code ?? e.message})`);
    }
  };
  const jsonIn = async (dir) => (await list(dir)).filter((n) => !skipped(n) && n.toLowerCase().endsWith(".json")).sort().map((n) => join(dir, n));
  // The JSON at the top (one export, in one file or several), or an export unzipped into a folder of its own one
  // level down (the import runner's imports/grok/<export>/). Two exports would be read as one, the older copy of a
  // conversation winning wherever its folder sorts first, so they are refused, naming them.
  const exports = [];
  const here = await jsonIn(path);
  if (here.length) exports.push({ at: path, files: here });
  for (const d of (await list(path, { withFileTypes: true })).filter((e) => e.isDirectory() && !skipped(e.name)).map((e) => e.name).sort()) {
    const files = await jsonIn(join(path, d));
    if (files.length) exports.push({ at: join(path, d), files });
  }
  if (exports.length > 1) fail(`${path} holds ${exports.length} exports (${exports.map((x) => x.at).join(", ")}); keep one, the newest, or merge the parts of one export into one folder`);
  // Something there but no JSON export is not "no export yet": a zip, or the JSON nested deeper than one folder.
  if (!exports.length && (await list(path)).some((n) => !skipped(n))) fail(`${path} holds no JSON export: a .zip to extract first, or the conversations JSON nested more than one folder down (put the file itself here)`);
  return exports[0]?.files ?? [];
}

async function main() {
  const { path, skip, limit } = parseArgs(process.argv.slice(2));
  const conversations = [];
  const files = await exportFiles(path);
  for (const file of files) {
    let text, parsed;
    try {
      text = await readFile(file, "utf-8");
    } catch (e) {
      fail(`${file}: cannot be read (${e.code ?? e.message})`);
    }
    try {
      parsed = JSON.parse(text);
    } catch {
      // As the other refusals: a parse error is said without the parser's words, which quote the export's text into the run report (review pass 5).
      fail(`${file}: not a JSON export (it does not parse as JSON)`);
    }
    // Grok exports can have conversations at top level or nested
    const found = Array.isArray(parsed?.conversations) ? parsed.conversations
      : Array.isArray(parsed) ? parsed
      : parsed && typeof parsed === "object" && !("conversations" in parsed) ? [parsed]
      : fail(`${file}: neither a list of conversations nor an object holding one`);
    console.error(`${file}: ${found.length} conversations`);
    conversations.push(...found.map((conv) => ({ conv, file })));
  }

  // Every conversation is read for the two-files check below; --skip and --limit choose only which are emitted
  // (review pass 4: two overlapping exports passed with a window that held one copy).
  const inWindow = (i) => i >= skip && i < skip + limit;
  const windowed = conversations.filter((_, i) => inWindow(i)).length;
  /** Each conversation's key and the file it came from. */
  const seen = new Map();
  let emitted = 0, dropped = 0, malformed = 0, parsedConvs = 0;
  // Printed once, at the end: a refusal mid-run (a record in two files) prints nothing, so a pipe into the
  // pipeline never ingests half an export.
  const lines = [];

  for (let i = 0; i < conversations.length; i++) {
    const { conv, file } = conversations[i];
    const emit = inWindow(i);
    let cs;
    try {
      if (!conv || typeof conv !== "object") throw new Error("not an object");
      cs = normalizeConversation(conv);
    } catch (e) {
      // One conversation the parser cannot read is skipped and named, as the importer always did; the rest are emitted.
      if (emit) { console.error(`conversation ${i + 1}: cannot be read (${e.message}); skipped`); malformed++; }
      continue;
    }
    if (cs.length) parsedConvs++;
    if (!cs.length || cs[0].content.trim().length < 100) { if (emit) dropped++; continue; }
    // A conversation in two files is two exports: read as one, the older copy would win wherever its file sorts
    // first, so it is refused, naming both. One file listing it twice is emitted once (two lines of one identity
    // would refuse the whole items file).
    const first = seen.get(cs[0].key);
    if (first !== undefined && first !== file) fail(`conversation ${cs[0].key} is in two files (${first}, ${file}): two exports; keep one, the newest`);
    if (first !== undefined) { if (emit) { console.error(`conversation ${cs[0].key} appears twice; emitted once`); dropped++; } continue; }
    for (const c of cs) {
      seen.set(c.key, file);
      if (!emit) continue;
      const item = {
        identity: { system: SYSTEM, key: c.key },
        scope: SCOPE,
        canonical: { form: c.canonical, mediaType: "application/json" },
        text: c.content,
        links: [],
        mentions: [],
        facets: { title: c.title, type: "reference", source_type: "grok_import", importance: 3, quality_score: 50, sensitivity_tier: "standard" },
      };
      if (c.createdAt) item.createdAt = c.createdAt;
      lines.push(JSON.stringify(item));
      emitted++;
    }
  }

  if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
  console.error(`Emitted ${emitted} item(s), skipped ${dropped}${malformed ? `, ${malformed} unreadable` : ""} (of ${windowed}; skip=${skip}, limit=${limit === Infinity ? "all" : limit})`);
  // An export found but no record of this importer's kind parsed from it is refused, not reported as no export:
  // another product's file of the name it reads, or a vendor shape it does not know, would otherwise be a green
  // run that writes nothing, every week (review pass 4). Records parsed and all skipped by the importer's own
  // filters (short, retweets) are a correct read, and exit 0 (review pass 5). Under --skip or --limit the window
  // is the request's.
  if (!parsedConvs && files.length && skip === 0 && limit === Infinity) fail(`${path}: read ${files.length} JSON file(s) and found no conversation with a message in them (${conversations.length} entr${conversations.length === 1 ? "y" : "ies"}, ${malformed} unreadable): an export with none, or not a Grok export`);
  if (droppedDates.size) console.error(`${droppedDates.size} date(s) left out, not ones the brain accepts (it dates those thoughts when it writes them): ${[...droppedDates].slice(0, 5).map((d) => JSON.stringify(d.slice(0, 40))).join(", ")}`);
}

// A failure no check foresaw (a file unreadable mid-run) is named, not left a stack trace in the runner's report.
await main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
