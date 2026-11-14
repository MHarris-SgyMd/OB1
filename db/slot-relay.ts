/**
 * slot-relay.ts — the coordinator's relay to the host's slot broker (SMD-3379 PR 3b-1).
 *
 * The broker (deploy/federated/broker.ts, PR 3a) hands the model servers the brains on one host share their slots:
 * a live call at once, a background call in turn across the brains. A brain reaches it through its own coordinator
 * alone (docs/brain-coordinator.md, row 2; the maintainer, 2026-11-10): the coordinator holds the brain's broker key
 * (OB1_SLOT_BROKER_URL, OB1_SLOT_BROKER_KEY, handed to no child) and one WebSocket to the broker, and its children ask
 * it over their IPC channels (the maintainer, 2026-11-11). This is that relay; server-portable/slots.ts's hook is the
 * children's side.
 *
 * Child → relay, over the child's channel:
 *   {slot: "ask", id, base, model, cls, first?, max_wait_s?}  a slot for a call; answered go, queued or own (a go may later lapse)
 *   {slot: "running", id, base, model, cls}                   a call running on the child's own share (after `own`)
 *   {slot: "done", id}                                        a call ended, or an ask withdrawn
 * Relay → child: {slot: "go" | "queued" | "own" | "lapsed", id}, and {slot: "back"} at each new socket. `own` is "take
 * your own share" (PR 2's semaphore): the broker does not broker that base (its hello's list, or `no server`), the ask
 * was malformed, or no broker answered within GRACE_MS — that last with `why: "away"`, so the child, still waiting on
 * its own share, asks again at the next `back`, its time waited carried (`waited_s` on the ask).
 *
 * What the broker counts is what runs (review pass 1: a hand-back after a lost link ran six calls on three slots
 * uncounted for as long as they ran):
 *   - every call a child runs is counted there: a grant as it is granted, a call on the child's own share (`running`)
 *     as `held`, sent at once or on the next socket;
 *   - a socket lost keeps every grant and every own call, and sends each again as `held` once a socket is open, on a
 *     base its hello lists (the broker restarted, or a link lost, so counts the calls still running);
 *   - a socket lost parks each ask waiting there, which is asked again on the next socket, its time waited carried
 *     (`waited_s`); only those still parked GRACE_MS after the loss, and every ask while none answers past it, are
 *     answered `own`.
 * The broker's own limit on asks waiting (`max_waiting`, its hello's) is kept here: asks past it wait in the relay,
 * fed as those ahead resolve, so a wide fan-out never runs on its own share (the broker's protocol: never `own` for
 * `limit`; review pass 1: 3000 asks, 1974 run uncounted).
 *
 * Liveness (review pass 1: a broker frozen, or a link that swallows data, held every queued ask for minutes and said
 * nothing): the relay pings every third of its silence limit and drops a socket that has said nothing for it — idle_s
 * (its hello's), SILENCE_MS (10 s) at most — as the broker drops a brain's; a socket that never says hello within
 * HELLO_MS is dropped too; a refused key is named (a 401) rather than read as an outage. Each frame a child sends is
 * checked before it is passed on (review pass 1: one child's 5 kB base made the broker close the brain's whole socket).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { MIN_RELAY_KEY, normalisedBase } from "../server-portable/slots.ts";

export { MIN_RELAY_KEY };

/** The reconnect's backoff: from the first, doubling to the most. */
export const RECONNECT_MS = { first: 500, max: 2000 } as const;
/** How long asks parked by a lost socket wait for the next before they take their children's own shares. */
export const GRACE_MS = 3000;
/** How long a socket may go, from its dial, without the broker's hello. */
export const HELLO_MS = 5000;
/** The reconnect's pace within the grace: a broker back within it is found before the grace ends (review pass 2). */
export const GRACE_RETRY_MS = 250;
/** The longest the relay waits on a silent socket, whatever the broker's idle_s (review pass 2: idle_s 30 made 33 s). */
export const SILENCE_MS = 10_000;
/** An ask the broker has not answered this long is told `queued` by the relay, so the pass waits on the relay's liveness
 *  and grace rather than its own 1 s bound (review pass 3: a frozen broker sent new asks to own shares at 1 s). */
export const QUIET_ASK_MS = 500;

/** What a child sends. */
export type ChildFrame =
  | { slot: "ask"; id: string; base: string; model?: string | null; cls: "live" | "background"; first?: boolean; max_wait_s?: number; waited_s?: number }
  | { slot: "running"; id: string; base: string; model?: string | null; cls: "live" | "background" }
  | { slot: "done"; id: string };
/** What the relay sends a child. */
export type RelayFrame = { slot: "go" | "queued" | "own" | "lapsed" | "back"; id: string; why?: "away" };

/** One child's link to the relay: messages from it, and the channel to send it on while it runs. */
export type RelayPort = {
  /** A message from the child's channel; anything that is no relay frame is left alone. */
  onMessage(m: unknown): void;
  /** The child (re)started, and this sends to it. */
  attach(send: (m: RelayFrame) => void): void;
  /** The child ended: every call it had is done. */
  detach(): void;
  /** Its asks withdrawn, its running calls kept counted: an api's socket closed, the api perhaps coming back (serveRelay). */
  withdrawAsks?(): void;
  /** Every call but those `ids` names done: an api back on a new socket has named what it still runs. */
  retain?(ids: ReadonlySet<string>): void;
};

/** What a test reads of the relay, and the coordinator's row (`broker` and `since`, the start of that state). */
export type RelayState = { broker: "up" | "down"; boot: string | null; since: number; asks: number; parked: number; grants: number; own: number };

