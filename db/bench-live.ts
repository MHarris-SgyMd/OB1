#!/usr/bin/env bun
/**
 * bench-live.ts — what a background pass costs a live call (SMD-3024).
 *
 * Times the two calls a client makes most, end to end through a brain's MCP
 * endpoint, and the model calls they are made of, called directly:
 *   - search_thoughts and capture_thought over MCP, as a client makes them
 *     (one client, closed loop: each call waits for the last);
 *   - a query embedding and a capture's metadata call, through the server's
 *     own functions (server-portable/embed.ts, metadata.ts) against the same
 *     provider, with the same settings.
 * The kinds are interleaved across the run, so a background pass that speeds
 * up or slows down meets each kind alike, and never overlap, so the harness
 * does not contend with itself. One untimed call of each kind comes first, so
 * no timed call pays for loading a model.
 *
 * What the numbers are, and are not (the first run's review, 2026-10-15):
 *   - A capture is its metadata call plus ~10–12 ms: the two columns measure
 *     one model call twice, and their gap is sampling.
 *   - The provider keeps the last prompt cached per slot (llama-server's prefix
 *     cache, and the embedder has one slot), so an embedding's time depends on
 *     the call before it. The direct embeds use their own queries, so none
 *     re-sends a search's prompt; they still share the instruction prefix, as
 *     consecutive searches do. They are an embedding with a warm prefix, not a
 *     search's own embedding time; Ollama's log has that per request.
 *   - The database's share is not timed here (this script does not reach the
 *     database). Measured end to end minus the model's time, everything but
 *     the model stayed within ±2 ms across states in the first run.
 *   - p95 is printed only from 20 samples up: below that, nearest rank makes it
 *     the single slowest call.
 *
 *   bun db/bench-live.ts --label baseline --out /private/tmp/live.jsonl --ids /private/tmp/probe-ids.txt
 *   --mcp URL (http://127.0.0.1:8010/canary/mcp)   --key-from NAME (open-brain: ~/.claude.json's mcpServers entry)
 *   --searches N (60)   --captures N (30)   --embeds N (40)   --metadata N (20)   --keep-probes
 *   bun db/bench-live.ts --self-check     # the pure parts — the answer reader, the ok rule, the schedule, the flags — no brain, no provider
 *
 * The provider and models come from the variables the server reads
 * (OB1_LLM_BASE_URL, OB1_EMBEDDING_MODEL, OB1_EMBEDDING_DIM, OB1_METADATA_MODEL,
 * OB1_LLM_LOCAL, …), resolved by the server's own function; the banner prints
 * what was resolved, to compare with the server's.
 *
 * Captures are real writes. Each starts "SMD-3024 latency probe"; its id is
 * appended to --ids as it lands, and the run deletes its own probes at the end
 * through delete_thought (--keep-probes leaves them). Run it against a brain
 * whose content is disposable — the canary or a scratch brain, never stable.
 * The key is read from ~/.claude.json and never printed.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createEmbedder, resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { extractMetadata } from "../server-portable/metadata.ts";
import type { EgressSubject } from "../server-portable/egress.ts";

type Kind = "search" | "capture" | "embed" | "metadata";
type Sample = { label: string; kind: Kind; i: number; ts: string; ms: number; ok: boolean; status?: number; error?: string };
type Outcome = { ok: boolean; status?: number; error?: string };

/** The content every probe starts with — delete-by-content tools match on it. */
export const PROBE_PREFIX = "SMD-3024 latency probe";

/** The searches' queries: the kinds of question the brain is asked. */
export const QUERIES = [
  "sleep scheduler yields to live traffic",
  "HNSW reachability under churn",
  "capture stamp reset and recapture label",
  "board findings posted to Linear and the acceptance rate",
  "event log as the source of truth for thoughts",
  "extraction windows left out as malformed",
  "one brain per stack and the edge proxy",
  "consolidation proposals outdating a session summary",
  "operator GUI as a client of the REST core",
  "release cut and migration numbering",
];

/** The direct embeds' queries — none of QUERIES, so no direct embed re-sends the prompt a search just left in the cache. */
export const EMBED_QUERIES = [
  "what the canary measured before a release",
  "how a worker key is minted and classified",
  "why the query log is opt-in",
  "where the change records live in the repo",
  "the egress gate for a local provider",
  "a thought longer than every sleep",
  "trust labels on ingested rows",
  "the page store and its owned sections",
  "how preflight reads the schema version",
  "the import runner's least-privilege role",
];

