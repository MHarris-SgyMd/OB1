#!/usr/bin/env bun
/**
 * eval-jev-coload.ts — the typed-decision tier beside the embedder and the
 * metadata model: does either evict or slow the other? (SMD-2050's second
 * slice; the SMD-2000 memory question, for this tier.)
 *
 * The tier is its own process (jev/serve.ts, onnxruntime) and Ollama's
 * scheduler neither counts nor evicts it — OLLAMA_MAX_LOADED_MODELS governs
 * Ollama's own models only. What can still happen: the box runs short of
 * memory, and the OS pages or Ollama unloads; or the three compete for the
 * CPU and GPU and each call slows. So this measures, on the box it runs on:
 *
 *   1. before: Ollama's loaded models (/api/ps), its model runners (the
 *      llama-server processes: pid and start time), its own OLLAMA_* settings
 *      (read from its process, not this shell), the tier's memory footprint
 *      (macOS `footprint`, which counts the compressed pages `ps` leaves out),
 *      the box's free memory;
 *   2. alone: N embeddings, N/3 short chat completions, N decisions, each
 *      serial, each on its own — p50 and p95;
 *   3. together: the three loops at once, each running to one shared deadline
 *      so the three overlap for the whole phase;
 *   4. after: the same — a runner that is gone, or new, or started since, is an
 *      unload or a reload that a name comparison of /api/ps would not see
 *      (the loops themselves reload a model the moment it is evicted).
 *
 * What it does not test, said by the run too: no model load is requested, and
 * no memory pressure is applied. Ollama evicts on a load request; a tier that
 * is not an Ollama model never makes one. So this shows the tier does not by
 * itself cause an eviction, and what it costs in contention — not what a box
 * short of memory would do.
 *
 *   bun eval-jev-coload.ts [--n 30] [--jev-pid <pid>]
 *
 * The provider is OB1_LLM_BASE_URL (its /v1 stripped for /api/ps), the models
 * OB1_EMBEDDING_MODEL and OB1_METADATA_MODEL, the tier OB1_JEV_BASE_URL with
 * OB1_JEV_LOCAL=1. The texts are fixed and carry nothing from any brain. The
 * warm-up loads either Ollama model that is not loaded — the one load the run
 * can make, with the tier already up — so /api/ps and the runners are read
 * before it too, and a warm-up that loaded or evicted anything says so. Run it
 * where that is acceptable: on the dogfood Mac it shares Ollama with the brain.
 */

import { loadEnv } from "./env.ts";
import { jevDecide, resolveJevConfig, type JevEnv } from "../server-portable/jev.ts";

loadEnv();
const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const n = Number(arg("--n") ?? 30);
const jevPid = arg("--jev-pid");
const env = process.env;
const base = (env.OB1_LLM_BASE_URL ?? "http://127.0.0.1:11434/v1").replace(/\/+$/, "");
const ollama = base.replace(/\/v1$/, "");
const embedModel = env.OB1_EMBEDDING_MODEL ?? "qwen3-embedding:4b";
const chatModel = env.OB1_METADATA_MODEL ?? "qwen2.5:7b";
const cfg = resolveJevConfig(env as JevEnv);
if (!cfg || !Number.isInteger(n) || n < 1) {
  console.error("usage: OB1_JEV_BASE_URL=… OB1_JEV_LOCAL=1 bun eval-jev-coload.ts [--n 30] [--jev-pid <pid>]");
  process.exit(2);
}

type Loaded = { name: string; size: number; size_vram: number; expires_at: string };
const ps = async (): Promise<Loaded[]> => ((await (await fetch(`${ollama}/api/ps`)).json()) as { models: Loaded[] }).models ?? [];
const gb = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`;
/** The tier's memory: macOS `footprint` (compressed pages included), else ps's resident set, labelled which. */
async function tierMemory(pid: string | undefined): Promise<string> {
  if (!pid) return "—";
  const fp = await Bun.$`footprint -p ${pid}`.nothrow().quiet().text();
  const m = /Footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(fp);
  if (m) return `${Math.round(Number(m[1]) * (m[2] === "GB" ? 1024 : m[2] === "KB" ? 1 / 1024 : 1))} MB footprint`;
  const rss = (await Bun.$`ps -o rss= -p ${pid}`.nothrow().quiet().text()).trim();
  return rss ? `${Math.round(Number(rss) / 1024)} MB rss (excludes compressed pages)` : "—";
}
/** Ollama's model runners, as "pid start-time", so an unload or a reload between two snapshots shows. */
async function runners(): Promise<string[]> {
  const out = await Bun.$`ps -A -o pid=,lstart=,command=`.nothrow().quiet().text();
  return out.split("\n").filter((l) => /llama-server|ollama runner/.test(l)).map((l) => l.trim().replace(/\s+\/.*$/, "").replace(/\s+/g, " ")).sort();
}
/**
 * Ollama's own OLLAMA_* settings, from `ollama serve`'s environment — the eval's
 * own shell says nothing about them. `ps eww` shows another user's process
 * without its environment (Linux's systemd `ollama` user, a root Ollama), so no
 * variables past the command line reads as unreadable, not as the defaults.
 * A value with a space in it is cut at the space.
 */
async function ollamaSettings(): Promise<string> {
  const pid = (await Bun.$`pgrep -xf ${"^\\S*ollama serve$"}`.nothrow().quiet().text()).trim().split("\n")[0];
  if (!pid) return "unknown (no `ollama serve` process on this box)";
  const words = (await Bun.$`ps eww -o command= -p ${pid}`.nothrow().quiet().text()).trim().split(/\s+/);
  const vars = words.filter((w) => /^OLLAMA_[A-Z_]+=/.test(w));
  if (vars.length) return vars.join(" ");
  return words.slice(2).some((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ? "none set (Ollama's defaults)" : "unreadable (its environment is not shown to this user)";
}
/** Free memory as the OS reports it: pages free + inactive (macOS vm_stat), else /proc/meminfo's MemAvailable. */
async function freeMemory(): Promise<string> {
  const vm = await Bun.$`vm_stat`.nothrow().text();
  if (vm) {
    const page = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 16384);
    const pages = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0);
    return gb((pages("Pages free") + pages("Pages inactive")) * page);
  }
  const mi = await Bun.file("/proc/meminfo").text().catch(() => "");
  const kb = Number(/MemAvailable:\s+(\d+)/.exec(mi)?.[1] ?? 0);
  return kb ? gb(kb * 1024) : "unknown";
}

const TEXT = "The worker claims a batch of rows, embeds each one, and writes the vector back under the lease.";
const embedOnce = async () => {
  const r = await fetch(`${base}/embeddings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: embedModel, input: TEXT }) });
  if (!r.ok) throw new Error(`embeddings ${r.status}`);
  await r.json();
};
const chatOnce = async () => {
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: chatModel, max_tokens: 16, temperature: 0, messages: [{ role: "user", content: `In five words, what does this describe? ${TEXT}` }] }),
  });
  if (!r.ok) throw new Error(`chat ${r.status}`);
  await r.json();
};
const decideOnce = async () => {
  await jevDecide(cfg!, { proposition: "the note describes a worker writing vectors", context: TEXT }, { kind: "decision", actor: "eval-jev-coload" });
};

