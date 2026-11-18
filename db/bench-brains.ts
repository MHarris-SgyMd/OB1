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
 * path typed, a file's text or a parser's words: a key put in the wrong place
 * (a key file as --brains, --ids or --out, a key as keyFile's path) is not said,
 * and load and sample append only to a file that is new or holds what they write.
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
 *         Ollama's /api/ps when --ollama names it, appending one line per brain
 *         a round to --out. Reads alone, so any tier. Exits 1 if a brain never
 *         answered a round, and 128 + the signal's number when one cut it short,
 *         whatever the brains answered; a second signal exits at once.
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
 *         it (delete it by its id, or name another arm). Only a canary or
 *         working brain, as load. A last search finds what is left, and it
 *         exits 1 if anything is, or a delete, a read or that search failed. Run it once load has ended: a capture
 *         still on its way lands after, for another run to find. The notes
 *         alone go: the entities extraction drew from them stay until an
 *         operator prunes the orphans, and the audit log keeps each text.
 * summary prints, for each arm and brain, what its sleep's heartbeat says the
 *         sleep's background calls held over the arm's two windows — before
 *         --split minutes (no live load from the harness) and after (bench-live
 *         running): the calls, their time, the mean number in flight (their
 *         time over the window's), and their slot waits, in all and by pass. And
 *         its extraction rows pending or claimed, first to last and when they
 *         ran dry, how many of its samples failed, the model server's loaded
 *         models, and each --live file's latencies (bench-live.ts's samples).
 *
 * What the numbers are. A heartbeat's model tallies are the sleep process's
 * since it began (db/pass-stamp.ts `models`), stamped at least once a minute by the
 * database's clock, and a call is counted when it ends: a window's figures are
 * the sum of the increases from stamp to stamp, over the time between its first
 * and last stamps, and a call running across a stamp counts in the stamp after.
 * So a window is shorter than its minutes by up to a stamp at each end, and the
 * pair of stamps across the split is in neither. A call's time runs from its
 * slot to its answer, failed or not: its wait inside the model server (a model
 * loading, a call ahead of it) is in it, its wait for a slot is not; a call that
 * ran without a slot (a type no share holds, the gate failing open) counts too. A tally is
 * a pass's, over every model and server it calls, so a brain's figure can pass
 * any one server's room; and it is the sleep's alone — board-sync's calls, the
 * api's vector mender's and a detached job's hold slots too and are not in it.
 * A pass's tally that falls, or a pass that drops out, is the process begun
 * again, and every pass's value is then the increase since (windowOf): the calls
 * the old process made after its last stamp are lost, and a restart whose first
 * stamp already passes the old one's on every tally is not seen. A sample keeps
 * the coordinator's children and its stamp's time, whose for_s says when. A
 * sleep that has made no model call stamps no tallies, nor does stable's build
 * before SMD-3379 PR 2b-2a: its sleep's state is shown. The extraction rows are
 * worker_status's pending and claimed under every extract: key — thoughts, the
 * probes' and any older backlog's among them, not failed rows, and none before
 * a brain's first extraction pass has pooled them.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandLine } from "./cli.ts";
import { answerTo, connectorOf, errorKind, fileProblem, jsonOf, keyFromFile, outcomeOf, percentile, shownUrl, textOf, tierRefusal } from "./bench-live.ts";
import { INGESTED_NOTICE } from "../server-portable/render.ts";

/** Every measure note starts with this, then `(arm <A> #<i>). `. */
export const NOTE_PREFIX = "SMD-3379 measure note";
/** The source every measure note is captured with. */
export const NOTE_SOURCE = "smd3379-measure";
/** The deadline of a call that makes no model call. */
const QUICK_MS = 30_000;
/** A capture's: its embedding, metadata and genre calls, behind a backlog's. */
const CAPTURE_MS = 300_000;

type Brain = { name: string; mcp: string; key: string };
type Answer = { status: number; msg: Record<string, any> | null };

/** A brain's url and key from its entry in --brains: a connector's, or a url beside a key file. */
export function brainOf(name: string, entry: unknown, claude: () => unknown, readKey: (path: string) => string): Brain {
  const e = (entry ?? {}) as { connector?: unknown; mcp?: unknown; keyFile?: unknown };
  if (typeof e.connector === "string" && e.connector !== "") {
    const c = connectorOf((claude() as { mcpServers?: Record<string, unknown> })?.mcpServers?.[e.connector], e.connector, typeof e.mcp === "string" ? e.mcp : undefined);
    return { name, ...c };
  }
  if (typeof e.mcp === "string" && e.mcp !== "" && typeof e.keyFile === "string" && e.keyFile !== "") {
    // The read apart from the key's reading: Node's words for a missing file quote the path, and a key written where the
    // path belongs was printed (review pass 4).
    const text = textOf(() => readKey(e.keyFile as string), `brain ${name}: its keyFile`);
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
  return raw as Record<string, unknown>;
}

/** Every brain --brains names. */
function brainsFrom(path: string): Brain[] {
  return Object.entries(brainsOf(textOf(() => readFileSync(path, "utf8"), BRAINS))).map(([name, entry]) => brainOf(name, entry, claudeJson, readKeyFile));
}

/** The one brain named, its entry alone resolved (another's broken entry does not block it); null when none is. */
function brainFrom(path: string, name: string): Brain | null {
  const raw = brainsOf(textOf(() => readFileSync(path, "utf8"), BRAINS));
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
 *  (ids a line; samples, each a JSON object) is another kind of file — a key file, which an appended line would break. */
export function appendProblem(kind: "ids" | "samples", text: string): string | null {
  if (kind === "ids") return idsOf(text).junk ? "--ids' file holds a line that is no thought id: load appends ids to it, and writes into no other kind of file" : null;
  return text.split("\n").some((l) => l.trim() !== "" && !l.trimStart().startsWith("{")) ? "--out's file holds a line that is no sample: sample appends to it, and writes into no other kind of file" : null;
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

/** A tool's structured answer, or a thrown error naming the brain, the tool and why (never the url's query). */
async function tool(b: Brain, rpc: ReturnType<typeof rpcFor>, name: string, args: Record<string, unknown>, ms = QUICK_MS): Promise<Record<string, any>> {
  let a: Answer;
  try { a = await rpc("tools/call", { name, arguments: args }, ms); } catch (e) { throw new Error(`${b.name}: ${name} got no answer from ${shownUrl(b.mcp)} (${errorKind(e)})`); }
  const o = outcomeOf(a.status, a.msg, name);
  if (!o.ok && name !== "capture_thought") throw new Error(`${b.name}: ${name} failed (${o.error})`);
  return { ...(a.msg?.result?.structuredContent ?? {}), _ok: o.ok, _error: o.error, _id: o.id };
}

async function writable(b: Brain, rpc: ReturnType<typeof rpcFor>): Promise<void> {
  const info = await tool(b, rpc, "brain_info", {});
  // The latency harness's rule, in this one's words: its own speak of probe captures.
  if (tierRefusal(info.tier)) throw new Error(`${b.name}: this brain's tier is not canary or working: load and clean write to a brain, so they run on no other`);
}

async function load(b: Brain, arm: string, n: number, parallel: number, ids: string): Promise<number> {
  const rpc = rpcFor(b);
  await writable(b, rpc);
  const problem = appendProblem("ids", existing(ids, "--ids' file"));
  if (problem) throw new Error(problem);
  append(ids, "", "--ids' file");
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

/** A tool call as clean reads it: its structured answer, or why not. Never throws. */
export type Call = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; sc: Record<string, any> }>;

/** What clean did: notes deleted, how many of those a search by content found, ids the brain does not hold (gone already, or never an id of its), listed notes of another arm left alone, and what is left, with why. */
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

async function clean(b: Brain, ids: string, arm: string | undefined): Promise<number> {
  const rpc = rpcFor(b);
  await writable(b, rpc);
  const { ids: listed, junk } = idsOf(textOf(() => readFileSync(ids, "utf8"), "--ids' file"));
  const call: Call = async (name, args) => {
    let a: Answer;
    try { a = await rpc("tools/call", { name, arguments: args }); } catch (e) { return { ok: false, error: `no answer from ${shownUrl(b.mcp)} (${errorKind(e)})`, sc: {} }; }
    const o = outcomeOf(a.status, a.msg, name);
    return { ok: o.ok, error: o.error, sc: a.msg?.result?.structuredContent ?? {} };
  };
  const { lines, code } = cleanLines(b.name, listed.length, await cleanWith(call, listed, arm), arm, junk);
  for (const line of lines) console.log(line);
  return code;
}

/** What a sample keeps of brain_info: each heartbeat's state and model tallies, the coordinator's relay mark. */
export function keptOf(info: Record<string, any>): Record<string, unknown> {
  const w = info?.database?.workers ?? {};
  return {
    tier: info?.tier ?? null,
    commit: info?.commit ?? null,
    provider: info?.provider?.status ?? null,
    heartbeats: (Array.isArray(w.heartbeats) ? w.heartbeats : []).map((h: Record<string, any>) => ({
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

async function sample(brains: Brain[], arm: string, minutes: number, everyS: number, out: string, ollama: string | undefined): Promise<number> {
  const problem = appendProblem("samples", existing(out, "--out's file"));
  if (problem) throw new Error(problem);
  append(out, "", "--out's file");
  const rpcs = new Map(brains.map((b) => [b.name, rpcFor(b)]));
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
        return { t, arm, brain: b.name, ...keptOf(info), backlog: backlogOf(status) };
      } catch (e) {
        return { t, arm, brain: b.name, error: (e as Error).message };
      }
    });
    if (ollama) {
      round.push((async () => {
        try {
          const r = await fetch(`${ollama.replace(/\/+$/, "")}/api/ps`, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
          if (!r.ok) return { t, arm, brain: "(ollama)", error: `HTTP ${r.status}` };
          const j = (await r.json()) as { models?: { name?: string }[] };
          return { t, arm, brain: "(ollama)", loaded: (j.models ?? []).map((m) => m.name ?? "?").sort() };
        } catch (e) {
          return { t, arm, brain: "(ollama)", error: errorKind(e) };
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

/** sample's exit code: 128 + the first signal's number when one cut it short, whatever the brains answered (so `sample && summary` stops there), else 1 when a brain never answered. */
export function sampleExit(signal: "SIGINT" | "SIGTERM" | null, silent: number): number {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : silent ? 1 : 0;
}

type Tally = { calls: number; callMs: number; waited: number; waitMs: number };
type Stamp = { at: number; byPass: Record<string, Tally> };

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
 * A window's increase over its stamps, stamp by stamp: null with fewer than two. The sleep's tallies count since its
 * process began, so a pair of stamps in which any pass's tally falls, or a pass drops out, is the process begun again:
 * every pass's value then is the increase since. Two restarts between one pair of stamps lose the calls before the second.
 */
export function windowOf(stamps: Stamp[]): { s: number; total: Tally; byPass: Record<string, Tally>; restarts: number } | null {
  if (stamps.length < 2) return null;
  const zero = (): Tally => ({ calls: 0, callMs: 0, waited: 0, waitMs: 0 });
  const fields = ["calls", "callMs", "waited", "waitMs"] as const;
  const total = zero();
  const byPass: Record<string, Tally> = {};
  let restarts = 0;
  for (let k = 1; k < stamps.length; k++) {
    const [prev, cur] = [stamps[k - 1].byPass, stamps[k].byPass];
    const restarted = Object.keys(prev).some((pass) => !(pass in cur) || fields.some((f) => cur[pass][f] < prev[pass][f]));
    if (restarted) restarts++;
    for (const [pass, t] of Object.entries(cur)) {
      const p = restarted ? zero() : prev[pass] ?? zero();
      const b = (byPass[pass] ??= zero());
      for (const f of fields) { b[f] += t[f] - p[f]; total[f] += t[f] - p[f]; }
    }
  }
  return { s: (stamps[stamps.length - 1].at - stamps[0].at) / 1000, total, byPass, restarts };
}

/** An arm's extraction backlog in sample order: first, last and most, and when it ran dry — the first empty sample after the last that was not, when the last is empty. */
export function backlogLine(sizes: readonly { t: string; n: number }[]): string {
  if (!sizes.length) return "-";
  const lastBusy = sizes.map((x) => x.n > 0).lastIndexOf(true);
  const dry = lastBusy < sizes.length - 1 ? sizes[lastBusy + 1].t : null;
  const most = Math.max(...sizes.map((x) => x.n));
  return `${sizes[0].n} first, ${sizes[sizes.length - 1].n} last, ${most} most${lastBusy === -1 ? "; empty throughout" : dry ? `; ran dry at ${dry}` : "; never dry at the end"}`;
}

/** One of bench-live.ts's samples. */
type Live = { label: string; kind: string; ms: number; ok: boolean };

/** What the table's columns are, printed under it: the reading no row can carry. */
export const LEGEND = "  s: from the window's first sleep stamp to its last. in flight: the sleep's call s over s; a call counts whole at the stamp after it ends, its wait inside the model server (a model loading, a call ahead of it) included, its wait for a slot not.\n" +
  "  by pass: calls/call s, and its slot waits. The brain's other background calls (board-sync's, the api's) are not in the table.";

/** summary's lines, from the samples' and each --live file's: pure, so the self-check holds the table's arithmetic. */
export function summaryLines(lines: readonly Record<string, any>[], splitMin: number, live: readonly (readonly Live[])[]): string[] {
  const out: string[] = [];
  const arms = [...new Set(lines.map((l) => l.arm as string))];
  for (const arm of arms) {
    const mine = lines.filter((l) => l.arm === arm);
    const t0 = Math.min(...mine.map((l) => Date.parse(l.t)));
    const t1 = Math.max(...mine.map((l) => Date.parse(l.t)));
    const split = t0 + splitMin * 60_000;
    out.push(`\narm ${arm}: ${new Date(t0).toISOString()} to ${new Date(t1).toISOString()} (${((t1 - t0) / 60_000).toFixed(1)} min); windows: before ${splitMin} min, and after`);
    out.push(`  brain      window    s      calls  call s   in flight  waited  wait s   by pass`);
    for (const brain of [...new Set(mine.map((l) => l.brain as string))].filter((b) => b !== "(ollama)")) {
      const asked = mine.filter((l) => l.brain === brain);
      const rows = asked.filter((l) => !l.error);
      // A sample that failed is no sample of the brain: said, never read as a sleep that stamped nothing.
      const unread = asked.length - rows.length;
      if (!rows.length) { out.push(`  ${brain.padEnd(10)} never answered in the arm: ${unread} of ${asked.length} samples failed`); continue; }
      const stamps = new Map<number, Stamp>();
      for (const r of rows) {
        const hb = (r.heartbeats ?? []).find((h: { worker?: string }) => h.worker === "sleep");
        const by = talliesOf(hb?.models);
        if (hb?.at && by) stamps.set(Date.parse(hb.at), { at: Date.parse(hb.at), byPass: by });
      }
      const all = [...stamps.values()].sort((x, y) => x.at - y.at);
      for (const [name, lo, hi] of [["before", t0, split], ["after", split, t1 + 1]] as const) {
        const inWindow = all.filter((s) => s.at >= lo && s.at < hi);
        const w = windowOf(inWindow);
        if (w === null) {
          const sleeping = rows.filter((r) => Date.parse(r.t) >= lo && Date.parse(r.t) < hi);
          if (!sleeping.length && !inWindow.length) {
            const unanswered = asked.filter((l) => l.error && Date.parse(l.t) >= lo && Date.parse(l.t) < hi).length;
            out.push(`  ${brain.padEnd(10)} ${name.padEnd(8)} ${unanswered ? `none of its ${unanswered} samples ${name} the split answered` : `no sample of it ${name} the split`}`);
            continue;
          }
          const working = sleeping.filter((r) => (r.heartbeats ?? []).some((h: Record<string, any>) => h.worker === "sleep" && h.running && h.slept && h.slept.to === null)).length;
          const why = all.length === 0 ? "no model tallies stamped in the arm (a build before SMD-3379 PR 2b-2a, no sleep, or a sleep that had made no model call)" : `${inWindow.length} sleep stamp(s) in the window, fewer than two`;
          out.push(`  ${brain.padEnd(10)} ${name.padEnd(8)} ${why}; sleep working in ${working} of ${sleeping.length} samples`);
          continue;
        }
        const f = (v: number, d = 0) => v.toFixed(d);
        const passes = Object.entries(w.byPass).filter(([, t]) => t.calls > 0 || t.waited > 0)
          .map(([p, t]) => `${p} ${t.calls}/${f(t.callMs / 1000)}s${t.waited ? ` (${t.waited} waited ${f(t.waitMs / 1000)}s)` : ""}`).join(", ");
        out.push(`  ${brain.padEnd(10)} ${name.padEnd(8)} ${f(w.s).padStart(5)} ${String(w.total.calls).padStart(7)} ${f(w.total.callMs / 1000).padStart(7)} ${f(w.total.callMs / 1000 / Math.max(1, w.s), 2).padStart(10)} ${String(w.total.waited).padStart(7)} ${f(w.total.waitMs / 1000, 1).padStart(7)}   ${passes || "-"}${w.restarts ? ` (the sleep begun again ${w.restarts} time(s))` : ""}`);
      }
      const sizes = rows.map((r) => ({ t: r.t as string, n: Object.entries(r.backlog ?? {}).filter(([k]) => k.startsWith("extract:")).reduce((s, [, n]) => s + Number(n), 0) }));
      out.push(`  ${"".padEnd(10)} extraction rows pending or claimed: ${backlogLine(sizes)}${unread ? `; ${unread} of ${asked.length} samples failed` : ""}`);
    }
    const olAsked = mine.filter((l) => l.brain === "(ollama)");
    const ol = olAsked.filter((l) => Array.isArray(l.loaded));
    if (olAsked.length && !ol.length) out.push(`  ollama: never answered in the arm: ${olAsked.length} of ${olAsked.length} samples failed`);
    if (ol.length) {
      const sets = new Map<string, number>();
      let swaps = 0;
      ol.forEach((l, k) => { const s = l.loaded.join(" + ") || "(none)"; sets.set(s, (sets.get(s) ?? 0) + 1); if (k && s !== (ol[k - 1].loaded.join(" + ") || "(none)")) swaps++; });
      out.push(`  ollama: ${[...sets].map(([s, n]) => `${s} in ${n}`).join("; ")} of ${ol.length} samples; the loaded set differed from the sample before ${swaps} times${olAsked.length > ol.length ? `; ${olAsked.length - ol.length} more failed` : ""}`);
    }
  }
  if (arms.length) out.push("", LEGEND);
  if (live.length) {
    out.push(`\nlive calls (bench-live.ts), of the ok calls:`);
    out.push(`  label                    kind       n   ok   p50 ms   p90 ms   max ms`);
    for (const s of live) {
      for (const label of [...new Set(s.map((x) => x.label))]) {
        for (const kind of ["search", "capture", "embed", "metadata"]) {
          const k = s.filter((x) => x.label === label && x.kind === kind);
          if (!k.length) continue;
          const ok = k.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b);
          const f = (v: number) => (Number.isNaN(v) ? "-" : Math.round(v).toString()).padStart(8);
          out.push(`  ${label.padEnd(24)} ${kind.padEnd(8)} ${String(k.length).padStart(4)} ${String(ok.length).padStart(4)} ${f(percentile(ok, 50))} ${f(percentile(ok, 90))} ${f(ok[ok.length - 1] ?? NaN)}`);
        }
      }
    }
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

/** sample's --out as samples: each a time, an arm and a brain. */
export function samplesOf(text: string, what: string): Record<string, any>[] {
  return linesOf(text, what, (v) => typeof v.t === "string" && !Number.isNaN(Date.parse(v.t)) && typeof v.arm === "string" && typeof v.brain === "string", "sample");
}

/** A --live file as bench-live.ts's samples: each a label, a kind, its milliseconds and whether it was ok. */
export function liveOf(text: string, what: string): Live[] {
  return linesOf(text, what, (v) => typeof v.label === "string" && typeof v.kind === "string" && typeof v.ms === "number" && typeof v.ok === "boolean", "bench-live.ts sample") as Live[];
}

function summary(out: string, splitMin: number, live: readonly string[]): number {
  const lines = samplesOf(textOf(() => readFileSync(out, "utf8"), "--out's file"), "--out's file");
  if (!lines.length) console.error("bench-brains.ts summary: --out's file holds no samples");
  const lives = live.map((file, k) => liveOf(textOf(() => readFileSync(file, "utf8"), `--live's file ${k + 1}`), `--live's file ${k + 1}`));
  for (const line of summaryLines(lines, splitMin, lives)) console.log(line);
  return lines.length ? 0 : 1;
}

/** The pure parts, and clean against a brain in memory, checked without a brain or a provider: what CI runs (--self-check). */
export async function selfCheck(): Promise<number> {
  const rows: [string, boolean][] = [];
  const ok = (pass: boolean, what: string) => rows.push([what, pass]);
  const finish = () => { for (const [what, pass] of rows) console.log((pass ? "ok   " : "FAIL ") + what); return rows.every(([, p]) => p) ? 0 : 1; };
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
  ok(!throws(() => brainOf("s", { mcp: "http://h/mcp", keyFile: "/k" }, claude, () => "k"), /./) && throws(() => brainOf("x", { connector: "missing" }, claude, () => ""), /has no key/), "a connector ~/.claude.json lacks is refused by bench-live's rule");

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

  // summary's table (no row reached it), from fourteen rounds of samples built here, two a stamp: a canary whose sleep
  // works, a brain with one stamp and a failed sample, a brain that never answers, the model server's loaded models.
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
  const KEYISH = "abcdef0123456789abcdef0123456789";
  ok(throws(() => brainsOf(`${KEYISH}\n`), /^--brains' file is not JSON$/) && throws(() => brainsOf("[]"), /^--brains' file holds no JSON object of brains$/) && throws(() => brainsOf('"k"'), /holds no JSON object/) && throws(() => brainsOf("null"), /holds no JSON object/) && throws(() => brainsOf("7"), /holds no JSON object/) && Object.keys(brainsOf('{"a":{}}')).join() === "a",
    "a brains file that is not JSON is named by its flag and nothing of it printed (a key file given as --brains); it is a JSON object, no array, string, number or null");

  // Review pass 4's rows: a refusal names a flag or a brain and a code, never a path, a parser's words or a line's text.
  const noFile = () => { throw Object.assign(new Error(`ENOENT: no such file or directory, open '${KEYISH}'`), { code: "ENOENT" }); };
  ok(throws(() => brainOf("s", { mcp: "http://h/mcp", keyFile: KEYISH }, claude, noFile), /^brain s: its keyFile could not be read \(ENOENT\)$/), "a key written where keyFile's path belongs is not printed: the brain is named, and the file system's code");
  const ID = "0123abcd-0123-4abc-8def-0123456789ab";
  const listedIds = idsOf(`${ID}\n\n  ${ID.toUpperCase()}  \r\n${ID}\nnot-a-uuid\n${KEYISH}\nhttp://h/mcp?key=${KEYISH}\n`);
  ok(JSON.stringify(listedIds.ids) === JSON.stringify([ID, ID.toUpperCase()]) && listedIds.junk === 3 && idsOf(`x${ID}\n${ID}x\n`).ids.length === 0 && idsOf(`x${ID}\n${ID}x\n`).junk === 2 && idsOf("").ids.length === 0 && idsOf("\n\n").junk === 0, "an ids file's ids are its lines that are thought ids, each once, spaces and blank lines aside; the others are counted, to be sent nowhere");
  ok(appendProblem("ids", "") === null && appendProblem("ids", `${ID}\n${ID}\n`) === null && /is no thought id/.test(appendProblem("ids", `${KEYISH}\n`) ?? "") && !(appendProblem("ids", `${KEYISH}\n`) ?? "").includes(KEYISH), "load appends ids to an empty file or one of ids alone, never to another kind of file (a key file), and says none of it");
  ok(appendProblem("samples", "") === null && appendProblem("samples", '{"t":"x"}\n\n{"t":"y"}\n') === null && /is no sample/.test(appendProblem("samples", `${KEYISH}\n`) ?? "") && /is no sample/.test(appendProblem("samples", `{"t":"x"}\n${KEYISH}\n`) ?? "") && !(appendProblem("samples", `${KEYISH}\n`) ?? "").includes(KEYISH), "sample appends to an empty file or one of JSON objects alone, likewise");
  const sample1 = `{"t":"${iso(0)}","arm":"X","brain":"b"}`;
  ok(!throws(() => samplesOf(`${sample1}\n\n${sample1}\n`, "f"), /./) && samplesOf(`${sample1}\n\n${sample1}\n`, "--out's file").length === 2 && throws(() => samplesOf(`{"t":"${iso(0)}","arm":"X"}\n`, "f"), /^f line 1 is no sample$/) && throws(() => samplesOf(`${sample1}\n\n${KEYISH}\n`, "--out's file"), /^--out's file line 3 is not JSON$/) && throws(() => samplesOf(`${sample1}\n12345\n`, "f"), /^f line 2 is no sample$/) && throws(() => samplesOf('"k"\n', "f"), /^f line 1 is no sample$/) && throws(() => samplesOf('{"t":"never","arm":"X","brain":"b"}\n', "f"), /^f line 1 is no sample$/) && samplesOf("", "f").length === 0,
    "a samples file's line that is not JSON, or no sample (a time, an arm, a brain), is named by flag and by the file's own line number, its text unsaid");
  ok(!throws(() => liveOf('{"label":"l","kind":"search","ms":5,"ok":true}\n', "f"), /./) && liveOf('{"label":"l","kind":"search","ms":5,"ok":true}\n', "f").length === 1 &&throws(() => liveOf("12345\n", "--live's file 1"), /^--live's file 1 line 1 is no bench-live\.ts sample$/) && throws(() => liveOf(`${KEYISH}\n`, "f"), /^f line 1 is not JSON$/), "a --live file's lines likewise");
  ok(cleanLines("x", 2, { deleted: 2, absent: 0, found: 0, otherArm: 0, left: new Map() }, undefined, 3).lines[0] === "x: 2 measure notes deleted, 0 of them found by content; 2 ids listed and 3 lines that are no id, not sent, 0 not on the brain", "clean's line counts the listed lines that were no id, sent nowhere");
  ok(new Bun.CryptoHasher("sha256").update(`${notesFor("A", 0)}\n${notesFor("fixed-2", 4999)}`).digest("hex").slice(0, 16) === "fb472cdb73cb2be9",
    "the generator's text is pinned: clean deletes by it, so a note it wrote before an edit to its words would read as a lookalike and stay");
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
  ok(cells(lt.find((l) => l.includes(" search ")) ?? "").join(" ") === `rv search 20 18 ${Math.round(percentile(okMs, 50))} ${Math.round(percentile(okMs, 90))} 180` && percentile(okMs, 50) !== percentile(okMs, 90) && lt.some((l) => l.includes(" metadata ")) && !lt.includes(LEGEND),
    "the live table counts every call and reads its percentiles and its longest from the ok calls alone, a kind a row");
  ok(brief.some((l) => l === `  ${"canary".padEnd(10)} after    no sample of it after the split`) && brief.filter((l) => l.trim().startsWith("canary") && l.includes(" after ")).length === 1, "a window the arm never reached says so, not a count of none beside it");
  ok(!lt.some((l) => l.includes(" capture ") || l.includes(" embed ")), "a kind with no call has no row");
  await cleanChecks(ok);
  return finish();
}

/** What a key without write scope is answered for a delete, as bench-live.ts's outcomeOf reads the server's JSON-RPC error. */
const NO_SCOPE = '{"code":-32602,"message":"Tool delete_thought not found"}';

/**
 * A brain of thoughts in memory, answering clean's three tools as the server does (render.ts's NOT_FOUND texts, a keyword
 * search blind to case); `scope` false answers as a key without write scope. `deleteGone` is a thought another caller
 * deletes between its read and its delete; `searchFails` says which search calls fail, by their count from 1.
 */
function fakeBrain(texts: Record<string, string>, scope = true, opts: { deleteLies?: string; deleteGone?: string; deleteGoneAll?: boolean; fetchFails?: string; fetchNoText?: string; searchFails?: (nth: number) => boolean; noTotal?: boolean } = {}): { call: Call; held: Map<string, string>; deletes: string[] } {
  const held = new Map(Object.entries(texts));
  const deletes: string[] = [];
  let searches = 0;
  const call: Call = async (name, args) => {
    const id = String(args.id ?? "");
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
  return { call, held, deletes };
}

/** clean's rows, against fakeBrain: async, so run after the pure rows. */
export async function cleanChecks(ok: (pass: boolean, what: string) => void): Promise<void> {
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
  const many: Call = async (name) => name === "search_thoughts_keyword"
    ? { ok: true, sc: { hits: Array.from({ length: 100 }, (_, i) => ({ id: `quote-${i}` })), total: 1_000_000 } }
    : name === "fetch" ? { ok: true, sc: { text: "a thought quoting a note" } } : { ok: false, error: "unknown tool", sc: {} };
  r = await cleanWith(many, []);
  ok(r.left.get("(search)") === "the last search read 5,000 matches and stopped" && r.deleted === 0, "a last search that stops at 5,000 matches is said: what lies past them was not read");
  const said = (c: Cleaned, n: number, arm?: string) => cleanLines("canary", n, c, arm).lines;
  ok(said({ deleted: 5, absent: 1, found: 4, otherArm: 2, left: new Map() }, 3, "A").join("|") === "canary: 5 measure notes deleted (arm A), 4 of them found by content; 3 ids listed, 1 not on the brain, 2 another arm's notes and left"
    && said({ deleted: 2, absent: 0, found: 0, otherArm: 0, left: new Map() }, 2).join("|") === "canary: 2 measure notes deleted, 0 of them found by content; 2 ids listed, 0 not on the brain",
    "clean's line says what was deleted, how much of it a search found, what the brain did not hold and what was left to another arm, each apart; no arm and no other arm's are not said");
  ok(said({ deleted: 0, absent: 0, found: 0, otherArm: 0, left: new Map([["id-1", "its delete failed: X"], ["id-2", "its read failed: Y"]]) }, 2)[1] === "  NOT deleted, or not known to be: id-1 (its delete failed: X), id-2 (its read failed: Y)",
    "and each id left, with why, on a line of its own");
}

/** Each subcommand's flags; any other given is refused, not ignored (review pass 1: summary --arm looked like a filter). */
export const TAKES: Record<string, readonly string[]> = {
  load: ["brains", "brain", "arm", "ids", "notes", "parallel"],
  sample: ["brains", "arm", "minutes", "every", "out", "ollama"],
  clean: ["brains", "brain", "ids", "arm"],
  summary: ["out", "split", "live"],
};

/** The flags given that the subcommand does not read. None for a name that is no subcommand, which main refuses: its own names alone, so `constructor` is none (Object.prototype's is a function, not a list). */
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