/** A capture of a session summary's size (~1.5 KB), the shape most captures on the dogfood have. */
export function probeText(label: string, i: number): string {
  return `${PROBE_PREFIX} (${label} #${i}, ${new Date().toISOString()}). This thought exists only to time a capture and is deleted after the run. ` +
    "The session reviewed the sleep scheduler's behaviour when a live search arrives: the passes stop, their leases go back to the pool, and the brain waits for a quiet period before resuming. " +
    "It compared the cost of stopping against the cost of sharing the model, noted that extraction and consolidation run on the same local model the server uses for capture metadata, " +
    "and that every search embeds its query on the same GPU. It listed what to measure: search and capture latency with nothing running, with extraction at one and two workers, and with consolidation, " +
    "each split into model and database time. It recorded that the canary carries a real extraction backlog from the change records ingested earlier in the day, so the background load is genuine. " +
    "Next steps: run each state long enough for a stable median, keep the client to one call at a time, and delete these probes afterwards.";
}

/** p-th percentile by nearest rank; NaN for no samples. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** The JSON-RPC message answering request `id` in a body that is raw JSON or SSE frames (`data:` with or without a space); null when none does. */
export function answerTo(body: string, id: number): Record<string, any> | null {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.startsWith("data:") ? raw.slice(5).trimStart() : raw;
    if (!line.startsWith("{")) continue;
    try {
      const msg = JSON.parse(line);
      if (msg?.id === id) return msg;
    } catch {}
  }
  return null;
}

