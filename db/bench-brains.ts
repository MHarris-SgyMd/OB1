#!/usr/bin/env bun
/**
 * bench-brains.ts — two brains on one model server: what each one's background
 * work gets of its slots, arm by arm (SMD-3379 PR 3b-3b).
 *
 * The ticket's Verify on two brains: with both backlogged, neither brain's live
 * captures wait for a slot and their background work splits the background
 * slots; with one backlogged, it uses its share alone (fixed shares) or every
 * free slot (the broker). This harness makes the backlog, reads what each
 * brain's background work held while it ran, and cleans up after; bench-live.ts
 * times the live calls beside it.
 *
 *   bun db/bench-brains.ts load    --brains FILE --brain NAME --arm A --ids FILE [--notes 150] [--parallel 2]
 *   bun db/bench-brains.ts sample  --brains FILE --arm A --minutes 20 --out FILE [--every 15] [--ollama URL]
 *   bun db/bench-brains.ts clean   --brains FILE --brain NAME --ids FILE
 *   bun db/bench-brains.ts summary --out FILE [--split 12] [--live FILE …]
 *   bun db/bench-brains.ts --self-check
 *
 * --brains names each brain, by a JSON file:
 *   { "canary":  { "connector": "open-brain-canary" },                          ~/.claude.json's entry: its url and key
 *     "scratch": { "mcp": "http://127.0.0.1:18379/mcp", "keyFile": "/path/key" } a url and a file holding the key alone }
 * The key is never printed, nor a url's query (a ?key= url carries one).
 *
 * load    captures the arm's notes (notesFor: the same text for every brain,
 *         another for each arm, so no arm's capture is a re-capture of
 *         another's) with source smd3379-measure, `--parallel` at a time, and
 *         appends each id to --ids as it lands. Only a brain whose brain_info
 *         says tier canary or working (bench-live.ts's guard): stable is refused
 *         before anything is written.
 * sample  reads every brain's brain_info and worker_status each --every
 *         seconds for --minutes, and the model server's loaded models from
 *         Ollama's /api/ps when --ollama names it, appending one line per brain
 *         a round to --out. Reads alone, so any tier.
 * clean   deletes the ids in --ids, then searches the brain for measure notes
 *         whose ids never came back (a capture cut off can still land) and
 *         deletes those whose text is a measure note's from its first character.
 *         Exits 1 if one is left.
 * summary prints, for each arm and brain, what its sleep's heartbeat says its
 *         background calls held over the arm's two windows — before --split
 *         minutes (no live load from the harness) and after (bench-live
 *         running): the calls, their time, the mean number in flight (their
 *         time over the window's), and their slot waits. And whether its
 *         extraction backlog ran dry, the model server's loaded models, and
 *         each --live file's latencies (bench-live.ts's samples), by label.
 *
 * What the numbers are. A heartbeat's model tallies are since its worker
 * started, stamped about once a minute (db/pass-stamp.ts `models`), and a call
 * is counted when it ends: a window's figures are the difference between its
 * first and last stamps, over the time between them, and a call running across
 * a stamp counts in the stamp after. A worker that restarted in a window (a
 * tally going down) is said, and that window is not read. Stable's build may
 * stamp no tallies (before SMD-3379 PR 2b-2a): its sleep's state is shown.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandLine } from "./cli.ts";
import { answerTo, connectorOf, errorKind, keyFromFile, outcomeOf, percentile, shownUrl, tierRefusal } from "./bench-live.ts";
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
    try { return { name, mcp: e.mcp, key: keyFromFile(readKey(e.keyFile)) }; } catch (x) { throw new Error(`brain ${name}: ${(x as Error).message}`); }
  }
  throw new Error(`brain ${name}: give "connector" (a ~/.claude.json mcpServers name), or "mcp" and "keyFile"`);
}

function brainsFrom(path: string): Brain[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const claude = () => JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
  return Object.entries(raw).map(([name, entry]) => brainOf(name, entry, claude, (p) => readFileSync(p, "utf8")));
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

/** The arm's i-th note: the same text in every brain and on every run, about 700–900 characters. */
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

