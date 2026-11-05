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
 * In a process, one of a share's calls polls for a slot at a time, the rest
 * queued in order there, each polling and then holding its slot on a
 * connection of its own, closed once the slot is let go — so a share costs a
 * process a connection for each slot it holds and one for its poller, none
 * when idle (review passes 1 and 2: a pool opened all its connections at the
 * first call, then every queued call polled on its own). A poller holds the
 * share's WAITING lock (slot -1) shared, and a call about to make its first
 * try that finds it held elsewhere sits out a poll first, so a process with a
 * backlog, or making calls back to back, does not take every slot let go
 * before another process's poller asks again (review pass 2). A stop ends a
 * wait at once, a connect or a statement in flight included: the call's own
 * signal, or the process's (`stop`, or `uninstall`, which leaves a call
 * already running its slot until it ends). Every statement is bounded, as
 * the connect is, by 5 s: a database that stops answering fails a waiting
 * call open, and a slot's unlock gives up, the call's answer returned.
 *
 * Written as types, with per-model overrides: `chat=1,embed=2,decide=1,
 * chat:qwen3.8:27b=1`. A type left out is unlimited; unset, empty or `off`,
 * no hook is set. A value that does not parse is said and the hook is left
 * off, as other server settings fall back.
 *
 * Fail open (the maintainer, 2026-11-05): a semaphore whose database does not
 * answer lets the call run without a slot, said once, and is not asked again
 * for 30 s, so an unreachable host does not cost each call its connect timeout;
 * the worker's own database is the same one, and meets a real outage itself. A
 * database full (too many clients), or slower than 5 s to connect or answer,
 * reads as one not answering, and the whole process's calls run without a slot
 * for the 30 s. A slot's lock lost while held — its connection ended or
 * stalled, a Postgres restart — is said once, and so is an unlock that reaches
 * another backend or finds no lock: a pooler between the process and Postgres,
 * which session locks do not survive. Behind one each call's lock stays on a
 * pooled backend and the share fills for good; the stack reaches Postgres
 * directly, so no supported deployment has one. The semaphore's sessions carry
 * TCP keepalives, so one whose client went away unseen — a partition, a swallowed
 * FIN — ends, its locks with it, within about a minute.
 */
import { SQL } from "bun";
import { setModelCallHook, type ModelCallHook, type ModelType, type ResolvedModelCall } from "./model-call.ts";

/** A parsed OB1_BACKGROUND_SLOTS: each type's share, and per-model overrides keyed `type:model`. */
export type BackgroundSlots = ReadonlyMap<string, number>;

const TYPES: readonly ModelType[] = ["embed", "chat", "decide"];
/** The most slots one share may have: a model server answers a handful at once, and each slot held is a connection. */
export const MAX_SLOTS = 16;
/** How often a poller tries its share's slots again: every POLL_MS to twice it, in ms, jittered so pollers do not move in step. */
const POLL_MS = 250;
/** The application_name of the semaphore's connections. */
export const SLOTS_APP = "ob1-slots";
/**
 * How long a poller's connection may take to open, and any statement to answer,
 * in s: Bun's own bound on the connect is
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
    const type = colon < 0 ? name : name.slice(0, colon).trim();
    const model = colon < 0 ? "" : name.slice(colon + 1).trim();
    if (!(TYPES as readonly string[]).includes(type)) return bad(`names no model type (${TYPES.join(", ")})`);
    if (colon >= 0 && (model === "" || type === "decide")) return bad(type === "decide" ? "gives the decide tier a model: it is shared per model server alone" : "names no model after the colon");
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_SLOTS) return bad(`is no whole number of slots from 1 to ${MAX_SLOTS}`);
    const keyed = colon < 0 ? type : `${type}:${model}`;
    if (slots.has(keyed)) return bad("is given twice");
    slots.set(keyed, Number(value));
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

/** A statement or a connect the semaphore's database did not answer within the bound. */
class NoAnswer extends Error {
  constructor(ms: number) {
    super(`no answer in ${ms / 1000} s`);
  }
}

/**
 * `p` within `ms`, rejecting with the signal's reason once it aborts: a connect
 * or a statement the semaphore's database never answers holds up neither a stop
 * nor the call (review pass 2: a stalled connection held a call and its share
 * past every stop).
 */
