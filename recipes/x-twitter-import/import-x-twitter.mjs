#!/usr/bin/env bun
/**
 * X/Twitter Import for Open Brain — an emitter of ingestion-contract items
 *
 * Parses X (Twitter) data exports (tweets, DMs and Grok chats) and prints one
 * ingestion-contract item per thought, one JSON object per line, for the
 * brain's pipeline to write (db/README.md, "Items from a file"). It holds no
 * database client and makes no model call: the pipeline owns the row, the
 * fingerprint and the source record, and `db/reembed.ts` embeds at the
 * brain's model (SMD-2493).
 *
 * Every item is the `x` system's, the Grok chats from the X archive included:
 * one import, one source (the import runner refuses a pipeline that emits two).
 *
 * Usage:
 *   bun import-x-twitter.mjs /path/to/twitter-export [--skip N] [--limit N] > items.jsonl
 *   bun import-x-twitter.mjs /path/to/twitter-export --types tweets,dms
 *
 * Expected directory structure:
 *   twitter-export/
 *   └── data/
 *       ├── tweets.js (or tweet.js)
 *       ├── direct-messages.js
 *       └── grok-conversations.js
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const SYSTEM = "x";
const SCOPE = "x:export";
const TYPES = ["tweets", "dms", "grok"];
const USAGE = "Usage: bun import-x-twitter.mjs /path/to/twitter-export [--skip N] [--limit N] [--if-present] [--types tweets,dms,grok] > items.jsonl";
/** The enhanced fields every item carries as facets, as the import set them before (SMD-2493). */
const ENHANCED = { type: "reference", source_type: "x_twitter_import", importance: 2, quality_score: 40, sensitivity_tier: "standard" };