/** A tool call's outcome from its answer: ok only for a result that is not an error; a capture whose tagging fell back or that saved without a vector is degraded, not ok. */
export function outcomeOf(status: number, msg: Record<string, any> | null, tool: string): Outcome & { id?: string } {
  if (status !== 200) return { ok: false, status, error: `HTTP ${status}` };
  if (!msg) return { ok: false, status, error: "no JSON-RPC answer to this request" };
  if (msg.error !== undefined) return { ok: false, status, error: JSON.stringify(msg.error).slice(0, 200) };
  const result = msg.result;
  if (result === undefined) return { ok: false, status, error: "answer has no result" };
  const text = (result.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
  if (result.isError === true) return { ok: false, status, error: text.slice(0, 200) };
  if (tool !== "capture_thought") return { ok: true, status };
  const id = typeof result.structuredContent?.id === "string" ? result.structuredContent.id : undefined;
  if (!id) return { ok: false, status, error: "capture answered without an id" };
  if (result.structuredContent?.embeddingCall === false) return { ok: false, status, id, error: "degraded: saved without a vector" };
  if (/automatic tagging failed/.test(text)) return { ok: false, status, id, error: "degraded: automatic tagging failed" };
  return { ok: true, status, id };
}

/** One flag's value in `argv`: refused when given twice, given without a value, or given a value that is another flag. */
export function flagIn(argv: string[], name: string, fallback?: string): string | undefined {
  const at = argv.flatMap((a, i) => (a === `--${name}` ? [i] : []));
  if (at.length > 1) throw new Error(`--${name} given twice`);
  if (at.length === 0) return fallback;
  const value = argv[at[0] + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}
/** A count flag: digits only, so `1e1`, `0x10`, `-3` and a blank are refused rather than read as a number. */
export function countIn(argv: string[], name: string, fallback: number): number {
  const raw = flagIn(argv, name, String(fallback))!;
  if (!/^\d+$/.test(raw)) throw new Error(`--${name} takes a whole number`);
  return Number(raw);
}

/**
 * The order of a run's calls: each step takes the next of every kind still
 * owed, a kind due once the step has reached its share, so each kind is spread
 * across the run and each owed call comes exactly once, in index order.
 */
export function schedule(want: Record<Kind, number>): { kind: Kind; i: number }[] {
  const kinds: Kind[] = ["search", "embed", "capture", "metadata"];
  const done: Record<Kind, number> = { search: 0, capture: 0, embed: 0, metadata: 0 };
  const steps = Math.max(...kinds.map((k) => want[k]));
  const order: { kind: Kind; i: number }[] = [];
  for (let step = 0; step < steps; step++) {
    for (const k of kinds) {
      if (done[k] < want[k] && step >= Math.floor((done[k] * steps) / want[k])) order.push({ kind: k, i: done[k]++ });
    }
  }
  return order;
}

function keyFrom(name: string): string {
  const config = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
  const key = config?.mcpServers?.[name]?.headers?.["x-brain-key"];
  if (typeof key !== "string" || key === "") throw new Error(`~/.claude.json has no x-brain-key for mcpServers["${name}"]`);
  return key;
}

async function main(): Promise<void> {
  const argv = process.argv;
  const label = flagIn(argv, "label");
  const out = flagIn(argv, "out");
  const ids = flagIn(argv, "ids");
  if (!label || !out || !ids) throw new Error("--label, --out and --ids are required");
  const mcp = flagIn(argv, "mcp", "http://127.0.0.1:8010/canary/mcp")!;
  const key = keyFrom(flagIn(argv, "key-from", "open-brain")!);
  const keep = argv.includes("--keep-probes");
  const want = { search: countIn(argv, "searches", 60), capture: countIn(argv, "captures", 30), embed: countIn(argv, "embeds", 40), metadata: countIn(argv, "metadata", 20) };
  // Fail before the first call, not after a capture has landed, if either file cannot be written.
  appendFileSync(out, "");
  appendFileSync(ids, "");

  const cfg = resolveEmbedConfig(process.env as EmbedEnv);
  const embedder = createEmbedder(() => cfg);
  console.error(`  ${label}: ${want.search} searches, ${want.capture} captures over ${mcp}; ${want.embed} embeds and ${want.metadata} metadata calls direct`);
  console.error(`  direct: embeddings ${cfg.embeddingModel} @ ${cfg.embeddingDim} via ${cfg.embeddings.base}; metadata ${cfg.metadataModel} via ${cfg.chat.base}; ${cfg.timeoutMs / 1000} s per call`);

  let seq = 0;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const id = ++seq;
    const res = await fetch(mcp, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": key },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return { status: res.status, msg: answerTo(await res.text(), id) };
  };
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench-live", version: "1" } });
  if (init.status !== 200 || !init.msg?.result) throw new Error(`initialize was refused (HTTP ${init.status}${init.msg?.error ? `: ${JSON.stringify(init.msg.error).slice(0, 120)}` : ""})`);

  const probes: string[] = [];
  const call = (tool: string, args: Record<string, unknown>) => async (): Promise<Outcome> => {
    const { status, msg } = await rpc("tools/call", { name: tool, arguments: args });
    const o = outcomeOf(status, msg, tool);
    if (o.id) { probes.push(o.id); appendFileSync(ids, o.id + "\n"); }
    return { ok: o.ok, status: o.status, error: o.error };
  };
  const embedOne = (query: string) => async (): Promise<Outcome> => {
    await embedder.getEmbedding(query, { kind: "query", actor: "bench-live", content: query } as EgressSubject, "query");
    return { ok: true };
  };
  const metadataOne = (text: string) => async (): Promise<Outcome> => {
    const m = await extractMetadata(text, { kind: "capture", actor: "bench-live", content: text } as EgressSubject, cfg);
    const failed = typeof m.metadata_extraction_failed === "string" ? m.metadata_extraction_failed : undefined;
    return { ok: failed === undefined, error: failed };
  };

  // Warm-up, untimed: each model loaded and each path taken once before anything is timed.
  await call("search_thoughts", { query: "warm-up query for the latency harness", limit: 10 })();
  await embedOne("warm-up embedding for the latency harness")();
  await metadataOne(probeText(`${label} warm-up`, 0))();

  const samples: Sample[] = [];
  const timed = async (kind: Kind, i: number, fn: () => Promise<Outcome>) => {
    const ts = new Date().toISOString();
    const t0 = performance.now();
    let o: Outcome;
    try { o = await fn(); } catch (e) { o = { ok: false, error: (e as Error).message.slice(0, 200) }; }
    const s: Sample = { label, kind, i, ts, ms: performance.now() - t0, ...o };
    samples.push(s);
    appendFileSync(out, JSON.stringify(s) + "\n");
  };

  for (const { kind, i } of schedule(want)) {
    if (kind === "search") await timed(kind, i, call("search_thoughts", { query: QUERIES[i % QUERIES.length], limit: 10 }));
    else if (kind === "embed") await timed(kind, i, embedOne(EMBED_QUERIES[i % EMBED_QUERIES.length]));
    else if (kind === "capture") await timed(kind, i, call("capture_thought", { content: probeText(label, i) }));
    else await timed(kind, i, metadataOne(probeText(label, 1000 + i)));
  }

  console.log(`\n  ${label.padEnd(16)}  n   ok   p50 ms   p90 ms   p95 ms   max ms`);
  for (const kind of ["search", "capture", "embed", "metadata"] as Kind[]) {
    const mine = samples.filter((s) => s.kind === kind);
    const ok = mine.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
    const f = (v: number) => (Number.isNaN(v) ? "-" : Math.round(v).toString()).padStart(8);
    console.log(`  ${kind.padEnd(16)}${String(mine.length).padStart(3)}  ${String(ok.length).padStart(3)} ${f(percentile(ok, 50))} ${f(percentile(ok, 90))} ${f(ok.length >= 20 ? percentile(ok, 95) : NaN)} ${f(ok[ok.length - 1] ?? NaN)}`);
  }
  const failed = samples.filter((s) => !s.ok);
  if (failed.length) console.log(`  failures: ${failed.map((s) => `${s.kind}#${s.i} ${s.status ?? ""} ${s.error ?? ""}`.trim()).join("; ")}`);

  if (keep) { console.log(`  probes kept: ${probes.length} (ids in ${ids})`); return; }
  let deleted = 0;
  const notDeleted: string[] = [];
  for (const id of probes) {
    try {
      const { status, msg } = await rpc("tools/call", { name: "delete_thought", arguments: { id } });
      const o = outcomeOf(status, msg, "delete_thought");
      if (o.ok) deleted++; else notDeleted.push(`${id} (${o.error})`);
    } catch (e) {
      notDeleted.push(`${id} (${(e as Error).message.slice(0, 80)})`);
    }
  }
  console.log(`  probes deleted: ${deleted} of ${probes.length}${notDeleted.length ? `; NOT deleted: ${notDeleted.join(", ")}` : ""}`);
}

/** The pure parts, checked without a brain or a provider: what CI runs (--self-check). */
export function selfCheck(): number {
  let bad = 0;
  const ok = (cond: boolean, what: string) => { if (!cond) { bad++; console.log(`  FAIL ${what}`); } };

  // The answer reader and the ok rule, against the first run's review's failing inputs (2026-10-15).
  const res = (o: object) => JSON.stringify({ jsonrpc: "2.0", id: 7, ...o });
  const id = "0c057ac3-bad2-4621-b74c-4a394bbf2b7b";
  const cap = (sc: object, text = "Captured.") => res({ result: { content: [{ type: "text", text }], structuredContent: sc } });
  const cases: [string, number, string, string, boolean][] = [
    ["an empty 200", 200, "", "search_thoughts", false],
    ["a keepalive-only stream", 200, ": keepalive\n\n", "search_thoughts", false],
    ["a proxy's HTML page", 200, "<html><body>proxy error</body></html>", "search_thoughts", false],
    ["SSE data: with no space", 200, "event: message\ndata:" + res({ result: { content: [{ type: "text", text: "hits" }] } }), "search_thoughts", true],
    ["SSE with CRLF", 200, "event: message\r\ndata: " + res({ result: { content: [] } }) + "\r\n\r\n", "search_thoughts", true],
    ["a notification after the result", 200, "data: " + res({ result: { content: [] } }) + "\n\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n", "search_thoughts", true],
    ["an answer to another request only", 200, JSON.stringify({ jsonrpc: "2.0", id: 6, result: { content: [] } }), "search_thoughts", false],
    ["a JSON-RPC error", 200, res({ error: { code: -32602, message: "bad" } }), "search_thoughts", false],
    ["a tool's refusal", 200, res({ result: { isError: true, content: [{ type: "text", text: "refused" }] } }), "search_thoughts", false],
    ["an HTTP 503", 503, res({ result: { content: [] } }), "search_thoughts", false],
    ["a capture", 200, cap({ id, embeddingCall: true }), "capture_thought", true],
    ["a capture without id", 200, cap({ embeddingCall: true }), "capture_thought", false],
    ["a capture saved without a vector", 200, cap({ id, embeddingCall: false }), "capture_thought", false],
    ["a capture whose tagging failed", 200, cap({ id, embeddingCall: true }, "Captured.\n\nNote: the thought was saved, but automatic tagging failed (timeout)."), "capture_thought", false],
  ];
  for (const [name, status, body, tool, expectOk] of cases) {
    const o = outcomeOf(status, answerTo(body, 7), tool);
    ok(o.ok === expectOk, `${name}: ok is ${o.ok}, expected ${expectOk}`);
    if (tool === "capture_thought" && name !== "a capture without id") ok(o.id === id, `${name}: the id is read from structuredContent`);
  }

  // Percentiles by nearest rank.
  ok(Number.isNaN(percentile([], 50)), "no samples: NaN");
  ok(percentile([5], 95) === 5, "one sample is every percentile");
  const twelve = Array.from({ length: 12 }, (_, i) => i + 1);
  ok(percentile(twelve, 95) === 12 && percentile(twelve, 50) === 6, "n=12: p95 is the slowest call (why p95 waits for 20 samples), p50 the 6th");
  const forty = Array.from({ length: 40 }, (_, i) => i + 1);
  ok(percentile(forty, 95) === 38 && percentile(forty, 90) === 36, "n=40: p95 the 38th, p90 the 36th");

  // The schedule: every owed call exactly once, in index order, for lopsided and zero counts; each kind spread across the run.
  const wants: Record<Kind, number>[] = [
    { search: 60, capture: 30, embed: 40, metadata: 20 },
    { search: 0, capture: 1, embed: 0, metadata: 0 },
    { search: 3, capture: 0, embed: 7, metadata: 1 },
    { search: 0, capture: 0, embed: 0, metadata: 0 },
  ];
  for (const want of wants) {
    const order = schedule(want);
    for (const k of ["search", "capture", "embed", "metadata"] as Kind[]) {
      const is = order.filter((o) => o.kind === k).map((o) => o.i);
      ok(is.length === want[k] && is.every((v, j) => v === j), `schedule ${JSON.stringify(want)}: ${k} runs 0..${want[k] - 1} once each`);
    }
  }
  const full = schedule({ search: 60, capture: 30, embed: 40, metadata: 20 });
  ok(full.map((o) => o.kind).lastIndexOf("capture") > full.length * 0.8, "captures reach the end of the run, not bunched at its start");

  // The flags.
  const refused = (f: () => unknown, rule: RegExp) => { try { f(); return false; } catch (e) { return rule.test((e as Error).message); } };
  ok(refused(() => flagIn(["--label", "--out", "x"], "label"), /needs a value/), "a flag followed by another flag needs a value");
  ok(refused(() => flagIn(["--label"], "label"), /needs a value/), "a flag last on the line needs a value");
  ok(refused(() => flagIn(["--label", "a", "--label", "b"], "label"), /given twice/), "a flag given twice is refused");
  ok(refused(() => countIn(["--captures", "1e1"], "captures", 30), /whole number/), "a count in exponent form is refused");
  ok(refused(() => countIn(["--captures", ""], "captures", 30), /whole number/), "a blank count is refused");
  ok(countIn([], "captures", 30) === 30 && countIn(["--captures", "0"], "captures", 30) === 0, "a count falls back, and 0 is a count");
  ok(flagIn(["--mcp", "http://x/mcp"], "mcp", "d") === "http://x/mcp" && flagIn([], "mcp", "d") === "d", "a flag's value, or its fallback");

  // The probes and the queries.
  ok(probeText("x", 1).startsWith(PROBE_PREFIX), "every probe starts with the prefix delete-by-content matches");
  ok(QUERIES.length > 0 && EMBED_QUERIES.length > 0 && !QUERIES.some((q) => EMBED_QUERIES.includes(q)), "the direct embeds' queries are none of the searches'");

  console.log(bad === 0 ? "bench-live.ts self-check PASS" : `bench-live.ts self-check: ${bad} FAILED`);
  return bad === 0 ? 0 : 1;
}

if (import.meta.main) {
  if (process.argv.includes("--self-check")) process.exit(selfCheck());
  await main();
}
