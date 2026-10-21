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
 * does not contend with itself. One untimed call of each kind the run times
 * comes first, so no timed call loads a model; a warm-up that fails is said.
 *
 * What the numbers are, and are not (the first run's reviews, 2026-10-15):
 *   - A capture is its own metadata call plus ~10–12 ms (median). The direct
 *     metadata call is a separate call of the same size, not the capture's:
 *     the first run had it ~0.1 s faster than the capture's at baseline and
 *     ~0.6 s slower beside two extraction streams (n=8).
 *   - The provider keeps the last prompt cached per slot (llama-server's prefix
 *     cache, and the embedder has one slot), so an embedding's time depends on
 *     the call before it. The direct embeds use their own queries, so none
 *     re-sends a search's prompt; they still share the instruction prefix, as
 *     consecutive searches do. They are an embedding with a warm prefix, not a
 *     search's own embedding time; Ollama's log has that per request.
 *   - The database's share is not timed here (this script does not reach the
 *     database). Measured end to end minus the model's time, everything but
 *     the model stayed in a 4 ms band (10–14 ms) at the median across states
 *     in the first run.
 *   - Percentiles are of the ok calls: a capture whose tagging timed out under
 *     load, or a call cut off at its deadline, drops out of them and shows in
 *     the n and ok columns and the failures line.
 *   - p95 is printed only from 20 samples up: below that, nearest rank makes it
 *     the single slowest call.
 *
 *   bun db/bench-live.ts --label baseline --out /tmp/live.jsonl --ids /tmp/probe-ids-baseline.txt
 *   --key-from NAME (open-brain-canary: ~/.claude.json's mcpServers entry, its url and key)   --mcp URL (that entry's url; another needs --key-from)
 *   --searches N (60)   --captures N (30)   --embeds N (40)   --metadata N (20)   --keep-probes
 *   bun db/bench-live.ts --self-check     # the pure parts — the answer reader, the ok rule against the server's own replies, the probe match, the schedule, the tier guard — no brain, no provider
 *   bun db/bench-live.ts --help           # the flags (cli.ts reads every argument: an unknown one, a repeat or a blank value is refused, exit 2)
 *
 * The provider and models come from the variables the server reads
 * (OB1_LLM_BASE_URL, OB1_EMBEDDING_MODEL, OB1_EMBEDDING_DIM, OB1_METADATA_MODEL,
 * OB1_LLM_LOCAL, OB1_LLM_TIMEOUT, OB1_CHUNK_CONTEXT, OB1_JEV_*, …), resolved by
 * the server's own functions; they must mirror the benched server's, and the
 * banner prints what was resolved. An MCP call ends at the server's own bound
 * on a capture (captureCallSeconds) plus a minute; one that makes no model
 * call (initialize, brain_info and the cleanup's) at 30 s.
 *
 * Captures are real writes, so it runs only against a brain whose brain_info
 * says tier canary or working (OB1_TIER): stable (tier stable, or none) is
 * refused before any probe is written. Each probe starts "SMD-3024 latency
 * probe (<label> #<i>, <instant>)", and its id is appended to --ids as it
 * lands. Whatever ends the run (a normal end, a throw, or SIGINT, SIGTERM or
 * SIGHUP; a second signal stops at once and leaves them), it deletes the
 * probes it recorded, then searches the brain for this run's probes whose ids
 * never came back (a capture cut off at its deadline, or whose connection
 * dropped, can still land) and deletes those. It exits 1 if a probe is left,
 * or if a capture got no answer and was not found, since it may land yet;
 * else 128 + the signal's number if a signal cut the run short. The key, and
 * the url unless --mcp names one, are read from one ~/.claude.json entry, the
 * canary's connector by default (since SMD-2874 the canary takes its own key
 * alone, on its own port); the key is never printed.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandLine } from "./cli.ts";