type Timing = { label: string; calls: number; p50: number; p95: number };
/** `count` calls, or — with `until` — as many as fit before that instant (at least three), so loops run together overlap throughout. */
async function timed(label: string, once: () => Promise<void>, count: number, until?: number): Promise<Timing> {
  const ms: number[] = [];
  while (until === undefined ? ms.length < count : performance.now() < until || ms.length < 3) {
    const t = performance.now();
    await once();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  return { label, calls: ms.length, p50: ms[Math.floor(ms.length / 2)], p95: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] };
}

const showPs = (models: Loaded[]) => models.map((m) => `${m.name} ${gb(m.size)} (VRAM ${gb(m.size_vram)})`).join("; ") || "none";

// Warm all three so "alone" measures a loaded model, not a load — read before
// and after, since a load here is the one the run can cause.
const cold = await ps();
const runnersCold = await runners();
await embedOnce();
await chatOnce();
await decideOnce();
const before = await ps();
const runnersBefore = await runners();
const warmLoaded = before.filter((m) => !cold.some((c) => c.name === m.name)).map((m) => m.name);
const warmEvicted = cold.filter((m) => !before.some((b) => b.name === m.name)).map((m) => m.name);
const warmChanged = JSON.stringify(runnersCold) !== JSON.stringify(runnersBefore);
console.log(`\nwarm-up: ${warmLoaded.length ? `loaded ${warmLoaded.join(", ")}` : "loaded nothing"}${warmEvicted.length ? `; EVICTED ${warmEvicted.join(", ")}` : ""}${warmChanged && !warmLoaded.length ? "; a runner stopped or started" : ""}`);
console.log(`before: Ollama holds ${showPs(before)}`);
console.log(`        Ollama's settings: ${await ollamaSettings()}; runners ${runnersBefore.join(", ") || "none seen"}`);
console.log(`        tier ${await tierMemory(jevPid)}; free memory ${await freeMemory()}`);

const alone = [await timed("embedding", embedOnce, n), await timed("chat (16 tokens)", chatOnce, Math.max(3, Math.floor(n / 3))), await timed("decision", decideOnce, n)];
// Together for as long as the three took alone, all to one deadline.
const phaseMs = alone.reduce((s, t) => s + t.p50 * t.calls, 0);
const deadline = performance.now() + phaseMs;
const together = await Promise.all([timed("embedding", embedOnce, 0, deadline), timed("chat (16 tokens)", chatOnce, 0, deadline), timed("decision", decideOnce, 0, deadline)]);
const after = await ps();
const runnersAfter = await runners();

console.log(`\n| call | alone: calls, p50 / p95 | beside the other two: calls, p50 / p95 | p50 ratio |`);
console.log(`| --- | --- | --- | --- |`);
for (let i = 0; i < 3; i++) console.log(`| ${alone[i].label} | ${alone[i].calls}, ${alone[i].p50.toFixed(0)} / ${alone[i].p95.toFixed(0)} ms | ${together[i].calls}, ${together[i].p50.toFixed(0)} / ${together[i].p95.toFixed(0)} ms | ${(together[i].p50 / alone[i].p50).toFixed(2)}× |`);
const evicted = before.filter((m) => !after.some((a) => a.name === m.name)).map((m) => m.name);
const reloaded = runnersBefore.length > 0 && JSON.stringify(runnersBefore) !== JSON.stringify(runnersAfter);
console.log(`\nafter: Ollama holds ${showPs(after)}; runners ${runnersAfter.join(", ") || "none seen"}`);
console.log(`       tier ${await tierMemory(jevPid)}; free memory ${await freeMemory()}`);
console.log(evicted.length ? `EVICTED while the tier ran: ${evicted.join(", ")}`
  : reloaded ? "a runner stopped or started while the tier ran: a model was unloaded and reloaded (see the runners above)"
  : runnersBefore.length ? "no Ollama model was evicted or reloaded while the tier ran beside it (same runners, same start times)"
  : "no Ollama model was evicted (runners not visible from here: the name comparison alone)");
console.log(`not tested: ${warmLoaded.length ? "past the warm-up's load, " : ""}no model load was requested and no memory pressure applied — Ollama evicts on a load, which the tier never makes`);
