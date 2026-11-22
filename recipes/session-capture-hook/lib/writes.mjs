/**
 * lib/writes.mjs — the write fan-out (SMD-3314; moved here by SMD-4338): the
 * copies of each capture, edit, delete and forget made through one brain's
 * connector, queued for every other brain with a write key and drained in
 * order under one lock per brain; a forget's copies dropped and its review
 * logged (SMD-1723, SMD-4411); and --check's look at a brain's write key.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync, openSync, closeSync, statSync, utimesSync, linkSync } from "node:fs";
import { join, basename } from "node:path";
import { spawn } from "node:child_process";
import { UUID, oneLine, shellWord, shownUrl } from "./util.mjs";
import { CLAIM_MAX_AGE_MS, CONFIG_PATH, DEAD_MAX_AGE_MS, LOG_PATH, PENDING_MAX_AGE_MS, SELF, STATE_BASE, STATE_DIR, ensureDirs, isAlive, log, useStateRoot } from "./state.mjs";
import { SDK_ERROR_RE, resultText, rpc, textOfResult } from "./rpc.mjs";
import { BRAIN_NAME_RE } from "./config.mjs";
import { providerMends, verdictOf } from "./post.mjs";

// ── The write fan-out (SMD-3314) ─────────────────────────────────────────────
//
// A PostToolUse hook on the brain's write tools: each capture, edit, delete
// and forget that lands on the brain a connector names is repeated on every
// other brain with a write key, through that brain's own key and its own
// queue. A copied capture carries `client_key`: the id the first brain gave
// the thought, which the server keeps on the copy (migration 112), so an edit
// or a pointer that names the thought by that id finds the copy on every
// brain. The queue keeps the first brain's order, one write at a time: a
// capture lands before the edit, the delete or the forget of it, and a brain
// away holds its queue until it answers.

/** The write tools a fan-out repeats: forget_thought since 1.9.0 (SMD-1723 PR 3), a server from 144 on serving it. */
export const FANOUT_TOOLS = ["capture_thought", "update_thought", "delete_thought", "forget_thought"];
/** The fan-out's tools a brain's server may lack and still take the rest: a copy of one is held for it, not refused. */
const FANOUT_LATER = new Set(["forget_thought"]);
const WRITES_DIR = () => join(STATE_DIR, "writes");
const WRITES_PENDING = () => join(WRITES_DIR(), "pending");
const WRITES_DEAD = () => join(WRITES_DIR(), "dead");
const DRAIN_LOCK = () => join(WRITES_DIR(), "drain.lock");
/** A drain lock held this long by a live process is a stalled drain's, and is taken back. */
const DRAIN_LOCK_MAX_AGE_MS = 15 * 60_000;

/** Whether a result is the tool's error: its flag, where the shape carries one, else its words (a refusal, a fault, an unknown id). */
export function resultIsError(resp, text) {
  if (resp && typeof resp === "object" && !Array.isArray(resp) && (resp.isError === true || resp.result?.isError === true)) return true;
  return /^\s*(?:Refused\b|Error\b|No thought with id\b|MCP error\b)/.test(text);
}

/** A value's outline for the log — its types and keys, never its text. */
function shapeOf(v, depth = 0) {
  if (Array.isArray(v)) return depth > 1 ? "list" : `list[${v.length ? shapeOf(v[0], depth + 1) : ""}]`;
  if (v && typeof v === "object") return depth > 1 ? "object" : `{${Object.keys(v).slice(0, 8).map((k) => `${k}: ${shapeOf(v[k], depth + 1)}`).join(", ")}}`;
  return v === null ? "null" : typeof v;
}

/** The named keys of an object that it holds, as they are (a null too: update_thought's `supersedes: null` clears). */
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]]));

/**
 * What a PostToolUse hook copies, and where: `{ source, targets, op }`, or
 * `{ skip }` — a reason to log, or null for a tool that is not the fan-out's.
 * The source is the brain whose `connector` names the tool's server; a write
 * through any other server (the canary's own connector, its test traffic) is
 * that brain's alone. The targets are the other brains with a write key.
 */
export function fanOutPlan(hook, brains) {
  const m = /^mcp__(.+)__([a-z_]+)$/.exec(String(hook?.tool_name ?? ""));
  if (!m || !FANOUT_TOOLS.includes(m[2])) return { skip: null };
  const [, server, tool] = m;
  const source = brains.find((b) => b.cfg.connector === server);
  if (!source) return { skip: null };
  const targets = brains.filter((b) => b !== source && b.cfg.writeKey);
  // A forget goes on with none: its drop reaches every brain's queue, and a brain left without a key that has been copied to (its writes/ is there) is held it (queueForget, SMD-4411).
  if (!targets.length && tool !== "forget_thought") return { skip: `${tool} through ${server}: no other brain has a write_key, so nothing is copied` };
  const input = hook.tool_input && typeof hook.tool_input === "object" && !Array.isArray(hook.tool_input) ? hook.tool_input : {};
  const resp = hook.tool_response;
  const text = resultText(resp);
  const first = text.split("\n")[0];
  const sc = resp && typeof resp === "object" && !Array.isArray(resp) ? (resp.structuredContent ?? resp.result?.structuredContent) : undefined;
  const scId = typeof sc?.id === "string" && new RegExp(`^${UUID}$`, "i").test(sc.id) ? sc.id.toLowerCase() : undefined;
  // A write that failed reaches PostToolUseFailure, not this hook; a result
  // that reads as an error is never copied all the same — a refusal's or a
  // fault's code, or a reply that is not the tool's success: `Captured as`,
  // `Updated`, `Deleted`, `Forgot` (review pass 2: a fault's
  // `update_thought failed: …` read as a success).
  const success = { capture_thought: /^Captured as /, update_thought: /^Updated /, delete_thought: /^Deleted /, forget_thought: /^Forgot / }[tool];
  if (resultIsError(resp, text) || typeof sc?.code === "string" || !(success.test(first) || (scId && !/^Already captured\b/.test(first) && sc?.keyed !== "matched")))
    return { skip: /^Already captured\b/.test(first) || sc?.keyed === "matched"
      // The key named a thought already there: nothing was written on the first brain, so nothing is copied (review pass 2).
      ? `capture_thought matched a thought already on ${source.name} by its client_key and wrote nothing, so nothing is copied`
      : `${tool} did not land on ${source.name}, so it is not copied: ${oneLine(text).slice(0, 120) || `its shape: ${shapeOf(resp)}`}` };
  let args, alt;
  if (tool === "capture_thought") {
    // The id the first brain gave it: the result's structured id where the
    // shape carries one, else the reply's first line — `Captured as <type> —
    // id <uuid>`, the type the model's, up to 40 characters, so the id is the
    // one after it, never one a type spells (review pass 1).
    const id = scId
      ?? new RegExp(`^Captured as .*? — id (${UUID})\\b`, "i").exec(first)?.[1]
      ?? new RegExp(`^Captured as\\b.*\\bid (${UUID})\\b`, "i").exec(first)?.[1];
    if (!id) return { skip: `${source.name}'s reply to capture_thought named no id, so it is not copied (its shape: ${shapeOf(resp)})` };
    if (typeof input.content !== "string") return { skip: "capture_thought's input carried no content, so it is not copied" };
    args = { ...pick(input, ["content", "derived_from", "supersedes", "source", "trust", "metadata"]), client_key: id.toLowerCase() };
  } else {
    // The thought by the id the first brain answered: a name the caller gave
    // as a client_key resolved there to the thought's own id, which is the
    // copy's key (review pass 2); else the name as sent.
    const answered = scId ?? new RegExp(`^(?:Updated|Deleted|Forgot) (${UUID})\\b`, "i").exec(first)?.[1]?.toLowerCase();
    args = tool === "update_thought"
      // `if_unchanged_since` is the first brain's clock: the copy is always newer, so it is not sent.
      ? pick(input, ["id", "content", "metadata_patch", "supersedes"])
      : pick(input, ["id", "detach_citations"]);
    if (answered) args.id = answered;
    if (typeof args.id !== "string") return { skip: `${tool}'s input carried no id, so it is not copied` };
    if (tool === "forget_thought") {
      // A forget's echo (SMD-1723 PR 3): the name the copy sends, which each brain resolves on its own — the first
      // brain's id, there the copy's client_key — so the echo is checked against what reaches that brain.
      args.confirm = args.id;
      // Its citations there go with it: the person chose to forget on the first brain, and a citation on another is a
      // copy of the text (the maintainer, review pass 1: a copy refused CITED was given up, the text left there).
      args.detach_citations = true;
      // The thought's own client_key, as the reply names it: where the receiving brain knows the thought by that key
      // alone — the thought began there, its id its own — the copy is sent again by it (review pass 1).
      const ownName = new RegExp(`\\bclient_key (${UUID})\\b`, "i").exec(first)?.[1]?.toLowerCase();
      if (ownName && ownName !== args.id) alt = ownName;
    }
    if (tool === "update_thought" && Object.keys(args).length === 1) return { skip: `update_thought of ${args.id} changed nothing a copy carries, so it is not copied` };
  }
  return { source, targets, op: { tool, args, ...(alt ? { alt } : {}), from: source.name, session: typeof hook.session_id === "string" ? hook.session_id : null, at: new Date().toISOString() } };
}