export type Relay = {
  port(child: string): RelayPort;
  state(): RelayState;
  stop(): Promise<void>;
  /** An api has named every call it runs (its `named`, serveRelay), or none is coming: a `synced` held for them is sent. */
  apiBack?(): void;
};

type Entry = {
  child: string;
  childId: string;
  /** ask: waiting at the broker; parked: waiting here; grant: the broker's; own: running on the child's own share. */
  kind: "ask" | "parked" | "grant" | "own";
  base: string; model: string | null; cls: "live" | "background";
  first: boolean; maxWaitS: number | undefined;
  /** When it began waiting (performance.now), for `waited_s` when asked again. */
  at: number;
  /** When it was last asked of the broker, and whether its child has been told it waits. */
  askedAt: number; told: boolean;
  /** An own (running) call refused for the broker's limit: sent as `held` again once room frees. */
  heldAgain?: boolean;
  /** The socket it is registered on (`epoch`), -1 where none: a `done` reaches the broker only where it is known. */
  on: number;
};

const str = (v: unknown, lo: number, hi: number): v is string => typeof v === "string" && v.length >= lo && v.length <= hi;
/** A child's frame, checked as the broker checks an ask, so one bad frame never closes the brain's socket. */
export function childFrame(m: unknown): ChildFrame | "bad" | null {
  if (typeof m !== "object" || m === null) return null;
  const f = m as Record<string, unknown>;
  if (f.slot !== "ask" && f.slot !== "running" && f.slot !== "done") return null;
  if (!str(f.id, 1, 64)) return "bad";
  if (f.slot === "done") return { slot: "done", id: f.id };
  if (!str(f.base, 1, 2048) || !(f.model === undefined || f.model === null || str(f.model, 1, 256)) || (f.cls !== "live" && f.cls !== "background")) return "bad";
  const model = typeof f.model === "string" ? f.model : null;
  if (f.slot === "running") return { slot: "running", id: f.id, base: f.base, model, cls: f.cls };
  if (f.first !== undefined && typeof f.first !== "boolean") return "bad";
  const secs = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 86_400);
  if (!secs(f.max_wait_s) || !secs(f.waited_s)) return "bad";
  return { slot: "ask", id: f.id, base: f.base, model, cls: f.cls, ...(f.first === true ? { first: true } : {}), ...(typeof f.max_wait_s === "number" ? { max_wait_s: f.max_wait_s } : {}), ...(typeof f.waited_s === "number" ? { waited_s: f.waited_s } : {}) };
}