/** Whether a thought's text is a measure note, from its first character (an ingested thought's notice read past). */
export function isMeasureNote(text: string): boolean {
  const body = text.startsWith(`${INGESTED_NOTICE}\n\n`) ? text.slice(INGESTED_NOTICE.length + 2) : text;
  return /^SMD-3379 measure note \(arm [A-Za-z0-9-]+ #\d+\)\. /.test(body);
}

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
  const refusal = tierRefusal(info.tier);
  if (refusal) throw new Error(`${b.name}: ${refusal}`);
}

async function load(b: Brain, arm: string, n: number, parallel: number, ids: string): Promise<number> {
  const rpc = rpcFor(b);
  await writable(b, rpc);
  appendFileSync(ids, "");
  let next = 0, ok = 0, failed = 0;
  const t0 = performance.now();
  const worker = async () => {
    for (let i = next++; i < n; i = next++) {
      const r = await tool(b, rpc, "capture_thought", { content: notesFor(arm, i), source: NOTE_SOURCE }, CAPTURE_MS).catch((e) => ({ _ok: false, _error: (e as Error).message, _id: undefined }));
      if (typeof r._id === "string") appendFileSync(ids, r._id + "\n");
      if (r._ok) ok++;
      else { failed++; console.error(`  ${b.name} #${i}: ${r._error}`); }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  console.log(`${b.name}: arm ${arm}, ${ok} of ${n} notes captured (${failed} not) in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  return failed ? 1 : 0;
}

async function clean(b: Brain, ids: string): Promise<number> {
  const rpc = rpcFor(b);
  await writable(b, rpc);
  const listed = [...new Set(readFileSync(ids, "utf8").split("\n").map((s) => s.trim()).filter(Boolean))];
  const left: string[] = [];
  let gone = 0;
  const del = async (id: string) => {
    const r = await tool(b, rpc, "delete_thought", { id }).catch((e) => ({ _error: (e as Error).message }));
    if ((r as { _error?: string })._error && !/not found|no thought/i.test(String((r as { _error?: string })._error))) left.push(`${id} (${(r as { _error?: string })._error})`);
    else gone++;
  };
  for (const id of listed) await del(id);
  // Notes whose ids never came back: by content, read back, deleted only when their text is a measure note's.
  let found = 0;
  for (let round = 0; round < 20; round++) {
    const sc = await tool(b, rpc, "search_thoughts_keyword", { query: `${NOTE_PREFIX} (arm`, limit: 100 });
    const hits: string[] = (Array.isArray(sc.hits) ? sc.hits : []).map((h: { id?: unknown }) => h?.id).filter((id: unknown): id is string => typeof id === "string");
    let deleted = 0;
    for (const id of hits) {
      const f = await tool(b, rpc, "fetch", { id }).catch(() => null);
      if (typeof f?.text !== "string" || !isMeasureNote(f.text)) continue;
      found++; deleted++;
      await del(id);
    }
    if (deleted === 0) break;
  }
  console.log(`${b.name}: ${gone} measure notes deleted (${listed.length} listed, ${found} more found by content)`);
  if (left.length) { console.log(`  NOT deleted: ${left.join(", ")}`); return 1; }
  return 0;
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
  appendFileSync(out, "");
  const rpcs = new Map(brains.map((b) => [b.name, rpcFor(b)]));
  const end = Date.now() + minutes * 60_000;
  let stop = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stop = true; });
  console.log(`sampling arm ${arm}: ${brains.map((b) => `${b.name} (${shownUrl(b.mcp)})`).join(", ")} every ${everyS} s for ${minutes} min into ${out}`);
  while (!stop && Date.now() < end) {
    const t = new Date().toISOString();
    const round: Promise<Record<string, unknown>>[] = brains.map(async (b) => {
      const rpc = rpcs.get(b.name)!;
      try {
        const [info, status] = await Promise.all([tool(b, rpc, "brain_info", {}), tool(b, rpc, "worker_status", {})]);
        return { t, arm, brain: b.name, ...keptOf(info), backlog: backlogOf(status) };
      } catch (e) {
        return { t, arm, brain: b.name, error: (e as Error).message };
      }
    });
    if (ollama) {
      round.push((async () => {
        try {
          const r = await fetch(`${ollama.replace(/\/+$/, "")}/api/ps`, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
          const j = (await r.json()) as { models?: { name?: string }[] };
          return { t, arm, brain: "(ollama)", loaded: (j.models ?? []).map((m) => m.name ?? "?").sort() };
        } catch (e) {
          return { t, arm, brain: "(ollama)", error: errorKind(e) };
        }
      })());
    }
    for (const line of await Promise.all(round)) appendFileSync(out, JSON.stringify(line) + "\n");
    const wait = Math.min(everyS * 1000, end - Date.now());
    if (wait > 0 && !stop) await new Promise((r) => setTimeout(r, wait));
  }
  console.log(`sampled arm ${arm}${stop ? " (stopped early)" : ""}`);
  return 0;
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

/** A window's difference between its first and last stamps: null with fewer than two, "restarted" when a tally fell. */
export function windowOf(stamps: Stamp[]): { s: number; total: Tally; byPass: Record<string, Tally> } | null | "restarted" {
  if (stamps.length < 2) return null;
  const [a, z] = [stamps[0], stamps[stamps.length - 1]];
  const total: Tally = { calls: 0, callMs: 0, waited: 0, waitMs: 0 };
  const byPass: Record<string, Tally> = {};
  for (let k = 1; k < stamps.length; k++) {
    for (const [pass, t] of Object.entries(stamps[k].byPass)) {
      const p = stamps[k - 1].byPass[pass] ?? { calls: 0, callMs: 0, waited: 0, waitMs: 0 };
      if (t.calls < p.calls || t.callMs < p.callMs) return "restarted";
    }
  }
  for (const [pass, t] of Object.entries(z.byPass)) {
    const p = a.byPass[pass] ?? { calls: 0, callMs: 0, waited: 0, waitMs: 0 };
    const d = { calls: t.calls - p.calls, callMs: t.callMs - p.callMs, waited: t.waited - p.waited, waitMs: t.waitMs - p.waitMs };
    byPass[pass] = d;
    total.calls += d.calls; total.callMs += d.callMs; total.waited += d.waited; total.waitMs += d.waitMs;
  }
  return { s: (z.at - a.at) / 1000, total, byPass };
}

function summary(out: string, splitMin: number, live: readonly string[]): number {
  const lines = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
  const arms = [...new Set(lines.map((l) => l.arm as string))];
  for (const arm of arms) {
    const mine = lines.filter((l) => l.arm === arm);
    const t0 = Math.min(...mine.map((l) => Date.parse(l.t)));
    const t1 = Math.max(...mine.map((l) => Date.parse(l.t)));
    const split = t0 + splitMin * 60_000;
    console.log(`\narm ${arm}: ${new Date(t0).toISOString()} to ${new Date(t1).toISOString()} (${((t1 - t0) / 60_000).toFixed(1)} min); windows: before ${splitMin} min, and after`);
    console.log(`  brain      window    s      calls  call s   in flight  waited  wait s   by pass`);
    for (const brain of [...new Set(mine.map((l) => l.brain as string))].filter((b) => b !== "(ollama)")) {
      const rows = mine.filter((l) => l.brain === brain && !l.error);
      const stamps = new Map<number, Stamp>();
      for (const r of rows) {
        const hb = (r.heartbeats ?? []).find((h: { worker?: string }) => h.worker === "sleep");
        const by = talliesOf(hb?.models);
        if (hb?.at && by) stamps.set(Date.parse(hb.at), { at: Date.parse(hb.at), byPass: by });
      }
      const all = [...stamps.values()].sort((x, y) => x.at - y.at);
      for (const [name, lo, hi] of [["before", t0, split], ["after", split, t1 + 1]] as const) {
        const w = windowOf(all.filter((s) => s.at >= lo && s.at < hi));
        if (w === null || w === "restarted") {
          const sleeping = rows.filter((r) => Date.parse(r.t) >= lo && Date.parse(r.t) < hi);
          const working = sleeping.filter((r) => (r.heartbeats ?? []).some((h: Record<string, any>) => h.worker === "sleep" && h.running && h.slept && h.slept.to === null)).length;
          console.log(`  ${brain.padEnd(10)} ${name.padEnd(8)} ${w === "restarted" ? "a worker restarted in the window: not read" : `no model tallies stamped; sleep working in ${working} of ${sleeping.length} samples`}`);
          continue;
        }
        const f = (v: number, d = 0) => v.toFixed(d);
        const passes = Object.entries(w.byPass).filter(([, t]) => t.calls > 0).map(([p, t]) => `${p} ${t.calls}/${f(t.callMs / 1000)}s`).join(", ");
        console.log(`  ${brain.padEnd(10)} ${name.padEnd(8)} ${f(w.s).padStart(5)} ${String(w.total.calls).padStart(7)} ${f(w.total.callMs / 1000).padStart(7)} ${f(w.total.callMs / 1000 / Math.max(1, w.s), 2).padStart(10)} ${String(w.total.waited).padStart(7)} ${f(w.total.waitMs / 1000, 1).padStart(7)}   ${passes || "-"}`);
      }
      const dry = rows.filter((r) => !Object.keys(r.backlog ?? {}).some((k) => k.startsWith("extract:")));
      const sizes = rows.map((r) => Object.entries(r.backlog ?? {}).filter(([k]) => k.startsWith("extract:")).reduce((s, [, n]) => s + Number(n), 0));
      console.log(`  ${"".padEnd(10)} extraction backlog ${sizes.length ? `${Math.max(...sizes)} to ${Math.min(...sizes)}` : "-"}${dry.length ? `; none in ${dry.length} of ${rows.length} samples, from ${dry[0].t}` : ""}`);
    }
    const ol = mine.filter((l) => l.brain === "(ollama)" && Array.isArray(l.loaded));
    if (ol.length) {
      const sets = new Map<string, number>();
      let swaps = 0;
      ol.forEach((l, k) => { const s = l.loaded.join(" + ") || "(none)"; sets.set(s, (sets.get(s) ?? 0) + 1); if (k && s !== (ol[k - 1].loaded.join(" + ") || "(none)")) swaps++; });
      console.log(`  ollama: ${[...sets].map(([s, n]) => `${s} in ${n}`).join("; ")} of ${ol.length} samples; the loaded set changed ${swaps} times`);
    }
  }
  if (live.length) {
    console.log(`\nlive calls (bench-live.ts), of the ok calls:`);
    console.log(`  label                    kind       n   ok   p50 ms   p90 ms   max ms`);
    for (const file of live) {
      const s = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { label: string; kind: string; ms: number; ok: boolean });
      for (const label of [...new Set(s.map((x) => x.label))]) {
        for (const kind of ["search", "capture", "embed", "metadata"]) {
          const k = s.filter((x) => x.label === label && x.kind === kind);
          if (!k.length) continue;
          const ok = k.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b);
          const f = (v: number) => (Number.isNaN(v) ? "-" : Math.round(v).toString()).padStart(8);
          console.log(`  ${label.padEnd(24)} ${kind.padEnd(8)} ${String(k.length).padStart(4)} ${String(ok.length).padStart(4)} ${f(percentile(ok, 50))} ${f(percentile(ok, 90))} ${f(ok[ok.length - 1] ?? NaN)}`);
        }
      }
    }
  }
  return 0;
}

/** The pure parts, checked without a brain or a provider: what CI runs (--self-check). */
export function selfCheck(): number {
  const rows: [string, boolean][] = [];
  const ok = (pass: boolean, what: string) => rows.push([what, pass]);
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
  ok(JSON.stringify(backlogOf({ pools: [{ workType: "extract:m@p2", pending: 4, claimed: 1 }, { workType: "reembed:e", pending: 0, claimed: 0 }] })) === '{"extract:m@p2":5}', "the backlog is the pools with pending or claimed rows");

  const tl = talliesOf({ extract: { calls: { live: 0, background: 7 }, callMs: 1000, slotWaits: { waited: 2, totalMs: 30 } }, consolidate: {} });
  ok(JSON.stringify(tl) === '{"extract":{"calls":7,"callMs":1000,"waited":2,"waitMs":30},"consolidate":{"calls":0,"callMs":0,"waited":0,"waitMs":0}}' && talliesOf(null) === null, "a heartbeat's tallies by pass, background calls only; none without models");
  const st = (at: number, calls: number, callMs: number, pass = "extract") => ({ at, byPass: { [pass]: { calls, callMs, waited: 0, waitMs: 0 } } });
  const w = windowOf([st(0, 10, 10_000), st(60_000, 14, 70_000), st(120_000, 20, 250_000)]);
  ok(w !== null && w !== "restarted" && w.s === 120 && w.total.calls === 10 && w.total.callMs === 240_000 && w.total.callMs / 1000 / w.s === 2, "a window is its last stamp less its first: 10 calls, 240 s of calls over 120 s is 2 in flight");
  ok(windowOf([st(0, 10, 10_000)]) === null, "one stamp is no window");
  ok(windowOf([st(0, 10, 10_000), st(60_000, 2, 5_000), st(120_000, 6, 20_000)]) === "restarted", "a tally that falls inside the window says the worker restarted");
  const np = windowOf([st(0, 0, 0), { at: 60_000, byPass: { extract: { calls: 0, callMs: 0, waited: 0, waitMs: 0 }, consolidate: { calls: 3, callMs: 9_000, waited: 1, waitMs: 500 } } }]);
  ok(np !== null && np !== "restarted" && np.byPass.consolidate.calls === 3 && np.total.waited === 1, "a pass first stamped inside the window counts from zero");

  for (const [what, pass] of rows) console.log((pass ? "ok   " : "FAIL ") + what);
  return rows.every(([, p]) => p) ? 0 : 1;
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
  if (cli.has("self-check")) return selfCheck();
  const cmd = cli.positionals[0];
  const need = (...names: ("brains" | "brain" | "arm" | "ids" | "out")[]) => {
    const missing = names.filter((n) => !cli.value(n));
    if (missing.length) { console.error(`bench-brains.ts ${cmd}: give ${missing.map((n) => `--${n}`).join(", ")} (--help lists every flag)`); process.exit(2); }
  };
  const one = (name: string) => {
    const b = brainsFrom(cli.value("brains")!).find((x) => x.name === name);
    if (!b) { console.error(`bench-brains.ts: no brain ${JSON.stringify(name)} in ${cli.value("brains")}`); process.exit(2); }
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
      return clean(one(cli.value("brain")!), cli.value("ids")!);
    case "summary":
      need("out");
      return summary(cli.value("out")!, cli.int("split", { absent: 12, min: 0, max: 600 }), cli.values("live"));
    default:
      console.error("bench-brains.ts: first say load, sample, clean or summary (--help lists every flag)");
      return 2;
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code), (e) => { console.error(`bench-brains.ts: ${(e as Error).message}`); process.exit(1); });
}
