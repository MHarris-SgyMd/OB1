#!/usr/bin/env bun
/**
 * bench-brains.ts — two brains on one model server: what each one's background
 * work gets of its slots, arm by arm (SMD-3379 PR 3b-3b).
 *
 * The ticket's Verify on two brains: with both backlogged, neither brain's live
 * captures wait for a slot and their background work splits the background
 * slots; with one backlogged, it uses its share alone (fixed shares) or every
 * free slot (the broker). This harness makes the backlog, reads what each
 * brain's sleep held of the slots while it ran, and deletes its notes after;
 * bench-live.ts times the live calls beside it.
 *
 *   bun db/bench-brains.ts load    --brains FILE --brain NAME --arm A --ids FILE [--notes 150] [--parallel 2]
 *   bun db/bench-brains.ts sample  --brains FILE --arm A --out FILE [--minutes 20] [--every 15] [--ollama URL]
 *   bun db/bench-brains.ts clean   --brains FILE --brain NAME --ids FILE [--arm A]
 *   bun db/bench-brains.ts summary --out FILE [--split 12] [--live FILE …]
 *   bun db/bench-brains.ts --self-check
 *
 * --brains names each brain, by a JSON file:
 *   { "canary":  { "connector": "open-brain-canary" },                          ~/.claude.json's entry: its url and key
 *     "scratch": { "mcp": "http://127.0.0.1:18379/mcp", "keyFile": "/path/key" } a url and a file holding the key alone }
 * The key is never printed, nor a url's query (a ?key= url carries one). A
 * refusal names a flag or a brain and a file's failure by its code, never the
 * path typed, a file's text, a connector's name or a parser's words: a key put
 * in the wrong place (a key file as --brains, --ids or --out, a key as keyFile's
 * path or as a connector) is not said, and load and sample append only to a file
 * that is new or holds what they write, ids or whole samples. An entry gives a
 * connector or a key file, not both, and no brain is named `(ollama)`: the model
 * server's samples carry that name. A brain's answer of a shape the harness does
 * not read is said in those words, never a thrown error's.
 *
 * load    captures the arm's notes (notesFor: the same text for every brain,
 *         another for each arm, so no arm's capture is a re-capture of
 *         another's) with source smd3379-measure, `--parallel` at a time, and
 *         appends each id to --ids as it lands. Only a brain whose brain_info
 *         says tier canary or working (bench-live.ts's guard): stable is refused
 *         before anything is written. A capture that answers no id is counted
 *         apart: not saved, a note the brain already held (an arm loaded
 *         twice), or one cut off that may land yet.
 * sample  reads every brain's brain_info and worker_status each --every
 *         seconds for --minutes, and the model server's loaded models from
 *         Ollama's /api/ps when --ollama names it (an http or https url, a
 *         query it carries kept), appending one line per brain a round to
 *         --out. A line keeps its run's start, so another run of the arm's name
 *         appended to the file is told from it, and every pool's pending,
 *         claimed, failed and unpooled counts. Reads alone, so any tier. Exits
 *         1 if a brain never answered a round, and 128 + the signal's number
 *         when one cut it short, whatever the brains answered; a second signal
 *         exits at once.
 * clean   reads back each id in --ids, then searches the brain for measure
 *         notes whose ids never came back (a capture cut off can still land) and
 *         reads those back too. It deletes a thought only when its whole text
 *         is the generator's for the arm and index its heading names
 *         (noteKind): the arm's alone with --arm, else every measure note on
 *         the brain, any arm's or run's. A listed id whose text is none is left
 *         and said; one of another arm is left and counted; one the brain does
 *         not hold is counted not on the brain; a line that is no thought id is
 *         counted and sent nowhere. A text that starts with a note's heading
 *         and then differs is never deleted, and said on every run that meets
 *         it (delete it by its id; another arm passes it by unless it is
 *         listed). Only a canary or working brain, as load. A last search finds
 *         what is left, and it exits 1 if anything is, or a delete, a read or
 *         that search failed. Run it once load has ended: a capture still on
 *         its way lands after, for another run to find. The notes alone go: the
 *         entities extraction drew from them stay until an operator prunes the
 *         orphans, and the audit log keeps each text.
 * summary prints, for each run of an arm and each brain, what its sleep's
 *         heartbeat says the sleep's background calls held over the arm's two
 *         windows — before --split minutes (no live load from the harness) and
 *         after (bench-live running): the calls, their time, the mean number in
 *         flight (their time over the window's), and their slot waits, in all
 *         and by pass. Under them, the same for its board-sync where that
 *         stamped tallies, a row that names no brain. And its extraction rows
 *         under its own key — pending or claimed, not yet pooled, failed, first
 *         to last, and when they ran dry — how many of its samples failed, the
 *         model server's loaded models, and each --live file's latencies
 *         (bench-live.ts's samples), each row with its file's place.
 *
 * What the numbers are. A heartbeat's model tallies are the sleep process's
 * since it began (db/pass-stamp.ts `models`), stamped at least once a minute by
 * the database's clock, and a call is counted when it ends: a window's figures
 * are the sum of the increases from stamp to stamp, over the time between its
 * first and last stamps, and a call running across a stamp counts in the stamp
 * after. So a window is shorter than its minutes by up to a stamp at each end,
 * and the pair of stamps across the split is in neither. A call's time runs
 * from its slot to its answer, failed or not: its wait inside the model server
 * (a model loading, a call ahead of it) is in it, its wait for a slot is not; a
 * call that ran without a slot (a type no share holds, the gate failing open)
 * counts too. A tally is a pass's, over every model and server it calls, so a
 * brain's figure can pass any one server's room. A row is one process's: the
 * sleep's, and board-sync's under it from board-sync's own stamps, which come
 * every five minutes while it is idle, so a window holds few. The two are not
 * summed: their stamps are other times. The api's vector mender's calls and a
 * detached job's hold slots too, stamp no tallies, and are in no row.
 *
 * A process begun again. Tallies count since the process began, so across a
 * restart every pass's value is the increase since (windowOf), and the calls
 * the old process made after its last stamp are lost. A pair of stamps in
 * which a pass's tally falls, or a pass drops out, is a restart: the tallies'
 * own sign, and the only one on a brain with no coordinator, for a pass it
 * does not run, or in samples that kept no stamp time (those of 2026-11-16).
 * It misses a restart whose first stamp already passes the old one's on every
 * tally, so the coordinator's marks are read too (SMD-4382): each sample keeps
 * the coordinator's children and its stamp's time, and a child marked running
 * for for_s seconds began that long before the stamp (beginsOf). A beginning
 * with a fall beside it is that fall's restart, counted once; one with none is
 * a restart at the pair of stamps it lies between. A stamp half a second or
 * less after a beginning may be either process's (for_s is rounded, and a
 * sleep stamps its first tallies within a second of starting), and is taken
 * for the old one's last. Two runs that began within fifteen seconds read as
 * one. A sleep that has made no model call stamps no tallies, nor does a build
 * before SMD-3379 PR 2b-2a: its sleep's state is shown.
 *
 * The extraction rows are worker_status's under the key the brain says is its
 * own (`active`), extractionLine: pending or claimed, the thoughts with no row
 * yet (a pass pools them as it starts, so they are work to do), and the rows
 * failed. They are thoughts, the probes' among them. "Ran dry" is not said of a
 * pool that emptied while more of its rows failed, and an older key's leftover
 * rows are said apart. worker_status names a pool only once it has a row, so a
 * brain whose extraction has never run has none to read: that is said, not
 * read as empty. Samples from before SMD-4382 kept pending and claimed rows
 * alone, under every extract: key, and are read so.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { commandLine } from "./cli.ts";
import { answerTo, connectorOf, errorKind, fileProblem, jsonOf, keyFromFile, outcomeOf, percentile, shownUrl, textOf, tierRefusal } from "./bench-live.ts";
import { INGESTED_NOTICE, renderDelete, renderFetch } from "../server-portable/render.ts";
import { ok as okOutcome, refuse } from "../server-portable/core/refusal.ts";

/** Every measure note starts with this, then `(arm <A> #<i>). `. */
export const NOTE_PREFIX = "SMD-3379 measure note";
/** The source every measure note is captured with. */
export const NOTE_SOURCE = "smd3379-measure";
/** The deadline of a call that makes no model call. */
const QUICK_MS = 30_000;
/** A capture's: its embedding, metadata and genre calls, behind a backlog's. */
const CAPTURE_MS = 300_000;
/** The name a sample of the model server's loaded models carries where a brain's carries its own: no brain may have it. */
export const MODEL_SERVER = "(ollama)";

type Brain = { name: string; mcp: string; key: string };
type Answer = { status: number; msg: Record<string, any> | null };

/** A brain's url and key from its entry in --brains: a connector's, or a url beside a key file. */
export function brainOf(name: string, entry: unknown, claude: () => unknown, readKey: (path: string) => string): Brain {
  const e = (entry ?? {}) as { connector?: unknown; mcp?: unknown; keyFile?: unknown };
  // A field that is there and no string is no entry: it was passed over unsaid, a `keyFile: 9` beside a connector among them.
  if ([e.connector, e.mcp, e.keyFile].some((v) => v !== undefined && typeof v !== "string")) throw new Error(`brain ${name}: give "connector" (a ~/.claude.json mcpServers name), or "mcp" and "keyFile", each a string`);
  const connector = typeof e.connector === "string" && e.connector !== "" ? e.connector : null;
  const keyFile = typeof e.keyFile === "string" && e.keyFile !== "" ? e.keyFile : null;
  // One key's source an entry: a connector's key beside a key file would be one of them ignored, unsaid (bench-live.ts
  // refuses its two key flags together too).
  if (connector !== null && keyFile !== null) throw new Error(`brain ${name}: give "connector" or "keyFile", not both`);
  if (connector !== null) {
    // In this harness's words, not connectorOf's: those name the value typed, and a key put in "connector" by mistake was
    // printed (review pass 5). Its own entry alone: `constructor` names no connector.
    const servers = (claude() as { mcpServers?: Record<string, unknown> } | null)?.mcpServers;
    if (!servers || !Object.hasOwn(servers, connector)) throw new Error(`brain ${name}: ~/.claude.json has no mcpServers entry of its connector's name`);
    try { return { name, ...connectorOf(servers[connector], connector, typeof e.mcp === "string" && e.mcp !== "" ? e.mcp : undefined) }; } catch {
      throw new Error(`brain ${name}: its connector's entry in ~/.claude.json has no key (an x-brain-key header, or on its url), or no url where the brain's entry gives no "mcp"`);
    }
  }
  if (typeof e.mcp === "string" && e.mcp !== "" && keyFile !== null) {
    // The read apart from the key's reading: Node's words for a missing file quote the path, and a key written where the
    // path belongs was printed (review pass 4).
    const text = textOf(() => readKey(keyFile), `brain ${name}: its keyFile`);
    try { return { name, mcp: e.mcp, key: keyFromFile(text) }; } catch (x) { throw new Error(`brain ${name}: ${(x as Error).message}`); }
  }
  throw new Error(`brain ${name}: give "connector" (a ~/.claude.json mcpServers name), or "mcp" and "keyFile"`);
}

const claudeJson = () => jsonOf(textOf(() => readFileSync(join(homedir(), ".claude.json"), "utf8"), "~/.claude.json"), "~/.claude.json");
const readKeyFile = (p: string) => readFileSync(p, "utf8");
const BRAINS = "--brains' file";

/** --brains' file: a JSON object, a brain a name. */
export function brainsOf(text: string): Record<string, unknown> {
  const raw = jsonOf(text, BRAINS);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${BRAINS} holds no JSON object of brains`);
  // summary tells the model server's samples from a brain's by this name alone: a brain of the name would be dropped from
  // its table, and its samples read as the model server's (SMD-4382).
  if (Object.hasOwn(raw, MODEL_SERVER)) throw new Error(`${BRAINS} names a brain ${MODEL_SERVER}: the model server's samples carry that name, so give the brain another`);
  return raw as Record<string, unknown>;
}

/** --brains' entries, read and parsed, none resolved. */
const entriesFrom = (path: string) => brainsOf(textOf(() => readFileSync(path, "utf8"), BRAINS));

/** Every brain --brains names. */
function brainsFrom(path: string): Brain[] {
  return Object.entries(entriesFrom(path)).map(([name, entry]) => brainOf(name, entry, claudeJson, readKeyFile));
}

/** The one brain named, its entry alone resolved (another's broken entry does not block it); null when none is. */
function brainFrom(path: string, name: string): Brain | null {
  const raw = entriesFrom(path);
  return Object.hasOwn(raw, name) ? brainOf(name, raw[name], claudeJson, readKeyFile) : null;
}

/** A thought's id, as the brain makes them. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An --ids file's ids, each once, and how many of its lines are no id: those are never sent to a brain nor printed, so a
 *  key file given as --ids goes nowhere (review pass 4). */
export function idsOf(text: string): { ids: string[]; junk: number } {
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  return { ids: [...new Set(lines.filter((l) => UUID.test(l)))], junk: lines.filter((l) => !UUID.test(l)).length };
}

/** Why a file that load or sample appends to must not be written, or null: one holding anything but what they write there
 *  (ids a line; samples, each as samplesOf reads one) is another kind of file — a key file, a brains file on one line, the
 *  latency harness's samples — which an appended line would break. A line beginning `{` was once enough (review pass 5). */
export function appendProblem(kind: "ids" | "samples", text: string): string | null {
  if (kind === "ids") return idsOf(text).junk ? "--ids' file holds a line that is no thought id: load appends ids to it, and writes into no other kind of file" : null;
  try { samplesOf(text, "--out's file"); return null; } catch { return "--out's file holds a line that is no sample: sample appends to it, and writes into no other kind of file"; }
}

/** What to append first to a file whose last line has no end: without it the first line added runs on from that one. */
export function lineEnd(text: string): string {
  return text === "" || text.endsWith("\n") ? "" : "\n";
}

/** A file's text, "" where there is none yet. */
function existing(path: string, what: string): string {
  try { return readFileSync(path, "utf8"); } catch (e) { if (fileProblem(e) === "ENOENT") return ""; throw new Error(`${what} could not be read (${fileProblem(e)})`); }
}

function append(path: string, text: string, what: string): void {
  try { appendFileSync(path, text); } catch (e) { throw new Error(`${what} could not be written (${fileProblem(e)})`); }
}

