/**
 * slots.ts — background calls held to a share of a model server's slots
 * (SMD-3379 PR 2b-1): the model-call seam's hook (model-call.ts), off unless
 * OB1_BACKGROUND_SLOTS says how many.
 *
 * A model server answers a few calls at once — Ollama's OLLAMA_NUM_PARALLEL,
 * per loaded model — and live calls (a capture, a search) should find one
 * free. So each brain's background calls (its sleep passes, board-sync, its
 * servers' timers, a detached job, a webhook's deferred work, among them) are
 * held to a share: at most N at once for a model on a model server, across
 * every process of the brain, by Postgres advisory locks — slot i of a share
 * is the two-key lock (hashtext(key), i), taken with pg_try_advisory_lock and
 * held for the call, so a process that dies lets its slots go with its
 * session. A share is kept per model server (its base URL, normalised: the
 * scheme and host in lower case, no userinfo, no trailing slash, the path
 * kept) and model, the decide tier per model server alone — it answers one
 * request at a time, whatever its model. Two spellings of one server
 * (compose's host alias, a checkout's localhost) are two shares. A live call
 * never takes a slot.
 *
 * In a process, at most N of a share's calls contend for it at once, the rest
 * queued in order there; each contender polls on a connection of its own,
 * opened as it starts contending and closed once its slot is let go — so the
 * semaphore holds a connection for each call contending or running, and none
 * when idle (review pass 1: a pool opened all its connections at the first
 * call and kept them). A stop ends a wait at once: the call's own signal, or
 * the process's (`stop`, or `uninstall`, which leaves a call already running
 * its slot until it ends).
 *
 * Written as types, with per-model overrides: `chat=1,embed=2,decide=1,
 * chat:qwen3.8:27b=1`. A type left out is unlimited; unset, empty or `off`,
 * no hook is set. A value that does not parse is said and the hook is left
 * off, as other server settings fall back.
 *
 * Fail open (the maintainer, 2026-11-05): a semaphore whose database does not
 * answer lets the call run without a slot, said once, and is not asked again
 * for 30 s, so an unreachable host does not cost each call its connect
 * timeout; the worker's own database is the same one, and meets a real outage
 * itself. A slot's lock lost while held — its connection ended — and an
 * unlock the database refuses (a pooler between the process and Postgres,
 * which session locks do not survive) are each said once.
 */
import { SQL } from "bun";
import { setModelCallHook, type ModelCallHook, type ModelType, type ResolvedModelCall } from "./model-call.ts";

/** A parsed OB1_BACKGROUND_SLOTS: each type's share, and per-model overrides keyed `type:model`. */
export type BackgroundSlots = ReadonlyMap<string, number>;

const TYPES: readonly ModelType[] = ["embed", "chat", "decide"];
/** The most slots one share may have: a model server answers a handful at once, and each contending or held slot is a connection. */
export const MAX_SLOTS = 16;
/** How often a contender tries its share's slots again, in ms, a little jitter beside it so contenders do not move in step. */
const POLL_MS = 250;
/** The application_name of the semaphore's connections. */
export const SLOTS_APP = "ob1-slots";
/**
 * How long a contender's connection may take to open, in s: Bun's own bound is
 * 30 s, retrying a server that takes each connection and closes it all that
 * while, so a call would wait that long to fail open (review pass 1, measured).
 */
const CONNECT_S = 5;
/** How long a semaphore found down is not asked again, in ms: its calls run without a slot meanwhile. */
const DOWN_MS = 30_000;

/** OB1_BACKGROUND_SLOTS read: null when unset, empty or `off`; else its shares, or a problem in words. */
export function backgroundSlotsFrom(raw: string | undefined): { slots: BackgroundSlots | null; problem?: string } {
  const text = (raw ?? "").trim();
  if (text === "" || text.toLowerCase() === "off") return { slots: null };
  const slots = new Map<string, number>();
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const bad = (why: string) => ({ slots: null, problem: `OB1_BACKGROUND_SLOTS: ${JSON.stringify(part)} ${why} — write types and per-model overrides, e.g. chat=1,embed=2,decide=1,chat:qwen3.8:27b=1, or off; background slots stay off` });
    const eq = part.lastIndexOf("=");
    if (eq <= 0) return bad("has no =N");
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    const colon = name.indexOf(":");
    const type = colon < 0 ? name : name.slice(0, colon);
    const model = colon < 0 ? "" : name.slice(colon + 1);
    if (!(TYPES as readonly string[]).includes(type)) return bad(`names no model type (${TYPES.join(", ")})`);
    if (colon >= 0 && (model === "" || type === "decide")) return bad(type === "decide" ? "gives the decide tier a model: it is shared per model server alone" : "names no model after the colon");
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_SLOTS) return bad(`is no whole number of slots from 1 to ${MAX_SLOTS}`);
    if (slots.has(name)) return bad("is given twice");
    slots.set(name, Number(value));
  }
  return slots.size ? { slots } : { slots: null };
}

/** A model server's base as one share knows it: the scheme and host in lower case, no userinfo, no trailing slash, the path kept. */
export function normalisedBase(base: string): string {
  try {
    // URL lower-cases the scheme and host; built from its parts, the userinfo is left out.
    const u = new URL(base);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return base.replace(/\/+$/, "");
  }
}

/** The share a call counts against: its key and its size, or null where it is unlimited (a live call, a type left out). */
export function shareOf(slots: BackgroundSlots, call: Pick<ResolvedModelCall, "type" | "model" | "base" | "cls">): { key: string; limit: number } | null {
  if (call.cls !== "background") return null;
  const limit = (call.type !== "decide" && call.model !== undefined ? slots.get(`${call.type}:${call.model}`) : undefined) ?? slots.get(call.type);
  if (limit === undefined) return null;
  const base = normalisedBase(call.base);
  return { key: call.type === "decide" ? `ob1:slot:decide:${base}` : `ob1:slot:${call.type}:${base}:${call.model ?? "?"}`, limit };
}

