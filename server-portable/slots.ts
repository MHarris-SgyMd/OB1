/**
 * slots.ts — background calls held to a share of a model server's slots
 * (SMD-3379 PR 2b-1): the model-call seam's hook (model-call.ts), on by
 * default since PR 2b-2b for a local model server, OB1_BACKGROUND_SLOTS
 * setting shares of its own or `off`.
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
 * In a process, one of a share's calls waits for a slot at a time, the rest
 * queued in order there, each waiting and then holding its slot on a connection
 * of its own — so a share costs a process a connection for each slot it holds
 * and one for its waiter (review passes 1 and 2: a pool opened all its
 * connections at the first call, then every queued call polled on its own). A
 * connection that lets its slot go cleanly is kept 2 s for the process's next
 * call, at most four of them, then closed: none when idle (review pass 5).
 *
 * Across processes the share is a queue (PR 2c-1): a process's waiting call
 * takes the share's queue lock (slot -1 less the share's size, -2 at N=1)
 * with pg_advisory_lock, which Postgres grants in the order asked, so the
 * processes' calls reach the slots in turn, one at a time from each — a
 * process with a backlog, or making calls back to back, joins the queue behind
 * a call another process already has in it. The queue's holder, at its head,
 * tries the slots, and with none free waits for one let go: a release that
 * finds another process's call at the head tells it on the ob1_slots channel
 * (NOTIFY, the share's key the payload), this process's own head woken
 * directly, so a slot let go goes to the head at once, not a poll later (2b's
 * polls left two re-embed followers' share half idle: 2b-1's record and
 * 2b-2b's). The head tries again every second or two all the same: a process
 * that dies, or one from before PR 2c-1, lets its slot go untold. It hears the
 * channel on a connection of the process's own, opened at its first wait and
 * closed 2 s after the process's last, as a live subscription holds a process
 * open; one that fails to open is said once and asked again at a head's round
 * 2 s or more on, and one found deaf — a ping of the process's own, sent at a
 * nap no release ended, not heard back by a later one — is dropped, said
 * once, and subscribed again; a ping is judged a second or more after it
 * was sent, as another share's head may look while it is on its way. The
 * head takes its slot and lets the queue go, its next waiter's turn.
 * Processes counting a share's slots differently queue apart, each size
 * its own queue. A stop ends a wait at once, a connect or a statement in
 * flight included: the call's own signal, or the process's
 * (`stop`, or `uninstall`, which leaves a call already running its slot until
 * it ends); a wait in the queue is cancelled on the server (pg_cancel_backend,
 * from a connection of its own: Bun's own cancel leaves the server waiting,
 * and a close waits for the statement). Every statement but the wait in the
 * queue is bounded, as the connect is, by 5 s: a database that stops answering
 * fails a waiting call open, and a slot's unlock gives up, the call's answer
 * returned. The wait in the queue is as long as the calls ahead of it, and a
 * slot's session sits idle while its call runs, so the semaphore's sessions set
 * lock_timeout, statement_timeout and idle_session_timeout to none, beating a
 * role's or a database's own, and client_connection_check_interval to 1 s, so
 * a process gone while waiting leaves the queue within a second.
 *
 * In a process a share's calls are ordered (PR 2c-2): consolidation's go
 * first, then the rest in the order they asked, and a call that has waited
 * --max-wait (OB1_SLEEP_MAX_WAIT, 60 s) goes first whatever its pass; across
 * processes the queue is in the order each process's next call asked. Which
 * model the server has loaded is not read: one brain's order cannot see the
 * other brains' or clients' loads on a server they share, so it is PR 3's
 * host broker's (the maintainer, 2026-11-09).
 *
 * The defaults (PR 2b-2b, the maintainer, 2026-11-06): a local model server —
 * an endpoint OB1_LLM_LOCAL, OB1_CHAT_LOCAL or OB1_JEV_LOCAL declares — answers
 * OB1_MODEL_SLOTS calls at once per model (4 unset; compose hands the bundled
 * Ollama the same as OLLAMA_NUM_PARALLEL), and background chat and embedding
 * calls are held to one fewer, so a slot is left for live calls, the decide
 * tier to one. A remote provider's calls are not held by default.
 * OB1_BACKGROUND_SLOTS, written as types with per-model overrides —
 * `chat=1,embed=2,decide=1,chat:qwen3.8:27b=1` — merges over the defaults, its
 * shares holding every endpoint, local or not; `off` holds none. A value that
 * does not parse is said, and the defaults stay, as other server settings
 * fall back.
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
 * TCP keepalives, so one whose client went away unseen — a partition, a
 * swallowed FIN — ends, its locks with it, within about a minute.
 */