import { createEmbedder, resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { extractMetadata, metadataRefused, metadataUnavailable } from "../server-portable/metadata.ts";
import { INGESTED_NOTICE, renderCapture } from "../server-portable/render.ts";
import { captureCallSeconds } from "../server-portable/core/writes.ts";
import { resolveJevConfig, type JevEnv } from "../server-portable/jev.ts";
import { ok as okOutcome, refuse } from "../server-portable/core/refusal.ts";
import type { EgressSubject } from "../server-portable/egress.ts";

type Kind = "search" | "capture" | "embed" | "metadata";
type Sample = { label: string; kind: Kind; i: number; ts: string; ms: number; ok: boolean; status?: number; error?: string };
type Outcome = { ok: boolean; status?: number; error?: string };
type Answer = { status: number; msg: Record<string, any> | null };

/** The content every probe starts with; search_thoughts_keyword on it finds any left behind. */
export const PROBE_PREFIX = "SMD-3024 latency probe";

/** The deadline of an MCP call that makes no model call: initialize, brain_info, and the cleanup's deletes, search and reads. */
const QUICK_MS = 30_000;

/** The signals that stop a run, by number: one that cuts the run short makes it exit 128 + that, as a shell reports a process a signal ended. */
const SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const;
type Signal = keyof typeof SIGNALS;

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

/** A probe capture of about 1 KB of prose. */
export function probeText(label: string, i: number): string {
  return `${PROBE_PREFIX} (${label} #${i}, ${new Date().toISOString()}). This thought exists only to time a capture and is deleted after the run. ` +
    "The session reviewed the sleep scheduler's behaviour when a live search arrives: the passes stop, their leases go back to the pool, and the brain waits for a quiet period before resuming. " +
    "It compared the cost of stopping against the cost of sharing the model, noted that extraction and consolidation run on the same local model the server uses for capture metadata, " +
    "and that every search embeds its query on the same GPU. It listed what to measure: search and capture latency with nothing running, with extraction at one and two workers, and with consolidation, " +
    "each split into model and database time. It recorded that the canary carries a real extraction backlog from the change records ingested earlier in the day, so the background load is genuine. " +
    "Next steps: run each state long enough for a stable median, keep the client to one call at a time, and delete these probes afterwards.";
}

/** What search_thoughts_keyword is asked for a run's probes: every probe of the label, its warm-up's included, contains it. */
export function probeQuery(label: string): string {
  return `${PROBE_PREFIX} (${label} `;
}

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a thought's text is a probe this run wrote: from its first
 * character, the prefix, this run's label (or its warm-up's), an index and the
 * instant the probe was made, no earlier than the run's start. Exact case (the
 * keyword search that found it ignores case), so a thought that only quotes a
 * probe (a change record, a session summary) is never one, nor is an earlier
 * run's leftover under the same label. The text fetch returns for an ingested
 * thought starts with the notice, which is read past.
 */
export function isRunProbe(text: string, label: string, since: number): boolean {
  const body = text.startsWith(`${INGESTED_NOTICE}\n\n`) ? text.slice(INGESTED_NOTICE.length + 2) : text;
  const m = new RegExp(`^${escaped(PROBE_PREFIX)} \\(${escaped(label)} (?:warm-up )?#\\d+, (\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z)\\)\\. `).exec(body);
  return m !== null && Date.parse(m[1]) >= since;
}

/** p-th percentile by nearest rank; NaN for no samples. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** The p95 a summary prints: only from 20 samples up, below which nearest rank makes it the slowest call. */
export function shownP95(sorted: number[]): number {
  return sorted.length >= 20 ? percentile(sorted, 95) : NaN;
}

/**
 * The notes a capture's reply carries when its tagging did not happen
 * (render.ts renderCapture): placeholders from the fallback, a provider that
 * timed out or failed (metadataUnavailable, SMD-2888) and a gate that refused
 * the call (metadataRefused). The self-check feeds it the renderer's own replies.
 */
export const TAGGING_FAILED = /automatic tagging failed|no tags were extracted|no topics, people or type were extracted|tagging call for this capture was not made/;

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

/**
 * A tool call's outcome from its answer: ok only for a result that is not an
 * error. A capture is not ok when it saved without a vector, when its tagging
 * did not happen, or when it was a re-capture (the text was already a thought).
 * A capture's id comes back for every probe that landed — a refusal that saved
 * the thought (EMBEDDING_NOT_ATTACHED) included — so it is deleted with the
 * rest; never a re-capture's, which was there before the run.
 */
