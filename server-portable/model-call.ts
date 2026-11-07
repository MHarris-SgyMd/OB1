/**
 * model-call.ts — the one seam every model call goes through (SMD-3379 PR 2a).
 *
 * Each call to a model provider — an embedding, a chat completion, the typed-
 * decision tier's /decide or /info, and the one-token probes the workers and
 * preflight make — runs as `modelCall(call, run)`: `call` says what it is, and
 * `run` is the whole exchange, the request and the reading of its answer, a
 * streamed one included. The seam calls `run` at once unless a hook is set
 * (`setModelCallHook`); PR 2b's hook holds background calls to a share of the
 * model server's slots (draft 5's fixed shares, SMD-3034's host rule), PR 3's
 * asks the federated coordinator's slot service.
 *
 * So `run` does what the hook's wait must not eat into: it starts the call's
 * deadline itself (AbortSignal.timeout inside it, not before), and a caller's
 * stop is handed in as `call.signal`, which a hook waiting for a slot honours.
 * Two exceptions: a caller that starts its own deadline and hands it in as the
 * signal — db/consolidate.ts's per-pair bound, judgePair's and decidePair's
 * caller — has it running before the seam, so a hook's wait would count
 * against it, were the bound not paused while the pair's calls wait (PR 2b-1:
 * db/lease.ts's pausableTimeout); and preflight's probes read their answer's
 * small body after the seam, which covers the call to its headers.
 *
 * Live or background (`cls`): a call made while a request is served is live —
 * the REST core runs each request inside `asLive` (rest/app.ts) — and every
 * other is background: the sleep scheduler's passes, board-sync, the CLI
 * scripts, and the servers' own timers (the vector mender, the provider
 * reprobe), which run outside any request. Work a request starts and nobody
 * waits on is background too: a detached job (jobs.ts runs it `asBackground`)
 * and a webhook's deferred work (core/plugins.ts). A webhook's discard stays
 * live, since it runs before the delivery's 500 — unless it is deferred after
 * the handler failed, which the 500 does not wait on. A call may still say its
 * class outright.
 *
 * Two more things the context carries, for PR 2b's and 2c's hooks: the pass a
 * call belongs to (`asPass`, which each claim worker's run sets: `extract`,
 * `consolidate`, `reembed`; and the subject sweep's, `subjects`, SMD-3306 PR 6b-2),
 * so a hook can order the passes' calls; and an observer told when a call
 * starts waiting on the hook — the hook says so, through the `waiting` it is
 * handed, where it queues, defers or finds no slot free — and when it runs
 * (`withCallWaits`), so a worker's clocks — N12's call in hand, extraction's
 * stall — do not count a wait for a slot as the call's time (review pass 3),
 * and a stopping pass gives back only a call that waits (PR 2b-1, its review
 * pass 6).
 *
 * Each call is measured here (PR 2b-2a): its own time a point on
 * `ob1.model.call.duration`, a slot hook's wait one on
 * `ob1.model.slot.wait.duration` (noteSlotWait), where a process installed
 * telemetry; and in this process's tallies by pass (modelCallTallies), which
 * a follower's pass stamp carries, where none runs. A one-shot worker run, the
 * weekly digest and the evals stamp nothing, so theirs are measured nowhere.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { faultOf, modelLabel, recordPoint, serverOf, statusType, type HistogramSpec, type SpanAttributes } from "./spans.ts";

/** The model server a call reaches, by what it is asked: embeddings, a chat completion, or a typed decision (jev). */
export type ModelType = "embed" | "chat" | "decide";

/** Who waits on a call: a request being served (`live`), or nobody (`background`). */
export type CallClass = "live" | "background";

export type ModelCall = {
  type: ModelType;
  /** The model asked for, as the request names it; undefined where the endpoint picks (the decide tier without OB1_JEV_MODEL). */
  model: string | undefined;
  /** The endpoint's base URL, without the call's path (`…/v1`, not `…/v1/embeddings`): the model server, which PR 2b's slots are kept per. */
  base: string;
  /** What the call is for — a short word for a log line and a test: `capture`, `extraction`, `judge`, `probe`… */
  purpose: string;
  /** Set to say the class outright; else the context's (asLive / asBackground), background by default. */
  cls?: CallClass;
  /** The caller's stop: a hook waiting for a slot ends its wait on it, as the call would. */
  signal?: AbortSignal;
};

/** A call as a hook sees it: its class settled, and the pass it belongs to (undefined outside one: a request, a timer, a script). */
export type ResolvedModelCall = Omit<ModelCall, "cls"> & { cls: CallClass; pass: string | undefined };

/** Told when a call starts waiting on the hook, and when it starts running (or ends without having run). */
export type CallWaits = { waiting(): void; running(): void };