/** Writes a copy into the current brain's queue: a name that sorts in the order the hooks ran, written whole before it is seen. */
export function enqueueWrite(op) {
  mkdirSync(WRITES_PENDING(), { recursive: true, mode: 0o700 });
  const name = `${String(Date.now()).padStart(15, "0")}-${String(process.hrtime.bigint() % 10n ** 15n).padStart(15, "0")}-${process.pid}.json`;
  const tmp = join(WRITES_PENDING(), `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(op), { mode: 0o600 });
  renameSync(tmp, join(WRITES_PENDING(), name));
  return name;
}

/**
 * Removes the current brain's queued and given-up copies that carry a thought by one of `names` — a capture keyed so,
 * an edit or a delete of it — and returns how many (SMD-1723 PR 3). A forget's own copies stay, and so does a queued
 * copy a send may have reached (`sent`), or one in flight or left so by a killed drain (`sending`): it may have landed,
 * or land late, and the forget behind it is what reaches it there — dropped, a capture committed after the forget's
 * NOT_FOUND kept its text for good (review passes 7 and 8). `dirs` narrows it to one of the two (SMD-4411).
 */
export function dropCopiesOf(names, dirs = [WRITES_PENDING(), WRITES_DEAD()]) {
  const want = new Set(names.map((n) => String(n).toLowerCase()));
  let n = 0;
  for (const dir of dirs) {
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")); } catch { continue; }
    for (const f of files) {
      let op;
      try { op = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
      if (op?.tool === "forget_thought") continue;
      if ((op?.sent === true || op?.sending === true) && dir === WRITES_PENDING()) continue;
      if (namesOf(op).some((x) => want.has(x))) { try { unlinkSync(join(dir, f)); n++; } catch { /* gone: a drain took it */ } }
    }
  }
  return n;
}
/** The names a queued copy carries a thought by: a capture's client_key, an edit's or a delete's id. */
const namesOf = (op) => [op?.args?.client_key, op?.args?.id].filter((x) => typeof x === "string").map((x) => x.toLowerCase());
/** Whether the current brain's queue still holds a copy of a thought by one of `names` — after a drop, one kept for having maybe landed. */
function queueCarries(names) {
  const want = new Set(names.map((n) => String(n).toLowerCase()));
  return pendingWrites().some((f) => { try { const op = JSON.parse(readFileSync(join(WRITES_PENDING(), f), "utf8")); return op?.tool !== "forget_thought" && namesOf(op).some((x) => want.has(x)); } catch { return false; } });
}

/**
 * A forget queued (SMD-1723 PR 3, SMD-4411). Each brain it covers — every configured brain with `all`, else the
 * `targets` — first loses its queued and given-up copies of the thought (dropCopiesOf). Then the forget goes into its
 * queue: queued where the brain has a write key, held where it has none but has been copied to (its writes/ is there),
 * to land behind whatever was sent before it once a key is set, as a brain away holds its queue. The brain the forget
 * was made on (`source`) has forgotten it already, but a copy its queue kept for having maybe landed (a two-way
 * fan-out queues copies to it too) would land again, as a new thought under its key: so it is queued the forget too
 * where it has a write key — whatever its queue shows, since a drain racing the drop can write such a copy back after
 * the drop read the queue — and held where it has none and its queue still carries one (review pass 1). By hand
 * (`sourceAlways` false: --copy-forget, which cannot tell a forgotten id from a wrong one) it is queued the forget only
 * where its queue carries a copy, so a wrong id never forgets the person's own thought there (review pass 2). With
 * `all`, a queue left on disk by a brain no longer in the config (renamed, removed) loses its copies too, said in the
 * first brain's log, with the command for one still carrying a copy that may have landed. Each brain is its own step:
 * one whose queue cannot be written is logged, in its own log and the first brain's, with the --copy-forget that
 * redoes it, and the others go on (review passes 2 and 3). Returns `{ queued, held, failed }`: `{ brain, name }` for
 * each queue the forget was queued or held in, and the brains that failed.
 */
export function queueForget(op, brains, { source = null, targets, all, sourceAlways = true }) {
  const names = [op.args.id, op.alt].filter(Boolean);
  const queued = [], held = [], failed = [];
  // Lines for the first brain's log too, the one an operator reads: a forget lost on a brain, a stray queue's copy (review pass 3).
  const notices = [];
  // The command that redoes a forget lost on one brain: --brain names it, save the brain the forget was made on, which --copy-forget sends one only where its queue carries a copy.
  const redo = (name) => `bun ${shellWord(SELF)} --copy-forget ${op.args.id}${op.alt ? ` --client-key ${op.alt}` : ""} --from ${source?.name ?? "<the brain you forgot it on>"}${source && name === source.name ? "" : ` --brain ${name}`} --yes`;
  for (const b of all ? brains : targets) {
    try {
      useStateRoot(b.root);
      const dropped = dropCopiesOf(names);
      if (dropped) log(`fan-out: dropped ${dropped} queued or given-up cop${dropped === 1 ? "y" : "ies"} of ${op.args.id}, which a forget follows`);
      const owed = b !== source || (b.cfg.writeKey && sourceAlways) || queueCarries(names);
      if (!owed) continue;
      if (b.cfg.writeKey) {
        queued.push({ brain: b, name: enqueueWrite(op) });
        log(`fan-out: queued ${opLabel(op)} from ${op.from}${b === source ? ", where it was made: a copy kept here for having maybe landed is sent again before it" : ""}`);
      } else if (existsSync(WRITES_DIR())) {
        held.push({ brain: b, name: enqueueWrite({ ...op, held: true }) });
        log(`fan-out: held ${opLabel(op)} from ${op.from}: this brain has no write_key now; once one is set, it lands, in order, at its next drain`);
      }
    } catch (e) {
      failed.push(b);
      const line = `fan-out: error: ${oneLine(String(e?.message ?? e)).slice(0, 200)} — ${opLabel(op)} was not queued for ${b.name}; once that is mended, run: ${redo(b.name)}`;
      log(line);
      notices.push(line);
    }
  }
  if (all) {
    const configured = new Set(brains.map((b) => b.root));
    let stray = [];
    try { stray = readdirSync(join(STATE_BASE, "brains")).map((n) => join(STATE_BASE, "brains", n)).filter((r) => !configured.has(r) && existsSync(join(r, "writes"))); } catch { /* none */ }
    for (const root of stray) {
      // Its own log is no one's now, and log() would make a state there: what it lost and kept is said in the first brain's.
      try {
        useStateRoot(root);
        const dropped = dropCopiesOf(names);
        if (dropped) notices.push(`fan-out: dropped ${dropped} queued or given-up cop${dropped === 1 ? "y" : "ies"} of ${op.args.id} from ${root}, the queue of a brain no longer in the config`);
        // A copy kept for having maybe landed, on a brain no forget can be queued for: named, with what sends one.
        if (queueCarries(names)) notices.push(`fan-out: a copy of ${op.args.id} in ${root} was sent to the brain that queue was for and may have landed there, and no forget follows it: once that brain is back in the config, run: ${redo(basename(root))}`);
      } catch (e) { notices.push(`fan-out: error: ${oneLine(String(e?.message ?? e)).slice(0, 200)} — reading ${root}`); }
    }
  }
  if (notices.length && brains.length) { useStateRoot(brains[0].root); for (const line of notices) if (!failed.includes(brains[0]) || !line.includes(`not queued for ${brains[0].name};`)) log(line); }
  return { queued, held, failed };
}

/**
 * For a PostToolUse run of a forget that landed, the words naming it and the --copy-forget that copies it — for a run
 * whose config did not load, which copies nothing (SMD-4411 review pass 1) — or null. Read from the reply, and the
 * --from brain's name from the config's JSON where it still reads: with no config loaded, which connector the fan-out
 * copies from is unknown, so the words say it applies to that one.
 */
export function lostForget(hook) {
  if (hook?.hook_event_name !== "PostToolUse" || !/^mcp__.+__forget_thought$/.test(String(hook?.tool_name ?? ""))) return null;
  const text = resultText(hook.tool_response);
  if (resultIsError(hook.tool_response, text)) return null;
  const first = text.split("\n")[0];
  const id = new RegExp(`^Forgot (${UUID})\\b`, "i").exec(first)?.[1]?.toLowerCase();
  if (!id) return null;
  const ownName = new RegExp(`\\bclient_key (${UUID})\\b`, "i").exec(first)?.[1]?.toLowerCase();
  const server = /^mcp__(.+)__forget_thought$/.exec(String(hook.tool_name))[1];
  // The brain whose connector it is, where the config's JSON still reads (a key file failed, not the file): named (review pass 3).
  let from = `<the brain whose connector is ${server}>`;
  try { const named = JSON.parse(readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "")).brains?.find?.((b) => b?.connector === server)?.name; if (typeof named === "string" && BRAIN_NAME_RE.test(named)) from = named; } catch { /* unreadable: the placeholder */ }
  return `forget_thought of ${id} was not copied to the other brains, as the config did not load. If it went through the connector the fan-out copies from, run once the config loads: bun ${shellWord(SELF)} --copy-forget ${id}${ownName && ownName !== id ? ` --client-key ${ownName}` : ""} --from ${from}, then again with --yes`;
}

/** The current brain's queued copies, oldest first. */
export const pendingWrites = () => (existsSync(WRITES_PENDING()) ? readdirSync(WRITES_PENDING()).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort() : []);

/**
 * One drain per brain at a time: the lock, or false when a live drain holds
 * it. Its age is the time since its holder last began a copy (drainWrites
 * touches it before each), so a long drain is never mistaken for a stalled
 * one; a dead holder's, or one silent past DRAIN_LOCK_MAX_AGE_MS, is taken
 * back by renaming it aside — one process's rename wins, so two never both
 * take it and each make a lock of its own (review pass 1).
 */
function takeDrainLock() {
  mkdirSync(WRITES_DIR(), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    // Made whole: the pid written to a file of this process's own, then
    // linked into place — the link fails if a lock is there — so no drain
    // ever reads a lock still empty, judges it stale and takes it from the
    // drain making it (review pass 2: the two-drain case caught one doing
    // so, and both stopped).
    const mine = `${DRAIN_LOCK()}.new.${process.pid}`;
    try {
      writeFileSync(mine, String(process.pid), { mode: 0o600 });
      linkSync(mine, DRAIN_LOCK());
      unlinkSync(mine);
      return true;
    } catch (e) {
      try { unlinkSync(mine); } catch { /* not made */ }
      if (e?.code !== "EEXIST") throw e;
      let pid = NaN, age = 0;
      try { pid = Number(readFileSync(DRAIN_LOCK(), "utf8").trim()); age = Date.now() - statSync(DRAIN_LOCK()).mtimeMs; } catch { continue; } // gone between the two: try again
      if (liveLock(pid, age)) { log(`drain: the queue is left to the drain in pid ${pid}`); return false; }
      const aside = `${DRAIN_LOCK()}.${process.pid}`;
      try { renameSync(DRAIN_LOCK(), aside); } catch { continue; } // another took it back first: try for the new one
      // Taken back only if what was moved aside is still a lock to take: its
      // holder may have renewed it, or made a new one, in the gap — judged
      // again on its pid AND its age (review pass 2). One still live goes back
      // by a hard link, which fails rather than overwrite a lock made meanwhile.
      let nowPid = pid, nowAge = age;
      try { nowPid = Number(readFileSync(aside, "utf8").trim()); nowAge = Date.now() - statSync(aside).mtimeMs; } catch { /* unreadable: judged as read */ }
      if (liveLock(nowPid, nowAge)) { try { linkSync(aside, DRAIN_LOCK()); } catch { /* a newer one stands */ } try { unlinkSync(aside); } catch { /* gone */ } log(`drain: the queue is left to the drain in pid ${nowPid}`); return false; }
      try { unlinkSync(aside); } catch { /* gone */ }
      log(`drain: took back the lock of pid ${Number.isInteger(pid) ? pid : "?"}${Number.isInteger(pid) && isAlive(pid) ? `, silent for ${Math.round(age / 60_000)} min` : ", no longer running"}`);
    }
  }
  return false;
}
/** A lock to leave alone: another live process's, renewed within DRAIN_LOCK_MAX_AGE_MS. An unreadable one is not (review pass 2). */
const liveLock = (pid, age) => Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid) && age < DRAIN_LOCK_MAX_AGE_MS;
const releaseDrainLock = () => { try { if (Number(readFileSync(DRAIN_LOCK(), "utf8").trim()) === process.pid) unlinkSync(DRAIN_LOCK()); } catch { /* not ours, or gone */ } };
/** Whether this process still holds the lock, its age reset: false once another has taken it back — the drain stops, the copy left to it. */
const holdDrainLock = () => { try { if (Number(readFileSync(DRAIN_LOCK(), "utf8").trim()) !== process.pid) return false; const t = new Date(); utimesSync(DRAIN_LOCK(), t, t); return true; } catch { return false; } };

/**
 * Whether a queued file holds a copy as the hook writes one: an object whose `tool` is one the fan-out copies
 * (FANOUT_TOOLS: a mistyped one was held a week, the log saying to mint a write key that was fine — review pass 2), an
 * object `args`, an `at` that parses as a date, and the names the drain reads — `args.client_key`, `args.id`, `alt` — each a string or absent.
 * Anything else, a hand edit or a corrupt file, is given up as one that does not parse: it threw on every drain, ahead
 * of the week's give-up, or, with no date, was never given up once a fault kept it, and every copy behind it waited
 * for good (SMD-4412). A name that is no string (`{"toString":1}`) threw wherever a template or String() met it — the
 * log's label, a forget's note, its drop of dead/ copies — so it is refused here, before any of them (review passes 1, 2).
 */
const isCopy = (op) => FANOUT_TOOLS.includes(op?.tool) && op.args !== null && typeof op.args === "object" && !Array.isArray(op.args)
  && Number.isFinite(Date.parse(op.at)) && [op.args.client_key, op.args.id, op.alt].every((n) => n === undefined || typeof n === "string");

/** A copy as the log names it: the tool and the id or key it names, never its text. */
const opLabel = (op) => `${op.tool}${op.tool === "capture_thought" ? ` (client_key ${op.args.client_key})` : ` of ${op.args.id}`}`;

/**
 * One copy onto a brain, through its write key. `done` — landed, or skipped
 * for good: the thought it names was never copied there (NOT_FOUND, marked
 * `notFound`); `keep` — the brain did not answer, or answered a transient: the
 * queue stops here, in order, with `unknown` when the send may have reached the
 * brain (a transport failure past the connection, a fault, a store it could not
 * reach); `dead` — refused for good. A pointer the brain does not know (a
 * thought each brain's own writers made, a board-sync row) is dropped and the
 * write tried again, as the server's contract asks (SMD-3314 PR 1). A forget
 * answered NOT_FOUND or FORGOTTEN is sent again by the thought's own client_key
 * (`alt`) where it carries one (SMD-4411).
 */
export async function postWrite(cfg, op) {
  const wcfg = { ...cfg, key: cfg.writeKey };
  const args = structuredClone(op.args);
  const dropped = [];
  let forgottenBefore = false; // a forget whose id answered FORGOTTEN, sent again by the thought's own client_key
  let byKey = ""; // why a forget went again by the thought's own client_key, for its line
  for (let attempt = 0; attempt < 5; attempt++) {
    let result;
    try { result = await rpc(wcfg, "tools/call", { name: op.tool, arguments: args }); }
    catch (e) {
      const msg = oneLine(String(e?.message ?? e));
      // A real server answers a tool it lacks with a JSON-RPC error, which rpc throws (review pass 7: the lines below
      // never ran against one). A transport failure past the connection (a timeout, a 5xx from a front, a reset) may
      // have reached the brain: its answer is unknown. One refused at the connection, or a name resolving to nothing,
      // never did; nor did a JSON-RPC error, which the server answered.
      const missing = toolMissing(op, msg);
      const unknown = !missing && !/^JSON-RPC /.test(msg) && !NOT_REACHED.has(e?.code) && !NOT_REACHED.has(e?.cause?.code);
      return { keep: true, ...(unknown ? { unknown: true } : {}), line: missing ?? `kept: ${opLabel(op)} — ${msg.slice(0, 200)}` };
    }
    const text = textOfResult(result);
    const note = `${dropped.length ? ` (dropped: ${dropped.join(", ")})` : ""}${byKey ? ` (sent again by its client_key ${op.alt}, ${byKey})` : ""}`;
    // A forget that left some of the thought there (a replay, a fault, on a copy after the first): kept, to be sent
    // again, so its text does not stay there for a copy logged done (SMD-1723 PR 3, review pass 2).
    const missedThere = op.tool === "forget_thought" && !result.isError && Array.isArray(result.structuredContent?.notForgotten) ? result.structuredContent.notForgotten : [];
    if (missedThere.length) return { keep: true, line: `kept: ${opLabel(op)} — forgotten in part there, ${missedThere.length} cop${missedThere.length === 1 ? "y" : "ies"} of it not yet (${[...new Set(missedThere.map((m) => String(m?.code ?? "?")))].join(", ")}): sent again` };
    if (!result.isError) {
      const id = new RegExp(`\\b(${UUID})\\b`, "i").exec(text.split("\n")[0])?.[1];
      const keyed = typeof result.structuredContent?.keyed === "string" ? `, ${result.structuredContent.keyed}` : "";
      // Recorded on a thought this brain already held by the same text — its own, now named by the first brain's id
      // too, so the first brain's later edits and delete reach it (the server's rule: one text, one thought) (review pass 2).
      const onto = result.structuredContent?.keyed === "recorded" && result.structuredContent?.existed === true ? " onto a thought already there by the same text" : "";
      return { done: true, line: `copied ${opLabel(op)}${id ? ` → ${id.toLowerCase()}` : ""}${keyed}${onto}${note}${op.tool === "forget_thought" ? forgetReview(result.structuredContent) : ""}` };
    }
    const v = verdictOf(result, text);
    // Forgotten there already (its own forget, or a copy that landed before a lost answer): done (SMD-1723 PR 3) — once
    // the thought's own client_key is tried too. A copy queued there ahead of this forget, kept for having maybe landed,
    // was sent again and lands as a new thought under that key, which a forget by this name no longer reaches (SMD-4411
    // review pass 1: the first brain's own queue, and --copy-forget given the receiving brain's own id).
    if (op.tool === "forget_thought" && v.code === "FORGOTTEN") {
      if (op.alt && args.id !== op.alt) { args.id = op.alt; args.confirm = op.alt; forgottenBefore = true; byKey = "its id forgotten there already"; continue; }
      return { done: true, line: `copied ${opLabel(op)}: forgotten there already${note}` };
    }
    // A tool this brain cannot call (toolMissing says which): a server from before forget_thought (migration 144),
    // the copy waiting for it, in order, as a brain away does — given up only after the week — so the forget is not
    // lost (SMD-1723 PR 3); or a key that cannot call it (a capture key in write_key), the operator's to fix, which
    // every later copy would meet — kept, in order.
    const cannotCall = SDK_ERROR_RE.test(text) && toolMissing(op, text);
    if (cannotCall) return { keep: true, line: cannotCall };
    // A capture key in write_key, which cannot send a client_key: the operator's to fix, kept, as above.
    if (v.code === "REFUSED_CLIENT_KEY_SCOPE") return { keep: true, line: `kept: ${opLabel(op)} — the write key cannot send a client_key (a capture key); mint a write key on this brain (bun server-portable/keygen.ts --name claude-code --scope write) and set write_key — --check says` };
    // A forget the brain knows by the thought's own client_key alone (the thought began there): sent again by it.
    if (op.tool === "forget_thought" && v.code === "NOT_FOUND" && op.alt && args.id !== op.alt) {
      args.id = op.alt; args.confirm = op.alt;
      byKey = "its id not found there";
      continue;
    }
    // Its id forgotten there already, and nothing there under its client_key either: done.
    if (forgottenBefore && v.code === "NOT_FOUND") return { done: true, line: `copied ${opLabel(op)}: forgotten there already, and nothing there keeps its client_key ${op.alt}` };
    // A forget's NOT_FOUND may also be one forgotten there already, by a copy whose answer was lost — a forgotten copy
    // keeps no key to resolve (SMD-1723 PR 3). `notFound` lets --copy-forget say a name that found nothing (review pass 1).
    if (v.code === "NOT_FOUND") return { done: true, notFound: true, line: `skipped ${opLabel(op)}: no thought there has that id or keeps it as its client_key — never copied to this brain${op.tool === "forget_thought" ? ", or forgotten there already (also, its text kept: a copy deleted there before by its key, on a v2.1.0 server; a thought that began here, its forget from a v2.1.0 first brain, whose reply names no client_key — upgrade both and forget it here)" : ""}${note}` };
    // A fault (FAILED: the REST core away behind the MCP server, the store
    // restarting, a busy registry) carries no `retryable`, which verdictOf reads
    // as final: kept, so a brain mid-restart does not lose its edits (review pass 2).
    if (v.code === "FAILED") return { keep: true, unknown: true, line: `kept: ${opLabel(op)} — ${oneLine(text).slice(0, 200)}` };
    if (v.mend === "derived" && args.derived_from) {
      const at = v.positions.filter((i) => i < args.derived_from.length);
      dropped.push(at.length ? `derived_from[${at.join(", ")}]` : "derived_from");
      args.derived_from = at.length ? args.derived_from.filter((_, i) => !at.includes(i)) : [];
      if (!args.derived_from.length) delete args.derived_from;
      continue;
    }
    // Metadata the brain's server refuses (a key it reserves that the first
    // brain's did not): dropped and sent again, as the session hook drops a
    // summary's (review pass 2).
    if (v.mend === "metadata" && (args.metadata !== undefined || args.metadata_patch !== undefined)) {
      dropped.push(args.metadata !== undefined ? "metadata" : "metadata_patch");
      delete args.metadata; delete args.metadata_patch;
      if (op.tool === "update_thought" && Object.keys(args).length === 1) return { done: true, line: `skipped ${opLabel(op)}: its only change, metadata_patch, this brain refuses (${oneLine(text).slice(0, 120)})` };
      continue;
    }
    if ((v.mend === "supersedes" || v.code === "REFUSED_WOULD_CYCLE") && typeof args.supersedes === "string") {
      dropped.push("supersedes");
      delete args.supersedes;
      if (op.tool === "update_thought" && Object.keys(args).length === 1) return { done: true, line: `skipped ${opLabel(op)}: its only change, supersedes, names no thought there` };
      continue;
    }
    // The receiving brain's embedding provider refusing it (a key or a model its operator mends, SMD-2892): held as a
    // fault is, not given up — its edits and delete would otherwise meet NOT_FOUND there (review pass 1).
    // STORE_UNAVAILABLE is how a capture says the fault FAILED says for an edit: the REST core behind the MCP server
    // away or slow — which may have committed it all the same (review pass 9).
    if (v.retryable || providerMends(result)) return { keep: true, ...(v.code === "STORE_UNAVAILABLE" ? { unknown: true } : {}), line: `kept: ${opLabel(op)} — ${oneLine(text).slice(0, 200)}` };
    return { dead: true, line: `not copied (given up): ${opLabel(op)} — ${oneLine(text).slice(0, 200)}${note}${op.tool === "forget_thought" ? " — its text stays on this brain until forgotten there by hand" : ""}` };
  }
  return { dead: true, line: `not copied (given up): ${opLabel(op)} — still refused after dropping ${dropped.join(", ")}` };
}

/**
 * The current brain's queue, oldest first, one copy at a time, until it is
 * empty or a copy is kept — the rest wait behind it, in order. One drain per
 * brain: a drain that finds the lock held leaves the queue to its holder, and a
 * holder looks once more after it lets go, so a copy queued meanwhile is not
 * left behind. Returns each copy's outcome, with its file's `name` and a
 * forget's `forgetOf`; each is also a line in the log.
 */
export async function drainWrites(cfg) {
  const outcomes = [];
  pruneWrites();
  const seen = new Set(); // names this drain has dealt with: one that answers ENOENT every time (a dangling link) cannot spin it (review pass 2)
  for (;;) {
    if (!takeDrainLock()) return outcomes;
    let stopped = false;
    try {
      for (const name of pendingWrites()) {
        if (seen.has(name)) continue;
        seen.add(name);
        // Still this drain's, its age reset before each copy: a lock another
        // took back means the rest is theirs now (review pass 1). Only a holder
        // silent past DRAIN_LOCK_MAX_AGE_MS loses it — a copy's longest is five
        // attempts at POST_TIMEOUT_MS, well inside — so the one copy such a
        // holder had in flight is the only one two drains can both post, and
        // its key makes the second land as the same thought — unless its
        // forget lands between the two, a gap the lock check just before the
        // send narrows.
        if (!holdDrainLock()) { stopped = true; break; }
        const path = join(WRITES_PENDING(), name);
        let op;
        try { op = JSON.parse(readFileSync(path, "utf8")); } catch (e) {
          if (e?.code === "ENOENT") { try { unlinkSync(path); } catch { /* gone: the holder before finished it */ } continue; }
          moveWrite(path, WRITES_DEAD(), name);
          const o = { dead: true, name, line: `not copied (given up): ${name} does not parse` };
          log(o.line); outcomes.push(o); continue;
        }
        if (!isCopy(op)) {
          moveWrite(path, WRITES_DEAD(), name);
          const o = { dead: true, name, line: `not copied (given up): ${name} is not a copy${op?.tool === "forget_thought" ? " — a forget: its text stays on this brain until forgotten there by hand" : ""}` };
          log(o.line); outcomes.push(o); continue;
        }
        // A send may reach the brain whatever it answers: the copy says so in its own file before it goes (`sending`),
        // and a forget's drop leaves it — dropped, a capture committed after the forget's NOT_FOUND kept its text for
        // good (review pass 7). One a drain killed mid-send left `sending` is read as having been sent (review pass 8).
        // A forget held for a brain with no write key (queueForget): its week starts at its first send, now that the
        // brain has one, not when it was made — else a key set back after a week gave it up at its first fault, its text
        // left there (SMD-4411 review pass 1).
        if (op.held === true) { const { held: _h, ...rest } = op; op = { ...rest, at: new Date().toISOString() }; if (!rewriteWrite(name, op)) continue; }
        const reachedBefore = op.sent === true || op.sending === true;
        if (!reachedBefore && !rewriteWrite(name, { ...op, sending: true })) continue; // gone: a drop took it first
        // Still this drain's, just before the send: a holder whose lock was taken back while it was suspended does not
        // send a copy its successor may have sent, and a forget after (review pass 9). Narrowed, not closed: the gap is
        // the microseconds to the request.
        if (!holdDrainLock()) { stopped = true; break; }
        // A throw on one copy (an answer of a shape the hook cannot read: the url not the brain's /mcp, or a server and
        // hook out of step) keeps it, as a fault does, rather than ending the drain: its send may have reached the brain,
        // and after a week it is given up like any other (SMD-4412).
        let o;
        try { o = await postWrite(cfg, op); }
        catch (e) { o = { keep: true, unknown: true, line: `kept: ${opLabel(op)} — the brain's answer could not be read (${oneLine(String(e?.message ?? e)).slice(0, 160)}): check that the url is this brain's /mcp, and that its server and this hook are current` }; }
        // A lock taken back while this copy was in flight: the queue is its new holder's, and this drain touches no
        // file of it — not this copy's, which the holder may be sending again (review pass 8: a stale holder's
        // write-back put a copy back after the forget that followed it).
        if (!holdDrainLock()) { log(`drain: the lock was taken back while ${opLabel(op)} was in flight; the queue is its new holder's`); stopped = true; break; }
        // Kept for a week: given up, as the capture queue gives a payload up
        // (PENDING_MAX_AGE_MS) — what it named is skipped there afterwards.
        if (o.keep && Date.now() - Date.parse(op.at) > PENDING_MAX_AGE_MS) o = { dead: true, line: `not copied (given up after a week): ${o.line.replace(/^kept: /, "")}${op.tool === "forget_thought" ? " — its text stays on this brain until forgotten there by hand" : ""}` };
        // A forget of a name a forget landed for earlier in this drain finds nothing: said so, not as a copy never sent
        // with its text kept (review pass 3: alarming after a success).
        if (o.notFound && op.tool === "forget_thought" && outcomes.some((x) => x.done && !x.notFound && x.forgetOf === op.args.id)) o = { ...o, line: `skipped ${opLabel(op)}: forgotten by the forget of it above, in this drain` };
        log(o.line);
        outcomes.push({ ...o, name, ...(op.tool === "forget_thought" ? { forgetOf: op.args.id } : {}) });
        // A forget landed: a copy of its thought given up since the forget's drop (sent again ahead of it, then refused
        // for good) holds its text in dead/ — removed now (SMD-4411 review pass 1).
        if (o.done && op.tool === "forget_thought") {
          const gone = dropCopiesOf([op.args.id, op.alt].filter(Boolean), [WRITES_DEAD()]);
          if (gone) log(`fan-out: removed ${gone} given-up cop${gone === 1 ? "y" : "ies"} of ${op.args.id}, which its forget followed`);
        }
        if (o.keep) {
          // `sent` once a send may have reached the brain — a transport failure past the connection, a fault, a
          // store it could not reach (`unknown`) — and never cleared; any other answer the brain gave (a refusal, a
          // code to retry) wrote nothing.
          // Written back even if a forget's drop removed it during the send — the drop read it before it was marked
          // (review pass 9): its name keeps it ahead of that forget, which then reaches it. Only this drain, holding the
          // lock, and a drop remove a queued copy.
          const { sending: _s, sent: _t, ...rest } = op;
          const sent = reachedBefore || o.unknown === true;
          rewriteWrite(name, { ...rest, ...(sent ? { sent: true } : {}) }, { force: sent });
          stopped = true; markHeld(name); break;
        }
        if (o.dead) moveWrite(path, WRITES_DEAD(), name); else removeWrite(path); // already gone: the holder before finished it too
      }
    } finally { releaseDrainLock(); }
    if (!pendingWrites().length) clearHeld();
    if (stopped || !pendingWrites().some((n) => !seen.has(n))) return outcomes;
  }
}