/** Sleeps `ms`, ending early, rejecting with the signal's reason, when it aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A share's calls in this process: how many contend for it or hold a slot, and those queued behind them, in order. */
type Local = { key: string; limit: number; active: number; queue: { go: () => void }[] };

/**
 * Sets the background-slots hook for this process, once, at its entry point:
 * `raw` its OB1_BACKGROUND_SLOTS, `url` its database. Returns `uninstall`,
 * which puts back the hook it replaced and ends every wait, a call already
 * running keeping its slot until it ends; and the setting's problem, said
 * through `log`, the hook then left off. `connectS` bounds a connection's
 * opening, CONNECT_S unless a test asks for less.
 */
export function installBackgroundSlots(opts: { url: string; raw: string | undefined; log?: (line: string) => void; stop?: AbortSignal; connectS?: number }): { installed: boolean; problem?: string; uninstall: () => Promise<void> } {
  const log = opts.log ?? ((line: string) => console.error(line));
  const { slots, problem } = backgroundSlotsFrom(opts.raw);
  if (problem) log(problem);
  if (!slots) return { installed: false, ...(problem ? { problem } : {}), uninstall: async () => {} };
  const ended = new AbortController();
  const stop = opts.stop ? AbortSignal.any([opts.stop, ended.signal]) : ended.signal;
  /** Until when (Date.now()) the semaphore, found down, is not asked: 0 while it answers. */
  let downUntil = 0;
  let saidDown = false;
  const said = new Set<string>();
  const sayOnce = (what: string, line: string) => {
    if (said.has(what)) return;
    said.add(what);
    log(line);
  };
  const locals = new Map<string, Local>();
  const localOf = (key: string, limit: number): Local => {
    let l = locals.get(key);
    if (!l) locals.set(key, (l = { key, limit, active: 0, queue: [] }));
    return l;
  };
  /** A place among the share's contenders in this process: at once below its limit, else in order once one leaves; a stop takes it out of the queue. */
  const enter = (l: Local, signal: AbortSignal): Promise<void> => {
    if (l.active < l.limit) {
      l.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const entry = { go: () => { signal.removeEventListener("abort", onAbort); l.active++; resolve(); } };
      const onAbort = () => { l.queue.splice(l.queue.indexOf(entry), 1); reject(signal.reason); };
      signal.addEventListener("abort", onAbort, { once: true });
      l.queue.push(entry);
    });
  };
  const leave = (l: Local) => {
    l.active--;
    l.queue.shift()?.go();
  };
  type Held = { client: SQL; local: Local; slot: number };
  /** A slot of the share, held on a connection of its own; null where the semaphore fails open. A stop rejects with its reason. */
  const acquire = async (l: Local, signal: AbortSignal): Promise<Held | null> => {
    if (Date.now() < downUntil) return null;
    await enter(l, signal);
    // Queued behind a contender that found the database down: run without a slot as well.
    if (Date.now() < downUntil) {
      leave(l);
      return null;
    }
    // Named, so pg_stat_activity tells the semaphore's connections apart.
    const client = new SQL({ url: opts.url, max: 1, connectionTimeout: opts.connectS ?? CONNECT_S, connection: { application_name: SLOTS_APP } });
    try {
      for (;;) {
        if (signal.aborted) throw signal.reason;
        for (let slot = 0; slot < l.limit; slot++) {
          const [r] = (await client`SELECT pg_try_advisory_lock(hashtext(${l.key}), ${slot}) AS got`) as { got: boolean }[];
          if (r.got) {
            if (saidDown) log("  background slots: the semaphore's database answers again");
            saidDown = false;
            downUntil = 0;
            return { client, local: l, slot };
          }
        }
        await wait(POLL_MS + Math.floor(Math.random() * POLL_MS), signal);
      }
    } catch (e) {
      await client.close({ timeout: 0 }).catch(() => {});
      leave(l);
      // A stop is the stop, never the database not answering (review pass 1: a shutdown read as an outage).
      if (signal.aborted) throw signal.reason;
      if (!saidDown) log(`  background slots: the semaphore's database did not answer (${(e as Error).message}) — background calls run without a slot, asked again in ${DOWN_MS / 1000} s`);
      saidDown = true;
      downUntil = Date.now() + DOWN_MS;
      return null;
    }
  };
  const release = async (held: Held): Promise<void> => {
    try {
      const [u] = (await held.client`SELECT pg_advisory_unlock(hashtext(${held.local.key}), ${held.slot}) AS released`) as { released: boolean }[];
      if (u.released !== true) sayOnce("unlock", "  background slots: a slot's unlock was refused — its lock is on another session: a pooler between this process and Postgres? Session locks need a direct connection");
    } catch (e) {
      sayOnce("lost", `  background slots: a slot's connection ended while its call ran (${(e as Error).message}) — the lock went with it, and another call may have taken the slot meanwhile`);
    } finally {
      await held.client.close({ timeout: 0 }).catch(() => {});
      leave(held.local);
    }
  };
  const hook: ModelCallHook = async (call, run) => {
    const share = shareOf(slots, call);
    if (!share) return run();
    const held = await acquire(localOf(share.key, share.limit), call.signal ? AbortSignal.any([call.signal, stop]) : stop);
    try {
      return await run();
    } finally {
      if (held) await release(held);
    }
  };
  const before = setModelCallHook(hook);
  return {
    installed: true,
    uninstall: async () => {
      setModelCallHook(before);
      ended.abort(new Error("background slots: the process is stopping"));
    },
  };
}