function bounded<T>(p: PromiseLike<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const done = () => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); };
    const onAbort = () => { done(); reject(signal!.reason); };
    const t = setTimeout(() => { done(); reject(new NoAnswer(ms)); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { done(); resolve(v); }, (e: unknown) => { done(); reject(e); });
  });
}

/** A share's calls in this process: whether one of them polls for a slot, and those queued behind it, in order. */
type Local = { key: string; limit: number; polling: boolean; queue: { go: () => void }[] };

/** Slot -1 of a share: the lock each poller holds shared, so a call about to try can see others waiting. */
const WAITING = -1;

/**
 * Sets the background-slots hook for this process, once, at its entry point:
 * `raw` its OB1_BACKGROUND_SLOTS, `url` its database. Returns `uninstall`,
 * which puts back the hook it replaced and ends every wait, a call already
 * running keeping its slot until it ends; and the setting's problem, said
 * through `log`, the hook then left off. `connectS` bounds a connection's
 * opening and each statement, CONNECT_S unless a test asks for less.
 */
export function installBackgroundSlots(opts: { url: string; raw: string | undefined; log?: (line: string) => void; stop?: AbortSignal; connectS?: number }): { installed: boolean; problem?: string; uninstall: () => Promise<void> } {
  const log = opts.log ?? ((line: string) => console.error(line));
  const { slots, problem } = backgroundSlotsFrom(opts.raw);
  if (problem) log(problem);
  if (!slots) return { installed: false, ...(problem ? { problem } : {}), uninstall: async () => {} };
  const ended = new AbortController();
  const stop = opts.stop ? AbortSignal.any([opts.stop, ended.signal]) : ended.signal;
  const boundS = opts.connectS ?? CONNECT_S;
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
    if (!l) locals.set(key, (l = { key, limit, polling: false, queue: [] }));
    return l;
  };
  /** The share's turn to poll in this process: at once when no call of it polls, else in order; a stop takes a call out of the queue. */
  const takeTurn = (l: Local, signal: AbortSignal): Promise<void> => {
    if (!l.polling) {
      l.polling = true;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const entry = { go: () => { signal.removeEventListener("abort", onAbort); resolve(); } };
      const onAbort = () => { l.queue.splice(l.queue.indexOf(entry), 1); reject(signal.reason); };
      signal.addEventListener("abort", onAbort, { once: true });
      l.queue.push(entry);
    });
  };
  /** The turn handed to the next call queued, or given up. */
  const passTurn = (l: Local) => {
    const next = l.queue.shift();
    if (next) next.go();
    else l.polling = false;
  };
  /** A slot held: its connection, the backend that holds its lock, and whether that connection has ended since. */
  type Held = { client: SQL; key: string; slot: number; pid: number; conn: { lost: boolean } };
  /** A slot of the share, held on a connection of its own; null where the semaphore fails open. A stop rejects with its reason. */
  const acquire = async (l: Local, signal: AbortSignal): Promise<Held | null> => {
    if (Date.now() < downUntil) return null;
    await takeTurn(l, signal);
    let client: SQL | undefined;
    try {
      // Queued behind a poller that found the database down: run without a slot as well.
      if (Date.now() < downUntil) return null;
      for (;;) {
        // Built inside the try: Bun throws at once on some URLs (review pass 2). Named, so pg_stat_activity tells the
        // semaphore's connections apart; a connection ending marks its slot lost, since Bun's client reconnects quietly
        // and the unlock would reach a new session (review pass 2).
        const conn = { lost: false };
        // The keepalives end a session whose client went away unseen — a partition, a swallowed FIN — in about a
        // minute, where the OS's default left its locks, the whole share at N=1, for some two hours (review pass 3).
        const session = (client = new SQL({
          url: opts.url, max: 1, connectionTimeout: boundS, onclose: () => { conn.lost = true; },
          connection: { application_name: SLOTS_APP, tcp_keepalives_idle: "30", tcp_keepalives_interval: "10", tcp_keepalives_count: "3", tcp_user_timeout: "60000" },
        }));
        // Whether this session has answered: one the database ends after it has — a terminate, a restart — is asked
        // again on a fresh session rather than read as an outage, its queue let through for 30 s (review pass 3); a
        // session that never answers fails open.
        let answered = false;
        const ask = <T>(q: PromiseLike<T>) => bounded(q, boundS * 1000, signal).then((v) => { answered = true; return v; });
        try {
          // Others waiting for the share — a poller elsewhere holding its WAITING lock shared — and this call sits out
          // a poll before its first try, so a process with calls queued, or making them back to back, does not take
          // every slot let go before a poller elsewhere asks again (review pass 2: one process's backlog held the
          // share).
          const [w] = (await ask(session`SELECT CASE WHEN pg_try_advisory_lock(hashtext(${l.key}), ${WAITING}) THEN pg_advisory_unlock(hashtext(${l.key}), ${WAITING}) ELSE false END AS alone`)) as { alone: boolean }[];
          if (!w.alone) await wait(POLL_MS + Math.floor(Math.random() * POLL_MS), signal);
          // Whether this call holds its WAITING lock: taken with a try, again each poll, as a call checking for others
          // holds it alone for a moment.
          let marked = false;
          for (;;) {
            if (signal.aborted) throw signal.reason;
            for (let slot = 0; slot < l.limit; slot++) {
              // A connection that closed while this call waited, before any lock — a statement in flight would have
              // failed — is Bun's quiet reconnect: the new session holds no WAITING lock, and a lock it takes is no
              // lost one (review pass 3: read as a slot lost at the unlock, the waiter's mark gone).
              if (conn.lost) {
                conn.lost = false;
                marked = false;
              }
              const [r] = (await ask(session`SELECT pg_try_advisory_lock(hashtext(${l.key}), ${slot}) AS got, pg_backend_pid() AS pid`)) as { got: boolean; pid: number }[];
              if (r.got) {
                // Stopped as the lock came: the finally closes the connection, and its locks go with the session.
                if (signal.aborted) throw signal.reason;
                if (marked) await ask(session`SELECT pg_advisory_unlock_shared(hashtext(${l.key}), ${WAITING})`);
                if (saidDown) log("  background slots: the semaphore's database answers again");
                saidDown = false;
                downUntil = 0;
                const held = { client: session, key: l.key, slot, pid: r.pid, conn };
                client = undefined;
                return held;
              }
            }
            if (!marked) [{ marked }] = (await ask(session`SELECT pg_try_advisory_lock_shared(hashtext(${l.key}), ${WAITING}) AS marked`)) as { marked: boolean }[];
            await wait(POLL_MS + Math.floor(Math.random() * POLL_MS), signal);
          }
        } catch (e) {
          if (signal.aborted || !answered || e instanceof NoAnswer) throw e;
          void session.close({ timeout: 0 }).catch(() => {});
          client = undefined;
        }
      }
    } catch (e) {
      // A stop is the stop, never the database not answering (review pass 1: a shutdown read as an outage).
      if (signal.aborted) throw signal.reason;
      if (!saidDown) log(`  background slots: the semaphore's database did not answer (${(e as Error).message}) — background calls run without a slot, asked again in ${DOWN_MS / 1000} s`);
      saidDown = true;
      downUntil = Date.now() + DOWN_MS;
      return null;
    } finally {
      // Not awaited: a close waits on a connect or a statement in flight, which a stalled database never ends.
      if (client) void client.close({ timeout: 0 }).catch(() => {});
      passTurn(l);
    }
  };
  /** The slot let go, within the bound: a stalled database holds the call's answer no longer than that. */
  const release = async (held: Held): Promise<void> => {
    const lost = (why: string) => sayOnce("lost", `  background slots: a slot's connection was lost while its call ran (${why}) — the lock went with it, or will, and another call may have taken the slot meanwhile`);
    let answered = false;
    try {
      if (held.conn.lost) return lost("the connection closed");
      // Unlocked only on the backend that took the lock. Another answering is Bun's quiet reconnect after the
      // connection ended, or, the connection never closed, a pooler handing the statement to another backend.
      const [u] = (await bounded(held.client`SELECT pg_backend_pid() = ${held.pid} AS same, CASE WHEN pg_backend_pid() = ${held.pid} THEN pg_advisory_unlock(hashtext(${held.key}), ${held.slot}) END AS released`, boundS * 1000)) as { same: boolean; released: boolean | null }[];
      answered = true;
      if (u.same !== true && held.conn.lost) lost("a new session answered the unlock");
      else if (u.same !== true || u.released !== true) sayOnce("unlock", "  background slots: a slot's unlock reached another backend than its lock, or found no lock: a pooler between this process and Postgres? Session locks need a direct connection");
    } catch (e) {
      lost((e as Error).message);
    } finally {
      const closing = held.client.close({ timeout: 0 }).catch(() => {});
      if (answered) await closing;
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
