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
 */
import { AsyncLocalStorage } from "node:async_hooks";

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

/** Runs `fn` with every model call it makes belonging to `pass`: a claim worker's run, or the subject sweep's. */
export function asPass<T>(pass: string, fn: () => T): T {
  return context.run({ ...context.getStore(), pass }, fn);
}

/** Runs `fn` with `waits` told of each of its model calls' wait on the hook: a worker's thought in hand. */
export function withCallWaits<T>(waits: CallWaits, fn: () => T): T {
  return context.run({ ...context.getStore(), waits }, fn);
}

/** One model call: `run` is the whole exchange, its deadline started inside it; through the hook when one is set. */
export function modelCall<T>(call: ModelCall, run: () => Promise<T>): Promise<T> {
  if (hook === null) return run();
  const { cls, ...rest } = call;
  const store = context.getStore();
  const resolved: ResolvedModelCall = { ...rest, cls: cls ?? store?.cls ?? "background", pass: store?.pass };
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