/**
 * Runs a call: `run` at once, or after whatever the hook waits for, and around it. `waiting` the hook calls as it
 * starts to wait — queued, deferring, or its slot not free — so the call's observer counts a wait only where there is
 * one (SMD-3379 PR 2b-1, review pass 6: told before every hook, a stopping pass gave back calls that never waited).
 */
export type ModelCallHook = <T>(call: ResolvedModelCall, run: () => Promise<T>, waiting: () => void) => Promise<T>;

const context = new AsyncLocalStorage<{ cls?: CallClass; pass?: string; waits?: CallWaits }>();
let hook: ModelCallHook | null = null;

/** Sets the hook every model call goes through, or clears it (null). Returns the one it replaced, for a test to restore. */
export function setModelCallHook(next: ModelCallHook | null): ModelCallHook | null {
  const before = hook;
  hook = next;
  return before;
}

/** The class a call made here gets: the context's, background outside any. */
export function currentCallClass(): CallClass {
  return context.getStore()?.cls ?? "background";
}

/** Runs `fn` with every model call it makes counted live: a request being served. */
export function asLive<T>(fn: () => T): T {
  return context.run({ ...context.getStore(), cls: "live" }, fn);
}

/** Runs `fn` with every model call it makes counted background, whatever context it was started from. */
export function asBackground<T>(fn: () => T): T {
  return context.run({ ...context.getStore(), cls: "background" }, fn);
}

/**
 * Runs `fn` with every model call it makes belonging to `pass`: a claim worker's run, or the subject sweep's. A pass's
 * name is lower case and hyphens, at most 40 characters: brain_info reads a stamp's `models` by it, and leaves the
 * whole field off at any other (review pass 2).
 */
export function asPass<T>(pass: string, fn: () => T): T {
  return context.run({ ...context.getStore(), pass }, fn);
}

/** Runs `fn` with `waits` told of each of its model calls' wait on the hook: a worker's thought in hand. */
export function withCallWaits<T>(waits: CallWaits, fn: () => T): T {
  return context.run({ ...context.getStore(), waits }, fn);
}

/**
 * A model call's own time, in seconds, from when its exchange starts — a wait for a slot is not in it — for every
 * call through the seam, labelled with its purpose and pass, where telemetry runs: the servers, beside the provider's
 * `gen_ai.client.operation.duration` point. Extraction's, the judge's and the writer's calls, which record no such point,
 * run in the workers, which export nothing: theirs are the stamp's tallies (SMD-3379 PR 2b-2a, its review pass 1).
 * The GenAI conventions' bounds, as spans.ts's.
 */
export const CALL_DURATION: HistogramSpec = {
  unit: "s",
  description: "How long each model call took once it ran, through the model-call seam (SMD-3379)",
  bounds: [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92, 163.84, 327.68],
};

