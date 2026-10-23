#!/usr/bin/env bun
/**
 * Instagram Import for Open Brain — an emitter of ingestion-contract items
 *
 * Parses Instagram data exports (DM conversations, comments and post captions)
 * and prints one ingestion-contract item per thought, one JSON object per
 * line, for the brain's pipeline to write (db/README.md, "Items from a file").
 * It holds no database client and makes no model call: the pipeline owns the
 * row, the fingerprint and the source record, and `db/reembed.ts` embeds at
 * the brain's model (SMD-2493).
 *
 * Usage:
 *   bun import-instagram.mjs /path/to/instagram-export [--skip N] [--limit N] > items.jsonl
 *   bun import-instagram.mjs /path/to/instagram-export --types messages,comments,posts
 *
 * Expected: instagram-export/your_instagram_activity/ folder structure
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SYSTEM = "instagram";
const SCOPE = "instagram:export";
const TYPES = ["messages", "comments", "posts"];
const USAGE = "Usage: bun import-instagram.mjs /path/to/instagram-export [--skip N] [--limit N] [--types messages,comments,posts] > items.jsonl";
/** The enhanced fields every item carries as facets, as the import set them before (SMD-2493). */
const ENHANCED = { type: "reference", source_type: "instagram_import", importance: 2, quality_score: 40, sensitivity_tier: "personal" };