/**
 * What a brain's forget left for a person to review there — the thoughts derived from it, the pages, the standing twins
 * that keep the text — as ids, so the log names them; the first brain's reply names only its own (review pass 7).
 */
function forgetReview(sc) {
  const ids = (k) => (Array.isArray(sc?.[k]) ? sc[k].filter((x) => typeof x === "string") : []);
  const parts = [["derived from it", ids("irreproducibleIds")], ["pages", ids("pageIds")], ["standing twins keeping its text", ids("twinIds")]]
    .filter(([, list]) => list.length).map(([what, list]) => `${what}: ${list.slice(0, 5).join(", ")}${list.length > 5 ? ` and ${list.length - 5} more` : ""}`);
  return parts.length ? ` — to review there: ${parts.join("; ")}` : "";
}

/** A connection refused, or a name that resolves to nothing: the copy never reached the brain. */
const NOT_REACHED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
/**
 * The line for a copy a brain cannot call its tool for — a server from before it (forget_thought, migration 144), held
 * for it; else a key that cannot call it — or null. Only "Tool … not found" (or disabled): the SDK answers an input it
 * cannot validate with the same -32602, and that copy is refused for good (review pass 1).
 */
function toolMissing(op, text) {
  if (!/\bTool \S+ (?:not found|disabled)\b/.test(text)) return null;
  if (FANOUT_LATER.has(op.tool)) return `kept: ${opLabel(op)} — this brain's server has no ${op.tool} (one before v2.1.0), or the write key is no write key: upgrade the server past v2.1.0, or mint a write key, and the copy lands in order`;
  return `kept: ${opLabel(op)} — the write key cannot call ${op.tool}; mint a write key on this brain (bun server-portable/keygen.ts --name claude-code --scope write) and set write_key — --check says`;
}