/** Opens the relay: one socket to the broker at `url` with `key`, kept open, and a port per child. */
export function startRelay(opts: { url: string; key: string; log?: (line: string) => void; reconnectMs?: { first: number; max: number }; graceMs?: number; helloMs?: number; onChange?: () => void; syncWaitMs?: number }): Relay {
  const log = opts.log ?? ((line: string) => console.error(line));
  const backoff = opts.reconnectMs ?? RECONNECT_MS;
  const graceMs = opts.graceMs ?? GRACE_MS;
  const helloMs = opts.helloMs ?? HELLO_MS;
  const entries = new Map<string, Entry>();
  /** Each child's ids, its own to the relay's. */
  const byChild = new Map<string, Map<string, string>>();
  /** Each child's ids the broker took back (`lapsed`), until the child says `done`: a `running` crossing the `lapsed` on
   *  its way (an api re-naming its calls at a new socket) is not counted again (review pass 4 of 3b-2). */
  const lapsedBy = new Map<string, Set<string>>();
  const senders = new Map<string, (m: RelayFrame) => void>();
  let ws: WebSocket | null = null;
  let open = false;
  let epoch = 0;
  let boot: string | null = null;
  let since = Date.now();
  let stopped = false;
  let wait = backoff.first;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let grace: ReturnType<typeof setTimeout> | null = null;
  /** When the broker last stopped answering (performance.now), or null while one answers: the grace runs from it, as does the quicker reconnect within it. */
  let downAt: number | null = performance.now();
  let maxWaiting = 1024;
  /** The bases the broker brokers, from its hello: a call to another is its child's own share at once, no round trip. */
  let brokered: Set<string> | null = null;
  /** Its ids' prefix, this process's own: a restarted coordinator never takes back another's kept grants by id. */
  const nonce = crypto.randomUUID().slice(0, 8);
  /** The current socket's timers, cleared at its end or at stop. */
  let quietNow: () => void = () => {};
  /** When the loss line was last said, and how many losses since went unsaid (a link flapping every few seconds). */
  let lostSaidAt = -Infinity;
  let lostUnsaid = 0;
  /** The kind of loss last said (its words, numbers aside): another kind is said at once. */
  let lostKind = "";
  let atBroker = 0;
  let next = 0;
  let saidDown = false;
  const saidOnce = new Set<string>();
  const once = (what: string, line: string) => { if (!saidOnce.has(what)) { saidOnce.add(what); log(line); } };
  /** The first hello's `synced`, held for the api's calls (`syncWaitMs`): the socket it is owed on, its bound, and whether an api's socket has opened. */
  const syncWait = opts.syncWaitMs ?? 0;
  let syncPending: WebSocket | null = null;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  let apiSeen = false;
  /** Whether a `synced` has been sent: the hold is the first's, kept across a socket lost before it (review pass 2 of 3b-2). */
  let syncedOnce = false;
  /** When the held `synced` goes at the latest (performance.now): a later api's socket never moves it past the bound. */
  let syncBy = 0;
  const sendSynced = (sock: WebSocket) => {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    if (syncPending !== sock) return;
    syncPending = null;
    syncedOnce = true;
    if (open && ws === sock) { try { sock.send(JSON.stringify({ op: "synced", id: nonce })); } catch { /* close follows */ } }
  };

  /** `away` on an `own` given for want of a broker — the grace, or past it — which the child asks again at `back`. */
  const tell = (e: Entry, slot: RelayFrame["slot"], away = false) => {
    const send = senders.get(e.child);
    if (!send) return;
    try { send({ slot, id: e.childId, ...(away ? { why: "away" as const } : {}) }); } catch { /* the child is going: its detach clears it */ }
  };
  const forget = (relayId: string) => {
    const e = entries.get(relayId);
    if (!e) return;
    if (e.kind === "ask") atBroker--;
    entries.delete(relayId);
    const mine = byChild.get(e.child);
    if (mine?.get(e.childId) === relayId) mine.delete(e.childId);
  };
  const toBroker = (frame: object) => { if (open && ws) ws.send(JSON.stringify(frame)); };
  const heldFrame = (relayId: string, e: Entry) => ({ op: "held", id: relayId, base: e.base, model: e.model, cls: e.cls });
  const askOf = (relayId: string, e: Entry) => {
    const waited = (performance.now() - e.at) / 1000;
    e.kind = "ask"; e.on = epoch; atBroker++; e.askedAt = performance.now();
    toBroker({ op: "ask", id: relayId, base: e.base, model: e.model, cls: e.cls, ...(e.first ? { first: true } : {}), ...(e.maxWaitS !== undefined ? { max_wait_s: e.maxWaitS } : {}), ...(waited >= 0.001 ? { waited_s: Math.min(waited, 86_400) } : {}) });
  };
  /** Parked asks to the broker, oldest first, while it takes more. */
  const feed = () => {
    if (!open) return;
    // A live call refused for the limit, counted once room frees (review pass 4: it waited for the next socket).
    for (const [relayId, e] of entries) if (e.kind === "own" && e.heldAgain) { e.heldAgain = false; e.on = epoch; toBroker(heldFrame(relayId, e)); }
    // Oldest first, by when each began waiting: asks asked again after a back carry their age (review pass 5). Nothing
    // to do with the broker's limit reached, so no sort on every grant then (review pass 6).
    if (atBroker >= maxWaiting) return;
    const parked = [...entries].filter(([, e]) => e.kind === "parked").sort((x, y) => x[1].at - y[1].at);
    for (const [relayId, e] of parked) {
      if (atBroker >= maxWaiting) return;
      askOf(relayId, e);
    }
  };
  /** Past the grace with no broker: asks take their own shares at once (the grace's timer, not the clock, decides). */
  const pastGrace = () => !open && grace === null;
  /** The grace over: every ask still parked takes its child's own share. */
  const graceOver = () => {
    grace = null;
    if (open) return;
    for (const [relayId, e] of [...entries]) if (e.kind === "parked") { forget(relayId); tell(e, "own", true); }
  };
  const helloOf = (sock: WebSocket, m: { boot?: string; max_waiting?: number; servers?: { bases?: string[] }[] }) => {
    const restarted = boot !== null && m.boot !== boot;
    boot = m.boot ?? null;
    open = true;
    epoch++;
    downAt = null;
    wait = backoff.first;
    since = Date.now();
    saidDown = false;
    if (grace) { clearTimeout(grace); grace = null; }
    if (typeof m.max_waiting === "number" && m.max_waiting > 0) maxWaiting = m.max_waiting;
    brokered = Array.isArray(m.servers) ? new Set(m.servers.flatMap((sv) => (Array.isArray(sv?.bases) ? sv.bases : []).filter((x: unknown): x is string => typeof x === "string").map((x) => normalisedBase(x)))) : null;
    // Every call running — a grant, or a call on its own share — counted again; then the parked asks, their time carried.
    let held = 0;
    // A base the hello does not list is the pass's own share, nothing to count there: an ask parked before the list was
    // known answered own, a call running on one not named (review pass 8: each told `no server`, each new socket).
    const unlisted = (e: Entry) => !!brokered && !brokered.has(normalisedBase(e.base));
    for (const [relayId, e] of [...entries]) if (e.kind === "parked" && unlisted(e)) { forget(relayId); tell(e, "own"); }
    for (const [relayId, e] of entries) if ((e.kind === "grant" || e.kind === "own") && !unlisted(e)) { e.on = epoch; sock.send(JSON.stringify(heldFrame(relayId, e))); held++; }
    // Every call it runs named: any grant the broker kept for it beyond these is given back now (review pass 3).
    // At this process's first hello, with the api's sockets listened for (`syncWaitMs`), not until the api's socket is
    // back and its calls named, at most that long: the api outlives a coordinator recreated, its calls running, and a
    // `synced` before they are named gave their slots to another brain while they ran (review pass 1 of 3b-2: 4 calls on
    // 2 slots for 3.5 s). The broker keeps them KEEP_MS (5 s) meanwhile; the wait is less.
    if (!syncedOnce && syncWait > 0 && !apiSeen) {
      syncPending = sock;
      // One bound from the first hello, kept across a socket lost before it is reached (review pass 5 of 3b-2).
      if (syncBy === 0) syncBy = performance.now() + syncWait;
      syncTimer = setTimeout(() => sendSynced(sock), Math.max(0, syncBy - performance.now()));
    } else { syncedOnce = true; sock.send(JSON.stringify({ op: "synced", id: nonce })); }
    // Each pass told the broker is back: a call still waiting on its own share asks again (review pass 4: a deep backlog
    // sent to own shares past the grace drained there for 45 s, the broker back).
    for (const send of senders.values()) { try { send({ slot: "back", id: "" }); } catch { /* going */ } }
    const parked = [...entries.values()].filter((e) => e.kind === "parked").length;
    feed();
    opts.onChange?.();
    if (epoch === 1 || restarted || performance.now() - lostSaidAt >= 60_000 || lostUnsaid === 0) log(`slot relay: the broker answers${restarted ? " (restarted)" : ""}${held ? `; ${held} call${held === 1 ? "" : "s"} still running re-registered` : ""}${parked ? `; ${parked} waiting asked again` : ""}`);
  };
  /** The socket gone (closed, or dropped here): asks parked, running calls kept for `held`, a reconnect scheduled. */
  const lost = (sock: WebSocket, why: string) => {
    if (ws !== sock) return;
    ws = null;
    // A `synced` owed on it is owed no more: the next socket's hello sends its own.
    if (syncPending === sock) { syncPending = null; if (syncTimer) clearTimeout(syncTimer); syncTimer = null; }
    const was = open;
    open = false;
    atBroker = 0;
    // A live call is running already (it never waits): kept for `held`, as an own call is; a background ask parks.
    for (const e of entries.values()) if (e.kind === "ask") {
      e.kind = e.cls === "live" ? "own" : "parked";
      if (e.kind === "parked" && !e.told) { e.told = true; tell(e, "queued"); }
    }
    if (was) opts.onChange?.();
    if (downAt === null) downAt = performance.now();
    if (!grace) grace = setTimeout(graceOver, Math.max(0, graceMs - (performance.now() - downAt)));
    if (stopped) return;
    // The state's start, moved only as it changes: a redial that fails is no new outage (review pass 1 of 3b-2: an hour
    // down read as a second, each failed dial its start).
    if (was) since = Date.now();
    if (!saidDown) {
      saidDown = true;
      // At most once a minute, with the count unsaid since: a link flapping every few seconds is one line a minute.
      const kind = `${was}:${why.replace(/[0-9]+/g, "")}`;
      if (kind !== lostKind || performance.now() - lostSaidAt >= 60_000) {
        lostKind = kind;
        log(`slot relay: ${was ? "the broker's socket was lost" : "the broker did not answer"} (${why})${lostUnsaid ? ` — and ${lostUnsaid} loss${lostUnsaid === 1 ? "" : "es"} since the last said` : ""} — asks wait ${graceMs / 1000} s for it, then take the passes' own shares (PR 2's semaphore), each counted there once it is back; trying again every ${backoff.max / 1000} s at most`);
        lostSaidAt = performance.now();
        lostUnsaid = 0;
      } else lostUnsaid++;
    }
    // Within the grace, quickly: a broker back in it is found before its asks take their own shares.
    const inGrace = performance.now() - downAt < graceMs;
    retry = setTimeout(() => { retry = null; connect(); }, inGrace ? Math.min(GRACE_RETRY_MS, wait) : wait);
    if (!inGrace) wait = Math.min(wait * 2, backoff.max);
  };
  const drop = (sock: WebSocket, why: string) => {
    try {
      const t = (sock as unknown as { terminate?: () => void }).terminate;
      if (typeof t === "function") t.call(sock); else sock.close();
    } catch { /* gone already */ }
    lost(sock, why);
  };
  /** Why a socket that never opened was refused: a 401 is the key, named; anything else an outage. */
  const whyRefused = async (): Promise<string> => {
    try {
      const r = await fetch(opts.url.replace(/^ws/, "http"), { headers: { "x-brain-key": opts.key }, redirect: "error", signal: AbortSignal.timeout(2000) });
      if (r.status === 401) return "the broker refused this brain's key (401): check OB1_SLOT_BROKER_KEY against the registry's hash";
      return r.status === 426 ? "an upgrade refused (426)" : `no WebSocket there (HTTP ${r.status}) — is OB1_SLOT_BROKER_URL the broker's /v1/slots?`;
    } catch (e) { return `no answer: ${(e as Error).message}`; }
  };

  const connect = () => {
    if (stopped) return;
    let sock: WebSocket;
    try {
      sock = new WebSocket(opts.url, { headers: { "x-brain-key": opts.key } } as unknown as string[]);
    } catch (e) {
      once("url", `slot relay: the broker URL could not be opened (${(e as Error).message})`);
      retry = setTimeout(() => { retry = null; connect(); }, backoff.max);
      return;
    }
    ws = sock;
    let opened = false;
    let heard = performance.now();
    let ping: ReturnType<typeof setInterval> | null = null;
    // From the dial, not the open: a peer that takes the connection and never answers holds a socket connecting for
    // good (review pass 2: 40 s and more on Bun 1.4.3, the relay down meanwhile, saying nothing).
    let hello: ReturnType<typeof setTimeout> | null = setTimeout(() => { quiet(); once("hello", `slot relay: no hello from the broker within ${helloMs / 1000} s of dialling — is OB1_SLOT_BROKER_URL the broker's /v1/slots, and the broker up?`); drop(sock, "no hello"); }, helloMs);
    const quiet = () => { if (ping) clearInterval(ping); if (hello) clearTimeout(hello); ping = null; hello = null; };
    quietNow = quiet;
    sock.onopen = () => { opened = true; };
    sock.onmessage = (ev) => {
      heard = performance.now();
      let m: { op?: string; id?: string | null; boot?: string; why?: string; idle_s?: number; max_waiting?: number; servers?: { bases?: string[] }[] };
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.op === "hello") {
        if (hello) { clearTimeout(hello); hello = null; }
        const idleMs = Math.min(SILENCE_MS, (typeof m.idle_s === "number" && m.idle_s > 0 ? m.idle_s : 30) * 1000);
        ping = setInterval(() => {
          if (performance.now() - heard > idleMs) { quiet(); drop(sock, `silent for ${Math.round(idleMs / 1000)} s`); return; }
          try { sock.send(JSON.stringify({ op: "ping", id: "ping" })); } catch { /* close follows */ }
        }, Math.max(100, idleMs / 3));
        helloOf(sock, m);
        return;
      }
      if (typeof m.id !== "string") return;
      const e = entries.get(m.id);
      if (!e) return;
      if (m.op === "go") {
        if (e.kind === "ask") { atBroker--; e.kind = "grant"; tell(e, "go"); feed(); }
        return;
      }
      if (m.op === "queued") { if (e.kind === "ask" && !e.told) { e.told = true; tell(e, "queued"); } return; }
      // Its child told, for a grant and for a call it re-named (`held`): neither is counted again at a later socket
      // (review pass 2 of 3b-2: an api call re-named after a recreate, taken back, was counted again at the next).
      if (m.op === "lapsed") {
        forget(m.id);
        if (e.kind === "grant" || e.kind === "own") { tell(e, "lapsed"); lapsedBy.get(e.child)?.add(e.childId); }
        feed();
        return;
      }
      if (m.op === "no") {
        if (e.kind === "ask" && m.why === "limit") {
          atBroker--;
          // A live call runs already: kept for `held` (review pass 3: parked, it ran uncounted).
          if (e.cls === "live") { e.kind = "own"; e.on = -1; e.heldAgain = true; return; }
          // Never its own share for the broker's limit: it waits here, asked again as those ahead resolve.
          e.kind = "parked"; maxWaiting = Math.max(1, atBroker);
          if (!e.told) { e.told = true; tell(e, "queued"); }
          return;
        }
        if (e.kind === "ask") {
          forget(m.id);
          if (m.why !== "server") once(m.why ?? "?", `slot relay: the broker refused a call (${m.why}) — it runs on the brain's own share; said once`);
          tell(e, "own");
          feed();
          return;
        }
        // A held call the broker does not broker (an own call to another base): left unregistered; one refused for its
        // limit, asked again as room frees.
        e.on = -1;
        if (m.why === "limit") e.heldAgain = true;
      }
    };
    sock.onclose = (ev) => {
      quiet();
      if (ws !== sock) return;
      if (opened) { lost(sock, `${ev.code}${ev.reason ? ` ${ev.reason}` : ""}`); return; }
      // Never opened: why, asked of the URL over plain HTTP; a refused key said on its own, whenever it is first met.
      void whyRefused().then((why) => {
        if (/\(401\)/.test(why)) once("401", `slot relay: ${why}`);
        lost(sock, why);
      });
    };
    sock.onerror = () => { /* onclose follows, and says it */ };
  };
  if (graceMs > 0) grace = setTimeout(graceOver, graceMs);
  // Asks the broker has left unanswered QUIET_ASK_MS, told `queued` by the relay.
  const quietAsks = setInterval(() => {
    const now = performance.now();
    for (const e of entries.values()) if (e.kind === "ask" && e.cls === "background" && !e.told && now - e.askedAt >= QUIET_ASK_MS) { e.told = true; tell(e, "queued"); }
  }, QUIET_ASK_MS / 2);
  (quietAsks as unknown as { unref?: () => void }).unref?.();
  connect();

  return {
    port(child: string): RelayPort {
      const mine = new Map<string, string>();
      byChild.set(child, mine);
      const lapsed = new Set<string>();
      lapsedBy.set(child, lapsed);
      return {
        onMessage(m: unknown) {
          const f = childFrame(m);
          if (f === null) return;
          const send = senders.get(child);
          if (f === "bad") {
            once("child-bad", `slot relay: ${child} sent a frame the relay does not pass on — that call takes its own share; said once`);
            const id = (m as { id?: unknown }).id;
            if (typeof id === "string" && id.length <= 64) send?.({ slot: "own", id });
            return;
          }
          if (f.slot === "done") {
            lapsed.delete(f.id);
            const relayId = mine.get(f.id);
            if (relayId === undefined) return;
            const e = entries.get(relayId)!;
            const known = (e.kind === "ask" || e.kind === "grant" || e.kind === "own") && e.on === epoch;
            forget(relayId);
            if (known) toBroker({ op: "done", id: relayId });
            feed();
            return;
          }
          // An id it has already: an ask for a call the broker granted is answered `go` again (an api back on a new socket
          // asks again for a call whose `go` went to the old one; review pass 2 of 3b-2); any other ask, its own share.
          if (mine.has(f.id)) {
            if (f.slot === "ask") send?.({ slot: entries.get(mine.get(f.id)!)?.kind === "grant" ? "go" : "own", id: f.id });
            return;
          }
          // A base the broker does not broker (its hello's list): its own share at once, and nothing to count there
          // (review pass 7: an ask, a `no server`, then a held and another `no server`, each call); the last hello's list
          // while the broker is away, rather than the grace (review pass 8).
          if (brokered && !brokered.has(normalisedBase(f.base))) { if (f.slot === "ask" && f.cls === "background") send?.({ slot: "own", id: f.id }); return; }
          const relayId = `${nonce}:${child}:${++next}`;
          const e: Entry = { child, childId: f.id, kind: "parked", base: f.base, model: f.model ?? null, cls: f.cls, first: f.slot === "ask" && f.first === true, maxWaitS: f.slot === "ask" ? f.max_wait_s : undefined, at: performance.now() - (f.slot === "ask" && f.waited_s ? f.waited_s * 1000 : 0), on: -1, askedAt: 0, told: false };
          if (f.slot === "running") {
            if (lapsed.has(f.id)) return;
            e.kind = "own";
            entries.set(relayId, e);
            mine.set(f.id, relayId);
            if (open) { e.on = epoch; toBroker(heldFrame(relayId, e)); }
            return;
          }
          // A live call runs at once whatever is said (it never waits): asked past any cap with a broker, else kept as
          // running, for `held` on the next socket (review pass 2: past the grace, or behind the cap, it went uncounted).
          if (f.cls === "live") {
            entries.set(relayId, e);
            mine.set(f.id, relayId);
            if (open) askOf(relayId, e); else e.kind = "own";
            return;
          }
          // No broker past the grace: its own share at once.
          if (pastGrace()) { send?.({ slot: "own", id: f.id, why: "away" }); return; }
          entries.set(relayId, e);
          mine.set(f.id, relayId);
          if (open && atBroker < maxWaiting) askOf(relayId, e);
          // Parked — the broker away within the grace, or its limit reached: the child told it waits.
          else { e.told = true; send?.({ slot: "queued", id: f.id }); }
        },
        attach(send) { senders.set(child, send); },
        detach() {
          senders.delete(child);
          for (const relayId of [...mine.values()]) {
            const e = entries.get(relayId);
            const known = !!e && e.kind !== "parked" && e.on === epoch;
            forget(relayId);
            if (known) toBroker({ op: "done", id: relayId });
          }
          mine.clear();
          lapsed.clear();
          feed();
        },
        withdrawAsks() {
          for (const relayId of [...mine.values()]) {
            const e = entries.get(relayId);
            // A live call runs already, its ask only awaiting the broker's `go`: kept, counted (review pass 4 of 3b-2).
            if (!e || (e.kind !== "ask" && e.kind !== "parked") || e.cls === "live") continue;
            const known = e.kind === "ask" && e.on === epoch;
            forget(relayId);
            if (known) toBroker({ op: "done", id: relayId });
          }
          feed();
        },
        retain(ids) {
          for (const id of [...lapsed]) if (!ids.has(id)) lapsed.delete(id);
          for (const [childId, relayId] of [...mine]) {
            if (ids.has(childId)) continue;
            const e = entries.get(relayId);
            const known = !!e && e.kind !== "parked" && e.on === epoch;
            forget(relayId);
            if (known) toBroker({ op: "done", id: relayId });
          }
          feed();
        },
      };
    },
    state() {
      let asks = 0, parked = 0, grants = 0, own = 0;
      for (const e of entries.values()) if (e.kind === "ask") asks++; else if (e.kind === "parked") parked++; else if (e.kind === "grant") grants++; else own++;
      return { broker: open ? "up" : "down", boot, since, asks, parked, grants, own };
    },
    apiBack() {
      apiSeen = true;
      // At the api's own word that its calls are named, not a time after its open (review pass 4 of 3b-2: an api stalled
      // past it, or opened just before the hello, its frames still on their way).
      if (syncPending) sendSynced(syncPending);
    },
    async stop() {
      stopped = true;
      if (syncTimer) clearTimeout(syncTimer);
      clearInterval(quietAsks);
      if (retry) clearTimeout(retry);
      if (grace) clearTimeout(grace);
      quietNow();
      const sock = ws;
      ws = null;
      open = false;
      if (sock && sock.readyState <= 1) await new Promise<void>((r) => { const t = setTimeout(r, 1000); sock.onclose = () => { clearTimeout(t); r(); }; sock.close(); });
    },
  };
}