function parseArgs(argv) {
  const out = { path: undefined, skip: 0, limit: Infinity, types: TYPES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--skip" || a === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) fail(`${a} takes a whole number`);
      out[a.slice(2)] = n;
    } else if (a === "--types") {
      out.types = [...new Set((argv[++i] ?? "").split(",").map((t) => t.trim()).filter(Boolean))];
      const bad = out.types.filter((t) => !TYPES.includes(t));
      if (!out.types.length || bad.length) fail(`--types takes ${TYPES.join(", ")}${bad.length ? `, not ${bad.join(", ")}` : ""}`);
    } else if (a === "--if-present") {
      ifPresent = true;
    } else if (a === "--dry-run") {
      fail("the emitter writes nothing; count what it emits with the pipeline's own --dry-run (bun db/ingest-records.ts --source items --items items.jsonl --allow x:export --dry-run)");
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
  console.error(`import-x-twitter: ${why}`);
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
 * The most text one thought holds, in characters. A search hit returns its
 * thought whole and a re-embed sends every one of its windows, so a thought
 * of hundreds of KB (a busy month, a long thread) was more than a client takes
 * and was re-embedded whole at every change (SMD-2493).
 */
const TEXT_BOUND = 100_000;

/**
 * Members grouped by the calendar day (UTC) of their date, oldest first, one
 * thought a day: so a member a later export adds or drops changes only its
 * own day's thought, which updates in place, and no other. (Batches of a
 * fixed size shifted at every member added or dropped before them, and the
 * shifted batches landed as new rows beside the old: the pipeline adds and
 * updates, it does not remove.) Members with no date are the `undated` day.
 * Within a day the order is by date, then by `tie`, so it is the same
 * however the export lists them.
 */
function byDay(members, dateOf, tie) {
  const days = new Map();
  for (const m of members) {
    const at = dateOf(m);
    const day = at ? at.slice(0, 10) : "undated";
    if (!days.has(day)) days.set(day, []);
    days.get(day).push({ m, at: at ?? "", tie: tie(m) });
  }
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...days.keys()].sort(order).map((day) => ({
    day,
    members: days.get(day).sort((a, b) => order(a.at, b.at) || order(a.tie, b.tie)).map((x) => x.m),
  }));
}

/**
 * A group's members as thoughts within TEXT_BOUND, packed greedily in order:
 * members appended (a thread that grew) only extend the last part or start a
 * new one, so earlier parts keep their text and their key. The first part's
 * key is the group's own, the k-th's `<key>#k`. A member with no line is left
 * out; one whose line alone passes the bound is cut, and says so (its source
 * record keeps it whole).
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

/** A part's label in its header and title: nothing for the first, so a thread that grows a second part leaves the first one's text as it was. */
const partLabel = (p) => (p.part > 1 ? ` (part ${p.part})` : "");

/** A tweet's or a message's text, as a string. */
const textOf = (v) => (typeof v === "string" ? clean(v) : "");

function parseTwitterJsFile(content) {
  // Twitter JS files start with "window.YTD.tweets.part0 = " or similar
  const jsonStart = content.indexOf("[");
  // No array at all (a file cut short) is refused as one that does not parse, not read as an empty one (review pass 6).
  if (jsonStart === -1) throw new Error("no JSON array");
  return JSON.parse(content.substring(jsonStart));
}

async function findDataDir(dir) {
  await exportRoot(dir);
  // An archive's data/ folder: at the top, or one level down, an archive extracted into the folder (the import
  // runner's imports/x-twitter/twitter-2024-…/data). Two would be read as one import with duplicates, so they are
  // refused, naming them; a folder that cannot be searched is refused too, since an archive may be in it.
  const isDir = async (p) => {
    try {
      return (await stat(p)).isDirectory();
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") return false;
      fail(`${p}: cannot be read (${e.code ?? e.message})`);
    }
  };
  let entries;
  try {
    entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (e) {
    fail(`${dir}: cannot be read (${e.code ?? e.message})`);
  }
  const archives = [];
  // The archive's files loose at the top are an archive too, so beside one in a subfolder they are two.
  if (entries.some((e) => ARCHIVE_FILES.includes(e.name))) archives.push(dir);
  if (await isDir(join(dir, "data"))) archives.push(join(dir, "data"));
  for (const e of entries) {
    if (!e.isDirectory() || skipped(e.name) || e.name === "data") continue;
    if (await isDir(join(dir, e.name, "data"))) archives.push(join(dir, e.name, "data"));
  }
  if (archives.length > 1) fail(`${dir} holds ${archives.length} archives (${archives.join(", ")}); keep one, the newest, or merge the parts of one archive into one folder`);
  // Something there but no archive is not "no export yet": a zip, or an archive nested more than one folder down.
  if (!archives.length && entries.some((e) => !skipped(e.name))) fail(`${dir} holds no X archive: a .zip to extract first, or an archive nested more than one folder down`);
  return archives[0] ?? null;
}

/** The archive files this importer reads, any one of which marks a folder as an archive's data. */
const ARCHIVE_FILES = ["tweets.js", "tweet.js", "direct-messages.js", "direct-message.js", "grok-conversations.js", "grokConversations.js"];

// ── Tweet Processing ─────────────────────────────────────────────────────

function processTweets(rawTweets) {
  const tweets = rawTweets
    .map((t) => t?.tweet || t)
    .filter((t) => {
      if (!t || typeof t !== "object") return false;
      const text = textOf(t.full_text || t.text);
      if (text.length < 30) return false;
      if (text.startsWith("RT @")) return false; // Skip retweets
      return true;
    });

  // One thought a day (byDay), the tweets in date order, ties by id; a day past the bound in parts.
  const lineOf = (t) => {
    const time = instant(t.created_at)?.slice(11, 16);
    return `Tweet${time ? ` (${time} UTC)` : ""}: ${textOf(t.full_text || t.text)}`;
  };
  return byDay(tweets, (t) => instant(t.created_at), (t) => String(t.id_str ?? t.id ?? JSON.stringify(t))).flatMap(({ day, members }) =>
    parts(`tweets:${day}`, members, lineOf, "\n\n").map((p) => {
      const label = `${day === "undated" ? "with no date" : `on ${day}`}${partLabel(p)}`;
      return {
        key: p.key, of: p.of,
        kind: "tweets",
        canonical: JSON.stringify(p.members),
        content: `X/Twitter tweets ${label}:\n\n${p.text}`,
        createdAt: instant(p.members[0].created_at),
        title: `Tweets ${label}`,
      };
    }));
}

// ── DM Processing ────────────────────────────────────────────────────────

/** Messages by date, undated first, ties kept in the archive's order (a date that does not parse no longer unsettles the sort). */
const byDate = (a, b) => {
  const x = instant(a.createdAt) ?? "", y = instant(b.createdAt) ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
};

function processDMs(rawDMs) {
  const conversations = rawDMs
    .map((dm) => dm?.dmConversation || dm)
    .filter((conv) => {
      const messages = Array.isArray(conv?.messages) ? conv.messages : [];
      return messages.length >= 3; // Skip very short conversations
    });

  // A conversation the archive lists twice is taken from its first copy alone: deduping part by part could mix the copies' parts.
  const seenConversations = new Set();
  return conversations.flatMap((conv) => {
    const id = keyFrom(conv.conversationId, conv);
    if (seenConversations.has(id)) { console.error(`dm:${id} appears twice; emitted once`); return []; }
    seenConversations.add(id);
    const messages = conv.messages
      .map((m) => m?.messageCreate || m)
      .filter((m) => m && textOf(m.text))
      .sort(byDate);

    // The archive's conversation id survives a re-export; a thread past the bound is in parts, its earlier parts fixed as it grows.
    const all = parts(`dm:${id}`, messages, (m) => `${clean(m.senderId || "sender")}: ${textOf(m.text)}`, "\n");
    return all.map((p) => ({
      key: p.key, of: p.of,
      kind: "dm",
      // One part: the conversation as the archive holds it. Several: each part's messages.
      canonical: JSON.stringify(p.of === 1 ? conv : p.members),
      content: `X/Twitter DM conversation${partLabel(p)}:\n\n${p.text}`,
      createdAt: p.members.map((m) => instant(m.createdAt)).find(Boolean),
      // The part's own count: the thread's would move every part's title as the thread grows.
      title: `Twitter DM (${p.members.length} messages)${partLabel(p)}`,
    }));
  });
}

// ── Grok Chat Processing ─────────────────────────────────────────────────

function processGrokChats(rawGrok) {
  const chats = {};

  for (const entry of rawGrok) {
    if (!entry || typeof entry !== "object") continue;
    const chatId = keyFrom(entry.chatId || "default", entry);
    if (!chats[chatId]) chats[chatId] = [];
    chats[chatId].push(entry);
  }

  return Object.entries(chats).flatMap(([chatId, messages]) => {
    messages.sort(byDate);

    const lineOf = (m) => {
      const role = String(m.sender || "user").toUpperCase() === "USER" ? "USER" : "ASSISTANT";
      const line = `${role}: ${textOf(m.message || m.text)}`;
      return line.length > 10 ? line : "";
    };
    // A chat past the bound is in parts, its earlier parts fixed as it grows.
    return parts(`grok:${chatId}`, messages, lineOf, "\n\n").map((p) => ({
      key: p.key, of: p.of,
      kind: "grok",
      canonical: JSON.stringify(p.of === 1 ? messages : p.members),
      content: `Grok chat conversation${partLabel(p)}:\n\n${p.text}`,
      createdAt: p.members.map((m) => instant(m.createdAt)).find(Boolean),
      title: `Grok chat (${p.members.length} messages)${partLabel(p)}`,
    }));
  });
}

// ── Main ─────────────────────────────────────────────────────────────────

/** The first of the names the archive holds, parsed; null when it holds none. A file that is there but does not parse is refused, not taken for absent. */
async function readArchiveFile(dataDir, names) {
  for (const name of names) {
    let raw;
    try {
      raw = await readFile(join(dataDir, name), "utf-8");
    } catch (e) {
      if (e.code === "ENOENT") continue; // file not found
      // One it cannot read is refused, not taken for absent: the import would quietly lack it.
      fail(`${join(dataDir, name)}: cannot be read (${e.code ?? e.message})`);
    }
    try {
      return { name, rows: parseTwitterJsFile(raw) };
    } catch {
      // As the other refusals: a parse error is said without the parser's words, which quote the export's text into the run report (review pass 5).
      fail(`${join(dataDir, name)}: not an archive file (it does not parse as the archive's JSON)`);
    }
  }
  return null;
}

async function main() {
  const { path, skip, limit, types } = parseArgs(process.argv.slice(2));

  const dataDir = await findDataDir(path);
  // An empty folder (the import runner's, before an archive is put in it) is no export: nothing to emit (review
  // pass 5: the end rule below refused it, every week).
  if (!dataDir) { console.error(`No X archive under ${path}; nothing emitted. Point the script at the extracted archive.`); return; }
  const allItems = [];
  /**
   * Records of the archive's kind read, before the importer's filters (short, retweets): what the end rule counts.
   * A record is one with the text this importer reads, so a vendor shape it does not know counts none (review pass
   * 6: rows of any shape were counted, and [1,2,3] passed as read).
   */
  let rows = 0;
  const hasText = (o, ...fields) => !!o && typeof o === "object" && fields.some((f) => typeof o[f] === "string");

  if (types.includes("tweets")) {
    const f = await readArchiveFile(dataDir, ["tweets.js", "tweet.js"]);
    if (f) {
      rows += (Array.isArray(f.rows) ? f.rows : []).filter((r) => hasText(r?.tweet ?? r, "full_text", "text")).length;
      const days = processTweets(f.rows);
      allItems.push(...days);
      console.error(`Tweets (${f.name}): ${f.rows.length} tweets → ${days.length} daily thoughts`);
    } else console.error(`Tweets: no tweets.js or tweet.js in ${dataDir}`);
  }

  if (types.includes("dms")) {
    const f = await readArchiveFile(dataDir, ["direct-messages.js", "direct-message.js"]);
    if (f) {
      rows += (Array.isArray(f.rows) ? f.rows : []).flatMap((r) => (Array.isArray((r?.dmConversation ?? r)?.messages) ? (r?.dmConversation ?? r).messages : [])).filter((m) => hasText(m?.messageCreate ?? m, "text")).length;
      const convs = processDMs(f.rows);
      allItems.push(...convs);
      console.error(`DMs (${f.name}): ${f.rows.length} conversations → ${convs.length} thoughts`);
    } else console.error(`DMs: no direct-messages.js or direct-message.js in ${dataDir}`);
  }

  if (types.includes("grok")) {
    const f = await readArchiveFile(dataDir, ["grok-conversations.js", "grokConversations.js"]);
    if (f) {
      rows += (Array.isArray(f.rows) ? f.rows : []).filter((r) => hasText(r, "message", "text")).length;
      const chats = processGrokChats(f.rows);
      allItems.push(...chats);
      console.error(`Grok chats (${f.name}): ${f.rows.length} messages → ${chats.length} thoughts`);
    } else console.error(`Grok chats: no grok-conversations.js or grokConversations.js in ${dataDir}`);
  }

  const toProcess = allItems.slice(skip, skip + limit);
  const seen = new Set();
  let emitted = 0, dropped = 0;
  // Printed once, at the end: a refusal mid-run (a record in two files) prints nothing, so a pipe into the
  // pipeline never ingests half an export.
  const lines = [];

  for (const it of toProcess) {
    // The short-text skip is a whole group's: a short first part before a message cut at the bound is kept.
    if (it.of === 1 && it.content.trim().length < 50) { dropped++; continue; }
    // Two lines of one identity refuse the whole file, so a conversation the archive lists twice is emitted once.
    if (seen.has(it.key)) { console.error(`${it.key} appears twice; emitted once`); dropped++; continue; }
    seen.add(it.key);
    const item = {
      identity: { system: SYSTEM, key: it.key },
      scope: SCOPE,
      canonical: { form: it.canonical, mediaType: "application/json" },
      text: it.content,
      links: [],
      mentions: [],
      facets: { title: it.title, kind: it.kind, ...ENHANCED },
    };
    if (it.createdAt) item.createdAt = it.createdAt;
    lines.push(JSON.stringify(item));
    emitted++;
  }

  if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
  console.error(`Emitted ${emitted} item(s), skipped ${dropped} (of ${toProcess.length} thought(s) from ${rows} record(s) read; skip=${skip}, limit=${limit === Infinity ? "all" : limit})`);
  // An export found but no record of this importer's kind parsed from it is refused, not reported as no export:
  // another product's file of the name it reads, or a vendor shape it does not know, would otherwise be a green
  // run that writes nothing, every week (review pass 4). Records parsed and all skipped by the importer's own
  // filters (short, retweets) are a correct read, and exit 0 (review pass 5). Under --skip, --limit or --types the
  // window is the request's.
  if (!rows && skip === 0 && limit === Infinity && types.length === TYPES.length) fail(`${dataDir}: found an archive's data folder but no tweet, DM or Grok chat in it (tweets.js, direct-messages.js, grok-conversations.js): an archive with none, its media-only part, or a layout this importer does not read`);
  if (droppedDates.size) console.error(`${droppedDates.size} date(s) left out, not ones the brain accepts (it dates those thoughts when it writes them): ${[...droppedDates].slice(0, 5).map((d) => JSON.stringify(d.slice(0, 40))).join(", ")}`);
}

// A failure no check foresaw (a file unreadable mid-run) is named, not left a stack trace in the runner's report.
await main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