/**
 * A queued copy's file rewritten whole — a temporary file renamed over it, so a kill or a full disk never leaves half a
 * copy (review pass 8) — or false when it is gone (a forget's drop took it), unless `force` puts it back.
 */
function rewriteWrite(name, op, { force = false } = {}) {
  const path = join(WRITES_PENDING(), name);
  if (!force && !existsSync(path)) return false;
  const tmp = join(WRITES_PENDING(), `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(op), { mode: 0o600 });
  renameSync(tmp, path);
  return true;
}

/** A copy's file moved aside, or removed: false when it is already gone (another drain's). */
function moveWrite(path, dir, name) { try { mkdirSync(dir, { recursive: true, mode: 0o700 }); renameSync(path, join(dir, name)); return true; } catch (e) { if (e?.code === "ENOENT") return false; throw e; } }
function removeWrite(path) { try { unlinkSync(path); return true; } catch (e) { if (e?.code === "ENOENT") return false; throw e; } }

/** The queue held on a copy: stamped, so session events try it again at most every HELD_RETRY_MS rather than at every turn (review pass 1). */
const HELD_PATH = () => join(WRITES_DIR(), "held");
const HELD_RETRY_MS = 5 * 60_000;
function markHeld(name) { try { writeFileSync(HELD_PATH(), name, { mode: 0o600 }); } catch { /* a stamp failure only means an earlier retry */ } }
function clearHeld() { try { unlinkSync(HELD_PATH()); } catch { /* none */ } }
const heldRecently = () => { try { return Date.now() - statSync(HELD_PATH()).mtimeMs < HELD_RETRY_MS; } catch { return false; } };

/** writes/dead/ pruned at thirty days and a temp file a writer left under writes/pending/, as pruneDead prunes the capture queue's. */
function pruneWrites() {
  // …and a lock a drain moved aside and was killed before removing (drain.lock.<pid>).
  for (const [dir, maxAge, only] of [[WRITES_DEAD(), DEAD_MAX_AGE_MS, null], [WRITES_PENDING(), CLAIM_MAX_AGE_MS, /\.tmp$/], [WRITES_DIR(), CLAIM_MAX_AGE_MS, /^drain\.lock\.(?:new\.)?\d+$/]]) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (only && !only.test(f)) continue;
      try { if (Date.now() - statSync(join(dir, f)).mtimeMs > maxAge) unlinkSync(join(dir, f)); } catch { /* gone */ }
    }
  }
}

/** Drains a brain's queue: in this process under OB1_SESSION_CAPTURE_SYNC=1 (its outcomes said on stderr), else in a detached child. */
async function startDrain(brain, tag) {
  useStateRoot(brain.root);
  if (process.env.OB1_SESSION_CAPTURE_SYNC === "1") {
    const outcomes = await drainWrites(brain.cfg);
    for (const o of outcomes) console.error(`session-capture: ${tag}${o.line}`);
    return outcomes.some((o) => !o.done) ? 1 : 0;
  }
  ensureDirs();
  const fd = openSync(LOG_PATH(), "a", 0o600);
  const child = spawn(process.execPath, [SELF, "--drain-writes", "--brain", brain.name], { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env } });
  child.unref();
  closeSync(fd);
  return 0;
}

/**
 * The hook on PostToolUse: queue the copy on each target, then drain each.
 * Exits 0 — a copy's fate is the log's, never the session's — save under
 * OB1_SESSION_CAPTURE_SYNC=1, where a copy not landed is exit 1, as a capture
 * not landed is there. A queue or drain that throws is logged, not thrown.
 */
async function fanOutHook(hook, brains) {
  const sync = process.env.OB1_SESSION_CAPTURE_SYNC === "1";
  try {
    const plan = fanOutPlan(hook, brains);
    if (!plan.op) {
      if (plan.skip) { useStateRoot(brains[0].root); log(`fan-out: ${plan.skip}`); }
      return 0;
    }
    // A forget goes through queueForget (SMD-4411): the copies of its thought no send may have reached are dropped
    // from every brain's queue, the first brain's own among them, and the forget is queued behind those kept, or held
    // for a brain with no write key now. dropCopiesOf's and queueForget's docblocks say why.
    let drains = plan.targets, lost = 0;
    if (plan.op.tool === "forget_thought") {
      const { queued, held, failed } = queueForget(plan.op, brains, { source: plan.source, targets: plan.targets, all: true });
      drains = queued.map((q) => q.brain);
      lost = failed.length; // a brain whose queue could not be written: a copy not landed, exit 1 under sync (review pass 3)
      // Said only when no other brain was queued, held or failed: the first brain's own forget is no copy (review pass 2).
      if (![...queued, ...held].some((x) => x.brain !== plan.source) && !failed.length) { useStateRoot(plan.source.root); log(`fan-out: forget_thought through ${plan.source.cfg.connector}: no other brain has a write_key, so nothing is copied`); }
    } else {
      for (const t of plan.targets) {
        useStateRoot(t.root);
        enqueueWrite(plan.op);
        log(`fan-out: queued ${opLabel(plan.op)} from ${plan.op.from}`);
      }
    }
    let code = lost ? 1 : 0;
    for (const t of drains) code = Math.max(code, await startDrain(t, `[${t.name}] `));
    return sync ? code : 0;
  } catch (e) {
    log(`fan-out: error: ${oneLine(String(e?.message ?? e)).slice(0, 200)}`);
    if (sync) console.error(`session-capture: fan-out: ${e?.message ?? e}`);
    return sync ? 1 : 0;
  }
}

/**
 * --check's lines for the fan-out, per brain: the connector whose writes are
 * copied from it and where to; for a brain with a write key, that the key can
 * edit, delete and forget (a server with no forget_thought is a warning), that
 * the brain keeps a client_key (a server from before migration 112 drops the
 * argument unread, and every later edit of the copy would find nothing), and
 * what its queue holds; for one without, a warning of the copies its queue
 * still holds (SMD-4411). Returns the exit code.
 */
async function checkWrites(brain, brains, tag) {
  const cfg = brain.cfg;
  // Said only where something is copied: a connector set for work claims alone is no fan-out (SMD-3602 review pass 4).
  if (cfg.connector && brains.some((b) => b.cfg.writeKey)) {
    const to = brains.filter((b) => b !== brain && b.cfg.writeKey).map((b) => b.name);
    console.log(`${tag}fan-out: writes through ${cfg.connector} ${to.length ? `are copied to ${to.join(", ")}` : "stay on this brain (no other brain has a write_key)"}`);
  }
  if (!cfg.writeKey) {
    // Copies queued while it had a key, and forgets held for it since (SMD-4411): nothing sends them until one is set.
    useStateRoot(brain.root);
    const held = pendingWrites();
    if (held.length) {
      let forgets = 0;
      for (const f of held) { try { if (JSON.parse(readFileSync(join(WRITES_PENDING(), f), "utf8"))?.tool === "forget_thought") forgets++; } catch { /* unreadable: the drain says so */ } }
      // A copy of a thought forgotten before 1.10.0 while this brain had no key was neither dropped nor held a forget
      // (review pass 1): it would land with its text, so the warning says how to forget it first.
      console.error(`session-capture: ${tag}warning: ${held.length} cop${held.length === 1 ? "y" : "ies"} queued for this brain${forgets ? `, ${forgets === 1 ? "1 of them a forget" : `${forgets} of them forgets`},` : ""} wait for a write_key; once one is set (write_key or write_key_file), they land, in order, at its next drain. Before setting it, run bun session-capture.mjs --copy-forget <id> --from <the brain you forgot it on> --brain ${brain.name} --yes for each thought you forgot while it had none on a hook before 1.10.0, which held no forget for it`);
    }
    return 0;
  }
  let tools;
  try { tools = (await rpc({ ...cfg, key: cfg.writeKey }, "tools/list", {}, 15_000)).tools ?? []; } catch (e) { console.error(`session-capture: ${tag}the write key: ${shownUrl(cfg.url)} did not answer tools/list — ${e.message}`); return 1; }
  const names = tools.map((t) => t.name);
  const missing = FANOUT_TOOLS.filter((t) => !names.includes(t) && !FANOUT_LATER.has(t));
  if (missing.length) { console.error(`session-capture: ${tag}the write key cannot call ${missing.join(", ")} — mint a write key on this brain: bun server-portable/keygen.ts --name claude-code --scope write`); return 1; }
  const later = FANOUT_TOOLS.filter((t) => !names.includes(t) && FANOUT_LATER.has(t));
  if (later.length) console.error(`session-capture: ${tag}warning: this brain's server has no ${later.join(", ")} (one before v2.1.0): a forget through the connector is held for it, the copies behind it waiting, for up to a week — upgrade it past v2.1.0`);
  const capture = tools.find((t) => t.name === "capture_thought");
  if (!capture?.inputSchema?.properties?.client_key) { console.error(`session-capture: ${tag}this brain's capture_thought takes no client_key — its server is from before migration 112 (SMD-3314): upgrade it before copying writes to it`); return 1; }
  useStateRoot(brain.root);
  const queued = pendingWrites();
  const dead = existsSync(WRITES_DEAD()) ? readdirSync(WRITES_DEAD()).filter((f) => f.endsWith(".json")).length : 0;
  // The oldest copy's age: a queue held on it for long is the one thing an operator needs to see (review pass 1).
  let oldest = "";
  if (queued.length) { try { const at = Date.parse(JSON.parse(readFileSync(join(WRITES_PENDING(), queued[0]), "utf8")).at); if (Number.isFinite(at)) oldest = `, the oldest ${Math.max(0, Math.round((Date.now() - at) / 60_000))} min old`; } catch { /* unreadable: the drain says so */ } }
  console.log(`${tag}write key: ok — it can capture, edit${later.length ? " and delete" : ", delete and forget"}, and the brain keeps a client_key. Copies queued: ${queued.length}${oldest}${dead ? `; given up: ${dead} (in ${WRITES_DEAD()})` : ""}`);
  return 0;
}

/** Marks the current brain's queued forgets `held`: drainWrites re-dates one at its first send. */
function holdForgets() {
  for (const f of pendingWrites()) {
    let op;
    try { op = JSON.parse(readFileSync(join(WRITES_PENDING(), f), "utf8")); } catch { continue; }
    if (op?.tool === "forget_thought" && op.held !== true) rewriteWrite(f, { ...op, held: true });
  }
}

/** Any other hook run: a brain whose queue holds copies a drain left (it was away) gets a drain, so they land without waiting for the next write. */
async function kickWriteDrains(brains, { atEnd = false } = {}) {
  for (const b of brains) {
    useStateRoot(b.root);
    if (!b.cfg.writeKey) {
      // A forget queued while this brain had a key, which it no longer has: held, so its week starts again at its first
      // send once a key is set, as a forget held for it does (SMD-4411 review pass 2: given up at its first fault).
      try { holdForgets(); } catch (e) { log(`fan-out: error: ${oneLine(String(e?.message ?? e)).slice(0, 200)}`); }
      continue;
    }
    // A queue held on a copy tried within HELD_RETRY_MS waits for the next
    // write or the next window (review pass 1) — save at a session's end, its
    // last chance before the next session (review pass 2). Never the session's
    // exit: a failure here is the log's.
    try { if (pendingWrites().length && (atEnd || !heldRecently())) await startDrain(b, `[${b.name}] `); }
    catch (e) { log(`fan-out: error: ${oneLine(String(e?.message ?? e)).slice(0, 200)}`); }
  }
}

export { WRITES_PENDING, checkWrites, fanOutHook, kickWriteDrains, opLabel };