/** The port the coordinator's listener takes on the brain's network (SMD-3379 PR 3b-2): the api dials coordinator:8096. */
export const RELAY_PORT = 8096;
/** Its one path. */
export const RELAY_PATH = "/v1/relay";
/** The most sockets it holds at once: the api's, one a process, and a spare for one replaced while its last closes. */
export const MAX_RELAY_SOCKETS = 8;
/** A frame's most bytes: an ask is a few hundred, its base at most 2048 characters, each up to three bytes in UTF-8 (review
 *  pass 1 of 3b-2: at 4096 a non-ASCII base closed the api's socket, again at each socket while its call ran). */
export const RELAY_FRAME_MAX = 16_384;
/** How long an api's running calls stay counted after its socket closes under a coordinator that stays, for its next
 *  socket to take back: the broker's KEEP_MS, for the same reason (review pass 2 of 3b-2). */
export const API_KEEP_MS = 5000;
/** Seconds a socket may say nothing before the listener drops it: the api's ping every 3.3 s, three missed (review pass 1 of
 *  3b-2: at 30 s a half-open socket kept its calls counted 20 s beside the api's next). */
export const RELAY_IDLE_S = 10;

/** `stop` closes every socket and the port: the api's calls left as they are, for the coordinator's stop, its relay stopping
 *  too — or, `detach`, each done, its sockets cut while the relay lives on. */
