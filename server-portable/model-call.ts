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
 *
 * Live or background (`cls`): a call made while a request is served is live —
 * the REST core runs each request inside `asLive` (rest/app.ts) — and every
 * other is background: the sleep scheduler's passes, board-sync, the CLI
 * scripts, and the servers' own timers (the vector mender, the provider
 * reprobe), which run outside any request. A detached job a request starts is
 * background too (jobs.ts runs it `asBackground`). A call may still say its
 * class outright.
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
  /** The endpoint's base URL, without its path: the model server, which PR 2b's slots are kept per. */
  base: string;
  /** What the call is for — a short word for a log line and a test: `capture`, `extraction`, `judge`, `probe`… */
  purpose: string;
  /** Set to say the class outright; else the context's (asLive / asBackground), background by default. */
  cls?: CallClass;
  /** The caller's stop: a hook waiting for a slot ends its wait on it, as the call would. */
  signal?: AbortSignal;
};

/** A call as a hook sees it: its class settled. */
export type ResolvedModelCall = Omit<ModelCall, "cls"> & { cls: CallClass };

/** Runs a call: `run` at once, or after whatever the hook waits for, and around it. */
export type ModelCallHook = <T>(call: ResolvedModelCall, run: () => Promise<T>) => Promise<T>;

const context = new AsyncLocalStorage<CallClass>();
let hook: ModelCallHook | null = null;

/** Sets the hook every model call goes through, or clears it (null). Returns the one it replaced, for a test to restore. */
export function setModelCallHook(next: ModelCallHook | null): ModelCallHook | null {
  const before = hook;
  hook = next;
  return before;
}

/** The class a call made here gets: the context's, background outside any. */
export function currentCallClass(): CallClass {
  return context.getStore() ?? "background";
}

/** Runs `fn` with every model call it makes counted live: a request being served. */
export function asLive<T>(fn: () => T): T {
  return context.run("live", fn);
}

/** Runs `fn` with every model call it makes counted background, whatever context it was started from. */
export function asBackground<T>(fn: () => T): T {
  return context.run("background", fn);
}

/** One model call: `run` is the whole exchange, its deadline started inside it; through the hook when one is set. */
export function modelCall<T>(call: ModelCall, run: () => Promise<T>): Promise<T> {
  if (hook === null) return run();
  const { cls, ...rest } = call;
  return hook({ ...rest, cls: cls ?? currentCallClass() }, run);
}
