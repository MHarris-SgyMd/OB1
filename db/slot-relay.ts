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
 *   {slot: "ask", id, base, model, cls, first?, max_wait_s?}  a slot for a call; answered go, queued, own or lapsed
 *   {slot: "running", id, base, model, cls}                   a call running on the child's own share (after `own`)
 *   {slot: "done", id}                                        a call ended, or an ask withdrawn
 * Relay → child: {slot: "go" | "queued" | "own" | "lapsed", id}. `own` is "take your own share" (PR 2's semaphore):
 * the broker does not broker that base (`no server`), the ask was malformed, or no broker answered within GRACE_MS.
 *
 * What the broker counts is what runs (review pass 1: a hand-back after a lost link ran six calls on three slots
 * uncounted for as long as they ran):
 *   - every call a child runs is counted there: a grant as it is granted, a call on the child's own share (`running`)
 *     as `held`, sent at once or on the next socket;
 *   - a socket lost keeps every grant and every own call, and sends each again as `held` once a socket is open (the
 *     broker restarted, or a link lost, so counts the calls still running);
 *   - a socket lost parks each ask waiting there, which is asked again on the next socket, its time waited carried
 *     (`waited_s`); only those still parked GRACE_MS after the loss, and every ask while none answers past it, are
 *     answered `own`.
 * The broker's own limit on asks waiting (`max_waiting`, its hello's) is kept here: asks past it wait in the relay,
 * fed as those ahead resolve, so a wide fan-out never runs on its own share (the broker's protocol: never `own` for
 * `limit`; review pass 1: 3000 asks, 1974 run uncounted).
 *
 * Liveness (review pass 1: a broker frozen, or a link that swallows data, held every queued ask for minutes and said
 * nothing): the relay pings every idle_s/3 and drops a socket that has said nothing for idle_s (both its hello's),
 * as the broker drops a brain's; a socket that never says hello within HELLO_MS is dropped too; a refused key is
 * named (a 401) rather than read as an outage. Each frame a child sends is checked before it is passed on (review
 * pass 1: one child's 5 kB base made the broker close the brain's whole socket).
 */

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
  | { slot: "ask"; id: string; base: string; model?: string | null; cls: "live" | "background"; first?: boolean; max_wait_s?: number }
  | { slot: "running"; id: string; base: string; model?: string | null; cls: "live" | "background" }
  | { slot: "done"; id: string };
/** What the relay sends a child. */
export type RelayFrame = { slot: "go" | "queued" | "own" | "lapsed"; id: string };

/** One child's link to the relay: messages from it, and the channel to send it on while it runs. */
export type RelayPort = {
  /** A message from the child's channel; anything that is no relay frame is left alone. */
  onMessage(m: unknown): void;
  /** The child (re)started, and this sends to it. */
  attach(send: (m: RelayFrame) => void): void;
  /** The child ended: every call it had is done. */
  detach(): void;
};

/** What a test reads of the relay. */
export type RelayState = { broker: "up" | "down"; boot: string | null; since: number; asks: number; parked: number; grants: number; own: number };

export type Relay = { port(child: string): RelayPort; state(): RelayState; stop(): Promise<void> };

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
  if (f.max_wait_s !== undefined && !(typeof f.max_wait_s === "number" && Number.isFinite(f.max_wait_s) && f.max_wait_s >= 0 && f.max_wait_s <= 86_400)) return "bad";
  return { slot: "ask", id: f.id, base: f.base, model, cls: f.cls, ...(f.first === true ? { first: true } : {}), ...(typeof f.max_wait_s === "number" ? { max_wait_s: f.max_wait_s } : {}) };
}