/** A background call's wait for a slot of its share on the hook, in seconds, however it ended (SMD-3379 PR 2b-2a). */
export const SLOT_WAIT: HistogramSpec = {
  unit: "s",
  description: "How long a background model call waited for a slot of its share (SMD-3379)",
  bounds: [0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
};

/** How a wait for a slot ended: a slot taken, the call run without one (the semaphore failed open), or a stop. */
export type SlotWaitEnd = "held" | "open" | "stopped";

/**
 * One pass's model calls in this process since it started — `-` for calls of no pass: a timer's, a request's, a
 * script's — what its pass stamp carries, where no telemetry runs (SMD-3379 PR 2b-2a): the calls by class and their
 * own time, and the waits for a slot by how each ended, their time in all and the longest.
 */
export type ModelCallTally = {
  calls: Record<CallClass, number>;
  callMs: number;
  /** Each ask for a slot by how it ended, how many of them waited at all — the rest took a slot at once — their time in all and the longest. */
  slotWaits: Record<SlotWaitEnd, number> & { waited: number; totalMs: number; maxMs: number };
};
const tallies = new Map<string, ModelCallTally>();
function tallyOf(pass: string | undefined): ModelCallTally {
  const key = pass ?? "-";
  let t = tallies.get(key);
  if (!t) tallies.set(key, (t = { calls: { live: 0, background: 0 }, callMs: 0, slotWaits: { held: 0, open: 0, stopped: 0, waited: 0, totalMs: 0, maxMs: 0 } }));
  return t;
}

/** This process's tallies so far, by pass: a copy, whole numbers of milliseconds. */
export function modelCallTallies(): Record<string, ModelCallTally> {
  const out: Record<string, ModelCallTally> = {};
  for (const [pass, t] of tallies) {
    out[pass] = {
      calls: { ...t.calls },
      callMs: Math.round(t.callMs),
      slotWaits: { ...t.slotWaits, totalMs: Math.round(t.slotWaits.totalMs), maxMs: Math.round(t.slotWaits.maxMs) },
    };
  }
  return out;
}

/** The labels a call's points carry: its type, model and server, never the base's userinfo or path; its pass where it has one. */
function labelsOf(call: ResolvedModelCall): SpanAttributes {
  return { "ob1.model.type": call.type, "gen_ai.request.model": modelLabel(call.model), ...serverOf(call.base), ...(call.pass ? { "ob1.pass": call.pass } : {}) };
}

/**
 * An ask for a slot ended, `ms` long: a point, and its pass's tally — `waited` where the hook said it waited, apart
 * from a slot taken at once (review pass 1: every ask read as a wait). The background-slots hook's (slots.ts).
 */
export function noteSlotWait(call: ResolvedModelCall, ms: number, end: SlotWaitEnd, waited: boolean): void {
  recordPoint("ob1.model.slot.wait.duration", SLOT_WAIT, ms / 1000, () => ({ ...labelsOf(call), "ob1.slot.outcome": end, "ob1.slot.waited": waited }));
  const w = tallyOf(call.pass).slotWaits;
  w[end] += 1;
  if (waited) w.waited += 1;
  w.totalMs += ms;
  w.maxMs = Math.max(w.maxMs, ms);
}

/**
 * How a call failed, in the provider point's words — embed.ts's providerErrorType, in its order, read by shape (this
 * module imports neither embed.ts nor jev.ts): a ProviderError's answer status (`503`, `_OTHER`), `invalid_body` for
 * a 2xx that is no JSON, its own kind (`timeout`, `egress`); another throw's status (a 429 a caller's own error
 * carries); else the runtime's code (`ECONNREFUSED`) or the throw's kind — so an overload is told from a timeout and
 * a body (review pass 1: every ProviderError read `ProviderError`; pass 2: a body's 200 read `_OTHER`, and any
 * throw's `kind` was a label).
 */
const PROVIDER_KINDS: readonly unknown[] = ["timeout", "http", "body", "egress"];
function errorTypeOf(e: unknown): string {
  try {
    const { name, kind, status } = (e ?? {}) as { name?: unknown; kind?: unknown; status?: unknown };
    const hasStatus = typeof status === "number" && Number.isInteger(status);
    if (e instanceof Error && name === "ProviderError" && PROVIDER_KINDS.includes(kind)) {
      if (kind === "http") return hasStatus ? statusType(status as number) : "http";
      return kind === "body" ? "invalid_body" : (kind as string);
    }
    if (hasStatus) return statusType(status as number);
  } catch {}
  const f = faultOf(e);
  return f.code ?? f.kind;
}

/** `run`, timed from when it starts: a point, and its pass's tally, whether it answers or throws. */
function timed<T>(call: ResolvedModelCall, run: () => Promise<T>): () => Promise<T> {
  return async () => {
    const started = performance.now();
    let failed: unknown;
    let threw = false;
    try {
      return await run();
    } catch (e) {
      threw = true;
      failed = e;
      throw e;
    } finally {
      const ms = performance.now() - started;
      recordPoint("ob1.model.call.duration", CALL_DURATION, ms / 1000, () => ({
        ...labelsOf(call), "ob1.call.class": call.cls, "ob1.call.purpose": call.purpose, ...(threw ? { "error.type": errorTypeOf(failed) } : {}),
      }));
      const t = tallyOf(call.pass);
      t.calls[call.cls] += 1;
      t.callMs += ms;
    }
  };
}

/** One model call: `run` is the whole exchange, its deadline started inside it; through the hook when one is set. */
export function modelCall<T>(call: ModelCall, plain: () => Promise<T>): Promise<T> {
  const { cls, ...rest } = call;
  const store = context.getStore();
  const resolved: ResolvedModelCall = { ...rest, cls: cls ?? store?.cls ?? "background", pass: store?.pass };
  // A class the call names, unlike its context's, is the one its provider span reads too (review pass 1).
  const run = timed(resolved, cls !== undefined && cls !== store?.cls ? () => context.run({ ...store, cls }, plain) : plain);
  if (hook === null) return run();
  // The wait on the hook told to the worker's observer: waiting when the hook says it waits, running when it runs the
  // call — or, if the call ended without running (refused, stopped), running then, so its clocks start from there
  // (review pass 3). A call the hook runs at once is told neither (PR 2b-1, its review pass 6).
  const waits = store?.waits;
  let told = false, ran = false;
  const waiting = () => {
    if (!waits || told || ran) return;
    told = true;
    waits.waiting();
  };
  const running = () => {
    ran = true;
    if (told) waits?.running();
    return run();
  };
  // A hook that throws before it returns its promise rejects the call, as one that rejects does (review pass 2).
  let answer: Promise<T>;
  try {
    answer = hook(resolved, running, waiting);
  } catch (e) {
    answer = Promise.reject(e);
  }
  return waits ? answer.finally(() => { if (told && !ran) waits.running(); }) : answer;
}
