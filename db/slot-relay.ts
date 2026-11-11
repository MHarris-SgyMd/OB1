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
 * Child → relay, over the child's channel: {slot: "ask", id, base, model, cls, first?, max_wait_s?} and
 * {slot: "done", id}. Relay → child: {slot: "go" | "queued" | "own" | "lapsed", id}. `own` is "take your own share":
 * the broker is not reachable, or it does not broker that base (`no`), or the call could not be asked (`no` bad or
 * limit, said once) — the child's hook then holds the call to PR 2's semaphore, as it does with no relay at all.
 *
 * Each call the relay asks has an id of the relay's own (`<child>:<n>`, never reused), so no child's id reaches the
 * broker and two children's never meet. While the broker socket is down every ask is answered `own` at once; when it
 * drops, each ask waiting there is answered `own` (the child takes its own share for that call), and each grant
 * running is kept and sent again as `held` once a socket is open again, so a broker restarted, or a link lost, counts
 * the calls still running. A child that ends — exits, or its channel closes — has every call it had told `done`.
 * A live call is the child's to send and end at once (it does not wait); the relay passes it on as any other.
 */

/** The reconnect's backoff: from the first, doubling to the most. */
export const RECONNECT_MS = { first: 500, max: 5000 } as const;

/** What a child sends. */
export type ChildFrame =
  | { slot: "ask"; id: string; base: string; model?: string | null; cls: "live" | "background"; first?: boolean; max_wait_s?: number }
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

/** What the coordinator's row and log read of the relay. */
export type RelayState = { broker: "up" | "down"; boot: string | null; since: number; asks: number; grants: number };

export type Relay = { port(child: string): RelayPort; state(): RelayState; stop(): Promise<void> };

type Entry = {
  child: string;
  childId: string;
  kind: "ask" | "grant";
  /** The ask as the broker took it, its id aside: sent again as `held` once a grant outlives a socket. */
  base: string; model: string | null; cls: "live" | "background";
};

const isFrame = (m: unknown): m is ChildFrame => typeof m === "object" && m !== null && ((m as { slot?: unknown }).slot === "ask" || (m as { slot?: unknown }).slot === "done") && typeof (m as { id?: unknown }).id === "string";