export function outcomeOf(status: number, msg: Record<string, any> | null, tool: string): Outcome & { id?: string } {
  if (status !== 200) return { ok: false, status, error: `HTTP ${status}` };
  if (!msg) return { ok: false, status, error: "no JSON-RPC answer to this request" };
  if (msg.error !== undefined) return { ok: false, status, error: JSON.stringify(msg.error).slice(0, 200) };
  const result = msg.result;
  if (result === undefined) return { ok: false, status, error: "answer has no result" };
  const text = (result.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
  const sc = result.structuredContent ?? {};
  const id = tool === "capture_thought" && typeof sc.id === "string" ? sc.id : undefined;
  if (result.isError === true) return { ok: false, status, id, error: text.slice(0, 200) };
  // A search the provider did not answer for is answered by exact literals
  // alone (SMD-2891): no vector search ran, so its latency is no sample of one.
  if ((tool === "search_thoughts" || tool === "search") && sc.vectorFailed !== undefined && sc.vectorFailed !== null) return { ok: false, status, error: `degraded: answered by exact literals alone, the embedding provider down (${String(sc.vectorFailed)})` };
  if (tool !== "capture_thought") return { ok: true, status };
  if (sc.existed === true) return { ok: false, status, error: "a re-capture: the text was already a thought (not a probe, so not deleted)" };
  if (!id) return { ok: false, status, error: "capture answered without an id" };
  if (sc.embeddingCall === false) return { ok: false, status, id, error: "degraded: saved without a vector (the embedding call was not made)" };
  if (typeof sc.vectorFailed === "string") return { ok: false, status, id, error: `degraded: saved without a vector (${sc.vectorFailed})` };
  const tagging = text.match(TAGGING_FAILED);
  if (tagging) return { ok: false, status, id, error: `degraded: ${tagging[0]}` };
  return { ok: true, status, id };
}

/** A thrown error as a run prints it: its name and code, never its message or its properties — Bun's failed fetch carries the URL, a ?key= and all, in `path`. */
export function errorKind(e: unknown): string {
  const o = (typeof e === "object" && e !== null ? e : {}) as { name?: unknown; code?: unknown };
  const name = typeof o.name === "string" && o.name !== "" ? o.name : typeof e;
  return typeof o.code === "string" && o.code !== "" ? `${name} ${o.code}` : name;
}

/** Why a brain may not be benched, or null: only one whose brain_info says tier canary or working. Stable (tier stable, or none) is refused, as is any brain with no tier. */
export function tierRefusal(tier: unknown): string | null {
  if (tier === "canary" || tier === "working") return null;
  return `this brain reports ${typeof tier === "string" && tier !== "" ? `tier ${tier}` : "no tier"}; the run writes probe captures, so it benches only a brain whose OB1_TIER is canary or working`;
}

/** The endpoint as the banner prints it: origin and path — never a query (a ?key= URL carries the key) or userinfo. */
export function shownUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(an endpoint that does not parse)";
  }
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

/** A connector entry's url and key: its x-brain-key header, else the key on its url, as deploy/canary.sh reads a connector's;
 * the url only where --mcp names none. Throws, naming neither, when the entry has no key or no url to use. */
export function connectorOf(entry: unknown, name: string, mcp: string | undefined): { mcp: string; key: string } {
  const e = entry as { url?: unknown; headers?: Record<string, unknown> } | undefined;
  const own = typeof e?.url === "string" && e.url !== "" ? e.url : undefined;
  let key = e?.headers?.["x-brain-key"];
  if ((typeof key !== "string" || key === "") && own) {
    try { key = new URL(own).searchParams.get("key") ?? undefined; } catch { /* a url that does not parse holds no key */ }
  }
  if (typeof key !== "string" || key === "") throw new Error(`~/.claude.json has no key for mcpServers["${name}"], in an x-brain-key header or on its url`);
  const url = mcp ?? own;
  if (url === undefined) throw new Error(`~/.claude.json has no url for mcpServers["${name}"]; give --mcp`);
  return { mcp: url, key };
}