/** Opens the relay: one socket to the broker at `url` with `key`, kept open, and a port per child. */
export function startRelay(opts: { url: string; key: string; log?: (line: string) => void; reconnectMs?: { first: number; max: number }; graceMs?: number; helloMs?: number }): Relay {
  const log = opts.log ?? ((line: string) => console.error(line));
  const backoff = opts.reconnectMs ?? RECONNECT_MS;
  const graceMs = opts.graceMs ?? GRACE_MS;
  const helloMs = opts.helloMs ?? HELLO_MS;
  const entries = new Map<string, Entry>();
  /** Each child's ids, its own to the relay's. */
  const byChild = new Map<string, Map<string, string>>();
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
  /** No broker since this long ago (performance.now), or null while one answers: past GRACE_MS, asks take their own shares. */
  let downAt: number | null = performance.now();
  let maxWaiting = 1024;
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

  const tell = (e: Entry, slot: RelayFrame["slot"]) => {
    const send = senders.get(e.child);
    if (!send) return;
    try { send({ slot, id: e.childId }); } catch { /* the child is going: its detach clears it */ }
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
  const askOf = (relayId: string, e: Entry) => {
    const waited = (performance.now() - e.at) / 1000;
    e.kind = "ask"; e.on = epoch; atBroker++; e.askedAt = performance.now();
    toBroker({ op: "ask", id: relayId, base: e.base, model: e.model, cls: e.cls, ...(e.first ? { first: true } : {}), ...(e.maxWaitS !== undefined ? { max_wait_s: e.maxWaitS } : {}), ...(waited >= 0.001 ? { waited_s: Math.min(waited, 86_400) } : {}) });
  };
  /** Parked asks to the broker, oldest first, while it takes more. */
  const feed = () => {
    if (!open) return;
    for (const [relayId, e] of entries) {
      if (atBroker >= maxWaiting) return;
      if (e.kind === "parked") askOf(relayId, e);
    }
  };
  /** Past the grace with no broker: asks take their own shares at once (the grace's timer, not the clock, decides). */
  const pastGrace = () => !open && grace === null;
  /** The grace over: every ask still parked takes its child's own share. */
  const graceOver = () => {
    grace = null;
    if (open) return;
    for (const [relayId, e] of [...entries]) if (e.kind === "parked") { forget(relayId); tell(e, "own"); }
  };
  const helloOf = (sock: WebSocket, m: { boot?: string; idle_s?: number; max_waiting?: number }) => {
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
    // Every call running — a grant, or a call on its own share — counted again; then the parked asks, their time carried.
    let held = 0;
    for (const [relayId, e] of entries) if (e.kind === "grant" || e.kind === "own") { e.on = epoch; sock.send(JSON.stringify({ op: "held", id: relayId, base: e.base, model: e.model, cls: e.cls })); held++; }
    // Every call it runs named: any grant the broker kept for it beyond these is given back now (review pass 3).
    sock.send(JSON.stringify({ op: "synced", id: "synced" }));
    const parked = [...entries.values()].filter((e) => e.kind === "parked").length;
    feed();
    if (epoch === 1 || restarted || performance.now() - lostSaidAt >= 60_000 || lostUnsaid === 0) log(`slot relay: the broker answers${restarted ? " (restarted)" : ""}${held ? `; ${held} call${held === 1 ? "" : "s"} still running re-registered` : ""}${parked ? `; ${parked} waiting asked again` : ""}`);
  };
  /** The socket gone (closed, or dropped here): asks parked, running calls kept for `held`, a reconnect scheduled. */
  const lost = (sock: WebSocket, why: string) => {
    if (ws !== sock) return;
    ws = null;
    const was = open;
    open = false;
    atBroker = 0;
    // A live call is running already (it never waits): kept for `held`, as an own call is; a background ask parks.
    for (const e of entries.values()) if (e.kind === "ask") {
      e.kind = e.cls === "live" ? "own" : "parked";
      if (e.kind === "parked" && !e.told) { e.told = true; tell(e, "queued"); }
    }
    if (downAt === null) downAt = performance.now();
    if (!grace) grace = setTimeout(graceOver, Math.max(0, graceMs - (performance.now() - downAt)));
    if (stopped) return;
    since = Date.now();
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
    const inGrace = downAt !== null && performance.now() - downAt < graceMs;
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
      let m: { op?: string; id?: string | null; boot?: string; why?: string; idle_s?: number; max_waiting?: number };
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
      if (m.op === "lapsed") { forget(m.id); if (e.kind === "grant") tell(e, "lapsed"); feed(); return; }
      if (m.op === "no") {
        if (e.kind === "ask" && m.why === "limit") {
          atBroker--;
          // A live call runs already: kept for `held` (review pass 3: parked, it ran uncounted).
          if (e.cls === "live") { e.kind = "own"; e.on = -1; return; }
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
        // A held call the broker does not broker (an own call to another base): left unregistered.
        e.on = -1;
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
            const relayId = mine.get(f.id);
            if (relayId === undefined) return;
            const e = entries.get(relayId)!;
            const known = (e.kind === "ask" || e.kind === "grant" || e.kind === "own") && e.on === epoch && e.on !== -1;
            forget(relayId);
            if (known) toBroker({ op: "done", id: relayId });
            feed();
            return;
          }
          if (mine.has(f.id)) { if (f.slot === "ask") send?.({ slot: "own", id: f.id }); return; }
          const relayId = `${nonce}:${child}:${++next}`;
          const e: Entry = { child, childId: f.id, kind: "parked", base: f.base, model: f.model ?? null, cls: f.cls, first: f.slot === "ask" && f.first === true, maxWaitS: f.slot === "ask" ? f.max_wait_s : undefined, at: performance.now(), on: -1, askedAt: 0, told: false };
          if (f.slot === "running") {
            e.kind = "own";
            entries.set(relayId, e);
            mine.set(f.id, relayId);
            if (open) { e.on = epoch; toBroker({ op: "held", id: relayId, base: e.base, model: e.model, cls: e.cls }); }
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
          if (pastGrace()) { send?.({ slot: "own", id: f.id }); return; }
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
            const known = !!e && e.kind !== "parked" && e.on === epoch && e.on !== -1;
            forget(relayId);
            if (known) toBroker({ op: "done", id: relayId });
          }
          mine.clear();
          feed();
        },
      };
    },
    state() {
      let asks = 0, parked = 0, grants = 0, own = 0;
      for (const e of entries.values()) if (e.kind === "ask") asks++; else if (e.kind === "parked") parked++; else if (e.kind === "grant") grants++; else own++;
      return { broker: open ? "up" : "down", boot, since, asks, parked, grants, own };
    },
    async stop() {
      stopped = true;
      clearInterval(quietAsks);
      if (retry) clearTimeout(retry);
      if (grace) clearTimeout(grace);
      quietNow();
      const sock = ws;
      ws = null;
      open = false;
      if (sock && sock.readyState <= 1) await new Promise<void>((r) => { sock.onclose = () => r(); sock.close(); setTimeout(r, 1000); });
    },
  };
}