/** Opens the relay: one socket to the broker at `url` with `key`, kept open, and a port per child. */
export function startRelay(opts: { url: string; key: string; log?: (line: string) => void; reconnectMs?: { first: number; max: number } }): Relay {
  const log = opts.log ?? ((line: string) => console.error(line));
  const backoff = opts.reconnectMs ?? RECONNECT_MS;
  const entries = new Map<string, Entry>();
  /** Each child's ids, its own to the relay's. */
  const byChild = new Map<string, Map<string, string>>();
  const senders = new Map<string, (m: RelayFrame) => void>();
  let ws: WebSocket | null = null;
  let open = false;
  let boot: string | null = null;
  let since = Date.now();
  let stopped = false;
  let wait = backoff.first;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let next = 0;
  /** Said once a down spell, so a broker away for an hour is one line, not one a reconnect. */
  let saidDown = false;
  const saidOnce = new Set<string>();

  const tell = (e: Entry, slot: RelayFrame["slot"]) => {
    const send = senders.get(e.child);
    if (!send) return;
    try { send({ slot, id: e.childId }); } catch { /* the child is going: its detach clears it */ }
  };
  const forget = (relayId: string) => {
    const e = entries.get(relayId);
    if (!e) return;
    entries.delete(relayId);
    const mine = byChild.get(e.child);
    if (mine?.get(e.childId) === relayId) mine.delete(e.childId);
  };
  const toBroker = (frame: object) => { if (open && ws) ws.send(JSON.stringify(frame)); };

  const connect = () => {
    if (stopped) return;
    let sock: WebSocket;
    try {
      sock = new WebSocket(opts.url, { headers: { "x-brain-key": opts.key } } as unknown as string[]);
    } catch (e) {
      down(`the broker URL could not be opened (${(e as Error).message})`);
      return;
    }
    ws = sock;
    sock.onmessage = (ev) => {
      let m: { op?: string; id?: string | null; boot?: string; why?: string };
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.op === "hello") {
        const restarted = boot !== null && m.boot !== boot;
        boot = m.boot ?? null;
        open = true;
        wait = backoff.first;
        since = Date.now();
        saidDown = false;
        // The calls still running, sent again: the broker restarted knows none, and a socket lost gave them back.
        let held = 0;
        for (const [relayId, e] of entries) if (e.kind === "grant") { sock.send(JSON.stringify({ op: "held", id: relayId, base: e.base, model: e.model, cls: e.cls })); held++; }
        log(`slot relay: the broker answers${restarted ? " (restarted)" : ""}${held ? `; ${held} call${held === 1 ? "" : "s"} still running re-registered` : ""}`);
        return;
      }
      if (typeof m.id !== "string") return;
      const e = entries.get(m.id);
      if (!e) return;
      if (m.op === "go") { e.kind = "grant"; tell(e, "go"); }
      else if (m.op === "queued") tell(e, "queued");
      else if (m.op === "lapsed") { forget(m.id); tell(e, "lapsed"); }
      else if (m.op === "no") {
        forget(m.id);
        if (m.why !== "server" && !saidOnce.has(m.why ?? "")) { saidOnce.add(m.why ?? ""); log(`slot relay: the broker refused a call (${m.why}) — it runs on the brain's own share; said once`); }
        tell(e, "own");
      }
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      const was = open;
      open = false;
      // Each ask waiting there goes to its child's own share now; each grant is kept, for `held` on the next socket.
      for (const [relayId, e] of [...entries]) if (e.kind === "ask") { forget(relayId); tell(e, "own"); }
      if (!stopped) down(was ? `the broker's socket closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})` : `the broker did not answer (${ev.code})`);
    };
    sock.onerror = () => { /* onclose follows, and says it */ };
  };
  const down = (why: string) => {
    since = Date.now();
    if (!saidDown) { saidDown = true; log(`slot relay: ${why} — the passes take their own shares meanwhile (PR 2's semaphore); trying again every ${backoff.max / 1000} s at most`); }
    timer = setTimeout(() => { timer = null; connect(); }, wait);
    wait = Math.min(wait * 2, backoff.max);
  };
  connect();

  return {
    port(child: string): RelayPort {
      const mine = new Map<string, string>();
      byChild.set(child, mine);
      return {
        onMessage(m: unknown) {
          if (!isFrame(m)) return;
          if (m.slot === "done") {
            const relayId = mine.get(m.id);
            if (relayId === undefined) return;
            forget(relayId);
            toBroker({ op: "done", id: relayId });
            return;
          }
          const send = senders.get(child);
          if (mine.has(m.id)) { send?.({ slot: "own", id: m.id }); return; }
          if (!open) { send?.({ slot: "own", id: m.id }); return; }
          const relayId = `${child}:${++next}`;
          const model = typeof m.model === "string" ? m.model : null;
          entries.set(relayId, { child, childId: m.id, kind: "ask", base: m.base, model, cls: m.cls });
          mine.set(m.id, relayId);
          toBroker({ op: "ask", id: relayId, base: m.base, model, cls: m.cls, ...(m.first ? { first: true } : {}), ...(typeof m.max_wait_s === "number" ? { max_wait_s: m.max_wait_s } : {}) });
        },
        attach(send) { senders.set(child, send); },
        detach() {
          senders.delete(child);
          for (const relayId of [...mine.values()]) { forget(relayId); toBroker({ op: "done", id: relayId }); }
          mine.clear();
        },
      };
    },
    state() {
      let asks = 0, grants = 0;
      for (const e of entries.values()) if (e.kind === "ask") asks++; else grants++;
      return { broker: open ? "up" : "down", boot, since, asks, grants };
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const sock = ws;
      ws = null;
      open = false;
      if (sock && sock.readyState <= 1) await new Promise<void>((r) => { sock.onclose = () => r(); sock.close(); setTimeout(r, 1000); });
    },
  };
}