/** A small seeded generator (mulberry32), so an arm's notes are the same text on every run and in every brain. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PEOPLE = ["Ana Ruiz", "Bo Lindqvist", "Chidi Okafor", "Dana Weiss", "Eitan Bar", "Fern Takeda", "Gus Moreau", "Hana Kovac", "Ines Duarte", "Jun Park", "Kofi Mensah", "Lea Brandt"];
const PROJECTS = ["the Larch ingest service", "Quarry billing", "the Heron search API", "the Tern mobile app", "the Pike data lake", "the Wren notification hub", "Juniper payroll", "the Osprey audit log"];
const TOOLS = ["Postgres", "Kafka", "Redis", "Terraform", "Grafana", "Kubernetes", "pgvector", "Airflow", "Envoy", "ClickHouse"];
const ISSUES = [
  "p99 latency doubled after the last deploy",
  "a nightly job overran its window twice this week",
  "the retry queue grew without bound during an outage",
  "two services disagree on a customer's time zone",
  "a schema change locked a hot table for forty seconds",
  "alerts fired for a disk that was already being replaced",
  "the staging copy drifted from production's settings",
  "a vendor's API started rate limiting at half the documented rate",
];
const DECISIONS = [
  "move the job behind a feature flag and roll it out by region",
  "add a dead-letter queue with a one-day retention",
  "pin the client library until the upstream fix ships",
  "split the table by month and backfill over a weekend",
  "page the owning team only after two consecutive failures",
  "write the incident review before Friday and share it widely",
  "replace the hand-rolled cache with the shared one",
  "budget a sprint for the migration and freeze new features meanwhile",
];
const FOLLOWUPS = [
  "measure the change for a week before calling it done",
  "update the runbook and link it from the dashboard",
  "ask finance whether the extra storage fits this quarter",
  "check whether the mobile team depends on the old field",
  "schedule a load test against the new limits",
  "draft a short note for the customer success team",
];

/** The arm's i-th note: the same text in every brain and on every run, about 820–960 characters. */
export function notesFor(arm: string, i: number): string {
  let h = 2166136261;
  for (const ch of `${arm}#${i}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const r = seeded(h);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const [a, b, c] = [pick(PEOPLE), pick(PEOPLE), pick(PEOPLE)];
  const project = pick(PROJECTS);
  const [t1, t2] = [pick(TOOLS), pick(TOOLS)];
  return `${NOTE_PREFIX} (arm ${arm} #${i}). ` +
    `${a} met with ${b} about ${project}: ${pick(ISSUES)}. ` +
    `They traced it to how ${project} uses ${t1}, and found that ${t2} was configured differently in the two regions. ` +
    `${c} pointed out that ${pick(ISSUES)} last quarter had the same root cause, and that the fix then was never written down. ` +
    `The group decided to ${pick(DECISIONS)}, and to ${pick(DECISIONS)} if that does not hold. ` +
    `${a} owns the first change; ${b} will ${pick(FOLLOWUPS)}; ${c} will ${pick(FOLLOWUPS)}. ` +
    `Open question: whether ${t1} or ${t2} should own the retry logic for ${project} long term.`;
}

/**
 * What a thought's text is to the harness, an ingested thought's notice read past:
 *   note       the generator's own text for the arm and index its heading names, whole (notesFor), the arm's when one is named;
 *   other-arm  such a note of another arm than the one named;
 *   lookalike  a text that starts with a note's heading and is not the generator's: someone's own words after it, or a
 *              note another version of the harness wrote. Never deleted: clean says it (review pass 3: the heading alone
 *              was the test, so a thought that began with it went);
 *   none       anything else, a thought that quotes a note among them.
 */
export function noteKind(text: string, arm?: string): "note" | "other-arm" | "lookalike" | "none" {
  const body = text.startsWith(`${INGESTED_NOTICE}\n\n`) ? text.slice(INGESTED_NOTICE.length + 2) : text;
  const m = /^SMD-3379 measure note \(arm ([A-Za-z0-9-]+) #(\d+)\)\. /.exec(body);
  if (m === null) return "none";
  if (body !== notesFor(m[1], Number(m[2]))) return "lookalike";
  return arm === undefined || m[1] === arm ? "note" : "other-arm";
}

/** Whether a thought's text is a measure note, the arm's when one is named. */
export function isMeasureNote(text: string, arm?: string): boolean {
  return noteKind(text, arm) === "note";
}

/** Why a lookalike is left. */
const LOOKALIKE = "starts as a measure note, but its text is not the harness's: not deleted";

/** The brain's own answer to a delete of an id it does not hold (render.ts): gone already. Nothing else counts as gone —
 *  not a key without write scope's "Tool delete_thought not found" (review pass 1). */
export const ALREADY_GONE = /^No thought with id /;
/** Its answer to a read of one (render.ts's fetch). */
export const READ_GONE = /^Fetch error: no thought with id /;

function rpcFor(b: Brain): (method: string, params: Record<string, unknown>, ms?: number) => Promise<Answer> {
  let seq = 0;
  return async (method, params, ms = QUICK_MS) => {
    const id = ++seq;
    const res = await fetch(b.mcp, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": b.key },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "manual",
      signal: AbortSignal.timeout(ms),
    });
    return { status: res.status, msg: answerTo(await res.text(), id) };
  };
}

/** What an answer the harness cannot read is called: never the words of the error its reading threw. */
export const WRONG_SHAPE = "an answer of a shape the harness does not read";

/**
 * A tool's answer as the harness reads it: bench-live.ts's outcome, and the structured content as an object. An answer
 * whose result is no object, whose content is no list of parts, or whose structured content is anything but an object is
 * not ok and is called WRONG_SHAPE: its reading threw a TypeError once, and that error's words were what a run printed
 * (SMD-4382). Never throws.
 */
export function readOf(status: number, msg: Record<string, any> | null, name: string): { ok: boolean; error?: string; id?: string; sc: Record<string, any> } {
  const wrong = { ok: false, error: WRONG_SHAPE, sc: {} };
  let o: ReturnType<typeof outcomeOf>;
  try { o = outcomeOf(status, msg, name); } catch { return wrong; }
  const sc: unknown = msg?.result?.structuredContent;
  if (sc === undefined) return { ok: o.ok, error: o.error, id: o.id, sc: {} };
  if (sc === null || typeof sc !== "object" || Array.isArray(sc)) return o.ok ? wrong : { ok: false, error: o.error, sc: {} };
  return { ok: o.ok, error: o.error, id: o.id, sc: sc as Record<string, any> };
}

/** A tool's structured answer, or a thrown error naming the brain, the tool and why (never the url's query). A capture the
 *  brain answered as failed is returned, not thrown: load counts it. */
async function tool(b: Brain, rpc: ReturnType<typeof rpcFor>, name: string, args: Record<string, unknown>, ms = QUICK_MS): Promise<Record<string, any>> {
  let a: Answer;
  try { a = await rpc("tools/call", { name, arguments: args }, ms); } catch (e) { throw new Error(`${b.name}: ${name} got no answer from ${shownUrl(b.mcp)} (${errorKind(e)})`); }
  const o = readOf(a.status, a.msg, name);
  if (!o.ok && name !== "capture_thought") throw new Error(`${b.name}: ${name} failed (${o.error})`);
  return { ...o.sc, _ok: o.ok, _error: o.error, _id: o.id };
}

/** A tool call as the tier guard and clean read it: its structured answer, or why not. Never throws. */
export type Call = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; sc: Record<string, any> }>;

/** A brain's tools as load's guard and clean read them: a structured answer, or why not. Never throws, never a url's query. */
function callOf(b: Brain, rpc: ReturnType<typeof rpcFor>): Call {
  return async (name, args) => {
    let a: Answer;
    try { a = await rpc("tools/call", { name, arguments: args }); } catch (e) { return { ok: false, error: `no answer from ${shownUrl(b.mcp)} (${errorKind(e)})`, sc: {} }; }
    const o = readOf(a.status, a.msg, name);
    return { ok: o.ok, error: o.error, sc: o.sc };
  };
}

/** The latency harness's tier rule, in this one's words: its own speak of probe captures. */
const tierWords = (name: string) => `${name}: this brain's tier is not canary or working: load and clean write to a brain, so they run on no other`;

/** load's and clean's guard, through `call`: only a brain that says its tier is canary or working is written to — not one
 *  that says another, says none, or cannot be asked. */
export async function tierGuard(call: Call, name: string): Promise<void> {
  const info = await call("brain_info", {});
  if (!info.ok) throw new Error(`${name}: brain_info failed (${info.error})`);
  if (tierRefusal(info.sc.tier)) throw new Error(tierWords(name));
}

async function load(b: Brain, arm: string, n: number, parallel: number, ids: string): Promise<number> {
  const rpc = rpcFor(b);
  await tierGuard(callOf(b, rpc), b.name);
  const before = existing(ids, "--ids' file");
  const problem = appendProblem("ids", before);
  if (problem) throw new Error(problem);
  append(ids, lineEnd(before), "--ids' file");
  let next = 0, ok = 0, degraded = 0, unsaved = 0;
  const t0 = performance.now();
  const worker = async () => {
    for (let i = next++; i < n; i = next++) {
      const r = await tool(b, rpc, "capture_thought", { content: notesFor(arm, i), source: NOTE_SOURCE }, CAPTURE_MS).catch((e) => ({ _ok: false, _error: (e as Error).message, _id: undefined }));
      if (typeof r._id === "string") append(ids, r._id + "\n", "--ids' file");
      if (r._ok) ok++;
      else {
        // Saved but degraded (no vector, no tags) is in the backlog all the same; no id back is not saved, or not known to be.
        if (typeof r._id === "string") degraded++; else unsaved++;
        console.error(`  ${b.name} #${i}: ${String(r._error).replace(" (not a probe, so not deleted)", "")}`);
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  console.log(`${b.name}: arm ${arm}, ${ok} of ${n} notes captured cleanly, ${degraded} saved degraded, ${unsaved} with no id back (not saved, already a thought, or not known to be saved) in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  return degraded + unsaved ? 1 : 0;
}

/** What clean did: notes deleted, how many of those a search by content found, ids the brain does not hold (gone already,
 *  or never an id of its), listed notes of another arm left alone, and what is left, with why. */
export type Cleaned = { deleted: number; absent: number; found: number; otherArm: number; left: Map<string, string> };

/**
 * Reads back each listed id, then each hit of a search by content, and deletes those whose text is a measure note's (the
 * arm's, when one is named): a listed id is trusted no more than a hit, so a wrong or stale --ids file deletes nothing
 * else (review pass 2). Every id is tried once. Then it searches once more for what is left. Returns what went and what
 * did not, with why: a listed id that is no measure note, a text that starts as one and is not the generator's (noteKind), a
 * delete the brain refused, a read that failed, the last search failing or stopping short, a note still there at the end.
 */
export async function cleanWith(call: Call, listed: readonly string[], arm?: string): Promise<Cleaned> {
  const left = new Map<string, string>();
  const tried = new Set<string>();
  let deleted = 0, absent = 0, found = 0, otherArm = 0, met = 0;
  const consider = async (id: string, fromList: boolean) => {
    tried.add(id);
    const f = await call("fetch", { id });
    if (!f.ok && READ_GONE.test(f.error ?? "")) { if (fromList) absent++; return; }
    if (!f.ok || typeof f.sc.text !== "string") { left.set(id, `its read failed: ${f.error ?? "no text"}`); return; }
    const kind = noteKind(f.sc.text, arm);
    if (kind === "lookalike") { left.set(id, LOOKALIKE); return; }
    if (kind === "none") { if (fromList) left.set(id, "listed, but its text is no measure note's: not deleted"); return; }
    if (kind === "other-arm") { if (fromList) otherArm++; return; }
    if (!fromList) met++;
    const r = await call("delete_thought", { id });
    // Found by content counts the notes that went, as the line says "of them": a refused delete is in `left`, not here.
    if (r.ok) { deleted++; if (!fromList) found++; }
    else if (ALREADY_GONE.test(r.error ?? "")) absent++;
    else left.set(id, `its delete failed: ${r.error}`);
  };
  for (const id of new Set(listed)) await consider(id, true);
  const query = arm === undefined ? `${NOTE_PREFIX} (arm` : `${NOTE_PREFIX} (arm ${arm} #`;
  /** Every hit's id, paged; `failed` says why a page was not read, `capped` that 5,000 matches were read and more follow. */
  const search = async (): Promise<{ ids: string[]; failed: [string, string] | null; capped: boolean }> => {
    const ids: string[] = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const r = await call("search_thoughts_keyword", { query, limit: 100, offset });
      if (!r.ok) return { ids, failed: [`(search at ${offset})`, `the search failed: ${r.error}`], capped: false };
      const hits: unknown[] = Array.isArray(r.sc.hits) ? r.sc.hits : [];
      for (const h of hits) { const id = (h as { id?: unknown })?.id; if (typeof id === "string") ids.push(id); }
      if (hits.length < 100 || offset + hits.length >= Number(r.sc.total)) return { ids, failed: null, capped: false };
    }
    return { ids, failed: null, capped: true };
  };
  // Notes whose ids never came back: by content, each read back. A round that meets no new note ends it, and so does a
  // failed search; a round capped at 5,000 matches deletes its notes and the next reads on, whatever each delete answered.
  for (let round = 0; round < 20; round++) {
    const s = await search();
    const before = met;
    for (const id of s.ids) if (!tried.has(id)) await consider(id, false);
    if (met === before || s.failed !== null) break;
  }
  // What is left, by a search of its own: a delete that answered but did not delete shows here, and only this search's
  // failing or stopping short is a reason to doubt the brain is clean.
  const last = await search();
  if (last.failed !== null) left.set(last.failed[0], last.failed[1]);
  if (last.capped) left.set("(search)", "the last search read 5,000 matches and stopped");
  for (const id of last.ids) {
    if (left.has(id)) continue;
    const f = await call("fetch", { id });
    if (!f.ok && READ_GONE.test(f.error ?? "")) continue;
    if (!f.ok || typeof f.sc.text !== "string") { left.set(id, `its read failed: ${f.error ?? "no text"}`); continue; }
    const kind = noteKind(f.sc.text, arm);
    if (kind === "note") left.set(id, tried.has(id) ? "still there after its delete" : "found by the last search alone, not tried");
    else if (kind === "lookalike") left.set(id, LOOKALIKE);
  }
  return { deleted, absent, found, otherArm, left };
}

/** clean's lines and its exit code: 1 when anything is left, or not known to be gone. */
export function cleanLines(name: string, listed: number, r: Cleaned, arm?: string, junk = 0): { lines: string[]; code: number } {
  const lines = [
    `${name}: ${r.deleted} measure notes deleted${arm === undefined ? "" : ` (arm ${arm})`}, ${r.found} of them found by content` +
    `; ${listed} ids listed${junk ? ` and ${junk} lines that are no id, not sent` : ""}, ${r.absent} not on the brain${r.otherArm ? `, ${r.otherArm} another arm's notes and left` : ""}`,
  ];
  if (r.left.size) lines.push(`  NOT deleted, or not known to be: ${[...r.left].map(([id, why]) => `${id} (${why})`).join(", ")}`);
  return { lines, code: r.left.size ? 1 : 0 };
}

/**
 * clean, whole, through `call`: the tier guard first, so nothing is searched, read or deleted on a brain of another tier;
 * then the ids' reading, the deletes and the lines. One function, so the self-check's brain in memory holds the guard and
 * the arm's passing with the rest (review pass 5: both sat in wiring no row reached).
 */
export async function cleanOn(call: Call, name: string, idsText: string, arm?: string): Promise<{ lines: string[]; code: number }> {
  await tierGuard(call, name);
  const { ids, junk } = idsOf(idsText);
  return cleanLines(name, ids.length, await cleanWith(call, ids, arm), arm, junk);
}

async function clean(b: Brain, ids: string, arm: string | undefined): Promise<number> {
  const idsText = textOf(() => readFileSync(ids, "utf8"), "--ids' file");
  const { lines, code } = await cleanOn(callOf(b, rpcFor(b)), b.name, idsText, arm);
  for (const line of lines) console.log(line);
  return code;
}

/** What a sample keeps of brain_info: the tier, the commit, the provider's state, each heartbeat's state and model tallies,
 *  and the coordinator's relay mark, children and stamp time. */
export function keptOf(info: Record<string, any>): Record<string, unknown> {
  const w = info?.database?.workers ?? {};
  return {
    tier: info?.tier ?? null,
    commit: info?.commit ?? null,
    provider: info?.provider?.status ?? null,
    heartbeats: (Array.isArray(w.heartbeats) ? w.heartbeats : []).filter((h: unknown) => h !== null && typeof h === "object").map((h: Record<string, any>) => ({
      worker: h.worker, at: h.at, running: h.running, slept: h.slept ?? null, models: h.models ?? null, answers: h.malformed?.answers ?? null,
    })),
    relay: w.coordinator?.relay ?? null,
    children: w.coordinator?.children ?? null,
    childrenAt: w.coordinator?.at ?? null,
  };
}

/** The pools with work: pending or claimed rows, by work type. */
export function backlogOf(status: Record<string, any>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of Array.isArray(status?.pools) ? status.pools : []) {
    const n = Number(p?.pending ?? 0) + Number(p?.claimed ?? 0);
    if (n > 0 && typeof p?.workType === "string") out[p.workType] = n;
  }
  return out;
}

/** One pool's rows as a sample keeps them: what is waiting or in hand, what failed, the thoughts with no row under the key
 *  yet, and whether the key is the brain's own for that work (null where the brain records none: consolidation). */
export type PoolKept = { pending: number; claimed: number; failed: number; unpooled: number; active: boolean | null };

/** Every pool worker_status names, by work type, an idle one too: the summary reads a pool that emptied, and one whose
 *  rows failed. Null where the answer holds no list of pools. */
export function poolsOf(status: Record<string, any>): Record<string, PoolKept> | null {
  if (!Array.isArray(status?.pools)) return null;
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const out: Record<string, PoolKept> = {};
  for (const p of status.pools) {
    if (p === null || typeof p !== "object" || typeof p.workType !== "string") continue;
    out[p.workType] = { pending: count(p.pending), claimed: count(p.claimed), failed: count(p.failed), unpooled: count(p.unpooled), active: typeof p.active === "boolean" ? p.active : null };
  }
  return out;
}

/** The url of Ollama's loaded models under --ollama's: its path with /api/ps after it, a query it carries kept behind the
 *  path (it was once put before it, SMD-4382). Null for what is no http or https url. */
export function psUrl(base: string): string | null {
  let u: URL;
  try { u = new URL(base); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/api/ps`;
  u.hash = "";
  return u.href;
}

/** A brain's line of a round: when, the arm and this run of it, the brain, and what is kept of its two answers. */
export function sampleLine(t: string, arm: string, run: string, brain: string, info: Record<string, any>, status: Record<string, any>): Record<string, unknown> {
  return { t, arm, run, brain, ...keptOf(info), backlog: backlogOf(status), pools: poolsOf(status) };
}

/** The loaded models' names in /api/ps's answer, sorted; null where it holds no list of models, which is no server with
 *  none loaded. */
export function loadedOf(answer: unknown): string[] | null {
  const models = (answer as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;
  return models.map((m) => (typeof m?.name === "string" ? m.name : "?")).sort();
}

async function sample(brains: Brain[], arm: string, minutes: number, everyS: number, out: string, ollama: string | undefined): Promise<number> {
  const before = existing(out, "--out's file");
  const problem = appendProblem("samples", before);
  if (problem) throw new Error(problem);
  append(out, lineEnd(before), "--out's file");
  const rpcs = new Map(brains.map((b) => [b.name, rpcFor(b)]));
  const ps = ollama ? psUrl(ollama) : null;
  // This run of the arm: summary reads another run of the same name, appended to the same file, as a table of its own.
  const run = new Date().toISOString();
  const end = Date.now() + minutes * 60_000;
  let stop: "SIGINT" | "SIGTERM" | null = null;
  let wake = () => {};
  // The first signal ends the wait at once and the round in hand; a second exits now.
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { if (stop) process.exit(sampleExit(stop, 0)); stop = sig; wake(); });
  const answered = new Set<string>();
  console.log(`sampling arm ${arm}: ${brains.map((b) => `${b.name} (${shownUrl(b.mcp)})`).join(", ")} every ${everyS} s for ${minutes} min into ${out}`);
  while (!stop && Date.now() < end) {
    const t = new Date().toISOString();
    const round: Promise<Record<string, unknown>>[] = brains.map(async (b) => {
      const rpc = rpcs.get(b.name)!;
      try {
        const [info, status] = await Promise.all([tool(b, rpc, "brain_info", {}), tool(b, rpc, "worker_status", {})]);
        answered.add(b.name);
        return sampleLine(t, arm, run, b.name, info, status);
      } catch (e) {
        return { t, arm, run, brain: b.name, error: (e as Error).message };
      }
    });
    if (ps) {
      round.push((async () => {
        try {
          const r = await fetch(ps, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
          if (!r.ok) return { t, arm, run, brain: MODEL_SERVER, error: `HTTP ${r.status}` };
          const loaded = loadedOf(await r.json());
          return loaded === null ? { t, arm, run, brain: MODEL_SERVER, error: WRONG_SHAPE } : { t, arm, run, brain: MODEL_SERVER, loaded };
        } catch (e) {
          return { t, arm, run, brain: MODEL_SERVER, error: errorKind(e) };
        }
      })());
    }
    for (const line of await Promise.all(round)) append(out, JSON.stringify(line) + "\n", "--out's file");
    const wait = Math.min(everyS * 1000, end - Date.now());
    if (wait > 0 && !stop) await new Promise<void>((r) => { const tm = setTimeout(r, wait); wake = () => { clearTimeout(tm); r(); }; });
  }
  const silent = brains.filter((b) => !answered.has(b.name)).map((b) => b.name);
  console.log(`sampled arm ${arm}${stop ? ` (stopped early by ${stop})` : ""}${silent.length ? `; never answered: ${silent.join(", ")}` : ""}`);
  return sampleExit(stop, silent.length);
}

/** Whether a sample has nothing to read: no brain and no model server. A model server alone is a sample, which summary
 *  reads (review pass 6: pass 5 refused it). */
export function nothingToSample(brains: number, ollama: string | undefined): boolean {
  return brains === 0 && !ollama;
}

/** sample's exit code: 128 + the first signal's number when one cut it short, whatever the brains answered
 *  (so `sample && summary` stops there), else 1 when a brain never answered. */
export function sampleExit(signal: "SIGINT" | "SIGTERM" | null, silent: number): number {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : silent ? 1 : 0;
}

type Tally = { calls: number; callMs: number; waited: number; waitMs: number };
type Stamp = { at: number; byPass: Record<string, Tally> };

/** Marks of one run differ by no more than this: a mark's seconds are rounded, and its row is written up to ten seconds
 *  after they were counted (supervise.ts's STAMP_TIMEOUT_MS). Two runs that began within it read as one: the first ran
 *  no longer than this, and the tallies' own rule still reads its stamps. */
const SAME_RUN_MS = 15_000;
/** A run began no later than this after the time read for it: a mark's seconds are rounded to the nearest, and its row
 *  is written after they were counted, never before. So a stamp later than this is the new process's for certain. */
const BEGIN_LATE_MS = 500;
/** And, for a fall in the tallies to be the same restart, no earlier than this before it: the rounding, and a write
 *  half a second behind its count. */
const BEGIN_EARLY_MS = 1_000;

/**
 * When each run of a pass the coordinator runs began, oldest first, from the samples' marks: a mark says the pass is
 * running and for how many seconds (`for_s`, counted back from the coordinator's stamp, coordinator.ts's
 * coordinatorValue), so its run began that long before the stamp's time. Marks within SAME_RUN_MS of a run's earliest
 * are that run's, and the earliest is the nearest to the truth: a late write only adds. Empty for a brain with no
 * coordinator, a pass it does not run, or samples from before they kept the stamp's time.
 */
export function beginsOf(rows: readonly Record<string, any>[], pass: string): number[] {
  const marks: number[] = [];
  for (const r of rows) {
    const m = r?.children?.[pass];
    const at = typeof r?.childrenAt === "string" ? Date.parse(r.childrenAt) : NaN;
    if (m?.state === "running" && typeof m.for_s === "number" && Number.isFinite(m.for_s) && m.for_s >= 0 && !Number.isNaN(at)) marks.push(at - m.for_s * 1000);
  }
  const begins: number[] = [];
  for (const b of marks.sort((x, y) => x - y)) if (!begins.length || b > begins[begins.length - 1] + SAME_RUN_MS) begins.push(b);
  return begins;
}

/** A sleep heartbeat's tallies, by pass: background calls, their time, and the slot waits. */
export function talliesOf(models: unknown): Record<string, Tally> | null {
  if (!models || typeof models !== "object") return null;
  const out: Record<string, Tally> = {};
  for (const [pass, m] of Object.entries(models as Record<string, any>)) {
    out[pass] = { calls: Number(m?.calls?.background ?? 0), callMs: Number(m?.callMs ?? 0), waited: Number(m?.slotWaits?.waited ?? 0), waitMs: Number(m?.slotWaits?.totalMs ?? 0) };
  }
  return out;
}

/**
 * A window's increase over its stamps, stamp by stamp: null with fewer than two. A process's tallies count since it
 * began, so across a restart every pass's value is the increase since. A pair of stamps is one:
 *   - where any pass's tally falls, or a pass drops out: the tallies' own sign, and the only one without `begins`;
 *   - where a run began between them (`begins`, beginsOf) and no such fall is beside that beginning: the restart the
 *     tallies cannot show, its first stamp already past the old one's on every tally. The pair is the one that ends at
 *     the first stamp surely the new process's, BEGIN_LATE_MS after the beginning read: a stamp nearer may be either's,
 *     and taking an old process's last stamp for a new one's first would count its whole life as the increase.
 * A beginning with a fall beside it is that fall's restart and counts once: a sleep stamps its first tallies within a
 * second of starting, so a stamp's time alone does not say whose it is (the rehearsal of SMD-4382 counted one restart
 * twice by it). Two restarts between one pair of stamps lose the calls before the second.
 */
export function windowOf(stamps: Stamp[], begins: readonly number[] = []): { s: number; total: Tally; byPass: Record<string, Tally>; restarts: number } | null {
  if (stamps.length < 2) return null;
  const zero = (): Tally => ({ calls: 0, callMs: 0, waited: 0, waitMs: 0 });
  const fields = ["calls", "callMs", "waited", "waitMs"] as const;
  const total = zero();
  const byPass: Record<string, Tally> = {};
  const fell = (k: number) => Object.keys(stamps[k - 1].byPass).some((pass) => !(pass in stamps[k].byPass) || fields.some((f) => stamps[k].byPass[pass][f] < stamps[k - 1].byPass[pass][f]));
  const unseen = new Set<number>();
  for (const b of begins) {
    if (stamps.some((_, k) => k > 0 && fell(k) && stamps[k - 1].at <= b + BEGIN_LATE_MS && stamps[k].at >= b - BEGIN_EARLY_MS)) continue;
    const k = stamps.findIndex((st) => st.at > b + BEGIN_LATE_MS);
    if (k > 0) unseen.add(k);
  }
  let restarts = 0;
  for (let k = 1; k < stamps.length; k++) {
    const [prev, cur] = [stamps[k - 1].byPass, stamps[k].byPass];
    const restarted = unseen.has(k) || fell(k);
    if (restarted) restarts++;
    for (const [pass, t] of Object.entries(cur)) {
      const p = restarted ? zero() : prev[pass] ?? zero();
      const b = (byPass[pass] ??= zero());
      for (const f of fields) { b[f] += t[f] - p[f]; total[f] += t[f] - p[f]; }
    }
  }
  return { s: (stamps[stamps.length - 1].at - stamps[0].at) / 1000, total, byPass, restarts };
}

/** An arm's extraction backlog in sample order: first, last and most, and when it ran dry — the first empty sample after
 *  the last that was not, when the last is empty. */
export function backlogLine(sizes: readonly { t: string; n: number }[]): string {
  if (!sizes.length) return "-";
  const lastBusy = sizes.map((x) => x.n > 0).lastIndexOf(true);
  const dry = lastBusy < sizes.length - 1 ? sizes[lastBusy + 1].t : null;
  const most = Math.max(...sizes.map((x) => x.n));
  return `${sizes[0].n} first, ${sizes[sizes.length - 1].n} last, ${most} most${lastBusy === -1 ? "; empty throughout" : dry ? `; ran dry at ${dry}` : "; never dry at the end"}`;
}

/**
 * An arm's extraction rows from the pools each sample kept (poolsOf), under the brain's own extraction key alone: an
 * older key's rows are said apart, where they once added a constant that made "never dry" permanent. To do is the rows
 * pending or claimed and the thoughts not yet pooled, which a pass pools as it starts: so a brain's loaded notes count
 * before its first pass has pooled them, where it has a pool at all. A sample with no row under the key is not empty but
 * unread: worker_status names a pool only once it has a row. The rows ran dry at the first sample with nothing to do
 * after the last with some, when the last has none; and where more rows have failed by then than at the first sample
 * with a pool, that is said in place of "ran dry", which would read as every note extracted.
 */
export function extractionLine(samples: readonly { t: string; pools: Record<string, PoolKept> }[]): string {
  if (!samples.length) return "-";
  const own = samples.map((s) => {
    const mine = Object.entries(s.pools).filter(([k, p]) => k.startsWith("extract:") && p.active === true).map(([, p]) => p);
    const others = Object.entries(s.pools).filter(([k, p]) => k.startsWith("extract:") && p.active !== true).reduce((n, [, p]) => n + p.pending + p.claimed, 0);
    const sum = (f: (p: PoolKept) => number) => mine.reduce((n, p) => n + f(p), 0);
    return { t: s.t, pooled: mine.length > 0, rows: sum((p) => p.pending + p.claimed), unpooled: sum((p) => p.unpooled), failed: sum((p) => p.failed), others };
  });
  const span = (f: (o: (typeof own)[number]) => number, most = false) => {
    const read = own.filter((o) => o.pooled);
    return `${f(read[0])} first, ${f(read[read.length - 1])} last${most ? `, ${Math.max(...read.map(f))} most` : ""}`;
  };
  const older = own.some((o) => o.others > 0) ? `; an older key's rows pending or claimed, not in these: ${own[0].others} first, ${own[own.length - 1].others} last` : "";
  if (!own.some((o) => o.pooled)) return `no row under the brain's extraction key in any sample: its extraction has pooled nothing yet, so notes loaded on it are not counted${older}`;
  const todo = (o: (typeof own)[number]) => o.rows + o.unpooled;
  const lastBusy = own.map((o) => !o.pooled || todo(o) > 0).lastIndexOf(true);
  const firstRead = own.find((o) => o.pooled)!;
  const dry = lastBusy < own.length - 1 ? own[lastBusy + 1] : null;
  const failedSince = dry ? dry.failed - firstRead.failed : 0;
  const end = lastBusy === -1 ? "nothing to do throughout"
    : !dry ? "never dry at the end"
    : failedSince > 0 ? `nothing left to do at ${dry.t}, but ${failedSince} more rows had failed than at the first sample: not every note was extracted`
    : `ran dry at ${dry.t}`;
  const unread = own.filter((o) => !o.pooled).length;
  return `pending or claimed ${span((o) => o.rows, true)}; not yet pooled ${span((o) => o.unpooled)}; failed ${span((o) => o.failed)}; ${end}${unread ? `; ${unread} of ${own.length} samples had no row under the key yet` : ""}${older}`;
}

/** One of bench-live.ts's samples. */
type Live = { label: string; kind: string; ms: number; ok: boolean };

/** What the table's columns are, printed under it: the reading no row can carry. */
export const LEGEND = "  s: from the window's first sleep stamp to its last. in flight: the sleep's call s over s; a call counts whole at the stamp after it ends, its wait inside the model server (a model loading, a call ahead of it) included, its wait for a slot not.\n" +
  "  by pass: calls/call s, and its slot waits. A row that names no brain is the brain above's board-sync, over its own stamps (one every five minutes while it is idle); a brain with none stamped no board-sync tallies. The api's background calls (its vector mender, a detached job) are in no row.";

/** A worker's stamps in an arm's samples of a brain, oldest first, each once however often it was sampled. */
function stampsOf(rows: readonly Record<string, any>[], worker: string): Stamp[] {
  const stamps = new Map<number, Stamp>();
  for (const r of rows) {
    const hb = (r.heartbeats ?? []).find((h: { worker?: string } | null) => h?.worker === worker);
    const by = talliesOf(hb?.models);
    const at = hb?.at ? Date.parse(hb.at) : NaN;
    if (!Number.isNaN(at) && by) stamps.set(at, { at, byPass: by });
  }
  return [...stamps.values()].sort((x, y) => x.at - y.at);
}

/** A window's row: its columns, then `last`. */
function windowRow(first: string, name: string, w: NonNullable<ReturnType<typeof windowOf>>, last: string, whose: string): string {
  const f = (v: number, d = 0) => v.toFixed(d);
  return `  ${first.padEnd(10)} ${name.padEnd(8)} ${f(w.s).padStart(5)} ${String(w.total.calls).padStart(7)} ${f(w.total.callMs / 1000).padStart(7)} ${f(w.total.callMs / 1000 / Math.max(1, w.s), 2).padStart(10)} ${String(w.total.waited).padStart(7)} ${f(w.total.waitMs / 1000, 1).padStart(7)}   ${last}${w.restarts ? ` (${whose} begun again ${w.restarts} time(s))` : ""}`;
}

/** summary's lines, from the samples' and each --live file's: pure, so the self-check holds the table's arithmetic. `liveNames`
 *  names each --live file, in their order. */
export function summaryLines(lines: readonly Record<string, any>[], splitMin: number, live: readonly (readonly Live[])[], liveNames: readonly string[] = []): string[] {
  const out: string[] = [];
  // An arm is a name and a run of `sample`: two runs of one name appended to one file are two tables, where they once
  // read as one arm from the first's start to the second's end (SMD-4382). Samples from before a run was named are one.
  const runKey = (l: Record<string, any>) => JSON.stringify([l.arm, typeof l.run === "string" ? l.run : null]);
  const armRuns = [...new Set(lines.map(runKey))];
  for (const key of armRuns) {
    const mine = lines.filter((l) => runKey(l) === key);
    const arm = mine[0].arm as string;
    const sameName = armRuns.filter((k) => JSON.parse(k)[0] === arm);
    const which = sameName.length > 1 ? ` (run ${sameName.indexOf(key) + 1} of ${sameName.length} of that name in the file)` : "";
    const t0 = Math.min(...mine.map((l) => Date.parse(l.t)));
    const t1 = Math.max(...mine.map((l) => Date.parse(l.t)));
    const split = t0 + splitMin * 60_000;
    out.push(`\narm ${arm}${which}: ${new Date(t0).toISOString()} to ${new Date(t1).toISOString()} (${((t1 - t0) / 60_000).toFixed(1)} min); windows: before ${splitMin} min, and after`);
    out.push(`  brain      window    s      calls  call s   in flight  waited  wait s   by pass`);
    for (const brain of [...new Set(mine.map((l) => l.brain as string))].filter((b) => b !== MODEL_SERVER)) {
      const asked = mine.filter((l) => l.brain === brain);
      const rows = asked.filter((l) => !l.error);
      // A sample that failed is no sample of the brain: said, never read as a sleep that stamped nothing.
      const unread = asked.length - rows.length;
      if (!rows.length) { out.push(`  ${brain.padEnd(10)} never answered in the arm: ${unread} of ${asked.length} samples failed`); continue; }
      const all = stampsOf(rows, "sleep");
      const began = beginsOf(rows, "sleep");
      const windows = [["before", t0, split], ["after", split, t1 + 1]] as const;
      for (const [name, lo, hi] of windows) {
        const inWindow = all.filter((s) => s.at >= lo && s.at < hi);
        const w = windowOf(inWindow, began);
        if (w === null) {
          const sleeping = rows.filter((r) => Date.parse(r.t) >= lo && Date.parse(r.t) < hi);
          if (!sleeping.length && !inWindow.length) {
            const unanswered = asked.filter((l) => l.error && Date.parse(l.t) >= lo && Date.parse(l.t) < hi).length;
            out.push(`  ${brain.padEnd(10)} ${name.padEnd(8)} ${unanswered ? `none of its ${unanswered} samples ${name} the split answered` : `no sample of it ${name} the split`}`);
            continue;
          }
          const working = sleeping.filter((r) => (r.heartbeats ?? []).some((h: Record<string, any> | null) => h?.worker === "sleep" && h.running && h.slept && h.slept.to === null)).length;
          const why = all.length === 0 ? "no model tallies stamped in the arm (a build before SMD-3379 PR 2b-2a, no sleep, or a sleep that had made no model call)" : `${inWindow.length} sleep stamp(s) in the window, fewer than two`;
          out.push(`  ${brain.padEnd(10)} ${name.padEnd(8)} ${why}; sleep working in ${working} of ${sleeping.length} samples`);
          continue;
        }
        const f = (v: number, d = 0) => v.toFixed(d);
        const passes = Object.entries(w.byPass).filter(([, t]) => t.calls > 0 || t.waited > 0)
          .map(([p, t]) => `${p} ${t.calls}/${f(t.callMs / 1000)}s${t.waited ? ` (${t.waited} waited ${f(t.waitMs / 1000)}s)` : ""}`).join(", ");
        out.push(windowRow(brain, name, w, passes || "-", "the sleep"));
      }
      // Board-sync's calls hold the same slots from a process of its own (SMD-4382): a row of theirs under the brain's,
      // not a sum with the sleep's, whose stamps are other times. None for a brain whose board-sync stamped no tallies.
      const sync = stampsOf(rows, "board-sync");
      const syncBegan = beginsOf(rows, "board-sync");
      if (sync.length) for (const [name, lo, hi] of windows) {
        const inWindow = sync.filter((s) => s.at >= lo && s.at < hi);
        const w = windowOf(inWindow, syncBegan);
        out.push(w === null ? `  ${"".padEnd(10)} ${name.padEnd(8)} its board-sync: ${inWindow.length} stamp(s) in the window, fewer than two` : windowRow("", name, w, "its board-sync", "it"));
      }
      // The pools each sample kept, where every one of the brain's has them; else the rows a sample before SMD-4382 kept.
      const pooled = rows.every((r) => r.pools !== null && typeof r.pools === "object" && !Array.isArray(r.pools));
      const sizes = rows.map((r) => ({ t: r.t as string, n: Object.entries(r.backlog ?? {}).filter(([k]) => k.startsWith("extract:")).reduce((s, [, n]) => s + Number(n), 0) }));
      const said = pooled ? `extraction rows under the brain's own key: ${extractionLine(rows.map((r) => ({ t: r.t as string, pools: r.pools as Record<string, PoolKept> })))}` : `extraction rows pending or claimed: ${backlogLine(sizes)}`;
      out.push(`  ${"".padEnd(10)} ${said}${unread ? `; ${unread} of ${asked.length} samples failed` : ""}`);
    }
    const olAsked = mine.filter((l) => l.brain === MODEL_SERVER);
    const ol = olAsked.filter((l) => Array.isArray(l.loaded));
    if (olAsked.length && !ol.length) out.push(`  ollama: never answered in the arm: ${olAsked.length} of ${olAsked.length} samples failed`);
    if (ol.length) {
      const sets = new Map<string, number>();
      let swaps = 0;
      ol.forEach((l, k) => { const s = l.loaded.join(" + ") || "(none)"; sets.set(s, (sets.get(s) ?? 0) + 1); if (k && s !== (ol[k - 1].loaded.join(" + ") || "(none)")) swaps++; });
      out.push(`  ollama: ${[...sets].map(([s, n]) => `${s} in ${n}`).join("; ")} of ${ol.length} samples; the loaded set differed from the sample before ${swaps} times${olAsked.length > ol.length ? `; ${olAsked.length - ol.length} more failed` : ""}`);
    }
  }
  if (armRuns.length) out.push("", LEGEND);
  if (live.length) {
    // Each row names its --live file by its place among them: a label is the operator's, and two brains' runs under one
    // label were rows no one could tell apart (SMD-4382).
    out.push(`\nlive calls (bench-live.ts), of the ok calls:`);
    out.push(`  label                    kind       n   ok   p50 ms   p90 ms   max ms  --live`);
    live.forEach((s, at) => {
      for (const label of [...new Set(s.map((x) => x.label))]) {
        for (const kind of ["search", "capture", "embed", "metadata"]) {
          const k = s.filter((x) => x.label === label && x.kind === kind);
          if (!k.length) continue;
          const ok = k.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b);
          const f = (v: number) => (Number.isNaN(v) ? "-" : Math.round(v).toString()).padStart(8);
          out.push(`  ${label.padEnd(24)} ${kind.padEnd(8)} ${String(k.length).padStart(4)} ${String(ok.length).padStart(4)} ${f(percentile(ok, 50))} ${f(percentile(ok, 90))} ${f(ok[ok.length - 1] ?? NaN)} ${String(at + 1).padStart(7)}`);
        }
      }
    });
    if (liveNames.length) out.push(`  --live: ${liveNames.map((n, at) => `${at + 1} ${n}`).join("; ")}`);
  }
  return out;
}

/** A file's lines as JSON objects, numbered as the file numbers them; a thrown error names `what` and the line, never its text. */
function linesOf(text: string, what: string, shape: (v: Record<string, any>) => boolean, kind: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  text.split("\n").forEach((l, k) => {
    if (l.trim() === "") return;
    const v = jsonOf(l, `${what} line ${k + 1}`);
    if (v === null || typeof v !== "object" || Array.isArray(v) || !shape(v as Record<string, any>)) throw new Error(`${what} line ${k + 1} is no ${kind}`);
    out.push(v as Record<string, any>);
  });
  return out;
}

/** sample's --out as samples: each an ISO time, an arm and a brain, its heartbeats a list where it has them. */
export function samplesOf(text: string, what: string): Record<string, any>[] {
  return linesOf(text, what, (v) => typeof v.t === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v.t) && !Number.isNaN(Date.parse(v.t)) && typeof v.arm === "string" && typeof v.brain === "string"
    && (v.heartbeats === undefined || Array.isArray(v.heartbeats)), "sample");
}

/** A --live file as bench-live.ts's samples: each a label, a kind, its milliseconds and whether it was ok. */
export function liveOf(text: string, what: string): Live[] {
  return linesOf(text, what, (v) => typeof v.label === "string" && typeof v.kind === "string" && typeof v.ms === "number" && typeof v.ok === "boolean", "bench-live.ts sample") as Live[];
}

function summary(out: string, splitMin: number, live: readonly string[]): number {
  const lines = samplesOf(textOf(() => readFileSync(out, "utf8"), "--out's file"), "--out's file");
  if (!lines.length) console.error("bench-brains.ts summary: --out's file holds no samples");
  const lives = live.map((file, k) => liveOf(textOf(() => readFileSync(file, "utf8"), `--live's file ${k + 1}`), `--live's file ${k + 1}`));
  // A file's own name, not the path typed: each was read as bench-live.ts's samples by now, so it is no key put there.
  for (const line of summaryLines(lines, splitMin, lives, live.map((file) => basename(file)))) console.log(line);
  return lines.length ? 0 : 1;
}

/** A floor under the self-check's rows, raised as it grows: fewer means some of it did not run. */
const ROWS_AT_LEAST = 140;

/** A string shaped like a key, for the rows that put one where a path, a file's text or an id belongs. */
const KEYISH = "abcdef0123456789abcdef0123456789";

/** The pure parts, and clean against a brain in memory, checked without a brain or a provider: what CI runs (--self-check). */
export async function selfCheck(): Promise<number> {
  const rows: [string, boolean][] = [];
  const ok = (pass: boolean, what: string) => { rows.push([what, pass]); };
  // A row that throws is a row that fails, said with the rows before it, not a self-check that ends with none printed
  // (review pass 5: three mutants ended it so).
  try { await selfRows(ok); } catch (e) { ok(false, `the self-check ended on a throw after ${rows.length} rows: ${String((e as Error | null)?.message ?? e)}`); }
  // CI reads the exit code alone: a self-check cut short by a stray return would pass with a handful of rows.
  if (rows.length < ROWS_AT_LEAST) ok(false, `the self-check ran ${rows.length} rows, fewer than the ${ROWS_AT_LEAST} it has had`);
  for (const [what, pass] of rows) console.log((pass ? "ok   " : "FAIL ") + what);
  return rows.every(([, p]) => p) ? 0 : 1;
}

async function selfRows(ok: (pass: boolean, what: string) => void): Promise<void> {
  const throws = (f: () => unknown, re: RegExp) => { try { f(); return false; } catch (e) { return re.test((e as Error).message); } };

  const a0 = notesFor("A", 0);
  ok(a0 === notesFor("A", 0), "an arm's note is the same text on every call");
  ok(a0 !== notesFor("B", 0) && a0 !== notesFor("A", 1), "another arm's, or another index's, is another text");
  const lens = Array.from({ length: 150 }, (_, i) => notesFor("A", i).length);
  ok(Math.min(...lens) > 500 && Math.max(...lens) < 1200, `a note is 500–1200 characters (${Math.min(...lens)}–${Math.max(...lens)})`);
  ok(new Set(Array.from({ length: 150 }, (_, i) => notesFor("C", i))).size === 150, "an arm's 150 notes are 150 texts");
  ok(isMeasureNote(a0) && isMeasureNote(`${INGESTED_NOTICE}\n\n${a0}`), "a note is a measure note, ingested or not");
  ok(!isMeasureNote(`A record quoting it: ${a0}`) && !isMeasureNote(`${NOTE_PREFIX} (arm A #x). `) && !isMeasureNote("smd-3379 measure note (arm A #1). x"), "a thought that quotes one, a malformed index or another case is not");

  const claude = () => ({ mcpServers: { "open-brain-canary": { url: "http://127.0.0.1:8011/mcp", headers: { "x-brain-key": "K" } } } });
  ok(JSON.stringify(brainOf("canary", { connector: "open-brain-canary" }, claude, () => "")) === JSON.stringify({ name: "canary", mcp: "http://127.0.0.1:8011/mcp", key: "K" }), "a connector's url and key");
  ok(brainOf("s", { mcp: "http://127.0.0.1:18379/mcp", keyFile: "/k" }, claude, () => "abc123\n").key === "abc123", "a key file's key, its newline trimmed");
  ok(throws(() => brainOf("s", { mcp: "http://h/mcp", keyFile: "/k" }, claude, () => "two words\n"), /holds no key on one line/), "a key file holding more than one word is refused");
  ok(throws(() => brainOf("s", { mcp: "http://h/mcp" }, claude, () => "k"), /give "connector"/) && throws(() => brainOf("s", {}, claude, () => "k"), /give "connector"/), "an entry with neither a connector nor a url and key file is refused");
  ok(!throws(() => brainOf("s", { mcp: "http://h/mcp", keyFile: "/k" }, claude, () => "k"), /./) && throws(() => brainOf("x", { connector: "missing" }, claude, () => ""), /^brain x: ~\/\.claude\.json has no mcpServers entry of its connector's name$/), "a connector ~/.claude.json lacks is refused, the brain named and not the connector");

  const info = { tier: "canary", commit: "c", provider: { status: "answering" }, database: { workers: { heartbeats: [{ worker: "sleep", at: "2026-11-16T00:00:00Z", running: true, slept: { from: "x", to: null }, models: { extract: { calls: { background: 3 } } }, malformed: { answers: 5 } }], coordinator: { relay: { broker: "up" } } } } };
  const kept = keptOf(info) as { heartbeats: { worker: string; answers: number }[]; relay: unknown; tier: string };
  ok(kept.tier === "canary" && kept.heartbeats[0].worker === "sleep" && kept.heartbeats[0].answers === 5 && JSON.stringify(kept.relay) === '{"broker":"up"}', "a sample keeps the tier, each heartbeat's state and tallies, and the relay mark");
  // Every field, whole (review pass 2): a sample that dropped `models` or `at` would read "no model tallies" only after an arm had run.
  const whole = keptOf({ ...info, database: { workers: { ...info.database.workers, coordinator: { relay: { broker: "up" }, children: { sleep: { for_s: 9 } }, at: "2026-11-16T00:00:01Z" } } } });
  ok(JSON.stringify(whole) === JSON.stringify({ tier: "canary", commit: "c", provider: "answering", heartbeats: [{ worker: "sleep", at: "2026-11-16T00:00:00Z", running: true, slept: { from: "x", to: null }, models: { extract: { calls: { background: 3 } } }, answers: 5 }], relay: { broker: "up" }, children: { sleep: { for_s: 9 } }, childrenAt: "2026-11-16T00:00:01Z" }), "a sample keeps each heartbeat's time, state, sleep and tallies whole, the provider's state, the commit, and the coordinator's children and stamp time");
  ok(JSON.stringify(backlogOf({ pools: [{ workType: "extract:m@p2", pending: 4, claimed: 1 }, { workType: "reembed:e", pending: 0, claimed: 0 }] })) === '{"extract:m@p2":5}', "the backlog is the pools with pending or claimed rows");
  ok(JSON.stringify(backlogOf({ pools: [{ workType: 5, pending: 2 }, { pending: 1 }] })) === "{}", "a pool with no work type named is no pool");

  const tl = talliesOf({ extract: { calls: { live: 0, background: 7 }, callMs: 1000, slotWaits: { waited: 2, totalMs: 30 } }, consolidate: {} });
  ok(JSON.stringify(tl) === '{"extract":{"calls":7,"callMs":1000,"waited":2,"waitMs":30},"consolidate":{"calls":0,"callMs":0,"waited":0,"waitMs":0}}' && talliesOf(null) === null, "a heartbeat's tallies by pass, background calls only; none without models");
  const st = (at: number, calls: number, callMs: number, pass = "extract") => ({ at, byPass: { [pass]: { calls, callMs, waited: 0, waitMs: 0 } } });
  const w = windowOf([st(0, 10, 10_000), st(60_000, 14, 70_000), st(120_000, 20, 250_000)]);
  ok(w !== null && w.restarts === 0 && w.s === 120 && w.total.calls === 10 && w.total.callMs === 240_000 && w.total.callMs / 1000 / w.s === 2 && w.byPass.extract.calls === 10 && w.byPass.extract.callMs === 240_000, "a window is its last stamp less its first, in all and by pass: 10 calls, 240 s of calls over 120 s is 2 in flight");
  ok(windowOf([st(0, 10, 10_000)]) === null, "one stamp is no window");
  const r = windowOf([st(0, 10, 10_000), st(60_000, 12, 30_000), st(120_000, 2, 5_000), st(180_000, 6, 20_000)]);
  ok(r !== null && r.restarts === 1 && r.total.calls === 2 + 2 + 4 && r.total.callMs === 20_000 + 5_000 + 15_000, "a tally that falls is the process begun again: its value is the increase since, then it counts on (8 calls, 40 s)");
  const np = windowOf([st(0, 0, 0), { at: 60_000, byPass: { extract: { calls: 0, callMs: 0, waited: 0, waitMs: 0 }, consolidate: { calls: 3, callMs: 9_000, waited: 1, waitMs: 500 } } }]);
  ok(np !== null && np.restarts === 0 && np.byPass.consolidate.calls === 3 && np.total.waited === 1 && np.total.waitMs === 500 && np.byPass.consolidate.waitMs === 500, "a pass first stamped inside the window counts from zero, its waits and their time too");
  const fellMs = windowOf([st(0, 5, 100_000), st(60_000, 6, 4_000)]);
  ok(fellMs !== null && fellMs.restarts === 1 && fellMs.total.calls === 6 && fellMs.total.callMs === 4_000, "a restart shows in any tally that falls: more calls than before but less call time is one, never a negative time");
  const twice = windowOf([st(0, 10, 10_000), st(60_000, 2, 2_000), st(120_000, 1, 1_000)]);
  ok(twice !== null && twice.restarts === 2 && twice.total.calls === 3, "each pair that falls is a restart of its own");
  ok(!throws(() => [talliesOf(undefined), talliesOf("x")], /./) && talliesOf(undefined) === null && talliesOf("x") === null, "a heartbeat with no models, or models that are no object, has no tallies");

  // A restart is decided once a pair of stamps (review pass 1): one pass falling, or one dropping out, starts every pass over.
  const two = (at: number, ex: number, co?: number) => ({ at, byPass: { extract: { calls: ex, callMs: ex * 1000, waited: 0, waitMs: 0 }, ...(co === undefined ? {} : { consolidate: { calls: co, callMs: co * 1000, waited: 0, waitMs: 0 } }) } });
  const fellOne = windowOf([two(0, 100, 2), two(60_000, 5, 3)]);
  ok(fellOne !== null && fellOne.restarts === 1 && fellOne.byPass.consolidate.calls === 3 && fellOne.byPass.extract.calls === 5, "one pass falling restarts every pass: consolidate's 3 since the restart counted whole, not +1");
  const dropped = windowOf([two(0, 100, 10), { at: 60_000, byPass: { consolidate: { calls: 12, callMs: 12_000, waited: 0, waitMs: 0 } } }]);
  ok(dropped !== null && dropped.restarts === 1 && dropped.byPass.consolidate.calls === 12, "a pass that drops out is a restart: consolidate's 12 counted whole, not +2");

  ok(backlogLine([{ t: "a", n: 0 }, { t: "b", n: 150 }, { t: "c", n: 40 }, { t: "d", n: 0 }, { t: "e", n: 0 }]) === "0 first, 0 last, 150 most; ran dry at d", "the backlog ran dry at the first empty sample after the last busy one, not at an empty one before the load");
  ok(backlogLine([{ t: "a", n: 9 }, { t: "b", n: 3 }]).endsWith("never dry at the end") && backlogLine([{ t: "a", n: 0 }]).endsWith("empty throughout") && backlogLine([]) === "-", "a backlog still there at the end, one never there, and no samples are each said");
  ok(isMeasureNote(notesFor("C3", 4), "C3") && !isMeasureNote(notesFor("C3", 4), "C") && !isMeasureNote(notesFor("B", 4), "C3"), "a note is the arm's only when its arm is that arm, a prefix of the name not enough");

  // Review pass 2's rows: what a whole-diff mutant run found unheld.
  ok(backlogLine([{ t: "a", n: 9 }, { t: "b", n: 3 }]) === "9 first, 3 last, 9 most; never dry at the end", "the backlog's first is its first sample's and its last its last's");
  ok(isMeasureNote(notesFor("fixed-2", 0), "fixed-2") && !isMeasureNote(`${NOTE_PREFIX} (arm A #1x). `) && !isMeasureNote(`${NOTE_PREFIX} (arm A #1) more`), "an arm's name may hold a hyphen, as --arm may; a heading not closed as a note's is none");
  const body = (t: string) => t.slice(t.indexOf("). "));
  ok(body(a0) !== body(notesFor("A", 1)) && body(a0) !== body(notesFor("B", 0)), "another index's note, or another arm's, differs past its heading");
  ok(!ALREADY_GONE.test("Refused: No thought with id x.") && READ_GONE.test("Fetch error: no thought with id x") && !READ_GONE.test("HTTP 500"), "gone is the brain's own words from their first character, a delete's and a read's");
  const blank = () => brainOf("s", { connector: "", mcp: "http://h/mcp", keyFile: "/k" }, claude, () => "k");
  ok(brainOf("c", { connector: "open-brain-canary", mcp: "http://127.0.0.1:9/mcp" }, claude, () => "").mcp === "http://127.0.0.1:9/mcp" && !throws(blank, /./) && blank().key === "k", "a connector entry's own url is taken over the connector's; a blank connector is none");
  ok(throws(() => brainOf("s", { mcp: "http://h/mcp", keyFile: "/k" }, claude, () => "two words\n"), /^brain s: the key file holds no key on one line$/), "a refused key file names its brain and nothing of the file");
  ok(sampleExit(null, 0) === 0 && sampleExit(null, 2) === 1 && sampleExit("SIGINT", 0) === 130 && sampleExit("SIGTERM", 1) === 143, "a sample exits 0, 1 when a brain never answered, and 128 + the signal's number when one cut it short");
  ok(JSON.stringify(strayFlags("summary", ["out", "arm"])) === '["arm"]' && strayFlags("clean", ["brains", "brain", "ids", "arm"]).length === 0 && JSON.stringify(strayFlags("load", ["brains", "out", "split"])) === '["out","split"]' && !throws(() => strayFlags("constructor", ["out"]), /./) && strayFlags("constructor", ["out"]).length === 0 && strayFlags(undefined, ["out"]).length === 0,
    "a subcommand's stray flags are those it does not read: summary's --arm, none of clean's own, and none for a name that is no subcommand");

  // summary's table (review pass 2: no row reached it), from fourteen rounds of samples built here, two a stamp: a canary
  // whose sleep works, a brain with one stamp and a failed sample, a brain whose sleep stamps no tallies, a brain that never
  // answers, the model server's loaded models.
  const T0 = Date.parse("2026-11-16T12:00:00Z");
  const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
  const grown = { calls: [10, 13, 19, 30, 34, 41, 50], s: [10, 60, 200, 420, 500, 640, 800], rows: [0, 150, 150, 90, 40, 0, 0] };
  const fixture: Record<string, any>[] = [];
  for (let k = 0; k < 7; k++) for (const d of [0, 30]) {
    const t = iso(k * 60 + d), round = k * 2 + d / 30;
    fixture.push({ t, arm: "X", brain: "canary", backlog: { "extract:m@p2": grown.rows[k], "reembed:e": 7 }, heartbeats: [
      { worker: "board-sync", at: iso(k * 60), models: { "-": { calls: { background: 500 * k }, callMs: 9_000_000 * k } } },
      { worker: "sleep", at: iso(k * 60), running: true, slept: { from: iso(0), to: null }, models: { extract: { calls: { live: 0, background: grown.calls[k] }, callMs: grown.s[k] * 1000, slotWaits: { waited: k, totalMs: k * 2000 } } } },
    ] });
    fixture.push({ t, arm: "X", brain: "idle", backlog: {}, heartbeats: [{ worker: "sleep", at: iso(0), running: true, slept: { from: iso(0), to: round < 2 ? null : iso(50) }, models: { extract: { calls: { background: 1 } } } }] });
    fixture.push({ t, arm: "X", brain: "quiet", backlog: {}, heartbeats: [{ worker: "sleep", at: iso(k * 60), running: round >= 4, slept: { from: iso(0), to: null } }] });
    fixture.push({ t, arm: "X", brain: "dead", error: "dead: brain_info got no answer" });
    fixture.push({ t, arm: "X", brain: "(ollama)", loaded: round >= 5 && round < 8 ? ["a"] : ["a", "b"] });
  }
  fixture.push({ t: iso(45), arm: "X", brain: "idle", error: "idle: worker_status failed" });
  fixture.push({ t: iso(15), arm: "X", brain: "(ollama)", error: "HTTP 500" });
  // A table that throws is rows that fail, each said, not a self-check that ends there.
  const safely = (f: () => string[]): string[] => { try { return f(); } catch { return []; } };
  const table = safely(() => summaryLines(fixture, 3, []));
  const line = (brain: string, win: string) => table.find((l) => l.trim().startsWith(brain) && l.includes(` ${win} `)) ?? "";
  const cells = (l: string) => l.trim().split(/\s+/);
  ok(cells(line("canary", "before")).slice(0, 8).join(" ") === "canary before 120 9 190 1.58 2 4.0" && line("canary", "before").endsWith("   extract 9/190s (2 waited 4s)"),
    "summary's window before the split: the sleep's stamps from the arm's first sample to the split, each once though sampled twice — 9 calls, 190 s over 120 s is 1.58 in flight, 2 waits, and the pass's own");
  ok(cells(line("canary", "after")).slice(0, 8).join(" ") === "canary after 180 20 380 2.11 3 6.0" && line("canary", "after").endsWith("   extract 20/380s (3 waited 6s)"), "and after it: 20 calls, 380 s over 180 s is 2.11; the pair of stamps across the split is in neither window");
  ok(line("idle", "before").endsWith("before   1 sleep stamp(s) in the window, fewer than two; sleep working in 2 of 6 samples") && line("idle", "after").endsWith("after    0 sleep stamp(s) in the window, fewer than two; sleep working in 0 of 8 samples"),
    "a brain with fewer than two stamps in a window is said, with the share of its samples in which its sleep was working, the arm's last sample among them and a failed one not");
  ok(table.includes(`  ${"".padEnd(10)} extraction rows pending or claimed: 0 first, 0 last, 150 most; ran dry at ${iso(300)}`) && table.some((l) => l.endsWith("0 first, 0 last, 0 most; empty throughout; 1 of 15 samples failed")),
    "the backlog line reads the extraction pools alone, and says a brain's failed samples");
  ok(table.includes(`  ${"dead".padEnd(10)} never answered in the arm: 14 of 14 samples failed`) && !table.some((l) => l.includes("dead") && l.includes("tallies")), "a brain that never answered is said so, never as a sleep that stamped nothing");
  ok(table.includes("  ollama: a + b in 11; a in 3 of 14 samples; the loaded set differed from the sample before 2 times; 1 more failed") && !table.some((l) => l.trim().startsWith("(ollama)")) && table[table.length - 1] === LEGEND,
    "the loaded sets are counted, and their changes from one sample to the next, a failed read of them said and no brain's row; the legend ends the table");
  // Review pass 3's rows.
  ok(table[0] === `\narm X: ${iso(0)} to ${iso(390)} (6.5 min); windows: before 3 min, and after`, "an arm's heading: its first and last sample and the minutes between");
  const none = "no model tallies stamped in the arm (a build before SMD-3379 PR 2b-2a, no sleep, or a sleep that had made no model call)";
  ok(line("quiet", "before") === `  ${"quiet".padEnd(10)} before   ${none}; sleep working in 2 of 6 samples` && line("quiet", "after") === `  ${"quiet".padEnd(10)} after    ${none}; sleep working in 8 of 8 samples`,
    "a sleep that stamps no tallies is said with its causes, and working is a sleep running and not yet ended");
  const waits = summaryLines([0, 60].map((s, k) => ({ t: iso(s), arm: "W", brain: "canary", backlog: {}, heartbeats: [{ worker: "sleep", at: iso(s), models: {
    extract: { calls: { background: 5 }, callMs: 9000 }, consolidate: { calls: { background: 0 }, callMs: 0, slotWaits: { waited: k * 40, totalMs: k * 173_000 } } } }] })), 3, []);
  const wl = waits.find((l) => l.trim().startsWith("canary") && l.includes(" before ")) ?? "";
  ok(cells(wl).slice(0, 8).join(" ") === "canary before 60 0 0 0.00 40 173.0" && wl.endsWith("   consolidate 0/0s (40 waited 173s)") && !wl.includes("extract"), "a pass whose asks waited while none of its calls ended is listed by its waits; a pass with no increase is not");
  ok(summaryLines([{ t: iso(0), arm: "O", brain: "(ollama)", error: "x" }], 1, []).includes("  ollama: never answered in the arm: 1 of 1 samples failed"), "a model server that never answered its loaded models is said");
  ok(throws(() => brainsOf(`${KEYISH}\n`), /^--brains' file is not JSON$/) && throws(() => brainsOf("[]"), /^--brains' file holds no JSON object of brains$/) && throws(() => brainsOf('"k"'), /holds no JSON object/) && throws(() => brainsOf("null"), /holds no JSON object/) && throws(() => brainsOf("7"), /holds no JSON object/) && Object.keys(brainsOf('{"a":{}}')).join() === "a",
    "a brains file that is not JSON is named by its flag and nothing of it printed (a key file given as --brains); it is a JSON object, no array, string, number or null");

  // Review pass 4's rows: a refusal names a flag or a brain and a code, never a path, a parser's words or a line's text.
  const noFile = () => { throw Object.assign(new Error(`ENOENT: no such file or directory, open '${KEYISH}'`), { code: "ENOENT" }); };
  ok(throws(() => brainOf("s", { mcp: "http://h/mcp", keyFile: KEYISH }, claude, noFile), /^brain s: its keyFile could not be read \(ENOENT\)$/), "a key written where keyFile's path belongs is not printed: the brain is named, and the file system's code");
  const ID = "0123abcd-0123-4abc-8def-0123456789ab";
  const listedIds = idsOf(`${ID}\n\n  ${ID.toUpperCase()}  \r\n${ID}\nnot-a-uuid\n${KEYISH}\nhttp://h/mcp?key=${KEYISH}\n`);
  ok(JSON.stringify(listedIds.ids) === JSON.stringify([ID, ID.toUpperCase()]) && listedIds.junk === 3 && idsOf(`x${ID}\n${ID}x\n`).ids.length === 0 && idsOf(`x${ID}\n${ID}x\n`).junk === 2 && idsOf("").ids.length === 0 && idsOf("\n\n").junk === 0, "an ids file's ids are its lines that are thought ids, each once, spaces and blank lines aside; the others are counted, to be sent nowhere");
  ok(appendProblem("ids", "") === null && appendProblem("ids", `${ID}\n${ID}\n`) === null && /is no thought id/.test(appendProblem("ids", `${KEYISH}\n`) ?? "") && !(appendProblem("ids", `${KEYISH}\n`) ?? "").includes(KEYISH), "load appends ids to an empty file or one of ids alone, never to another kind of file (a key file), and says none of it");
  const smp = `{"t":"${iso(0)}","arm":"X","brain":"b"}`;
  const noSample = (text: string) => /is no sample/.test(appendProblem("samples", text) ?? "");
  ok(appendProblem("samples", "") === null && appendProblem("samples", `${smp}\n\n${smp}\n`) === null && appendProblem("samples", smp) === null && noSample(`${KEYISH}\n`) && noSample(`${smp}\n${KEYISH}\n`) && !(appendProblem("samples", `${KEYISH}\n`) ?? "").includes(KEYISH)
    && noSample('{"w": {"mcp": "http://127.0.0.1:1/mcp", "keyFile": "/k"}}\n') && noSample('{"label":"l","kind":"search","ms":5,"ok":true}\n') && noSample("{this is not json\n") && noSample(`${smp}\n${smp.slice(0, 20)}`),
    "sample appends to an empty file or one of samples alone: not to a key file, a brains file on one line, the latency harness's samples, a line that only begins as JSON, or a file whose last sample was cut");
  ok(lineEnd("") === "" && lineEnd(`${smp}\n`) === "" && lineEnd(smp) === "\n", "a file whose last line has no end gets one before the first line appended; an empty file and a whole one get none");
  ok(!throws(() => samplesOf(`${smp}\n\n${smp}\n`, "f"), /./) && samplesOf(`${smp}\n\n${smp}\n`, "--out's file").length === 2 && throws(() => samplesOf(`{"t":"${iso(0)}","arm":"X"}\n`, "f"), /^f line 1 is no sample$/) && throws(() => samplesOf(`${smp}\n\n${KEYISH}\n`, "--out's file"), /^--out's file line 3 is not JSON$/) && throws(() => samplesOf(`${smp}\n12345\n`, "f"), /^f line 2 is no sample$/) && throws(() => samplesOf('"k"\n', "f"), /^f line 1 is no sample$/) && throws(() => samplesOf('{"t":"never","arm":"X","brain":"b"}\n', "f"), /^f line 1 is no sample$/) && samplesOf("", "f").length === 0,
    "a samples file's line that is not JSON, or no sample (a time, an arm, a brain), is named by flag and by the file's own line number, its text unsaid");
  ok(!throws(() => liveOf('{"label":"l","kind":"search","ms":5,"ok":true}\n', "f"), /./) && liveOf('{"label":"l","kind":"search","ms":5,"ok":true}\n', "f").length === 1 && throws(() => liveOf("12345\n", "--live's file 1"), /^--live's file 1 line 1 is no bench-live\.ts sample$/) && throws(() => liveOf(`${KEYISH}\n`, "f"), /^f line 1 is not JSON$/), "a --live file's lines likewise");
  ok(cleanLines("x", 2, { deleted: 2, absent: 0, found: 0, otherArm: 0, left: new Map() }, undefined, 3).lines[0] === "x: 2 measure notes deleted, 0 of them found by content; 2 ids listed and 3 lines that are no id, not sent, 0 not on the brain", "clean's line counts the listed lines that were no id, sent nowhere");
  const armA = Array.from({ length: 150 }, (_, i) => notesFor("A", i)).join("\n");
  ok(new Bun.CryptoHasher("sha256").update([armA, notesFor("fixed-2", 4999), notesFor("C3", 199)].join("\n")).digest("hex").slice(0, 16) === "6fc050428bf9eaff" && [...PEOPLE, ...PROJECTS, ...TOOLS, ...ISSUES, ...DECISIONS, ...FOLLOWUPS].every((w) => armA.includes(w)),
    "the generator's text is pinned — every word of its lists, and how an arm's whole name and an index past 150 seed it: clean deletes by it, so a note it wrote before an edit would read as a lookalike and stay");
  ok(noteKind(`${INGESTED_NOTICE}\n\n${INGESTED_NOTICE}\n\n${a0}`) === "none" && noteKind(`${INGESTED_NOTICE}\n${a0}`) === "none" && noteKind(`${INGESTED_NOTICE}xx${a0}`) === "none" && noteKind(`${NOTE_PREFIX} (arm A #). x`) === "none",
    "the ingested notice is read past once, with its blank line, and nothing else before a heading is; a heading without an index is none");
  ok(!waits.some((l) => l.includes("ollama")) && summaryLines([0, 15].map((s) => ({ t: iso(s), arm: "O", brain: "(ollama)", loaded: ["a"] })), 1, []).includes("  ollama: a in 2 of 2 samples; the loaded set differed from the sample before 0 times"), "an arm with no model server sampled has no line for one, and one that always answered has no failed count");
  const down = safely(() => summaryLines([...[0, 30, 60, 90].map((s) => ({ t: iso(s), arm: "D", brain: "b", backlog: {}, heartbeats: [] })), ...[120, 150, 180].map((s) => ({ t: iso(s), arm: "D", brain: "b", error: "b: brain_info got no answer" }))], 2, []));
  ok(down.includes(`  ${"b".padEnd(10)} after    none of its 3 samples after the split answered`) && !down.some((l) => l.includes(" after ") && l.includes("sleep working")),
    "a window whose samples all failed says so, apart from one the arm never reached, and prints no count of none beside it");
  ok(noteKind(a0) === "note" && noteKind(`${a0} more`) === "lookalike" && noteKind(`${NOTE_PREFIX} (arm A #0). my own words`) === "lookalike" && noteKind(a0.replace("#0)", "#00)")) === "lookalike" && noteKind(notesFor("B", 1), "A") === "other-arm" && noteKind(`${NOTE_PREFIX} (arm B #1). my own words`, "A") === "lookalike" && noteKind(`quote: ${a0}`) === "none" && noteKind(a0.slice(0, -1)) === "lookalike" && noteKind(`${NOTE_PREFIX} (arm A #1x). `) === "none" && noteKind(`${NOTE_PREFIX} (arm A #1) more`) === "none",
    "a measure note is the generator's whole text for the arm and index its heading names: a longer, shorter or other text behind the heading is a lookalike, whatever the arm");
  ok(!READ_GONE.test("x Fetch error: no thought with id y") && !READ_GONE.test("fetch error: no thought with id y"), "a read's gone is the server's words from their first character");
  const brief = summaryLines([0, 0.5].map((s, k) => ({ t: iso(s), arm: "Y", brain: "canary", backlog: {}, heartbeats: [{ worker: "sleep", at: iso(s), models: { extract: { calls: { background: k * 3 }, callMs: k * 6000 } } }] })), 1, []);
  ok(cells(brief.find((l) => l.includes(" before ") && l.trim().startsWith("canary")) ?? "")[5] === "6.00", "a window shorter than a second divides by one: 6 s of calls is 6.00 in flight, not 12");
  const okMs = Array.from({ length: 18 }, (_, i) => (i + 1) * 10);
  const lt = summaryLines([], 3, [[...okMs.map((ms) => ({ label: "rv", kind: "search", ms, ok: true })), ...[9000, 9000].map((ms) => ({ label: "rv", kind: "search", ms, ok: false })), { label: "rv", kind: "metadata", ms: 7, ok: true }]]);
  ok(cells(lt.find((l) => l.includes(" search ")) ?? "").join(" ") === `rv search 20 18 ${Math.round(percentile(okMs, 50))} ${Math.round(percentile(okMs, 90))} 180 1` && percentile(okMs, 50) !== percentile(okMs, 90) && lt.some((l) => l.includes(" metadata ")) && !lt.includes(LEGEND),
    "the live table counts every call and reads its percentiles and its longest from the ok calls alone, a kind a row");
  ok(brief.some((l) => l === `  ${"canary".padEnd(10)} after    no sample of it after the split`) && brief.filter((l) => l.trim().startsWith("canary") && l.includes(" after ")).length === 1, "a window the arm never reached says so, not a count of none beside it");
  ok(!lt.some((l) => l.includes(" capture ") || l.includes(" embed ")), "a kind with no call has no row");
  // Review pass 5's rows: a closing mutation pass over the whole file found these decisions unheld.
  const armOf = (arm: string, at: number, calls: number[], secs: number[]) => calls.map((c, k) => ({ t: iso(at + k * 60), arm, brain: "b", backlog: {}, heartbeats: [{ worker: "sleep", at: iso(at + k * 60), models: { extract: { calls: { background: c }, callMs: secs[k] * 1000 } } }] }));
  const rowOf = (lines: string[], arm: string) => { const at = lines.findIndex((l) => l.startsWith(`\narm ${arm}:`)); return at < 0 ? "" : lines.slice(at).find((l) => l.trim().startsWith("b ") && l.includes(" before ")) ?? ""; };
  const arms2 = safely(() => summaryLines([...armOf("P", 0, [0, 2, 4], [0, 30, 60]), ...armOf("Q", 3600, [100, 105, 110], [900, 1020, 1140])], 5, []));
  ok(arms2.includes(`\narm P: ${iso(0)} to ${iso(120)} (2.0 min); windows: before 5 min, and after`) && arms2.includes(`\narm Q: ${iso(3600)} to ${iso(3720)} (2.0 min); windows: before 5 min, and after`)
    && cells(rowOf(arms2, "P")).slice(0, 8).join(" ") === "b before 120 4 60 0.50 0 0.0" && cells(rowOf(arms2, "Q")).slice(0, 8).join(" ") === "b before 120 10 240 2.00 0 0.0",
    "each arm of a samples file is summarised from its own samples, its windows from its own first: two arms an hour apart, 0.50 and 2.00 in flight");
  const byLabel = summaryLines([], 3, [[...[10, 20, 30].map((ms) => ({ label: "one", kind: "search", ms, ok: true })), ...[1000, 2000].map((ms) => ({ label: "two", kind: "search", ms, ok: true })), { label: "two", kind: "capture", ms: 5, ok: false }]]);
  ok(byLabel.some((l) => cells(l).join(" ") === "one search 3 3 20 30 30 1") && byLabel.some((l) => cells(l).join(" ") === "two search 2 2 1000 2000 2000 1") && byLabel.some((l) => cells(l).join(" ") === "two capture 1 0 - - - 1"),
    "the live table reads each label's calls alone, and a kind with no ok call has no latency to say");
  const again = rowOf(safely(() => summaryLines(armOf("R", 0, [10, 14, 3], [10, 50, 6]), 5, [])), "R");
  ok(cells(again).slice(0, 8).join(" ") === "b before 120 7 46 0.38 0 0.0" && again.endsWith("   extract 7/46s (the sleep begun again 1 time(s))"), "a window that spans a restart says so: 4 calls before it and 3 since");
  ok(rowOf(safely(() => summaryLines(armOf("N", 0, [5, 5], [9, 9]), 5, [])), "N").endsWith("   -"), "a window in which no pass called or waited lists none");
  const gap = safely(() => summaryLines([...[0, 60].map((s) => ({ t: iso(s), arm: "G", brain: "b", backlog: { "extract:m": 5 }, heartbeats: [] })), { t: iso(120), arm: "G", brain: "b", error: "b: no answer" }], 5, []));
  ok(gap.some((l) => l.endsWith("extraction rows pending or claimed: 5 first, 5 last, 5 most; never dry at the end; 1 of 3 samples failed")), "a sample that failed is no empty backlog: the rows ran dry only where a brain said so");
  ok(summaryLines([{ t: iso(0), arm: "O", brain: "(ollama)", loaded: [] }], 1, []).includes("  ollama: (none) in 1 of 1 samples; the loaded set differed from the sample before 0 times"), "a model server with nothing loaded is said so");
  ok(safely(() => summaryLines([{ t: iso(0), arm: "Z", brain: "b", backlog: {}, heartbeats: [null, "x", { worker: "sleep", at: iso(0), running: true, slept: { from: iso(0), to: null } }] }], 1, [])).some((l) => l.includes("sleep working in 1 of 1 samples")), "a heartbeat that is no object is no heartbeat, and no end of the summary");

  ok(JSON.stringify(brainOf("s", { mcp: "http://127.0.0.1:18379/mcp", keyFile: "/k" }, claude, () => "abc123\n")) === '{"name":"s","mcp":"http://127.0.0.1:18379/mcp","key":"abc123"}', "a key file's brain is its entry's url and its file's key, whole");
  ok(throws(() => brainOf("s", { connector: "open-brain-canary", mcp: "http://h/mcp", keyFile: "/k" }, claude, () => "k"), /^brain s: give "connector" or "keyFile", not both$/), "an entry with a connector and a key file is refused: one of the two keys would be ignored unsaid");
  const noKeyEntry = () => ({ mcpServers: { bare: { url: "http://h/mcp" } } });
  ok(throws(() => brainOf("s", { connector: KEYISH }, claude, () => ""), /^brain s: ~\/\.claude\.json has no mcpServers entry of its connector's name$/) && throws(() => brainOf("s", { connector: "constructor" }, claude, () => ""), /has no mcpServers entry/)
    && throws(() => brainOf("s", { connector: "bare" }, noKeyEntry, () => ""), /^brain s: its connector's entry in ~\/\.claude\.json has no key /) && !throws(() => brainOf("s", { connector: "bare" }, noKeyEntry, () => ""), /bare/),
    "a connector's failure names the brain and never the connector's value (a key put there by mistake): no entry of that name, a prototype's name among them, or an entry with no key");
  ok(throws(() => brainOf("s", null, claude, () => "k"), /give "connector"/) && throws(() => brainOf("s", { mcp: "", keyFile: "/k" }, claude, () => "k"), /give "connector"/) && throws(() => brainOf("s", { mcp: "http://h/mcp", keyFile: "" }, claude, () => "k"), /give "connector"/), "an entry that is null, or whose url or key file is blank, is no entry");
  ok(JSON.stringify(keptOf({})) === '{"tier":null,"commit":null,"provider":null,"heartbeats":[],"relay":null,"children":null,"childrenAt":null}', "a brain_info with nothing in it is kept as nothing, not a throw");
  ok(noteKind("smd-3379 measure note (arm A #1). x") === "none" && noteKind("SMD-3379 Measure Note (arm A #1). x") === "none", "a heading in another case is none, not a lookalike to say on every run");
  ok(JSON.stringify(TAKES) === '{"load":["brains","brain","arm","ids","notes","parallel"],"sample":["brains","arm","minutes","every","out","ollama"],"clean":["brains","brain","ids","arm"],"summary":["out","split","live"]}', "each subcommand's flags, whole");
  ok(throws(() => liveOf('{"label":"l","kind":"search","ok":true}\n', "f"), /^f line 1 is no bench-live\.ts sample$/) && throws(() => liveOf('{"label":"l","kind":"search","ms":5}\n', "f"), /^f line 1 is no bench-live\.ts sample$/)
    && throws(() => samplesOf(`{"t":"${iso(0)}","brain":"b"}\n`, "f"), /^f line 1 is no sample$/) && throws(() => samplesOf("null\n", "f"), /^f line 1 is no sample$/)
    && throws(() => samplesOf('{"t":"5","arm":"X","brain":"b"}\n', "f"), /^f line 1 is no sample$/) && throws(() => samplesOf('{"t":"May 1","arm":"X","brain":"b"}\n', "f"), /^f line 1 is no sample$/)
    && throws(() => samplesOf(`{"t":"${iso(0)}","arm":"X","brain":"b","heartbeats":"x"}\n`, "f"), /^f line 1 is no sample$/) && throws(() => samplesOf('{"t":"2026-13-45T99:99","arm":"X","brain":"b"}\n', "f"), /^f line 1 is no sample$/),
    "a live sample wants its milliseconds and its ok; a sample its arm, an ISO time, and heartbeats that are a list");

  // Review pass 6's rows.
  ok(lineEnd(`${smp}\n${smp}`) === "\n" && lineEnd("a\nb\n") === "", "a line end is owed by the file's last character, not by any before it");
  ok(throws(() => brainOf("s", { connector: "open-brain-canary", keyFile: "/k" }, claude, () => "k"), /not both$/) && throws(() => brainOf("s", { connector: 5, mcp: "http://h/mcp", keyFile: "/k" }, claude, () => "k"), /each a string$/) && throws(() => brainOf("s", { connector: "open-brain-canary", keyFile: 9 }, claude, () => "k"), /each a string$/)
    && throws(() => brainOf("s", { connector: "open-brain-canary" }, () => ({}), () => ""), /has no mcpServers entry/) && throws(() => brainOf("s", { connector: "open-brain-canary" }, () => null, () => ""), /has no mcpServers entry/)
    && brainOf("c", { connector: "open-brain-canary", mcp: "" }, claude, () => "").mcp === "http://127.0.0.1:8011/mcp",
    "a connector beside a key file is refused with or without a url; a field that is no string is no entry; a ~/.claude.json with no servers has no entry; a connector entry's blank url is the connector's own");
  const paths: string[] = [];
  ok(brainOf("s", { mcp: "http://h/mcp", keyFile: "/the/one/path" }, claude, (p) => { paths.push(p); return p === "/the/one/path" ? "k1\n" : "other\n"; }).key === "k1" && paths.join() === "/the/one/path", "a brain's key is read from its entry's keyFile, that path and once");
  ok(throws(() => samplesOf('{"t":"2026-11-16","arm":"X","brain":"b"}\n', "f"), /^f line 1 is no sample$/) && throws(() => samplesOf(`{"t":"${iso(0)}","arm":"X","brain":"b","heartbeats":{}}\n`, "f"), /is no sample$/) && throws(() => samplesOf(`{"t":"${iso(0)}","arm":"X","brain":"b","heartbeats":null}\n`, "f"), /is no sample$/),
    "a sample's time has a time of day; its heartbeats, where there, are a list — no object, no null");
  const shared = summaryLines([], 3, [[{ label: "same", kind: "search", ms: 10, ok: true }], [{ label: "same", kind: "search", ms: 900, ok: true }]]);
  ok(shared.filter((l) => l.trim().startsWith("same")).map((l) => cells(l).join(" ")).join("|") === "same search 1 1 10 10 10 1|same search 1 1 900 900 900 2", "two --live files are two tables' rows, a label they share not merged, each row naming its file by its place");
  ok(JSON.stringify(keptOf({ database: { workers: { heartbeats: [null, "x", { worker: "sleep", at: "t" }] } } }).heartbeats) === '[{"worker":"sleep","at":"t","slept":null,"models":null,"answers":null}]', "a heartbeat that is no object is not kept, and no throw: a sample of the brain all the same");
  ok(nothingToSample(0, undefined) && nothingToSample(0, "") && !nothingToSample(0, "http://127.0.0.1:11434") && !nothingToSample(1, undefined), "a model server may be sampled alone; no brain and no model server is nothing to sample");

  // SMD-4382's rows: what the summary could not see, and the smaller items beside.
  // A restart the tallies cannot show: the new process's first stamp passes the old one's last on every tally. The
  // coordinator's marks say the sleep had run 1000 s at the first sample and 30 s at the third, so it began again between.
  const hidden = (arm: string, at: boolean) => [0, 60, 120, 180].map((s, k) => ({ t: iso(s), arm, brain: "b", backlog: {}, children: { sleep: { key: "heartbeat:sleep", state: "running", for_s: k < 2 ? 1000 + s : s - 90 } }, ...(at ? { childrenAt: iso(s) } : {}),
    heartbeats: [{ worker: "sleep", at: iso(s), models: { extract: { calls: { background: [10, 14, 20, 26][k] }, callMs: [100, 140, 200, 260][k] * 1000 } } }] }));
  const seen = rowOf(safely(() => summaryLines(hidden("H", true), 5, [])), "H");
  ok(cells(seen).slice(0, 8).join(" ") === "b before 180 30 300 1.67 0 0.0" && seen.endsWith("   extract 30/300s (the sleep begun again 1 time(s))"),
    "a restart the tallies cannot show is read from the coordinator's marks: one restart, and the new process's 20 calls counted whole, not as 6 more than the old one's 14 (30 calls, 300 s)");
  const unseen = rowOf(safely(() => summaryLines(hidden("H", false), 5, [])), "H");
  ok(cells(unseen).slice(0, 8).join(" ") === "b before 180 16 160 0.89 0 0.0" && unseen.endsWith("   extract 16/160s"), "samples that keep no time for the marks are read by the tallies alone, as a brain with no coordinator is: no restart seen, 16 calls");
  const marked = (forS: unknown, at: number | null, state = "running", pass = "sleep") => ({ children: { [pass]: { state, for_s: forS } }, ...(at === null ? {} : { childrenAt: iso(at) }) });
  const begins = beginsOf([marked(5, 400), marked(100, 100), marked(161, 160.4), marked(30, 200, "waiting"), marked(-1, 300), marked("9", 300), marked(7, null), marked(7, 300, "running", "board-sync"), {}, { children: null, childrenAt: iso(1) }], "sleep");
  ok(JSON.stringify(begins) === JSON.stringify([T0 - 600, T0 + 395_000]) && beginsOf([], "sleep").length === 0, "a run began its mark's seconds before the coordinator's stamp: two marks a rounding apart are one run, its earliest the one kept; a mark not running, of another pass, with no seconds or no stamp time is none");
  const ran = (at: number, calls: number) => ({ at: at * 1000, byPass: { extract: { calls, callMs: calls * 1000, waited: 0, waitMs: 0 } } });
  const win = (stamps: ReturnType<typeof ran>[], began: number[]) => { const x = windowOf(stamps, began.map((b) => b * 1000)); return x === null ? "none" : `${x.restarts}/${x.total.calls}`; };
  const rising = [ran(0, 10), ran(60, 14), ran(120, 20), ran(180, 26)];
  ok(win(rising, [90]) === "1/30" && win(rising, []) === "0/16" && win(rising, [-500]) === "0/16" && win(rising, [200]) === "0/16" && win(rising, [70, 100]) === "1/30" && win(rising, [30, 150]) === "2/46",
    "a run that began between two stamps is a restart at that pair, the tallies rising all the while: none with no run known, one that began before the first stamp or after the last, two runs in one pair one restart, two pairs two");
  // The rehearsal's shape: the new process stamps its first tallies within a second of starting, and they fall.
  const quick = [ran(0, 10), ran(60, 14), ran(70.9, 1), ran(130, 9)];
  ok(win(quick, [70]) === "1/13" && win(quick, [71.3]) === "1/13" && win(quick, [61]) === "1/13" && win(quick, []) === "1/13" && win(quick, [30]) === "2/23",
    "a restart the tallies show and the marks date is one restart, counted once: its first stamp within a second of the beginning, or before the time read for it; a run that began at another pair is a restart of its own");
  // A stamp half a second or less after the beginning read may be the old process's last: the restart is the pair after.
  const close = [ran(0, 10), ran(60, 14), ran(90.3, 15), ran(150, 20), ran(210, 26)];
  ok(win(close, [90]) === "1/31" && win(close, [90.31]) === "1/31" && win(close, [89.7]) === "1/30" && win([ran(0, 10), ran(60, 14)], [60.2]) === "0/4",
    "the unseen restart is at the first stamp surely the new process's, more than half a second after the beginning read: a stamp nearer is taken for the old one's last, whose whole tally would else count as an increase");

  // Board-sync's calls, apart from the sleep's: a row of their own under the brain's.
  const syncRow = (lines: string[], win: string) => cells(lines.find((l) => l.includes("its board-sync") && l.includes(` ${win} `)) ?? "").join(" ");
  ok(syncRow(table, "before") === "before 120 1000 18000 150.00 0 0.0 its board-sync" && syncRow(table, "after") === "after 180 1500 27000 150.00 0 0.0 its board-sync" && table.filter((l) => l.includes("its board-sync")).length === 2
    && table.findIndex((l) => l.includes("its board-sync")) === table.findIndex((l) => l.trim().startsWith("canary") && l.includes(" after ")) + 1,
    "a brain's board-sync has rows of its own under the sleep's, from its own stamps: 1,000 calls before the split and 1,500 after, none of them in the sleep's 9 and 20; a brain whose board-sync stamped no tallies has none");
  const syncArm = [0, 300, 600, 900].map((s, k) => ({ t: iso(s), arm: "S", brain: "b", backlog: {}, childrenAt: iso(s), children: { sleep: { state: "running", for_s: 50 + s }, "board-sync": { state: "running", for_s: k < 2 ? 50 + s : s - 400 } }, heartbeats: [
    { worker: "board-sync", at: iso(s), models: { "-": { calls: { background: [3, 5, 9, 12][k] }, callMs: [30, 50, 90, 120][k] * 1000, slotWaits: { waited: [0, 1, 1, 2][k], totalMs: [0, 4000, 4000, 6500][k] } } } },
    { worker: "sleep", at: iso(s), models: { extract: { calls: { background: 100 + k }, callMs: (1000 + 10 * k) * 1000 } } }] }));
  const synced = safely(() => summaryLines(syncArm, 20, []));
  ok(syncRow(synced, "before") === "before 900 14 140 0.16 3 10.5 its board-sync (it begun again 1 time(s))" && cells(rowOf(synced, "S")).slice(0, 8).join(" ") === "b before 900 3 30 0.03 0 0.0" && rowOf(synced, "S").endsWith("   extract 3/30s")
    && synced.some((l) => l === `  ${"".padEnd(10)} after    its board-sync: 0 stamp(s) in the window, fewer than two`),
    "board-sync's restart is read from its own mark, the sleep's row beside it untouched: 2 calls, then the new process's 9 whole, then 3; a window with fewer than two of its stamps says so");
  ok(LEGEND.includes("A row that names no brain is the brain above's board-sync") && !LEGEND.includes("board-sync's, the api's"), "the legend says whose a row with no brain is, and no longer that board-sync's calls are left out");

  // The extraction rows: the brain's own key alone, with what is not yet pooled and what failed.
  const pool = (pending: number, claimed: number, unpooled: number, failed: number, active: boolean | null = true): PoolKept => ({ pending, claimed, failed, unpooled, active });
  const ex = (pools: Record<string, PoolKept>[]) => extractionLine(pools.map((p, k) => ({ t: `t${k}`, pools: p })));
  const OWN = "extract:m@p2";
  ok(ex([{ [OWN]: pool(0, 0, 150, 2) }, { [OWN]: pool(140, 3, 0, 2) }, { [OWN]: pool(0, 0, 0, 2) }, { [OWN]: pool(0, 0, 0, 2) }]) === "pending or claimed 0 first, 0 last, 143 most; not yet pooled 150 first, 0 last; failed 2 first, 2 last; ran dry at t2",
    "the extraction line says the rows pending or claimed, the thoughts not yet pooled and the rows failed: notes a first pass has not pooled are work to do, and rows that had failed before the arm are no reason to doubt it ran dry");
  const failedLine = ex([{ [OWN]: pool(100, 2, 0, 0) }, { [OWN]: pool(0, 0, 0, 12) }, { [OWN]: pool(0, 0, 0, 12) }]);
  ok(failedLine === "pending or claimed 102 first, 0 last, 102 most; not yet pooled 0 first, 0 last; failed 0 first, 12 last; nothing left to do at t1, but 12 more rows had failed than at the first sample: not every note was extracted" && !failedLine.includes("ran dry"),
    "a pool that emptied while its rows failed is not said to have run dry: the rows that failed since the first sample are counted");
  ok(ex([{ [OWN]: pool(5, 0, 0, 0), "extract:old@p1": pool(7, 0, 900, 3, false) }, { [OWN]: pool(0, 0, 0, 0), "extract:old@p1": pool(7, 0, 900, 3, false) }]) === "pending or claimed 5 first, 0 last, 5 most; not yet pooled 0 first, 0 last; failed 0 first, 0 last; ran dry at t1; an older key's rows pending or claimed, not in these: 7 first, 7 last",
    "an older key's leftover rows are said apart and keep no pool from running dry, nor are its unpooled thoughts or failed rows the brain's");
  ok(ex([{}, { "consolidate:x": pool(4, 0, 0, 0, null), "reembed:e": pool(9, 0, 0, 0) }]) === "no row under the brain's extraction key in any sample: its extraction has pooled nothing yet, so notes loaded on it are not counted"
    && ex([{ "extract:old@p1": pool(2, 1, 0, 0, false) }]).endsWith("are not counted; an older key's rows pending or claimed, not in these: 3 first, 3 last") && ex([]) === "-",
    "a brain with no row under its extraction key is said to be unread, not empty; another work's pools are not extraction's");
  ok(ex([{}, { [OWN]: pool(0, 0, 0, 0) }, { [OWN]: pool(0, 0, 0, 0) }]) === "pending or claimed 0 first, 0 last, 0 most; not yet pooled 0 first, 0 last; failed 0 first, 0 last; ran dry at t1; 1 of 3 samples had no row under the key yet"
    && ex([{ [OWN]: pool(0, 0, 0, 0) }, { [OWN]: pool(0, 0, 0, 0) }]).endsWith("failed 0 first, 0 last; nothing to do throughout") && ex([{ [OWN]: pool(3, 0, 0, 0) }, { [OWN]: pool(0, 0, 5, 0) }]).endsWith("not yet pooled 0 first, 5 last; failed 0 first, 0 last; never dry at the end"),
    "a sample from before the key had a row is counted and is no empty pool; a pool with nothing to do in any sample, and one with thoughts still to pool at the end, are each said");
  ok(ex([{ [OWN]: pool(1, 0, 0, 0), "extract:odd": pool(4, 0, 0, 0, null), "extract:old@p1": pool(3, 0, 0, 0, false) }, { [OWN]: pool(1, 0, 0, 0), "extract:odd": pool(2, 0, 0, 0, null) }]) === "pending or claimed 1 first, 1 last, 1 most; not yet pooled 0 first, 0 last; failed 0 first, 0 last; never dry at the end; an older key's rows pending or claimed, not in these: 7 first, 2 last",
    "only a key the brain says is its own is read as its own: one it says nothing of is another's, with one it says is not, and theirs are said first to last");
  ok(ex([{}, { [OWN]: pool(9, 0, 3, 1) }, { [OWN]: pool(2, 0, 0, 1) }]) === "pending or claimed 9 first, 2 last, 9 most; not yet pooled 3 first, 0 last; failed 1 first, 1 last; never dry at the end; 1 of 3 samples had no row under the key yet",
    "first and last are of the samples that had a row under the key: one from before it had any is no 0");
  const kept2 = poolsOf({ pools: [{ workType: OWN, pending: 4, claimed: 1, succeeded: 90, failed: 2, unpooled: 30, thoughts: 127, stale: 0, active: true }, { workType: "consolidate:x", pending: 0, claimed: 0, failed: 0, unpooled: 0, active: null }, { workType: "extract:old", pending: "7", claimed: -1, failed: null, active: "yes" }, { pending: 3 }, null, "x"] });
  ok(JSON.stringify(kept2) === JSON.stringify({ [OWN]: pool(4, 1, 30, 2), "consolidate:x": pool(0, 0, 0, 0, null), "extract:old": pool(0, 0, 0, 0, null) }) && poolsOf({}) === null && poolsOf({ pools: "x" }) === null && JSON.stringify(poolsOf({ pools: [] })) === "{}",
    "a sample keeps every pool worker_status names, an idle one too: its pending, claimed, failed and unpooled counts and whether the key is the brain's own; a count that is no count is 0, and an answer with no list of pools is kept as none");
  const aLine = sampleLine(iso(60), "A", iso(0), "b", info, { pools: [{ workType: OWN, pending: 4, claimed: 1, failed: 2, unpooled: 30, active: true }] });
  ok(Object.keys(aLine).join() === "t,arm,run,brain,tier,commit,provider,heartbeats,relay,children,childrenAt,backlog,pools" && aLine.t === iso(60) && aLine.arm === "A" && aLine.run === iso(0) && aLine.brain === "b" && aLine.tier === "canary"
    && JSON.stringify(aLine.backlog) === `{"${OWN}":5}` && JSON.stringify(aLine.pools) === JSON.stringify({ [OWN]: pool(4, 1, 30, 2) }) && samplesOf(JSON.stringify(aLine), "f").length === 1 && sampleLine(iso(0), "A", iso(0), "b", {}, {}).pools === null,
    "a brain's line of a round keeps its time, its arm, the run's start and the brain, what a sample keeps of brain_info, and the pools beside the rows an older summary read; it is a sample as the summary reads one");
  const poolArm = (pools: (Record<string, PoolKept> | undefined)[]) => safely(() => summaryLines(pools.map((p, k) => ({ t: iso(k * 60), arm: "E", brain: "b", backlog: { [OWN]: 9 }, heartbeats: [], ...(p === undefined ? {} : { pools: p }) })), 5, []));
  ok(poolArm([{ [OWN]: pool(1, 0, 0, 0) }, { [OWN]: pool(0, 0, 0, 0) }]).includes(`  ${"".padEnd(10)} extraction rows under the brain's own key: pending or claimed 1 first, 0 last, 1 most; not yet pooled 0 first, 0 last; failed 0 first, 0 last; ran dry at ${iso(60)}`)
    && poolArm([{ [OWN]: pool(1, 0, 0, 0) }, undefined]).includes(`  ${"".padEnd(10)} extraction rows pending or claimed: 9 first, 9 last, 9 most; never dry at the end`),
    "the summary reads the pools where every sample of the brain kept them, and the rows an older sample kept where one did not");

  // Two runs of one arm's name in one file; the live table's files; the model server's name and url; an answer of no shape.
  const twoRuns = safely(() => summaryLines([...armOf("P", 0, [0, 2, 4], [0, 30, 60]).map((l) => ({ ...l, run: iso(0) })), ...armOf("P", 3600, [100, 105, 110], [900, 1020, 1140]).map((l) => ({ ...l, run: iso(3600) })), ...armOf("P", 7200, [1, 2, 3], [1, 2, 3]), ...armOf("Q", 9000, [1, 2, 3], [1, 2, 3]).map((l) => ({ ...l, run: iso(9000) }))], 5, []));
  const heads = twoRuns.filter((l) => l.startsWith("\narm "));
  ok(heads.join("|") === [`\narm P (run 1 of 3 of that name in the file): ${iso(0)} to ${iso(120)} (2.0 min); windows: before 5 min, and after`, `\narm P (run 2 of 3 of that name in the file): ${iso(3600)} to ${iso(3720)} (2.0 min); windows: before 5 min, and after`,
    `\narm P (run 3 of 3 of that name in the file): ${iso(7200)} to ${iso(7320)} (2.0 min); windows: before 5 min, and after`, `\narm Q: ${iso(9000)} to ${iso(9120)} (2.0 min); windows: before 5 min, and after`].join("|")
    && twoRuns.filter((l) => l.trim().startsWith("b ") && l.includes(" before ")).map((l) => cells(l).slice(2, 6).join(" ")).join("|") === "120 4 60 0.50|120 10 240 2.00|120 2 2 0.02|120 2 2 0.02",
    "two runs of one arm's name appended to one file are a table each, their windows their own, and samples that name no run another: not one arm from the first's start to the last's end; an arm run once is headed by its name alone");
  const named = summaryLines([], 3, [[{ label: "same", kind: "search", ms: 10, ok: true }], [{ label: "same", kind: "search", ms: 900, ok: true }]], ["live-canary.jsonl", "live-scratch.jsonl"]);
  ok(named[named.length - 1] === "  --live: 1 live-canary.jsonl; 2 live-scratch.jsonl" && named.some((l) => l.endsWith("max ms  --live")) && !shared.some((l) => l.trim().startsWith("--live:")), "the live table's last column is the file's place among --live's, and the files are named under it where the summary knows their names");
  ok(MODEL_SERVER === "(ollama)" && throws(() => brainsOf('{"(ollama)":{"connector":"x"},"a":{}}'), /^--brains' file names a brain \(ollama\): the model server's samples carry that name, so give the brain another$/) && !throws(() => brainsOf('{"ollama":{}}'), /./),
    "a brain may not be named as the model server's samples are: the summary would drop it from its table and read its samples as the server's");
  ok(psUrl("http://127.0.0.1:11434") === "http://127.0.0.1:11434/api/ps" && psUrl("http://127.0.0.1:11434///") === "http://127.0.0.1:11434/api/ps" && psUrl("https://h/ollama/") === "https://h/ollama/api/ps" && psUrl("http://h:1/x?token=t#frag") === "http://h:1/x/api/ps?token=t"
    && psUrl("ftp://h/") === null && psUrl("127.0.0.1:11434") === null && psUrl("not a url") === null && psUrl("") === null,
    "the model server's url is --ollama's with /api/ps after its path, a query kept behind the path and not before it; what is no http or https url is none");
  ok(JSON.stringify(loadedOf({ models: [{ name: "b" }, { name: "a" }, {}, null] })) === '["?","?","a","b"]' && JSON.stringify(loadedOf({ models: [] })) === "[]" && loadedOf({}) === null && loadedOf(null) === null && loadedOf({ models: "a" }) === null && loadedOf("x") === null,
    "the loaded models are the names in the server's list, sorted; an answer with no list is no server with none loaded");
  const shapes = [{ result: null }, { result: { content: "text" } }, { result: { content: [null] } }, { result: { content: [], structuredContent: "x" } }, { result: { content: [], structuredContent: [1] } }, { result: { content: [], structuredContent: null } }].map((m) => readOf(200, { jsonrpc: "2.0", id: 1, ...m } as never, "brain_info"));
  ok(shapes.every((r) => !r.ok && r.error === WRONG_SHAPE && JSON.stringify(r.sc) === "{}") && !/TypeError|evaluating|not an object|not a function/.test(WRONG_SHAPE),
    "an answer whose result, content or structured content is not of the shape read is called so, in the harness's own words: never the error its reading threw");
  const good = readOf(200, { result: { content: [{ type: "text", text: "hi" }], structuredContent: { tier: "canary" } } }, "brain_info");
  const bare = readOf(200, { result: { content: [] } }, "delete_thought");
  const refusedShape = readOf(200, { result: { isError: true, content: [{ type: "text", text: "Refused: no" }], structuredContent: "x" } }, "fetch");
  const captured = readOf(200, { result: { content: [], structuredContent: { id: ID } } }, "capture_thought");
  ok(good.ok && good.sc.tier === "canary" && bare.ok && JSON.stringify(bare.sc) === "{}" && !refusedShape.ok && refusedShape.error === "Refused: no" && readOf(500, null, "fetch").error === "HTTP 500" && captured.ok && captured.id === ID,
    "an answer that reads is passed on as before: its structured content, none where it has none, a refusal's own words, a failed request's status, a capture's id");

  // The server's own words (render.ts), read as the harness reads them: a change to them fails here, not on a brain.
  const read = (reply: unknown, name: string) => outcomeOf(200, { jsonrpc: "2.0", id: 1, result: reply } as never, name);
  const goneDelete = read(renderDelete(refuse({ code: "NOT_FOUND", retryable: false, id: ID }) as never), "delete_thought");
  const goneFetch = read(renderFetch(refuse({ code: "NOT_FOUND", retryable: false, id: ID }) as never), "fetch");
  ok(!goneDelete.ok && ALREADY_GONE.test(goneDelete.error ?? "") && !goneFetch.ok && READ_GONE.test(goneFetch.error ?? "") && !READ_GONE.test(goneDelete.error ?? "") && !ALREADY_GONE.test(goneFetch.error ?? ""),
    "a thought that is gone is known by the server's own replies, built by its renderers: its delete's and its read's, each by its own pattern");
  const fetched = (metadata: Record<string, unknown>) => (renderFetch(okOutcome({ id: ID, title: "t", text: a0, url: "u", metadata, claimed: [], claimedMore: 0 } as never)) as { structuredContent?: { text?: unknown } }).structuredContent?.text;
  ok(fetched({}) === a0 && fetched({ trust: "ingested" }) === `${INGESTED_NOTICE}\n\n${a0}` && noteKind(String(fetched({ trust: "ingested" }))) === "note" && noteKind(String(fetched({}))) === "note",
    "a fetched note's text is its content, behind the notice and a blank line where the server marks it ingested: the form noteKind reads past");
  await cleanChecks(ok);
}

/** What a key without write scope is answered for a delete, as bench-live.ts's outcomeOf reads the server's JSON-RPC error. */
const NO_SCOPE = '{"code":-32602,"message":"Tool delete_thought not found"}';

/**
 * A brain of thoughts in memory, answering the guard's brain_info and clean's three tools as the server does (render.ts's
 * NOT_FOUND texts, a keyword search blind to case); `scope` false answers as a key without write scope. `deleteGone` is a
 * thought another caller deletes between its read and its delete; `searchFails` says which search calls fail, by their
 * count from 1.
 */
function fakeBrain(texts: Record<string, string>, scope = true, opts: { deleteLies?: string; deleteGone?: string; deleteGoneAll?: boolean; fetchFails?: string; fetchNoText?: string; searchFails?: (nth: number) => boolean; noTotal?: boolean; tier?: string; noTier?: boolean; infoFails?: boolean } = {}): { call: Call; held: Map<string, string>; deletes: string[]; searched: () => number } {
  const held = new Map(Object.entries(texts));
  const deletes: string[] = [];
  let searches = 0;
  const call: Call = async (name, args) => {
    const id = String(args.id ?? "");
    if (name === "brain_info") return opts.infoFails ? { ok: false, error: "HTTP 500", sc: {} } : { ok: true, sc: opts.noTier ? {} : { tier: opts.tier ?? "canary" } };
    if (name === "delete_thought") {
      deletes.push(id);
      if (!scope) return { ok: false, error: NO_SCOPE, sc: {} };
      if (id === opts.deleteGone || opts.deleteGoneAll) held.delete(id);
      if (!held.has(id)) return { ok: false, error: `No thought with id ${id}. It may already have been deleted`, sc: {} };
      if (id !== opts.deleteLies) held.delete(id);
      return { ok: true, sc: {} };
    }
    if (name === "fetch") {
      if (id === opts.fetchFails) return { ok: false, error: "HTTP 500", sc: {} };
      if (id === opts.fetchNoText) return { ok: true, sc: {} };
      return held.has(id) ? { ok: true, sc: { text: held.get(id) } } : { ok: false, error: `Fetch error: no thought with id ${id}`, sc: {} };
    }
    if (name === "search_thoughts_keyword") {
      if (opts.searchFails?.(++searches)) return { ok: false, error: "HTTP 500", sc: {} };
      const q = String(args.query).toLowerCase();
      const all = [...held].filter(([, t]) => t.toLowerCase().includes(q)).map(([i]) => ({ id: i }));
      const off = Number(args.offset ?? 0);
      return { ok: true, sc: { hits: all.slice(off, off + Number(args.limit)), ...(opts.noTotal ? {} : { total: all.length }) } };
    }
    return { ok: false, error: "unknown tool", sc: {} };
  };
  return { call, held, deletes, searched: () => searches };
}

/** clean's rows, against fakeBrain: async, so run after the pure rows. */
async function cleanChecks(ok: (pass: boolean, what: string) => void): Promise<void> {
  const notes = (arm: string, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${arm}-${i}`, notesFor(arm, i)]));
  const base = { ...notes("A", 3), ...notes("B", 2), q: `A record quoting one: ${notesFor("A", 0)}`, other: "an ordinary thought" };
  const keys = (b: { held: Map<string, string> }) => [...b.held.keys()].sort().join(",");
  let b = fakeBrain(base);
  let r = await cleanWith(b.call, ["A-0", "A-0", "gone-already"]);
  ok(r.left.size === 0 && keys(b) === "other,q" && r.deleted === 5 && r.found === 4 && r.absent === 1 && b.deletes.length === 5,
    "clean deletes the listed notes and every measure note found by content, each tried once: 5 deleted, 4 of them found, an id the brain does not hold counted apart, a quoting thought kept");
  b = fakeBrain(base);
  r = await cleanWith(b.call, ["other", "q", "A-0"]);
  ok(b.held.has("other") && b.held.has("q") && !b.deletes.includes("other") && !b.deletes.includes("q") && /no measure note's/.test(r.left.get("other") ?? "") && r.left.size === 2 && r.deleted === 5 && cleanLines("x", 3, r).code === 1,
    "a listed id whose text is no measure note's is read back, never deleted, and said (exit 1): a wrong --ids file deletes nothing else");
  b = fakeBrain(base);
  r = await cleanWith(b.call, ["A-0"], "A");
  ok(r.left.size === 0 && b.held.has("B-0") && b.held.has("B-1") && !b.held.has("A-2") && r.deleted === 3 && r.otherArm === 0, "with --arm, clean's search deletes that arm's notes alone");
  b = fakeBrain(base);
  r = await cleanWith(b.call, ["B-0", "A-0"], "A");
  ok(r.left.size === 0 && b.held.has("B-0") && r.otherArm === 1 && r.deleted === 3 && cleanLines("x", 2, r, "A").code === 0, "with --arm, a listed note of another arm is left and counted, not deleted under the arm's name");
  b = fakeBrain({ ...notes("A", 2), ...Object.fromEntries([0, 1].map((i) => [`low-${i}`, notesFor("a", i)])) });
  r = await cleanWith(b.call, [], "a");
  ok(keys(b) === "A-0,A-1" && r.found === 2 && r.left.size === 0 && r.otherArm === 0, "a search blind to case, as the server's is, hits arm A's notes for --arm a: the read-back leaves them, uncounted");

  // A text that starts as a note and is not the generator's (review pass 3): listed or found, it stays and is said.
  const heading = `${NOTE_PREFIX} (arm A #7). `;
  const own = { ...notes("A", 2), mine: `${heading}but these are a person's own words after the heading.`, grown: `${notesFor("A", 9)} And a line someone added.`, ing: `${INGESTED_NOTICE}\n\n${notesFor("A", 5)}` };
  b = fakeBrain(own);
  r = await cleanWith(b.call, ["mine"]);
  ok(keys(b) === "grown,mine" && !b.deletes.includes("mine") && !b.deletes.includes("grown") && r.deleted === 3 && /^starts as a measure note, but its text is not the harness's/.test(r.left.get("mine") ?? "") && r.left.get("grown") === r.left.get("mine") && r.left.size === 2 && cleanLines("x", 1, r).code === 1,
    "a thought that starts with a note's heading and goes on in other words, listed or found by content, is never deleted and is said (exit 1); a note behind the ingested notice goes");
  b = fakeBrain(own);
  r = await cleanWith(b.call, ["mine"], "B");
  ok(r.left.size === 1 && r.left.has("mine") && r.deleted === 0 && b.held.size === Object.keys(own).length, "a listed lookalike is said at its read-back, where the arm's search would never hit it");
  b = fakeBrain({ mine: own.mine }, true, { searchFails: (nth) => nth === 1 });
  r = await cleanWith(b.call, []);
  ok(r.left.size === 1 && /^starts as a measure note/.test(r.left.get("mine") ?? "") && b.deletes.length === 0, "a lookalike only the last search reaches is said there");

  b = fakeBrain(base, false);
  r = await cleanWith(b.call, ["A-0", "A-1"]);
  ok(r.left.size === 5 && b.held.size === Object.keys(base).length && r.deleted === 0 && r.absent === 0 && r.found === 0 && b.deletes.length === 5
    && [...r.left.values()].every((why) => why === `its delete failed: ${NO_SCOPE}`) && cleanLines("ro", 2, r).code === 1 && cleanLines("ro", 2, r).lines[0] === "ro: 0 measure notes deleted, 0 of them found by content; 2 ids listed, 0 not on the brain",
    "a key without write scope ('Tool delete_thought not found') deletes nothing, tries each note once and says each with that reason: none deleted, none found, none gone (exit 1)");
  b = fakeBrain(base, true, { deleteLies: "B-1" });
  r = await cleanWith(b.call, []);
  ok(r.left.get("B-1") === "still there after its delete" && r.left.size === 1 && r.found === 5 && b.deletes.length === 5, "a delete that answers but leaves the note is found by the last search");
  b = fakeBrain({ ...notes("A", 2) }, true, { deleteGone: "A-1" });
  r = await cleanWith(b.call, ["A-1"]);
  ok(r.deleted === 1 && r.absent === 1 && r.found === 1 && r.left.size === 0 && b.held.size === 0 && cleanLines("x", 1, r).code === 0, "a note another caller deletes between its read and its delete is counted not on the brain, not deleted (exit 0)");
  b = fakeBrain({ ...notes("A", 2) }, true, { deleteGone: "A-1" });
  r = await cleanWith(b.call, []);
  ok(r.deleted === 1 && r.found === 1 && r.absent === 1 && r.left.size === 0 && b.held.size === 0, "a found note gone by its delete is not on the brain, and no note found: found counts what a search found and clean deleted");
  b = fakeBrain(notes("G", 5100), true, { deleteGoneAll: true });
  r = await cleanWith(b.call, []);
  ok(r.left.size === 0 && r.absent === 5100 && r.deleted === 0 && b.held.size === 0, "the rounds go on while a round meets new notes, whatever their deletes answered: 5,100 notes all gone by their deletes leave none untried");
  b = fakeBrain(base, true, { fetchFails: "B-0" });
  r = await cleanWith(b.call, []);
  ok(/its read failed/.test(r.left.get("B-0") ?? "") && b.held.has("B-0"), "a note whose read fails is said, not skipped in silence");
  b = fakeBrain(base, true, { fetchFails: "other" });
  r = await cleanWith(b.call, ["other"]);
  ok(r.left.get("other") === "its read failed: HTTP 500" && b.held.has("other") && cleanLines("x", 1, r).code === 1, "a listed id whose read fails is said (exit 1), though no search finds it");
  b = fakeBrain(base, true, { fetchNoText: "A-0" });
  const noText = await cleanWith(b.call, ["A-0"]).catch(() => null);
  ok(noText !== null && noText.left.get("A-0") === "its read failed: no text" && b.held.has("A-0") && !b.deletes.includes("A-0"), "a read that answers no text deletes nothing");
  b = fakeBrain(base, true, { searchFails: () => true });
  r = await cleanWith(b.call, ["A-0"]);
  ok(r.deleted === 1 && /the search failed: HTTP 500/.test(r.left.get("(search at 0)") ?? "") && r.left.size === 1 && cleanLines("x", 1, r).code === 1, "a last search that fails is said (exit 1), the listed notes deleted all the same");
  b = fakeBrain(base, true, { searchFails: (nth) => nth === 1 });
  r = await cleanWith(b.call, ["A-0", "A-1", "A-2", "B-0", "B-1"]);
  ok(r.left.size === 0 && r.deleted === 5 && keys(b) === "other,q", "a round's search that fails is no reason of its own: the last search, reading a clean brain, is exit 0");
  b = fakeBrain(notes("E", 150), true, { searchFails: (nth) => nth === 2 });
  r = await cleanWith(b.call, []);
  ok(r.deleted === 100 && r.left.size === 50 && [...r.left.values()].every((why) => why === "found by the last search alone, not tried") && b.held.size === 50,
    "a search that fails at its second page keeps the first page's hits; the notes it did not reach are found by the last search and said, not tried");
  b = fakeBrain(base, true, { noTotal: true });
  r = await cleanWith(b.call, []);
  ok(r.left.size === 0 && keys(b) === "other,q", "a search that answers no total ends at a short page");
  const quotes = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`q${i}`, `A record quoting one: ${notesFor("C", i)}`]));
  b = fakeBrain({ ...quotes, ...notes("C", 30) });
  r = await cleanWith(b.call, []);
  ok(r.left.size === 0 && b.held.size === 120 && r.found === 30, "clean's search pages past 100 hits: 30 notes behind 120 thoughts quoting one found and deleted");
  b = fakeBrain(notes("D", 5100));
  r = await cleanWith(b.call, []);
  ok(r.left.size === 0 && b.held.size === 0 && r.found === 5100 && r.deleted === 5100, "more than 5,000 notes go in rounds, and the brain clean at the last search is exit 0");
  let asks = 0;
  const many: Call = async (name) => name === "search_thoughts_keyword"
    ? (asks++, { ok: true, sc: { hits: Array.from({ length: 100 }, (_, i) => ({ id: `quote-${i}` })), total: 1_000_000 } })
    : name === "fetch" ? { ok: true, sc: { text: "a thought quoting a note" } } : { ok: false, error: "unknown tool", sc: {} };
  r = await cleanWith(many, []);
  ok(r.left.get("(search)") === "the last search read 5,000 matches and stopped" && r.deleted === 0 && asks === 100, "a last search that stops at 5,000 matches is said: what lies past them was not read, fifty pages a search and no more");
  const said = (c: Cleaned, n: number, arm?: string) => cleanLines("canary", n, c, arm).lines;
  ok(said({ deleted: 5, absent: 1, found: 4, otherArm: 2, left: new Map() }, 3, "A").join("|") === "canary: 5 measure notes deleted (arm A), 4 of them found by content; 3 ids listed, 1 not on the brain, 2 another arm's notes and left"
    && said({ deleted: 2, absent: 0, found: 0, otherArm: 0, left: new Map() }, 2).join("|") === "canary: 2 measure notes deleted, 0 of them found by content; 2 ids listed, 0 not on the brain",
    "clean's line says what was deleted, how much of it a search found, what the brain did not hold and what was left to another arm, each apart; no arm and no other arm's are not said");
  ok(said({ deleted: 0, absent: 0, found: 0, otherArm: 0, left: new Map([["id-1", "its delete failed: X"], ["id-2", "its read failed: Y"]]) }, 2)[1] === "  NOT deleted, or not known to be: id-1 (its delete failed: X), id-2 (its read failed: Y)",
    "and each id left, with why, on a line of its own");
  // Review pass 5's rows.
  b = fakeBrain({ n0: notesFor("A", 0) }, true, { searchFails: (nth) => nth === 1, fetchFails: "n0" });
  r = await cleanWith(b.call, []);
  ok(r.left.get("n0") === "its read failed: HTTP 500" && r.left.size === 1 && cleanLines("x", 0, r).code === 1, "a note only the last search reaches, whose read fails, is said (exit 1)");
  b = fakeBrain(notes("H", 5000));
  r = await cleanWith(b.call, []);
  ok(r.left.size === 0 && r.deleted === 5000 && b.held.size === 0, "exactly 5,000 matches are read whole: the search stops short only where more follow");
  b = fakeBrain(Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, `A record quoting one: ${notesFor("K", i % 7)}`])));
  r = await cleanWith(b.call, []);
  ok(r.left.size === 0 && r.deleted === 0 && b.held.size === 5000, "and exactly 5,000 that are no notes leave nothing to doubt: the last search read them all");
  b = fakeBrain(base, true, { tier: "stable" });
  let refused = await cleanOn(b.call, "st", "", "A").then(() => "", (e) => (e as Error).message);
  ok(refused === "st: this brain's tier is not canary or working: load and clean write to a brain, so they run on no other" && b.deletes.length === 0 && b.searched() === 0 && b.held.size === Object.keys(base).length,
    "clean on a stable brain is refused before a search, a read or a delete, in the harness's own words");
  b = fakeBrain(base, true, { infoFails: true });
  refused = await cleanOn(b.call, "x", "").then(() => "", (e) => (e as Error).message);
  ok(refused === "x: brain_info failed (HTTP 500)" && b.deletes.length === 0 && b.searched() === 0, "and where the tier cannot be read");
  b = fakeBrain(base);
  const on = await cleanOn(b.call, "x", `not-an-id\n${KEYISH}\n`, "A").catch(() => null);
  ok(on !== null && on.code === 0 && on.lines.join("|") === "x: 3 measure notes deleted (arm A), 3 of them found by content; 0 ids listed and 2 lines that are no id, not sent, 0 not on the brain" && b.held.has("B-0") && b.held.has("B-1") && !b.deletes.includes(KEYISH),
    "clean on a canary passes its arm and its ids on: arm A's notes alone go, and a line that is no id is counted and sent nowhere");
  // Review pass 6's rows: the guard alone, and clean with ids a brain makes.
  const guard = (o: Parameters<typeof fakeBrain>[2]) => { const f = fakeBrain(base, true, o); return tierGuard(f.call, "g").then(() => "", (e) => (e as Error).message).then((said) => ({ said, f })); };
  const [onCanary, onStable, onNone, onDown] = [await guard({}), await guard({ tier: "stable" }), await guard({ noTier: true }), await guard({ infoFails: true })];
  ok(onCanary.said === "" && /tier is not canary or working/.test(onStable.said) && /tier is not canary or working/.test(onNone.said) && onDown.said === "g: brain_info failed (HTTP 500)" && [onStable, onNone, onDown].every((x) => x.f.deletes.length === 0 && x.f.searched() === 0),
    "the tier guard lets a canary through and refuses a stable brain, a brain that says no tier, and one that cannot be asked");
  const U = (n: number) => `0123abcd-0123-4abc-8def-${String(n).padStart(12, "0")}`;
  b = fakeBrain({ [U(1)]: "an ordinary thought", [U(2)]: notesFor("B", 0), [U(3)]: notesFor("A", 0) });
  const listedOn = await cleanOn(b.call, "x", `${U(1)}\n${U(2)}\n`, "A").catch(() => null);
  ok(listedOn !== null && listedOn.code === 1 && listedOn.lines[0] === "x: 1 measure notes deleted (arm A), 1 of them found by content; 2 ids listed, 0 not on the brain, 1 another arm's notes and left"
    && listedOn.lines[1] === `  NOT deleted, or not known to be: ${U(1)} (listed, but its text is no measure note's: not deleted)` && keys(b) === `${U(1)},${U(2)}`,
    "clean passes the listed ids on, and counts them: an ordinary thought listed is read back and said, another arm's note left and counted, the arm's own found and deleted");
}

/** Each subcommand's flags; any other given is refused, not ignored (review pass 1: summary --arm looked like a filter). */
export const TAKES: Record<string, readonly string[]> = {
  load: ["brains", "brain", "arm", "ids", "notes", "parallel"],
  sample: ["brains", "arm", "minutes", "every", "out", "ollama"],
  clean: ["brains", "brain", "ids", "arm"],
  summary: ["out", "split", "live"],
};

/** The flags given that the subcommand does not read. None for a name that is no subcommand, which main refuses: its own
 *  names alone, so `constructor` is none (Object.prototype's is a function, not a list). */
export function strayFlags(cmd: string | undefined, given: readonly string[]): string[] {
  return cmd !== undefined && Object.hasOwn(TAKES, cmd) ? given.filter((f) => !TAKES[cmd].includes(f)) : [];
}

async function main(): Promise<number> {
  const cli = commandLine("bench-brains.ts", {
    brains: "one", brain: "one", arm: "one", ids: "one", notes: "one", parallel: "one",
    minutes: "one", every: "one", out: "one", ollama: "one", split: "one", live: "repeated", "self-check": "none",
  }, {
    positionals: 1,
    hints: { brains: "<brains.json>", brain: "<name>", arm: "<arm>", ids: "<ids.txt>", notes: "<n>", parallel: "<n>", minutes: "<n>", every: "<seconds>", out: "<samples.jsonl>", ollama: "<http://127.0.0.1:11434>", split: "<minutes>", live: "<bench-live samples.jsonl>" },
    note: "load|sample|clean|summary first; --self-check alone",
  });
  const cmd = cli.positionals[0];
  const given = ["brains", "brain", "arm", "ids", "notes", "parallel", "minutes", "every", "out", "ollama", "split", "live", "self-check"].filter((f) => cli.has(f as "brains"));
  if (cli.has("self-check")) {
    if (cmd !== undefined || given.length > 1) { console.error("bench-brains.ts: --self-check takes no subcommand and no other flag"); return 2; }
    return selfCheck();
  }
  const stray = strayFlags(cmd, given);
  if (stray.length) { console.error(`bench-brains.ts ${cmd}: ${stray.map((f) => `--${f}`).join(", ")} ${stray.length > 1 ? "are" : "is"} not ${cmd}'s (it takes ${TAKES[cmd!].map((f) => `--${f}`).join(", ")})`); return 2; }
  const need = (...names: ("brains" | "brain" | "arm" | "ids" | "out")[]) => {
    const missing = names.filter((n) => !cli.value(n));
    if (missing.length) { console.error(`bench-brains.ts ${cmd}: give ${missing.map((n) => `--${n}`).join(", ")} (--help lists every flag)`); process.exit(2); }
  };
  const one = (name: string) => {
    const b = brainFrom(cli.value("brains")!, name);
    if (!b) { console.error("bench-brains.ts: --brain names no brain in --brains' file"); process.exit(2); }
    return b;
  };
  const arm = cli.value("arm");
  if (arm !== undefined && !/^[A-Za-z0-9-]+$/.test(arm)) { console.error("bench-brains.ts: --arm is letters, digits and -"); return 2; }
  switch (cmd) {
    case "load":
      need("brains", "brain", "arm", "ids");
      return load(one(cli.value("brain")!), arm!, cli.int("notes", { absent: 150, min: 1, max: 5000 }), cli.int("parallel", { absent: 2, min: 1, max: 8 }), cli.value("ids")!);
    case "sample":
      need("brains", "arm", "out");
      if (nothingToSample(Object.keys(entriesFrom(cli.value("brains")!)).length, cli.value("ollama"))) { console.error("bench-brains.ts sample: --brains' file names no brain, and no --ollama names a model server: nothing to sample"); return 2; }
      // Said before a round is sampled, not as a failed read of the model server in every one; the value typed is not printed.
      if (cli.value("ollama") && psUrl(cli.value("ollama")!) === null) { console.error("bench-brains.ts sample: --ollama is no http or https url"); return 2; }
      return sample(brainsFrom(cli.value("brains")!), arm!, cli.int("minutes", { absent: 20, min: 1, max: 600 }), cli.int("every", { absent: 15, min: 5, max: 600 }), cli.value("out")!, cli.value("ollama"));
    case "clean":
      need("brains", "brain", "ids");
      return clean(one(cli.value("brain")!), cli.value("ids")!, arm);
    case "summary":
      need("out");
      return summary(cli.value("out")!, cli.int("split", { absent: 12, min: 1, max: 600 }), cli.values("live"));
    default:
      console.error("bench-brains.ts: first say load, sample, clean or summary (--help lists every flag)");
      return 2;
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code), (e) => { console.error(`bench-brains.ts: ${(e as Error).message}`); process.exit(1); });
}
