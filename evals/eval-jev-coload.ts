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
 *   1. before: Ollama's loaded models (/api/ps: name, size, VRAM, expiry), the
 *      tier's resident memory, the box's free memory;
 *   2. alone: N embeddings, N short chat completions, N decisions, each serial,
 *      each on its own — p50 and p95;
 *   3. together: the same three loops at once;
 *   4. after: /api/ps again — is every model that was loaded still loaded?
 *
 *   bun eval-jev-coload.ts [--n 30] [--jev-pid <pid>]
 *
 * The provider is OB1_LLM_BASE_URL (its /v1 stripped for /api/ps), the models
 * OB1_EMBEDDING_MODEL and OB1_METADATA_MODEL, the tier OB1_JEV_BASE_URL with
 * OB1_JEV_LOCAL=1. The texts are fixed and carry nothing from any brain. It
 * loads the two Ollama models if they are not loaded (a first call), so run it
 * where that is acceptable — on the dogfood Mac it shares Ollama with the brain.
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
const rssMb = async (pid: string | undefined) => {
  if (!pid) return null;
  const out = (await Bun.$`ps -o rss= -p ${pid}`.nothrow().text()).trim();
  return out ? Math.round(Number(out) / 1024) : null;
};
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

async function timed(label: string, once: () => Promise<void>, count: number): Promise<{ label: string; p50: number; p95: number }> {
  const ms: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = performance.now();
    await once();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  return { label, p50: ms[Math.floor(ms.length / 2)], p95: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] };
}

const showPs = (models: Loaded[]) => models.map((m) => `${m.name} ${gb(m.size)} (VRAM ${gb(m.size_vram)})`).join("; ") || "none";

// Warm all three so "alone" measures a loaded model, not a load.
await embedOnce();
await chatOnce();
await decideOnce();
const before = await ps();
console.log(`\nbefore: Ollama holds ${showPs(before)}; OLLAMA_MAX_LOADED_MODELS ${env.OLLAMA_MAX_LOADED_MODELS ?? "unset in this shell (Ollama's default applies)"}`);
console.log(`        tier rss ${(await rssMb(jevPid)) ?? "—"} MB; free memory ${await freeMemory()}`);

const alone = [await timed("embedding", embedOnce, n), await timed("chat (16 tokens)", chatOnce, Math.max(3, Math.floor(n / 3))), await timed("decision", decideOnce, n)];
const together = await Promise.all([timed("embedding", embedOnce, n), timed("chat (16 tokens)", chatOnce, Math.max(3, Math.floor(n / 3))), timed("decision", decideOnce, n)]);
const after = await ps();

console.log(`\n| call | alone p50 / p95 | beside the other two p50 / p95 |`);
console.log(`| --- | --- | --- |`);
for (let i = 0; i < 3; i++) console.log(`| ${alone[i].label} | ${alone[i].p50.toFixed(0)} / ${alone[i].p95.toFixed(0)} ms | ${together[i].p50.toFixed(0)} / ${together[i].p95.toFixed(0)} ms |`);
const evicted = before.filter((m) => !after.some((a) => a.name === m.name)).map((m) => m.name);
console.log(`\nafter: Ollama holds ${showPs(after)}`);
console.log(`       tier rss ${(await rssMb(jevPid)) ?? "—"} MB; free memory ${await freeMemory()}`);
console.log(evicted.length ? `EVICTED while the tier ran: ${evicted.join(", ")}` : "no Ollama model was evicted while the tier ran beside it");