export type RelayListener = { port: number; sockets(): number; stop(opts?: { detach?: boolean }): void };

/**
 * The coordinator's listener for the brain's servers (SMD-3379 PR 3b-2; docs/brain-coordinator.md, row 2): the api's
 * model calls asked of the host's broker through the coordinator, as its passes' are, over a WebSocket on the brain's
 * network at RELAY_PATH. The api proves itself with OB1_SLOT_RELAY_KEY, which both hold (x-brain-key; 401 without it,
 * checked before anything else is said). Each socket is one more of the relay's ports — the frames a pass sends over
 * its channel, and `{slot: "ping"}`, answered `{slot: "pong"}` here. Its close, under a coordinator that stays, keeps the
 * api's running calls API_KEEP_MS for its next socket (by `x-relay-client`), which names what it still runs; a `bye`, an
 * api that gives no id, or `stop({ detach })` gives them back at once. At most MAX_RELAY_SOCKETS at once (503 past it), frames of at most
 * RELAY_FRAME_MAX bytes, a socket silent RELAY_IDLE_S dropped.
 */
export function serveRelay(relay: Relay, opts: { key: string; port?: number; hostname?: string; log?: (line: string) => void; idleS?: number; maxSockets?: number; onChange?: () => void; keepMs?: number }): RelayListener {
  const log = opts.log ?? ((line: string) => console.error(line));
  const digest = (s: string) => createHash("sha256").update(s).digest();
  const want = digest(opts.key);
  const keyOk = (got: string | null) => got !== null && timingSafeEqual(digest(got), want);
  const max = opts.maxSockets ?? MAX_RELAY_SOCKETS;
  const keepMs = opts.keepMs ?? API_KEEP_MS;
  // Names reused, lowest free first: the relay keeps a port's ids under its name, so a name a closed socket held is
  // taken again rather than a new one a socket (a flapping link would grow the relay's map without end).
  const free = Array.from({ length: max }, (_, i) => `api#${i + 1}`);
  const take = () => free.sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))).shift();
  /** A socket's: its name, its port, the api process it is (`x-relay-client`), the ids it has named since it opened (until its `named`), and whether a newer socket of its api took its port. */
  type Data = { name: string; port: RelayPort | null; client: string | null; named: Set<string> | null; fresh: boolean; replaced: boolean; bye: boolean; heardAt: number; keepBy: number | null };
  type Sock = import("bun").ServerWebSocket<Data>;
  const open = new Set<Sock>();
  /** Each api process's open socket, and its port kept after a close, by its id. */
  const liveBy = new Map<string, Sock>();
  const kept = new Map<string, { name: string; port: RelayPort; timer: ReturnType<typeof setTimeout>; held: RelayFrame[]; by: number }>();
  /** The most frames held for a kept port's api: past it, the oldest dropped (a `lapsed` is the one that matters). */
  const HELD_FRAMES = 256;
  let refusedSaid = false;
  /** Stopping: the coordinator going, its relay with it; or giving every call back, its sockets cut (`detach`). */
  let stopping = false;
  let detaching = false;
  const release = (name: string, port: RelayPort) => { port.detach(); free.push(name); };
  /** A socket's end, once: Bun's close, or the listener's own drop of a socket silent past its bound. */
  const ended = (ws: Sock) => {
    if (!open.delete(ws)) return;
    const c = ws.data.client;
    if (c !== null && liveBy.get(c) === ws) liveBy.delete(c);
    const port = ws.data.port;
    ws.data.port = null;
    // A socket closed by the coordinator's stop leaves the api's calls as they are — still running there, and kept
    // counted at the broker by the relay's own close for the next coordinator to have named (review pass 1 of 3b-2: a
    // recreate's stop said each `done`, and their slots went to another brain while they ran).
    // Its asks withdrawn all the same: no slot granted, through the stop's last seconds, into a socket that is gone
    // (review pass 3 of 3b-2).
    if (!port || stopping) { port?.withdrawAsks?.(); opts.onChange?.(); return; }
    if (c === null || detaching || ws.data.bye) release(ws.data.name, port);
    else {
      // An api's socket closed under a coordinator that stays (a link cut, an api stalled past the idle bound): its
      // asks withdrawn — the api parks them, and asks again on its next socket — its running calls kept counted
      // API_KEEP_MS for that socket to take back, then done (review pass 2 of 3b-2: each `done` at once, the slots
      // went to another brain while the calls ran, 7 calls on 2 slots).
      port.withdrawAsks?.();
      const name = ws.data.name;
      const held: RelayFrame[] = [];
      port.attach((m) => { held.push(m); if (held.length > HELD_FRAMES) held.shift(); });
      // Until its keeping's end: a fresh API_KEEP_MS from this close, but the one it resumed under where the socket ended
      // before naming its calls — a link that lets the dial through and nothing back re-kept it at each dial, its ended
      // calls counted 20 s (review pass 5 of 3b-2).
      const by = ws.data.keepBy !== null && ws.data.named !== null ? ws.data.keepBy : performance.now() + keepMs;
      kept.set(c, { name, port, held, by, timer: setTimeout(() => { if (kept.get(c)?.port === port) { kept.delete(c); release(name, port); opts.onChange?.(); } }, Math.max(0, by - performance.now())) });
    }
    opts.onChange?.();
  };
  const server = Bun.serve<Data, never>({
    port: opts.port ?? RELAY_PORT,
    ...(opts.hostname ? { hostname: opts.hostname } : {}),
    fetch(req, srv) {
      if (new URL(req.url).pathname !== RELAY_PATH) return new Response("not found\n", { status: 404 });
      if (!keyOk(req.headers.get("x-brain-key"))) {
        if (!refusedSaid) { refusedSaid = true; log("slot relay: a socket was refused for its key — OB1_SLOT_RELAY_KEY must be the same on the api and the coordinator; said once"); }
        return new Response("refused: no OB1_SLOT_RELAY_KEY of this brain\n", { status: 401 });
      }
      const raw = req.headers.get("x-relay-client");
      const client = raw !== null && /^[A-Za-z0-9-]{8,64}$/.test(raw) ? raw : null;
      // An api back on a new socket takes its kept port's name, or its open one's, and so is never refused for room.
      const resumed = client === null ? undefined : kept.get(client)?.name ?? liveBy.get(client)?.data.name;
      // Full before a plain request's 426: the api asks again without the upgrade to say why it was refused.
      // A kept port is a courtesy: a new api with no name free takes the oldest one's, its calls given back (review pass 5
      // of 3b-2: an api crash-looping filled the eight names with its dead processes' ports, every new one refused).
      if (resumed === undefined && open.size < max && !free.length && kept.size && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const [oc, ok] = [...kept].sort((x, y) => x[1].by - y[1].by)[0];
        clearTimeout(ok.timer);
        kept.delete(oc);
        release(ok.name, ok.port);
      }
      if (resumed === undefined && (open.size >= max || !free.length)) return new Response("too many sockets\n", { status: 503 });
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("a WebSocket, at this path\n", { status: 426 });
      const name = resumed ?? take()!;
      if (srv.upgrade(req, { data: { name, port: null, client, named: new Set(), fresh: resumed === undefined, replaced: false, bye: false, heardAt: performance.now(), keepBy: null } })) return undefined;
      if (resumed === undefined) free.push(name);
      return new Response("upgrade failed\n", { status: 400 });
    },
    websocket: {
      maxPayloadLength: RELAY_FRAME_MAX,
      idleTimeout: opts.idleS ?? RELAY_IDLE_S,
      sendPings: true,
      open(ws) {
        const c = ws.data.client;
        const k = c === null ? undefined : kept.get(c);
        const old = c === null ? undefined : liveBy.get(c);
        let port: RelayPort;
        let held: RelayFrame[] = [];
        if (k) {
          // Back within the keeping: its running calls still counted, its port its own again, and what the relay said to
          // it meanwhile (a `lapsed`) said now (review pass 3 of 3b-2: lost on the closed socket, the call counted again).
          clearTimeout(k.timer);
          kept.delete(c!);
          port = k.port;
          held = k.held;
          ws.data.keepBy = k.by;
        } else if (old?.data.port) {
          // Its last socket still open here (half-open: the api dropped it, this side has not yet): this one takes its
          // port, the other closed without a word to the relay — its asks withdrawn first, as at a close, for the api asks
          // again (review pass 3 of 3b-2: a re-ask met its old id, answered `own`, the old one's grant counted for good).
          port = old.data.port;
          port.withdrawAsks?.();
          old.data.port = null;
          old.data.replaced = true;
          open.delete(old);
          try { old.close(4001, "replaced by the api's newer socket"); } catch { /* gone */ }
        } else {
          // A new api; or one whose keeping ran out between its request and this open, its name back among the free.
          if (!ws.data.fresh) { const at = free.indexOf(ws.data.name); if (at >= 0) free.splice(at, 1); }
          port = relay.port(ws.data.name);
        }
        open.add(ws);
        if (c !== null) liveBy.set(c, ws);
        ws.data.port = port;
        port.attach((m) => { ws.send(JSON.stringify(m)); });
        for (const m of held) ws.send(JSON.stringify(m));
        opts.onChange?.();
      },
      message(ws, msg) {
        ws.data.heardAt = performance.now();
        let m: unknown;
        try { m = JSON.parse(typeof msg === "string" ? msg : new TextDecoder().decode(msg)); } catch { return; }
        const slot = (m as { slot?: unknown } | null)?.slot;
        if (slot === "ping") { ws.send(JSON.stringify({ slot: "pong", id: "" })); return; }
        // The api stopping: its close is the end of its calls, nothing kept for it.
        if (slot === "bye") { ws.data.bye = true; return; }
        // The api has named every call it runs and asks for: any other its port holds — one that ended while it was away
        // — is done (review pass 2 of 3b-2).
        if (slot === "named") { if (ws.data.named) { ws.data.port?.retain?.(ws.data.named); ws.data.named = null; } relay.apiBack?.(); return; }
        const id = (m as { id?: unknown } | null)?.id;
        if (ws.data.named && typeof id === "string" && (slot === "ask" || slot === "running")) ws.data.named.add(id);
        ws.data.port?.onMessage(m);
      },
      close(ws) { ended(ws); },
    },
  });
  // Its own liveness, by what it hears: Bun's idle clock is reset by each frame sent, so a dead api the relay keeps
  // telling things (a `back` at each broker socket, a `go`) was never dropped, its calls counted for good (review pass 4
  // of 3b-2: 50 s through broker restarts). The api pings every 3.3 s; a socket heard nothing from for the idle bound ends.
  const idleMs = (opts.idleS ?? RELAY_IDLE_S) * 1000;
  const liveness = setInterval(() => {
    const now = performance.now();
    for (const ws of [...open]) if (now - ws.data.heardAt > idleMs) { ended(ws); try { ws.terminate(); } catch { /* gone */ } }
  }, Math.max(100, Math.min(1000, idleMs / 4)));
  (liveness as unknown as { unref?: () => void }).unref?.();
  return {
    port: server.port as number,
    sockets: () => open.size,
    stop(o) {
      clearInterval(liveness);
      detaching = o?.detach === true;
      stopping = !detaching;
      for (const ws of [...open]) { try { ws.close(1001, "the coordinator is stopping"); } catch { /* gone */ } }
      for (const [c, k] of [...kept]) { clearTimeout(k.timer); kept.delete(c); if (detaching) release(k.name, k.port); }
      void server.stop(true);
    },
  };
}