function parseArgs(argv) {
  const out = { path: undefined, skip: 0, limit: Infinity, types: TYPES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--skip" || a === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) fail(`${a} takes a whole number`);
      out[a.slice(2)] = n;
    } else if (a === "--types") {
      out.types = (argv[++i] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      const bad = out.types.filter((t) => !TYPES.includes(t));
      if (!out.types.length || bad.length) fail(`--types takes ${TYPES.join(", ")}${bad.length ? `, not ${bad.join(", ")}` : ""}`);
    } else if (a === "--dry-run") {
      fail("the emitter writes nothing; count what it emits with the pipeline's own --dry-run (bun db/ingest-records.ts --source items --items items.jsonl --allow instagram:export --dry-run)");
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
  console.error(`import-instagram: ${why}`);
  process.exit(2);
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Text a row can hold: a NUL or a lone surrogate would refuse the whole file at the pipeline, so they go here. */
const clean = (s) => String(s).replaceAll("\u0000", "").toWellFormed();

/**
 * Meta's double-encoded UTF-8: the export's bytes read as latin1. Only a
 * string that is all latin1 can be that, and only a repair that decodes
 * cleanly is one; anything else (an emoji already whole, an accent that was
 * never mangled) is kept as it is.
 */
function fixMetaEncoding(text) {
  const s = String(text);
  if (!/^[\u0000-\u00ff]*$/.test(s)) return clean(s);
  const fixed = Buffer.from(s, "latin1").toString("utf-8");
  return clean(fixed.includes("\ufffd") && !s.includes("\ufffd") ? s : fixed);
}

/** The dates the export gave that this run left out, counted once each and said in the summary. */
const droppedDates = new Set();

/**
 * An instant the pipeline accepts (ISO-8601 in UTC) from epoch milliseconds,
 * or undefined, which leaves the date to the pipeline: no date, epoch 0, and a
 * date it would refuse (before year 1, past 9999, more than a day ahead),
 * since one refused date refuses the whole file.
 */
function fromMs(ms) {
  if (!ms || typeof ms !== "number") return undefined;
  const d = new Date(ms);
  const t = d.getTime();
  if (Number.isNaN(t) || t > Date.now() + 86_400_000 || d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999) { droppedDates.add(String(ms)); return undefined; }
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

/** A file of the export, parsed; one that does not parse is refused, not taken for empty (a re-run would shrink the thought it feeds). */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch (e) {
    fail(`${file}: not a JSON file of the export (${e.message}); re-download the export, or move the file out`);
  }
}

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The export's names in a folder, or [] when the folder is not there (an export without that type). */
async function namesIn(dir, opts) {
  try {
    return await readdir(dir, opts);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return [];
    throw e;
  }
}

async function findActivityDir(dir) {
  // Look for your_instagram_activity directory
  async function walk(d, depth) {
    if (depth > 3) return null;
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === "your_instagram_activity") return join(d, e.name);
        const found = await walk(join(d, e.name), depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  try {
    return await walk(dir, 0);
  } catch {
    fail(`${dir}: no such folder`);
  }
}

// ── Message Processing ───────────────────────────────────────────────────

async function processMessages(activityDir) {
  const items = [];
  const messagesDir = join(activityDir, "messages", "inbox");
  const convDirs = (await namesIn(messagesDir, { withFileTypes: true })).sort((a, b) => byName(a.name, b.name));

  for (const convDir of convDirs) {
    if (!convDir.isDirectory()) continue;
    const convPath = join(messagesDir, convDir.name);

    // Find all message_*.json files
    const files = (await readdir(convPath)).filter((f) => f.startsWith("message") && f.endsWith(".json")).sort();

    const exported = [];
    const allMessages = [];
    for (const msgFile of files) {
      const data = await readJson(join(convPath, msgFile));
      exported.push(data);
      allMessages.push(...(Array.isArray(data?.messages) ? data.messages : []));
    }

    if (allMessages.length < 3) continue;

    // Sort by timestamp
    allMessages.sort((a, b) => (Number(a?.timestamp_ms) || 0) - (Number(b?.timestamp_ms) || 0));

    const participantName = fixMetaEncoding(convDir.name.replace(/_\d+$/, "").replace(/_/g, " "));
    const lineOf = (m) => {
      const line = `${fixMetaEncoding(m.sender_name || "unknown")}: ${fixMetaEncoding(m.content || "")}`;
      return line.length > 5 ? line : "";
    };

    // The inbox folder is `<name>_<thread id>`: the id survives the other person renaming themselves, the name does not.
    // Every message is in the text; a thread past the bound is in parts, its earlier parts fixed as it grows.
    for (const p of parts(`dm:${keyFrom(/_(\d+)$/.exec(convDir.name)?.[1] ?? convDir.name, exported)}`, allMessages, lineOf, "\n")) {
      items.push({
        key: p.key, of: p.of,
        kind: "dm",
        // One part: the thread's message files as exported. Several: each part's messages.
        canonical: JSON.stringify(p.of === 1 ? exported : p.members),
        content: `Instagram DM conversation with ${participantName}${partLabel(p)}:\n\n${p.text}`,
        createdAt: fromMs(p.members.find((m) => fromMs(m.timestamp_ms))?.timestamp_ms),
        // The part's own count: the thread's would move every part's title as the thread grows.
        title: `Instagram DM: ${participantName} (${p.members.length} messages)${partLabel(p)}`,
      });
    }
  }

  return items;
}

/**
 * The most text one thought holds, in characters. A search hit returns its
 * thought whole and a re-embed sends every one of its windows, so a thought
 * of hundreds of KB (a busy month, a long thread) was more than a client takes
 * and was re-embedded whole at every change (SMD-2493).
 */
const TEXT_BOUND = 100_000;

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

/**
 * Members grouped by the calendar day (UTC) of their date, oldest first, one
 * thought a day (in parts past the bound): so a member a later export adds or
 * drops changes only its own day's thought, which updates in place, and no
 * other. (Batches of a fixed size shifted at every member added or dropped
 * before them, and the shifted batches landed as new rows beside the old: the
 * pipeline adds and updates, it does not remove.) Members with no date are
 * the `undated` day. Within a day the order is by date, then by the member as
 * exported, so it is the same however the export lists them.
 */
function byDay(members, kind, lineOf, render) {
  const days = new Map();
  for (const m of members) {
    const day = m.date ? m.date.slice(0, 10) : "undated";
    if (!days.has(day)) days.set(day, []);
    days.get(day).push({ ...m, tie: JSON.stringify(m.raw) });
  }
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...days.keys()].sort(order).flatMap((day) => {
    const sorted = days.get(day).sort((a, b) => order(a.date ?? "", b.date ?? "") || order(a.tie, b.tie));
    return parts(`${kind}:${day}`, sorted, lineOf, "\n\n").map((p) => ({
      key: p.key, of: p.of, kind, canonical: JSON.stringify(p.members.map((m) => m.raw)), createdAt: p.members[0].date, ...render(p, `${day === "undated" ? "with no date" : `on ${day}`}${partLabel(p)}`),
    }));
  });
}

// ── Comments Processing ──────────────────────────────────────────────────

async function processComments(activityDir) {
  const commentsDir = join(activityDir, "comments");
  const allComments = [];

  for (const file of (await namesIn(commentsDir)).filter((f) => f.endsWith(".json")).sort()) {
    const data = await readJson(join(commentsDir, file));
    const comments = data?.comments_media_comments || data || [];
    if (!Array.isArray(comments)) continue;
    for (const c of comments) {
      const text = c?.string_map_data?.["Comment"]?.value
        || c?.string_map_data?.["comment"]?.value
        || c?.value || "";
      const timestamp = c?.string_map_data?.["Time"]?.timestamp
        || c?.timestamp || 0;
      if (typeof text === "string" && text.length > 10) {
        allComments.push({ raw: c, text: fixMetaEncoding(text), date: fromMs(timestamp * 1000) });
      }
    }
  }

  // One thought a day (byDay)
  return byDay(allComments, "comments", (c) => c.text, (p, label) => ({
    content: `Instagram comments by user ${label}:\n\n${p.text}`,
    title: `Instagram comments ${label}`,
  }));
}

// ── Posts/Captions Processing ────────────────────────────────────────────

async function processPosts(activityDir) {
  const postsFile = join(activityDir, "content", "posts_1.json");
  const captions = [];
  if (!(await namesIn(join(activityDir, "content"))).includes("posts_1.json")) return [];

  const posts = await readJson(postsFile);
  for (const post of (Array.isArray(posts) ? posts : [])) {
    const title = typeof post?.title === "string" ? fixMetaEncoding(post.title) : "";
    const timestamp = post?.creation_timestamp || 0;
    if (title.length > 10) {
      captions.push({ raw: post, text: title, date: fromMs(timestamp * 1000) });
    }
  }

  // One thought a day (byDay)
  return byDay(captions, "captions", (c) => c.text, (p, label) => ({
    content: `Instagram post captions ${label}:\n\n${p.text}`,
    title: `Instagram captions ${label}`,
  }));
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const { path, skip, limit, types } = parseArgs(process.argv.slice(2));

  const activityDir = await findActivityDir(path);
  if (!activityDir) {
    // An empty folder (the import runner's, before an export is put in it) is no export: nothing to emit.
    console.error(`No 'your_instagram_activity' folder under ${path}; nothing emitted. Point the script at the extracted export.`);
    return;
  }
  console.error(`Activity dir: ${activityDir}`);

  const allItems = [];

  if (types.includes("messages")) {
    const msgs = await processMessages(activityDir);
    allItems.push(...msgs);
    console.error(`Messages: ${msgs.length} conversations`);
  }

  if (types.includes("comments")) {
    const comments = await processComments(activityDir);
    allItems.push(...comments);
    console.error(`Comments: ${comments.length} days`);
  }

  if (types.includes("posts")) {
    const posts = await processPosts(activityDir);
    allItems.push(...posts);
    console.error(`Posts: ${posts.length} days`);
  }

  const toProcess = allItems.slice(skip, skip + limit);
  const seen = new Set();
  let emitted = 0, skipped = 0;

  for (const it of toProcess) {
    // The short-text skip is a whole group's: a short first part before a message cut at the bound is kept.
    if (it.of === 1 && it.content.trim().length < 50) { skipped++; continue; }
    // Two lines of one identity refuse the whole file, so a thought the export would make twice is emitted once.
    if (seen.has(it.key)) { console.error(`${it.key} appears twice; emitted once`); skipped++; continue; }
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
    process.stdout.write(`${JSON.stringify(item)}\n`);
    emitted++;
  }

  console.error(`Emitted ${emitted} item(s), skipped ${skipped} (of ${toProcess.length}; skip=${skip}, limit=${limit === Infinity ? "all" : limit})`);
  if (droppedDates.size) console.error(`${droppedDates.size} date(s) left out, not ones the brain accepts (it dates those thoughts when it writes them): ${[...droppedDates].slice(0, 5).map((d) => JSON.stringify(d.slice(0, 40))).join(", ")}`);
}

await main();