import { SQL } from "bun";
import { noteSlotWait, setModelCallHook, type ModelCallHook, type ModelType, type ResolvedModelCall } from "./model-call.ts";

/** A parsed OB1_BACKGROUND_SLOTS: each type's share, and per-model overrides keyed `type:model`. */
export type BackgroundSlots = ReadonlyMap<string, number>;

const TYPES: readonly ModelType[] = ["embed", "chat", "decide"];
/** The most slots one share may have: a model server answers a handful at once, and each slot held is a connection. */
export const MAX_SLOTS = 16;
/** A poll's time apart, in ms, jittered to twice it: between sessions the database ends, so one ending each as it comes is not asked in a loop. */
const POLL_MS = 250;
/**
 * How often the share's head tries its slots again untold, in ms, jittered to twice it: a slot let go by a process that
 * died, or by one from before PR 2c-1, is told to no one.
 */
const RECHECK_MS = 1000;
/** The application_name of the semaphore's connections. */
export const SLOTS_APP = "ob1-slots";
/** The channel a slot let go is told on, the share's key its payload, where another process's call heads the share's queue (PR 2c-1). */
export const SLOTS_CHANNEL = "ob1_slots";
/**
 * How long a connection of the semaphore's may take to open, and any statement to answer, in s: Bun's own bound on the
 * connect is 30 s, retrying a server that takes each connection and closes it all that while, so a call would wait that
 * long to fail open (review pass 1, measured).
 */
const CONNECT_S = 5;
/**
 * How long a connection that let its slot go is kept for the process's next call, in ms, and how many are kept: a
 * connection opened per call doubled a fast re-embed's time (review pass 5: 424 rows in 1.6 s against 0.8).
 */
const IDLE_MS = 2000;
const IDLE_MAX = 4;
/**
 * How long a close waits for a statement in flight, in s, before it ends the connection: Bun's close with none waits
 * for an unanswered statement for good, so a stop or a fail-open on a stalled session held the process open after its
 * work (review pass 4: a ping unanswered kept a CLI alive 47 s, until killed).
 */
const CLOSE_S = 1;
/** How long a semaphore found down is not asked again, in ms: its calls run without a slot meanwhile. */
const DOWN_MS = 30_000;