function connectorFrom(name: string, mcp: string | undefined): { mcp: string; key: string } {
  return connectorOf(JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"))?.mcpServers?.[name], name, mcp);
}

async function main(): Promise<void> {
  // Every argument through the one scanner (cli.ts) before anything runs: a flag the harness
  // does not have, one given twice, a missing or blank value, a count that is not digits — exit 2.
  const cli = commandLine("bench-live.ts", {
    label: "one", out: "one", ids: "one", mcp: "one", "key-from": "one",
    searches: "one", captures: "one", embeds: "one", metadata: "one",
    "keep-probes": "none", "self-check": "none",
  }, {
    hints: {
      label: "<state name>", out: "<samples.jsonl>", ids: "<probe-ids.txt>", mcp: "<MCP URL>", "key-from": "<~/.claude.json mcpServers name>",
      searches: "<n>", captures: "<n>", embeds: "<n>", metadata: "<n>",
    },
    note: "a run needs --label, --out and --ids; --self-check needs none",
  });
  if (cli.has("self-check")) process.exit(selfCheck());
  const label = cli.value("label");
  const out = cli.value("out");
  const ids = cli.value("ids");
  if (!label || !out || !ids) {
    console.error("bench-live.ts: a run needs --label, --out and --ids (--help lists every flag).");
    process.exit(2);
  }
  const count = (name: "searches" | "captures" | "embeds" | "metadata", absent: number) => cli.int(name, { absent, min: 0, max: 10_000 });
  const want = { search: count("searches", 60), capture: count("captures", 30), embed: count("embeds", 40), metadata: count("metadata", 20) };
  const keep = cli.has("keep-probes");
  // Another endpoint is another brain, which refuses the canary's key (SMD-2874): it names its connector.
  if (cli.value("mcp") !== undefined && cli.value("key-from") === undefined) {
    console.error("bench-live.ts: --mcp names another brain, whose key the canary's is not: give --key-from with the connector whose key it takes.");
    process.exit(2);
  }
  const { mcp, key } = connectorFrom(cli.value("key-from") ?? "open-brain-canary", cli.value("mcp"));
  // Fail before the first call, not after a capture has landed, if either file cannot be written.
  appendFileSync(out, "");
  appendFileSync(ids, "");

  const cfg = resolveEmbedConfig(process.env as EmbedEnv);
  const embedder = createEmbedder(() => cfg);
  // A search or capture ends at the server's own bound on a capture's model calls (core/index.ts's captureSeconds: the
  // embedding, the metadata call and the decision tier at once, two rounds with chunk context), plus a minute for the
  // database — not at the runtime's idle timeout once the server's keepalives stop (~15 min).
  const boundS = captureCallSeconds(cfg, resolveJevConfig(process.env as JevEnv));
  const callMs = (boundS + 60) * 1000;
  console.error(`  ${label}: ${want.search} searches, ${want.capture} captures over ${shownUrl(mcp)}, each ending at ${callMs / 1000} s (the server's capture bound, ${boundS} s, plus 60); ${want.embed} embeds and ${want.metadata} metadata calls direct`);
  console.error(`  direct: embeddings ${cfg.embeddingModel} @ ${cfg.embeddingDim} via ${shownUrl(cfg.embeddings.base)}; metadata ${cfg.metadataModel} via ${shownUrl(cfg.chat.base)}; ${cfg.timeoutMs / 1000} s per call`);

  let seq = 0;
  const rpc = async (method: string, params: Record<string, unknown>, ms = callMs): Promise<Answer> => {
    const id = ++seq;
    const res = await fetch(mcp, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": key },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(ms),
    });
    return { status: res.status, msg: answerTo(await res.text(), id) };
  };

  // The brain and its tier, before any probe is written. A failure is said by the endpoint's origin and path and the
  // error's kind: an uncaught one would print Bun's message, whose `path` is the URL as given, ?key= and all.
  let info: Answer;
  try {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench-live", version: "1" } }, QUICK_MS);
    if (init.status !== 200 || !init.msg?.result) {
      console.error(`bench-live.ts: ${shownUrl(mcp)} refused initialize (HTTP ${init.status}${init.msg?.error ? `: ${JSON.stringify(init.msg.error).slice(0, 120)}` : ""}); no probe was written.`);
      process.exit(2);
    }
    info = await rpc("tools/call", { name: "brain_info", arguments: {} }, QUICK_MS);
  } catch (e) {
    console.error(`bench-live.ts: ${shownUrl(mcp)} did not answer (${errorKind(e)}); no probe was written.`);
    process.exit(2);
  }
  const asked = outcomeOf(info.status, info.msg, "brain_info");
  if (!asked.ok) {
    console.error(`bench-live.ts: brain_info failed at ${shownUrl(mcp)} (${asked.error}); the run benches only a brain that says its tier, so no probe was written.`);
    process.exit(2);
  }
  const refusal = tierRefusal(info.msg?.result?.structuredContent?.tier);
  if (refusal) {
    console.error(`bench-live.ts: ${refusal}.`);
    process.exit(2);
  }

  const since = Date.now(); // every probe of this run is made from here on (isRunProbe)
  const probes: string[] = []; // the ids that came back, in order
  const deleted = new Set<string>();
  let made = 0; // capture calls made, the warm-up's included
  let unanswered = 0; // captures that ended with no answer (a throw, a non-200, no JSON-RPC answer): each may have landed
  let inHand = false; // a capture is in flight
  let stopping: Signal | null = null;
  const hint = `search_thoughts_keyword ${JSON.stringify({ query: probeQuery(label), limit: 100 })} finds them: delete only a hit whose text starts with that query`;
  for (const sig of Object.keys(SIGNALS) as Signal[]) {
    process.on(sig, () => {
      if (stopping) {
        const recorded = probes.filter((id) => !deleted.has(id)).length;
        const unrecorded = unanswered + (inHand ? 1 : 0);
        console.error(`  ${sig}: stopped at once. ${recorded} recorded probe(s) may remain (ids in ${ids})${unrecorded ? `, and ${unrecorded} capture(s) that got no answer may land unrecorded` : ""}; ${hint}`);
        process.exit(128 + SIGNALS[sig]);
      }
      stopping = sig;
      console.error(`  ${sig}: stopping. The call in hand finishes, then this run's probes are ${keep ? "kept (--keep-probes)" : "deleted"}; a second signal stops at once${keep ? "" : " and leaves them"}`);
    });
  }

  let idsWarned = false;
  const record = (id: string) => {
    probes.push(id);
    try {
      appendFileSync(ids, id + "\n");
    } catch (e) {
      if (!idsWarned) console.error(`  could not append to ${ids} (${errorKind(e)}): the run still deletes its probes, but one that dies now leaves no list of them; ${hint}`);
      idsWarned = true;
    }
  };
  const call = (tool: string, args: Record<string, unknown>) => async (): Promise<Outcome> => {
    const capture = tool === "capture_thought";
    let a: Answer;
    if (capture) made++;
    inHand = capture;
    try {
      a = await rpc("tools/call", { name: tool, arguments: args });
    } catch (e) {
      if (capture) unanswered++;
      return { ok: false, error: `no answer (${errorKind(e)})` };
    } finally {
      inHand = false;
    }
    if (capture && (a.status !== 200 || !a.msg)) unanswered++;
    const o = outcomeOf(a.status, a.msg, tool);
    if (o.id) record(o.id);
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

  const samples: Sample[] = [];
  const timed = async (kind: Kind, i: number, fn: () => Promise<Outcome>) => {
    const ts = new Date().toISOString();
    const t0 = performance.now();
    let o: Outcome;
    try { o = await fn(); } catch (e) { o = { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) }; }
    const s: Sample = { label, kind, i, ts, ms: performance.now() - t0, ...o };
    samples.push(s);
    appendFileSync(out, JSON.stringify(s) + "\n");
  };

  // The run's probes go, whatever ended it: first those it recorded, then any whose ids never came back.
  const cleanUp = async () => {
    const left: string[] = [];
    let down: string | null = null; // the first cleanup call that got no answer: the brain is gone, so the rest are not tried
    for (const id of probes) {
      if (down) { left.push(`${id} (not tried)`); continue; }
      try {
        const a = await rpc("tools/call", { name: "delete_thought", arguments: { id } }, QUICK_MS);
        const o = outcomeOf(a.status, a.msg, "delete_thought");
        if (o.ok) deleted.add(id);
        else left.push(`${id} (${o.error})`);
      } catch (e) {
        down = errorKind(e);
        left.push(`${id} (no answer: ${down})`);
      }
    }
    // A capture cut off at its deadline, or whose connection dropped, may have landed without its id coming back: the
    // server finishes a call its client abandoned. Search by content, read each hit back, and delete the ones whose text
    // is this run's probe (isRunProbe), never a thought that only quotes one.
    let found = 0;
    let problem: string | null = null;
    if (!down && made > 0) {
      try {
        const candidates: string[] = [];
        for (let offset = 0; ; offset += 100) {
          const a = await rpc("tools/call", { name: "search_thoughts_keyword", arguments: { query: probeQuery(label), limit: 100, offset } }, QUICK_MS);
          const o = outcomeOf(a.status, a.msg, "search_thoughts_keyword");
          if (!o.ok) { problem = `the search for unrecorded probes failed (${o.error})`; break; }
          const sc = a.msg?.result?.structuredContent ?? {};
          const hits: unknown[] = Array.isArray(sc.hits) ? sc.hits : [];
          for (const h of hits) {
            const id = (h as { id?: unknown })?.id;
            if (typeof id === "string" && !probes.includes(id)) candidates.push(id);
          }
          if (hits.length < 100 || offset + hits.length >= Number(sc.total)) break;
          if (offset >= 900) { problem = `the search for unrecorded probes read the first 1,000 of ${sc.total} matches only`; break; }
        }
        for (const id of candidates) {
          const f = await rpc("tools/call", { name: "fetch", arguments: { id } }, QUICK_MS);
          const text = outcomeOf(f.status, f.msg, "fetch").ok ? f.msg?.result?.structuredContent?.text : undefined;
          if (typeof text !== "string" || !isRunProbe(text, label, since)) continue;
          found++;
          const d = await rpc("tools/call", { name: "delete_thought", arguments: { id } }, QUICK_MS);
          const o = outcomeOf(d.status, d.msg, "delete_thought");
          if (o.ok) deleted.add(id);
          else left.push(`${id}, found by content (${o.error})`);
        }
      } catch (e) {
        problem = `the search for unrecorded probes got no answer (${errorKind(e)})`;
      }
    }

    const recordedGone = probes.filter((id) => deleted.has(id)).length;
    const foundGone = deleted.size - recordedGone;
    console.log(`  probes deleted: ${recordedGone} of ${probes.length} recorded${found ? `, and ${foundGone} of ${found} found by content, whose ids never came back` : ""}`);
    if (left.length) {
      console.log(`  NOT deleted: ${left.join(", ")} — delete each with delete_thought (recorded ids are in ${ids})`);
      process.exitCode = 1;
    }
    if (down) console.log(`  the brain stopped answering (${down}): the rest were not tried, and the search for unrecorded probes was not run`);
    if (problem) console.log(`  ${problem}`);
    if (unanswered > found) {
      console.log(`  ${unanswered - found} capture(s) got no answer and were not found: each may land yet; later, ${hint}`);
      process.exitCode = 1;
    }
  };

  let cut: Signal | null = null; // the signal that cut the run short, if one did
  try {
    // Warm-up, untimed: each kind the run times, once, so no timed call loads a model; a failure is said, not hidden.
    const warmFailures: string[] = [];
    const warm = async (kind: Kind, fn: () => Promise<Outcome>) => {
      try {
        const o = await fn();
        if (!o.ok) warmFailures.push(`${kind}: ${o.error ?? "not ok"}`);
      } catch (e) {
        warmFailures.push(`${kind}: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      }
    };
    if (!stopping && want.search > 0) await warm("search", call("search_thoughts", { query: "warm-up query for the latency harness", limit: 10 }));
    if (!stopping && want.embed > 0) await warm("embed", embedOne("warm-up embedding for the latency harness"));
    if (!stopping && want.capture > 0) await warm("capture", call("capture_thought", { content: probeText(`${label} warm-up`, 0) }));
    if (!stopping && want.metadata > 0) await warm("metadata", metadataOne(probeText(`${label} warm-up`, 1)));
    if (warmFailures.length) console.error(`  warm-up failed — the first timed calls may load a model: ${warmFailures.join("; ")}`);

    const order = schedule(want);
    let ran = 0;
    for (const { kind, i } of order) {
      if (stopping) break;
      if (kind === "search") await timed(kind, i, call("search_thoughts", { query: QUERIES[i % QUERIES.length], limit: 10 }));
      else if (kind === "embed") await timed(kind, i, embedOne(EMBED_QUERIES[i % EMBED_QUERIES.length]));
      else if (kind === "capture") await timed(kind, i, call("capture_thought", { content: probeText(label, i) }));
      else await timed(kind, i, metadataOne(probeText(label, 1000 + i)));
      ran++;
    }
    cut = ran < order.length ? stopping : null;

    console.log(`\n  ${label.padEnd(16)}  n   ok   p50 ms   p90 ms   p95 ms   max ms   (of the ok calls)${cut ? "   (stopped early)" : ""}`);
    for (const kind of ["search", "capture", "embed", "metadata"] as Kind[]) {
      const mine = samples.filter((s) => s.kind === kind);
      const ok = mine.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
      const f = (v: number) => (Number.isNaN(v) ? "-" : Math.round(v).toString()).padStart(8);
      console.log(`  ${kind.padEnd(16)}${String(mine.length).padStart(3)}  ${String(ok.length).padStart(3)} ${f(percentile(ok, 50))} ${f(percentile(ok, 90))} ${f(shownP95(ok))} ${f(ok[ok.length - 1] ?? NaN)}`);
    }
    const failed = samples.filter((s) => !s.ok);
    if (failed.length) console.log(`  failures: ${failed.map((s) => `${s.kind}#${s.i} ${s.status ?? ""} ${s.error ?? ""}`.trim()).join("; ")}`);
  } finally {
    if (keep) {
      console.log(`  probes kept: ${probes.length} recorded (ids in ${ids})${unanswered ? `; ${unanswered} capture(s) got no answer and may have landed unrecorded: ${hint}` : ""}`);
    } else {
      await cleanUp();
    }
    // A probe left beats the signal: exit 1 says there is something to clean up.
    if (cut && process.exitCode === undefined) process.exitCode = 128 + SIGNALS[cut];
  }
}

/** The pure parts, checked without a brain or a provider: what CI runs (--self-check). */
export function selfCheck(): number {
  let bad = 0;
  const ok = (cond: boolean, what: string) => { if (!cond) { bad++; console.log(`  FAIL ${what}`); } };

  // The answer reader and the ok rule: hand-built transport replies, then the server's own capture replies (renderCapture).
  const res = (o: object) => JSON.stringify({ jsonrpc: "2.0", id: 7, ...o });
  const transport: [string, number, string, boolean][] = [
    ["an empty 200", 200, "", false],
    ["a keepalive-only stream", 200, ": keepalive\n\n", false],
    ["a proxy's HTML page", 200, "<html><body>proxy error</body></html>", false],
    ["SSE data: with no space", 200, "event: message\ndata:" + res({ result: { content: [{ type: "text", text: "hits" }] } }), true],
    ["a notification after the result", 200, "data: " + res({ result: { content: [] } }) + "\n\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n", true],
    ["an answer to another request only", 200, JSON.stringify({ jsonrpc: "2.0", id: 6, result: { content: [] } }), false],
    ["a JSON-RPC error", 200, res({ error: { code: -32602, message: "bad" } }), false],
    ["a tool's refusal", 200, res({ result: { isError: true, content: [{ type: "text", text: "refused" }] } }), false],
    ["an HTTP 503", 503, res({ result: { content: [] } }), false],
  ];
  for (const [name, status, body, expectOk] of transport) {
    const o = outcomeOf(status, answerTo(body, 7), "search_thoughts");
    ok(o.ok === expectOk, `${name}: ok is ${o.ok}, expected ${expectOk}`);
  }
  // A search answered without a vector is degraded, not a latency sample (SMD-2891, review pass 4).
  const literalOnly = outcomeOf(200, answerTo("data: " + res({ result: { content: [{ type: "text", text: "Found 1 thought(s)" }], structuredContent: { vectorFailed: "provider_503" } } }), 7), "search_thoughts");
  ok(!literalOnly.ok && /degraded: answered by exact literals alone, the embedding provider down \(provider_503\)/.test(literalOnly.error ?? ""), `a search answered by literals alone is degraded (${literalOnly.error})`);

  const id = "0c057ac3-bad2-4621-b74c-4a394bbf2b7b";
  const base = {
    id, existed: false as boolean | undefined, reader: true,
    tags: { topics: ["sleep"], type: "observation" } as Record<string, unknown>,
    embeddings: { allowed: true } as Record<string, unknown>, chat: { allowed: true, base: "http://provider/v1" } as Record<string, unknown>,
    chunks: 0, contextFailures: 0, headWindow: null, recapture: null,
  };
  const replyBody = (reply: unknown) => `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 7, result: reply })}\n\n`;
  const captured = (over: Record<string, unknown>) => replyBody(renderCapture(okOutcome({ ...base, ...over } as never)));
  const gate = { allowed: false, base: "http://provider/v1", reason: "the egress gate refuses the chat endpoint" };
  // [case, reply body, ok, the id comes back for deletion]. Each of TAGGING_FAILED's four wordings decides one case alone.
  const captures: [string, string, boolean, boolean][] = [
    ["a capture, tagged", captured({}), true, true],
    ["tagging timed out (SMD-2888)", captured({ tags: metadataUnavailable("provider_timeout") }), false, true],
    ["tagging got a 503", captured({ tags: metadataUnavailable("provider_503") }), false, true],
    ["tagging got a 429, to a key that cannot read", captured({ tags: metadataUnavailable("provider_429"), existed: undefined, reader: false }), false, true],
    ["tagging refused by the egress gate", captured({ tags: metadataRefused(), chat: gate }), false, true],
    ["tagging refused by the egress gate, to a key that cannot read", captured({ tags: metadataRefused(), chat: gate, existed: undefined, reader: false }), false, true],
    ["tagging fell back to placeholders", captured({ tags: { topics: ["uncategorized"], type: "observation", metadata_extraction_failed: "provider_400" } }), false, true],
    ["saved without a vector: the call refused", captured({ embeddings: { allowed: false, reason: "egress off" } }), false, true],
    ["saved without a vector: the provider failed (SMD-2888)", captured({ vectorFailed: { reason: "provider_timeout", detail: "timed out", base: "http://provider/v1" } }), false, true],
    ["a re-capture of text already held", captured({ existed: true }), false, false],
    ["a re-capture whose tagging failed", captured({ tags: metadataUnavailable("provider_unreachable"), existed: true }), false, false],
    ["saved, but its vector did not attach (a refusal)", replyBody(renderCapture(refuse({ code: "EMBEDDING_NOT_ATTACHED", retryable: true, id, detail: "store error" }) as never)), false, true],
    ["a capture answered without an id", replyBody({ content: [{ type: "text", text: "Captured." }], structuredContent: { embeddingCall: true, chunks: 0, contextFailures: 0, text: "Captured." } }), false, false],
  ];
  for (const [name, body, expectOk, expectId] of captures) {
    const o = outcomeOf(200, answerTo(body, 7), "capture_thought");
    ok(o.ok === expectOk, `${name}: ok is ${o.ok}, expected ${expectOk}`);
    ok((o.id === id) === expectId, `${name}: the id ${expectId ? "comes back for deletion" : "is never deleted"}`);
    if (name.startsWith("a re-capture")) ok(/^a re-capture/.test(o.error ?? ""), `${name}: the failure says it was a re-capture, kept rather than deleted`);
  }

  // The probes the cleanup deletes by content: this run's, never a thought that quotes one, another label's or an earlier run's.
  const since = Date.now();
  const mine = probeText("baseline", 3);
  ok(isRunProbe(mine, "baseline", since), "this run's probe is one");
  ok(isRunProbe(probeText("baseline warm-up", 0), "baseline", since), "so is its warm-up's");
  ok(isRunProbe(`${INGESTED_NOTICE}\n\n${mine}`, "baseline", since), "so is one that fetch returns with the ingested notice");
  ok(!isRunProbe(probeText("extract1", 3), "baseline", since), "another label's probe is not");
  ok(!isRunProbe(probeText("baseline2", 3), "baseline", since), "nor one whose label only starts with this run's");
  ok(!isRunProbe(`Notes on the run: ${mine}`, "baseline", since), "nor a thought that quotes a probe");
  ok(!isRunProbe(mine.replace(PROBE_PREFIX, PROBE_PREFIX.toLowerCase()), "baseline", since), "nor one in another case (the search ignores case)");
  ok(!isRunProbe(mine, "baseline", since + 60_000), "nor one made before the run started (an earlier run's leftover)");
  ok(isRunProbe(probeText("a+b (x)", 1), "a+b (x)", since) && !isRunProbe(probeText("aab (x)", 1), "a+b (x)", since), "a label is matched as text, not as a pattern");
  for (const label of ["baseline", "a+b (x)"]) {
    ok(probeText(label, 3).includes(probeQuery(label)) && probeText(`${label} warm-up`, 0).includes(probeQuery(label)), `the search for ${label}'s probes finds its probes and its warm-up's`);
  }

  // Percentiles by nearest rank, and the p95 a summary prints.
  ok(Number.isNaN(percentile([], 50)), "no samples: NaN");
  ok(percentile([5], 95) === 5, "one sample is every percentile");
  const twelve = Array.from({ length: 12 }, (_, i) => i + 1);
  ok(percentile(twelve, 95) === 12 && percentile(twelve, 50) === 6, "n=12: p95 is the slowest call, p50 the 6th");
  const nineteen = Array.from({ length: 19 }, (_, i) => i + 1);
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
  ok(Number.isNaN(shownP95(nineteen)) && shownP95(twenty) === 19, "p95 is printed from 20 samples up: n=19 none, n=20 the 19th");

  // The schedule: every owed call exactly once, in index order; each kind starts in the first tenth of the run and ends in the last.
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
  for (const k of ["search", "capture", "embed", "metadata"] as Kind[]) {
    const at = full.flatMap((o, j) => (o.kind === k ? [j] : []));
    ok(at[0] < full.length * 0.1 && at[at.length - 1] > full.length * 0.9, `${k} starts in the run's first tenth and ends in its last`);
  }

  // The tier guard, the banner, and what a failed call prints.
  ok(tierRefusal("canary") === null && tierRefusal("working") === null, "the canary and a working brain may be benched");
  ok(tierRefusal("stable") !== null && tierRefusal(null) !== null && tierRefusal(undefined) !== null && tierRefusal("") !== null, "stable (tier stable, or none) is refused, as is any brain with no tier");
  ok(shownUrl("http://127.0.0.1:8010/canary/mcp?key=SECRET") === "http://127.0.0.1:8010/canary/mcp", "the banner never prints a URL's query");
  // The connector: its header's key, else the one on its url; its url unless --mcp names one (SMD-3101).
  const conn = (entry: unknown, mcp?: string) => { try { return connectorOf(entry, "c", mcp); } catch (e) { return (e as Error).message; } };
  const same = (a: unknown, b: object) => JSON.stringify(a) === JSON.stringify(b);
  ok(same(conn({ url: "http://h:8011/mcp", headers: { "x-brain-key": "H" } }), { mcp: "http://h:8011/mcp", key: "H" }), "a connector's url and its header's key");
  ok(same(conn({ url: "http://h:8011/mcp?key=Q" }), { mcp: "http://h:8011/mcp?key=Q", key: "Q" }), "with no header, the key on its url, as canary.sh reads one");
  ok(same(conn({ url: "http://h:8011/mcp?key=Q", headers: { "x-brain-key": "H" } }), { mcp: "http://h:8011/mcp?key=Q", key: "H" }), "the header's key wins over the url's");
  ok(same(conn({ url: "http://h:8011/mcp", headers: { "x-brain-key": "H" } }, "http://o:8000/mcp"), { mcp: "http://o:8000/mcp", key: "H" }), "--mcp names the endpoint, the entry the key");
  ok(conn({ url: "http://h:8011/mcp" }) === `~/.claude.json has no key for mcpServers["c"], in an x-brain-key header or on its url`, "no key anywhere is refused");
  ok(conn({ headers: { "x-brain-key": "H" } }) === `~/.claude.json has no url for mcpServers["c"]; give --mcp`, "no url and no --mcp is refused");
  ok(typeof conn(undefined) === "string", "no such entry is refused");
  ok(shownUrl("http://user:SECRET@host:8000/mcp") === "http://host:8000/mcp", "the banner never prints a URL's userinfo");
  ok(shownUrl("not a url") === "(an endpoint that does not parse)", "an endpoint that does not parse is not echoed");
  const refused = Object.assign(new TypeError("ECONNREFUSED: Unable to connect. Is the computer able to access the url?"), { code: "ECONNREFUSED", path: "http://127.0.0.1:9/mcp?key=SECRET", errno: 0 });
  ok(errorKind(refused) === "TypeError ECONNREFUSED", "a call that failed is said by its kind, never its message or its path (Bun's carries the URL, ?key= and all)");
  ok(errorKind(new DOMException("The operation timed out.", "TimeoutError")) === "TimeoutError", "a call cut off at its deadline is said as TimeoutError");

  // The probes and the queries. (The flags are cli.ts's, held by test-cli.ts.)
  ok(probeText("x", 1).startsWith(PROBE_PREFIX), "every probe starts with the prefix a keyword search finds");
  ok(QUERIES.length > 0 && EMBED_QUERIES.length > 0 && !QUERIES.some((q) => EMBED_QUERIES.includes(q)), "the direct embeds' queries are none of the searches'");

  console.log(bad === 0 ? "bench-live.ts self-check PASS" : `bench-live.ts self-check: ${bad} FAILED`);
  return bad === 0 ? 0 : 1;
}

if (import.meta.main) await main();