/** OB1_BACKGROUND_SLOTS' own shares: null when unset, empty or `off`; else its shares, or a problem in words. */
export function backgroundSlotsFrom(raw: string | undefined): { slots: BackgroundSlots | null; problem?: string } {
  const text = (raw ?? "").trim();
  if (text === "" || text.toLowerCase() === "off") return { slots: null };
  const slots = new Map<string, number>();
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const bad = (why: string) => ({ slots: null, problem: `OB1_BACKGROUND_SLOTS: ${JSON.stringify(part)} ${why} — write types and per-model overrides, e.g. chat=1,embed=2,decide=1,chat:qwen3.8:27b=1, or off; the defaults stay` });
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

/**
 * The parallel calls per model a local model server is counted to answer, OB1_MODEL_SLOTS unset: the bundled Ollama is
 * handed the same; a host Ollama's own default is 1 in current releases, so its operator raises it to match (the
 * maintainer, 2026-11-08).
 */
export const DEFAULT_MODEL_SLOTS = 4;

/** OB1_MODEL_SLOTS read: a whole number of slots from 1 to MAX_SLOTS, the default unset or empty; a value that does not parse is said, the default kept. */
export function modelSlotsFrom(raw: string | undefined): { n: number; problem?: string } {
  const text = (raw ?? "").trim();
  if (text === "") return { n: DEFAULT_MODEL_SLOTS };
  if (/^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= MAX_SLOTS) return { n: Number(text) };
  return { n: DEFAULT_MODEL_SLOTS, problem: `OB1_MODEL_SLOTS: ${JSON.stringify(text)} is no whole number of slots from 1 to ${MAX_SLOTS} — the model server's parallel calls per model, as OLLAMA_NUM_PARALLEL; ${DEFAULT_MODEL_SLOTS} stays` };
}

/**
 * The shares a local model server's background calls are held to by default (PR 2b-2b): chat and embeddings one
 * fewer than its slots, so one is left for live calls — at least one, so a server of one slot leaves none, which
 * preflight's host rule says — and the decide tier one, as it answers one request at a time.
 */
export function defaultShares(modelSlots: number): BackgroundSlots {
  const n = Math.max(1, modelSlots - 1);
  return new Map([["chat", n], ["embed", n], ["decide", 1]]);
}

/**
 * The shares in force (PR 2b-2b): OB1_BACKGROUND_SLOTS' own, holding every endpoint, over the defaults, holding a
 * local one alone; none under `off`. A value of either setting that does not parse is in `problems`, and leaves the
 * defaults as they would be: OB1_BACKGROUND_SLOTS' none of its own, OB1_MODEL_SLOTS its default.
 */
export type SlotsSetting = {
  /** OB1_BACKGROUND_SLOTS' own shares, every endpoint's: null where it gives none. */
  set: BackgroundSlots | null;
  /** The defaults, a local endpoint's: null under `off`. */
  defaults: BackgroundSlots | null;
  /** OB1_MODEL_SLOTS, read. */
  modelSlots: number;
  problems: string[];
};

/** The shares in force from OB1_BACKGROUND_SLOTS (`raw`) and OB1_MODEL_SLOTS (`modelSlots`). */
export function slotsSettingFrom(raw: string | undefined, modelSlots: string | undefined): SlotsSetting {
  const m = modelSlotsFrom(modelSlots);
  const problems = m.problem ? [m.problem] : [];
  if ((raw ?? "").trim().toLowerCase() === "off") return { set: null, defaults: null, modelSlots: m.n, problems };
  const own = backgroundSlotsFrom(raw);
  if (own.problem) problems.push(own.problem);
  return { set: own.slots, defaults: defaultShares(m.n), modelSlots: m.n, problems };
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

/**
 * The share a call counts against: its key and its size, or null where it is unlimited (a live call, a type left out).
 * Given a setting, its own shares first — a model's override, then its type — and a local endpoint's default after
 * (PR 2b-2b); given shares alone, those.
 */
export function shareOf(slots: BackgroundSlots | SlotsSetting, call: Pick<ResolvedModelCall, "type" | "model" | "base" | "cls" | "local">): { key: string; limit: number } | null {
  if (call.cls !== "background") return null;
  const setting: SlotsSetting = slots instanceof Map ? { set: slots, defaults: null, modelSlots: DEFAULT_MODEL_SLOTS, problems: [] } : (slots as SlotsSetting);
  const own = setting.set;
  const limit = (own && call.type !== "decide" && call.model !== undefined ? own.get(`${call.type}:${call.model}`) : undefined)
    ?? own?.get(call.type)
    ?? (call.local ? setting.defaults?.get(call.type) : undefined);
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
    const t = setTimeout(() => { done(); reject(new Error(`no answer in ${ms / 1000} s`)); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { done(); resolve(v); }, (e: unknown) => { done(); reject(e); });
  });
}

/**
 * Whether an error is the session ending — the connection closed, a terminate or a shutdown (57P0x), a connection
 * error (08xxx) — rather than a statement the database refused, a timeout, or a full lock table, which fail open
 * (review pass 5: any error but a timeout was asked again, a refusal in a tight loop).
 */
function sessionEnded(e: unknown): boolean {
  const { code, errno } = (e ?? {}) as { code?: unknown; errno?: unknown };
  return code === "ERR_POSTGRES_CONNECTION_CLOSED" || (typeof errno === "string" && /^(08|57P0)/.test(errno));
}

/**
 * A share's calls in this process: whether one of them waits for a slot, those queued behind it, in order, the waiter's
 * backend (`pid`), the slots told let go to it (`freed`, this process's and, through the channel, another's), whether
 * it waits (`busy`: in the share's queue, or at its head with no slot free, its queue told), and how to wake it from
 * its nap — a slot let go goes to the head at once, not at its next try (review pass 6: 424 embeddings at embed=1, two
 * workers, took 36 s against 0.6 with a poll a handoff). Each call queued says whether its pass goes first (`first`)
 * and when it queued (`at`, performance.now()), so the turn is passed in order (PR 2c-2).
 */
type Turn = { go: () => void; waiting: () => void; first: boolean; at: number };
type Local = { key: string; limit: number; waiter: boolean; queue: Turn[]; pid: number; freed: number; busy: boolean; wake?: () => void };

/**
 * The passes whose calls go first in a share, in a process (SMD-3379 PR 2c-2, draft 5's order): consolidation's, once it
 * has joined extraction — the sleep scheduler runs it beside extraction only then, so a consolidation call waiting at
 * all is one that has joined — a thought's pairs then judged before the next thought's windows are read, the passes'
 * work finished in the order it was started. Others' calls go in the order they asked.
 */
const FIRST_PASSES: ReadonlySet<string> = new Set(["consolidate"]);
/**
 * How long a call waits before it goes first whatever its pass, in s (`--max-wait`, OB1_SLEEP_MAX_WAIT): the order
 * reorders a share's calls and never more — the share is the same — and no pass's calls wait behind another's for good.
 */
export const DEFAULT_MAX_WAIT_S = 60;
/** Most seconds --max-wait takes: a day, as the sleep scheduler's other bounds. */
export const MAX_MAX_WAIT_S = 86_400;

/**
 * A share's queue (PR 2c-1): a lock a process's waiting call takes with pg_advisory_lock, Postgres granting it in the
 * order asked; its holder heads the queue. One per share size, -1 less the size (slot -2 at chat=1, -17 at 16), so a
 * process counting the share's slots otherwise — a CLI run without the stack's OB1_MODEL_SLOTS — does not wait behind a
 * head that may not take the slot free for it (review pass 1: a chat=3 process made 13 calls in 5 s behind a chat=1
 * one's, 677 alone). pg_locks shows the queues' locks as the oids QUEUE_OIDS spans.
 */
const queueOf = (limit: number) => -1 - limit;
const QUEUE_OIDS = [2 ** 32 - 1 - MAX_SLOTS, 2 ** 32 - 2] as const;
/** How long a subscription to the channel that failed to open is not tried again, in ms: a database refusing connections is not asked each round. */
const LISTEN_RETRY_MS = 2000;

/**
 * Sets the background-slots hook for this process, once, at its entry point:
 * `raw` its OB1_BACKGROUND_SLOTS, `modelSlots` its OB1_MODEL_SLOTS, `url` its
 * database. Returns `uninstall`, which puts back the hook it replaced and ends
 * every wait, a call already running keeping its slot until it ends; and the
 * settings' problems, said through `log`, the defaults then standing in.
 * Under `off` no hook is set. `maxWaitS` is --max-wait's, DEFAULT_MAX_WAIT_S
 * unless given. `connectS` bounds a connection's opening and
 * each statement, CONNECT_S unless a test asks for less.
 */
export function installBackgroundSlots(opts: { url: string; raw: string | undefined; modelSlots?: string | undefined; log?: (line: string) => void; stop?: AbortSignal; connectS?: number; maxWaitS?: number }): { installed: boolean; problem?: string; uninstall: () => Promise<void> } {
  const log = opts.log ?? ((line: string) => console.error(line));
  const setting = slotsSettingFrom(opts.raw, opts.modelSlots);
  for (const p of setting.problems) log(p);
  const problem = setting.problems.length ? setting.problems.join("; ") : undefined;
  if (!setting.set && !setting.defaults) return { installed: false, ...(problem ? { problem } : {}), uninstall: async () => {} };
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
    if (!l) locals.set(key, (l = { key, limit, waiter: false, queue: [], pid: 0, freed: 0, busy: false }));
    return l;
  };
  const maxWaitMs = (opts.maxWaitS ?? DEFAULT_MAX_WAIT_S) * 1000;
  /**
   * The share's turn to wait for a slot in this process: at once when no call of it has it, else queued, `first` where
   * its pass goes first (passTurn's order); a stop takes a call out of the queue.
   */
  const takeTurn = (l: Local, signal: AbortSignal, waiting: () => void, first: boolean): Promise<void> => {
    if (!l.waiter) {
      l.waiter = true;
      return Promise.resolve();
    }
    // Queued behind the waiter: a wait only once it waits in the share's queue or finds no slot free (`busy`), told
    // then — not for its own statements, a slot free (review pass 7: a stopping fan-out gave back seven answered
    // blurbs).
    if (l.busy) waiting();
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const entry: Turn = { waiting, first, at: performance.now(), go: () => { signal.removeEventListener("abort", onAbort); resolve(); } };
      const onAbort = () => { l.queue.splice(l.queue.indexOf(entry), 1); reject(signal.reason); };
      signal.addEventListener("abort", onAbort, { once: true });
      l.queue.push(entry);
    });
  };
  /** The head's sleep between its tries: `ms`, ended early by a stop (rejecting) or by a slot told let go (`wake`); whether it was woken. */
  const nap = (l: Local, ms: number, signal: AbortSignal): Promise<boolean> => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const done = () => { clearTimeout(t); signal.removeEventListener("abort", onAbort); l.wake = undefined; };
    const t = setTimeout(() => { done(); resolve(false); }, ms);
    const onAbort = () => { done(); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    l.wake = () => { done(); resolve(true); };
  });
  /** The waiter waits — in the share's queue, or at its head with no slot free — and so does each call queued behind it, told now. */
  const tellWaiting = (l: Local, waiting: () => void) => {
    waiting();
    if (l.busy) return;
    l.busy = true;
    // A copy: telling an entry can stop it, which takes it out of the queue as this goes (review pass 8: every other
    // entry skipped, one running its call through a stop).
    for (const e of [...l.queue]) e.waiting();
  };
  /**
   * The turn handed to the next call queued, or given up: the longest queued of those whose pass goes first or that
   * have waited --max-wait, else the longest queued (PR 2c-2). The queue is in the order the calls asked, so the first
   * such is the longest queued. The waiter is never passed over: a call queued after it waits for its slot.
   */
  const passTurn = (l: Local) => {
    if (l.queue.length === 0) {
      l.waiter = false;
      return;
    }
    const now = performance.now();
    const i = l.queue.findIndex((e) => e.first || now - e.at >= maxWaitMs);
    const [next] = l.queue.splice(i < 0 ? 0 : i, 1);
    next.go();
  };
  /** A connection's state: whether it has closed since it opened, and how to wake a head napping on it. */
  type Conn = { lost: boolean; wake?: () => void };
  /** A connection of the semaphore's, and its state. */
  type Session = { client: SQL; conn: Conn };
  /** A slot held: its session, and the backend that holds its lock. */
  type Held = Session & { local: Local; slot: number; pid: number };
  /** Sessions that let their slot go cleanly, holding no lock, kept a while for the next call. */
  const idle: { session: Session; timer: ReturnType<typeof setTimeout> }[] = [];
  const close = (s: { client: SQL }) => s.client.close({ timeout: CLOSE_S }).catch(() => {});
  const park = (s: Session) => {
    if (s.conn.lost || ended.signal.aborted || idle.length >= IDLE_MAX) return void close(s);
    const entry = { session: s, timer: setTimeout(() => { idle.splice(idle.indexOf(entry), 1); void close(s); }, IDLE_MS) };
    // A kept session holds no process open.
    entry.timer.unref();
    idle.push(entry);
  };
  const takeIdle = (): Session | undefined => {
    for (let e = idle.pop(); e; e = idle.pop()) {
      clearTimeout(e.timer);
      if (!e.session.conn.lost) return e.session;
      void close(e.session);
    }
    return undefined;
  };
  /**
   * A semaphore connection's settings: named, so pg_stat_activity tells them apart; keepalives (review pass 3 of 2b-1);
   * and no timeout of a role's or a database's — the wait in the share's queue is as long as the calls ahead of it, a
   * slot's session and the subscription sit idle while a call runs (review pass 1: a role's idle_session_timeout ended
   * a slot's session mid-call, three calls running at chat=1) — while a process gone leaves the queue within a second.
   */
  const SESSION = {
    application_name: SLOTS_APP, tcp_keepalives_idle: "30", tcp_keepalives_interval: "10", tcp_keepalives_count: "3", tcp_user_timeout: "60000",
    lock_timeout: "0", statement_timeout: "0", idle_session_timeout: "0", client_connection_check_interval: "1s",
  };
  /** A new session of the semaphore's; `conn.lost` marks it closed, and `conn.wake` wakes a head napping on it. */
  const newSession = (conn: Conn): SQL => new SQL({
    url: opts.url, max: 1, connectionTimeout: boundS, onclose: () => { conn.lost = true; conn.wake?.(); }, connection: SESSION,
  });
  /**
   * The process's subscription to the channel, a connection of its own: opened at a head's first wait, closed 2 s after
   * the process's last (`quiet`), since a live subscription holds a process open, and a CLI never uninstalls.
   * `subscribed` is whether it subscribed, once settled. One that did not is said once and dropped, asked again at a
   * round LISTEN_RETRY_MS or more on by a head still waiting, which meanwhile tries again every RECHECK_MS untold
   * (review pass 1: kept, a failed one held the process's head deaf for as long as calls waited, and every process's
   * calls behind it, 21 calls in 12 s where 185 ran). `pingAt` is when the process's ping last sent on it was answered
   * as sent, `heardAt` when it last heard one back, both by performance.now() (`stillHearing`).
   */
  type Listener = { client: SQL; timer?: ReturnType<typeof setTimeout>; subscribed?: boolean; pingAt?: number; heardAt?: number };
  let listener: Listener | undefined;
  /** Until when (Date.now()) a subscription that failed to open is not asked again. */
  let listenAgainAt = 0;
  /** This process's own ping on the channel: no share's key, which begins `ob1:slot:`. */
  const ping = `ping:${crypto.randomUUID()}`;
  /** A slot told let go: its share's head, in this process, tries again at once. */
  const wakeHead = (key: string) => {
    const l = locals.get(key);
    if (!l) return;
    l.freed++;
    l.wake?.();
  };
  /**
   * The process's subscription asked for: one opened where there is none, not awaited — a LISTEN slow to answer would
   * hold the head's tries for up to its bound (review pass 3). Each head waiting is woken as it subscribes, so a slot
   * let go before it heard is tried for at once.
   */
  const listening = (): void => {
    if (listener?.timer) {
      clearTimeout(listener.timer);
      listener.timer = undefined;
    }
    if (!listener) {
      if (Date.now() < listenAgainAt) return;
      const client = new SQL({ url: opts.url, max: 1, connectionTimeout: boundS, connection: SESSION });
      const it: Listener = { client };
      // Subscribed, and again after Bun re-subscribes a dropped connection: a slot let go before was told to no one, so
      // each head waiting tries again, and a ping sent meanwhile is not judged (review pass 3: lost in a restart, it
      // dropped a subscription Bun had brought back).
      const onListen = () => {
        it.pingAt = undefined;
        for (const k of locals.keys()) wakeHead(k);
      };
      const onNotify = (payload: string) => {
        if (payload === ping) it.heardAt = performance.now();
        else wakeHead(payload);
      };
      void bounded(client.listen(SLOTS_CHANNEL, onNotify, onListen), boundS * 1000).then(() => { it.subscribed = true; }, (e: unknown) => {
        // Closed on purpose meanwhile — the process stopping, the subscription idle or dropped — nothing to say (review
        // pass 2: said at a stop, the one saying spent).
        if (listener !== it) return;
        // Bun does not ask again after a first refusal: dropped, so a head still waiting asks again in a while.
        listener = undefined;
        if (it.timer) clearTimeout(it.timer);
        void close(it);
        listenAgainAt = Date.now() + LISTEN_RETRY_MS;
        sayOnce("listen", `  background slots: the ${SLOTS_CHANNEL} channel could not be heard (${(e as Error).message}) — a slot another process lets go is found at the next try, a second or two on; asked again at a waiting head's round ${LISTEN_RETRY_MS / 1000} s or more on`);
      });
      listener = it;
    }
  };
  /**
   * After a nap no release ended, whether the process still hears the channel: its ping, last sent at such a nap a
   * RECHECK_MS or more ago, heard back since. Not heard, the subscription is dropped and said once, a head subscribing
   * again at its next round (review pass 2: Bun stops re-subscribing a dropped one after some 3 minutes, and a
   * connection that swallows what it is sent never drops — the head left deaf, unsaid, every process behind it waiting
   * its tries out). A ping younger than RECHECK_MS is not judged: another share's head may check while it is still on
   * its way (review pass 3: twelve shares waiting dropped six healthy subscriptions in 30 s). Its time is taken as sent
   * and kept once the database answers it; a ping that fails is dropped unsent, not failing the call open — the ping is
   * a check, not the semaphore. Then the next ping sent, where none is on its way.
   */
  const stillHearing = async (ask: <T>(q: PromiseLike<T>) => Promise<T>, session: SQL, signal: AbortSignal): Promise<void> => {
    const it = listener;
    if (!it?.subscribed) return;
    const now = performance.now();
    if (it.pingAt !== undefined) {
      if (now - it.pingAt < RECHECK_MS) return;
      if ((it.heardAt ?? -1) < it.pingAt) {
        listener = undefined;
        if (it.timer) clearTimeout(it.timer);
        void close(it);
        sayOnce("deaf", `  background slots: the ${SLOTS_CHANNEL} channel was no longer heard — subscribing again; meanwhile a slot another process let go was found at the next try`);
        return;
      }
    }
    try {
      await ask(session`SELECT pg_notify(${SLOTS_CHANNEL}, ${ping})`);
      if (listener === it) it.pingAt = now;
    } catch (e) {
      if (signal.aborted) throw e;
    }
  };
  /** No call of this process waits for a slot: the subscription closed 2 s on, unless one waits again by then. */
  const quiet = () => {
    const it = listener;
    if (!it || it.timer || [...locals.values()].some((x) => x.waiter)) return;
    it.timer = setTimeout(() => {
      it.timer = undefined;
      // A call of this process waiting again by now, not yet at a head's try: kept, its own end closing it.
      if ([...locals.values()].some((x) => x.waiter)) return;
      if (listener === it) listener = undefined;
      void close(it);
    }, IDLE_MS);
    it.timer.unref();
  };
  /**
   * A wait in the share's queue: as long as the calls ahead of it, unbounded but by a stop, which cancels it on the
   * server — from a connection of its own, as Bun's cancel leaves the server waiting and a close waits for the
   * statement — so the queue is not held for a call gone. Only a backend of the semaphore's still waiting on an
   * advisory lock is cancelled, not one that has since been granted it, nor another backend given the pid.
   */
  const queueWait = (session: SQL, key: string, queue: number, pid: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      reject(signal.reason);
      const c = new SQL({ url: opts.url, max: 1, connectionTimeout: boundS, connection: { application_name: SLOTS_APP } });
      void bounded(c`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid = ${pid} AND application_name = ${SLOTS_APP} AND wait_event_type = 'Lock' AND wait_event = 'advisory'`, boundS * 1000)
        .catch(() => {})
        .finally(() => void c.close({ timeout: CLOSE_S }).catch(() => {}));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // A tagged query runs once then'd.
    session`SELECT pg_advisory_lock(hashtext(${key}), ${queue})`.then(
      () => { signal.removeEventListener("abort", onAbort); resolve(); },
      (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
  /** A slot of the share, held on a connection of its own; null where the semaphore fails open. A stop rejects with its reason. */
  const acquire = async (l: Local, signal: AbortSignal, waiting: () => void, first: boolean): Promise<Held | null> => {
    // Stopped already — a pass's first stop aborts a call's wait as it comes: no turn, no kept session spent.
    if (signal.aborted) throw signal.reason;
    if (Date.now() < downUntil) return null;
    await takeTurn(l, signal, waiting, first);
    let client: SQL | undefined;
    try {
      // Queued behind a waiter that found the database down: run without a slot as well.
      if (Date.now() < downUntil) return null;
      for (;;) {
        // A session kept from a slot let go, or a new one, built inside the try: Bun throws at once on some URLs
        // (review pass 2). Named, so pg_stat_activity tells the semaphore's connections apart; a connection ending
        // marks its slot lost, since Bun's client reconnects quietly and the unlock would reach a new session (review
        // pass 2). The keepalives end a session whose client went away unseen — a partition, a swallowed FIN — in about
        // a minute, where the OS's default left its locks, the whole share at N=1, for some two hours (review pass 3).
        const reused = takeIdle();
        const conn: Conn = reused?.conn ?? { lost: false };
        // A head napping on a session that closes tries again at once, on its new session (review pass 1: it slept its
        // nap out, a terminate costing its process ground).
        conn.wake = () => l.wake?.();
        const session = (client = reused?.client ?? newSession(conn));
        // Whether this session has answered: one the database ends after it has — a terminate, a restart — is asked
        // again on a fresh session, a poll later, rather than read as an outage, its queue let through for 30 s
        // (review pass 3); a session that never answers, and any other error, fails open.
        // A kept session has answered before.
        let answered = reused !== undefined;
        const ask = <T>(q: PromiseLike<T>) => bounded(q, boundS * 1000, signal).then((v) => { answered = true; return v; });
        try {
          // Whether this session holds the share's queue lock: at its head.
          let head = false;
          for (;;) {
            if (signal.aborted) throw signal.reason;
            // A connection that closed while this call waited, a statement in flight failing otherwise, is Bun's quiet
            // reconnect: the new session holds no lock, the queue's included, and a lock it takes is no lost one
            // (review pass 3: read as a slot lost at the unlock).
            if (conn.lost) {
              conn.lost = false;
              head = false;
            }
            if (!head) {
              // At the head at once where no call of another process waits for the share; else behind those that do.
              const [q] = (await ask(session`SELECT pg_try_advisory_lock(hashtext(${l.key}), ${queueOf(l.limit)}) AS head, pg_backend_pid() AS pid`)) as { head: boolean; pid: number }[];
              l.pid = q.pid;
              if (!q.head) {
                tellWaiting(l, waiting);
                await queueWait(session, l.key, queueOf(l.limit), q.pid, signal);
              }
              head = true;
            }
            // The slots told let go so far: one more by the round's end is tried at once.
            const seen = l.freed;
            for (let slot = 0; slot < l.limit; slot++) {
              // Its connection closed between tries: the queue is no longer this session's, taken again first (review
              // pass 1: a slot taken on the new session read as lost at its release).
              if (conn.lost) break;
              const [r] = (await ask(session`SELECT pg_try_advisory_lock(hashtext(${l.key}), ${slot}) AS got, pg_backend_pid() AS pid`)) as { got: boolean; pid: number }[];
              // Again at each try: after a quiet reconnect (above) the waiter is on a new backend.
              l.pid = r.pid;
              if (r.got) {
                // Stopped as the lock came: the finally closes the connection, and its locks go with the session.
                if (signal.aborted) throw signal.reason;
                // The queue let go: its next waiter's turn at the head.
                await ask(session`SELECT pg_advisory_unlock(hashtext(${l.key}), ${queueOf(l.limit)})`);
                if (saidDown) log("  background slots: the semaphore's database answers again");
                saidDown = false;
                downUntil = 0;
                const held = { client: session, conn, local: l, slot, pid: r.pid };
                client = undefined;
                return held;
              }
            }
            if (conn.lost) continue;
            // No slot free: a wait, told now, the queue's with it — a stopping pass aborts it here, before a
            // subscription is opened for it (review pass 1).
            tellWaiting(l, waiting);
            if (signal.aborted) throw signal.reason;
            // Asked each round, so a subscription that failed is asked again while the call waits; a live one costs
            // nothing.
            listening();
            if (l.freed === seen && !(await nap(l, RECHECK_MS + Math.floor(Math.random() * RECHECK_MS), signal))) await stillHearing(ask, session, signal);
          }
        } catch (e) {
          if (signal.aborted || !answered || !sessionEnded(e)) throw e;
          void session.close({ timeout: CLOSE_S }).catch(() => {});
          client = undefined;
          // A poll between sessions: a database ending each one as it comes is not asked in a loop (review pass 5).
          await wait(POLL_MS + Math.floor(Math.random() * POLL_MS), signal);
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
      // Not awaited: a close waits a second for a connect or a statement in flight, which a stalled database never
      // ends, then ends the connection. Its locks, the queue's among them, go with the session.
      if (client) void client.close({ timeout: CLOSE_S }).catch(() => {});
      l.pid = 0;
      l.busy = false;
      l.wake = undefined;
      passTurn(l);
      quiet();
    }
  };
  /** The slot let go, within the bound: a stalled database holds the call's answer no longer than that. */
  const release = async (held: Held): Promise<void> => {
    const lost = (why: string) => sayOnce("lost", `  background slots: a slot's connection was lost while its call ran (${why}) — the lock went with it, or will, and another call may have taken the slot meanwhile`);
    let answered = false;
    let clean = false;
    try {
      if (held.conn.lost) return lost("the connection closed");
      // Unlocked only on the backend that took the lock. Another answering is Bun's quiet reconnect after the
      // connection ended, or, the connection never closed, a pooler handing the statement to another backend.
      // With it, the backends at the head of the share's queues in this database — their queue locks held, read as
      // oids — as text: a bound int4[] comes back an Int32Array. Advisory locks are the database's own, so another
      // database on the cluster is left out (review pass 1).
      const [u] = (await bounded(held.client`
        SELECT pg_backend_pid() = ${held.pid} AS same,
               CASE WHEN pg_backend_pid() = ${held.pid} THEN pg_advisory_unlock(hashtext(${held.local.key}), ${held.slot}) END AS released,
               (SELECT string_agg(pid::text, ',') FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 2 AND granted
                   AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                   AND objid BETWEEN ${QUEUE_OIDS[0]} AND ${QUEUE_OIDS[1]}
                   AND classid::bigint = (hashtext(${held.local.key})::bigint & 4294967295)) AS heads`, boundS * 1000)) as { same: boolean; released: boolean | null; heads: string | null }[];
      answered = true;
      if (u.same === true && u.released === true) {
        clean = true;
        // The head this process's own: woken here, counted, so a head between its try and its nap tries again rather
        // than missing the wake (review pass 7). Another process's: told on the channel. None: the next call to ask
        // finds the slot free.
        const heads = (u.heads ?? "").split(",").filter((p) => p !== "").map(Number);
        if (heads.includes(held.local.pid)) wakeHead(held.local.key);
        if (heads.some((p) => p !== held.local.pid)) {
          await bounded(held.client`SELECT pg_notify(${SLOTS_CHANNEL}, ${held.local.key})`, boundS * 1000).catch(() => {
            // Untold, the head finds the slot at its next try; the session, not answering, is not kept.
            clean = false;
          });
        }
      } else if (u.same !== true && held.conn.lost) lost("a new session answered the unlock");
      else sayOnce("unlock", "  background slots: a slot's unlock reached another backend than its lock, or found no lock: a pooler between this process and Postgres? Session locks need a direct connection");
    } catch (e) {
      lost((e as Error).message);
    } finally {
      // Kept for the next call if it let go cleanly; else closed, awaited where it answered (a stalled one never ends).
      if (clean) park(held);
      else if (answered) await close(held);
      else void close(held);
    }
  };
  const hook: ModelCallHook = async (call, run, waiting) => {
    const share = shareOf(setting, call);
    if (!share) return run();
    // The wait timed however it ends, a slot taken at once included: a point and its pass's tally (SMD-3379 PR 2b-2a).
    const asked = performance.now();
    // Whether it waited at all, by the hook's own word, apart from a slot taken at once (review pass 1).
    let waited = false;
    const told = () => {
      waited = true;
      waiting();
    };
    let held: Held | null;
    try {
      held = await acquire(localOf(share.key, share.limit), call.signal ? AbortSignal.any([call.signal, stop]) : stop, told, call.pass !== undefined && FIRST_PASSES.has(call.pass));
    } catch (e) {
      noteSlotWait(call, performance.now() - asked, "stopped", waited);
      throw e;
    }
    noteSlotWait(call, performance.now() - asked, held ? "held" : "open", waited);
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
      const it = listener;
      listener = undefined;
      if (it?.timer) clearTimeout(it.timer);
      await Promise.all([...idle.splice(0).map((e) => { clearTimeout(e.timer); return close(e.session); }), ...(it ? [close(it)] : [])]);
    },
  };
}
