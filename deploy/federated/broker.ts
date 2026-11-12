// The slot broker (SMD-3379 PR 3a): the federated coordinator's slot service (docs/brain-coordinator.md, row 2). One
// process on the host, beside the model servers the brains on it share, that hands their model calls the servers'
// slots: a live call at once, always; a background call in turn across the brains, within the room the live calls
// leave. So one brain's passes yield to another brain's live work, a brain alone may use every background slot, and
// two backlogged brains split them (SMD-3034's host rule, the ticket's Verify 4). Until PR 3b no brain asks it: each
// keeps its own share (PR 2's semaphore), as it does when this is down.
//
//   bun --no-install --no-env-file broker.ts --registry PATH [--host ADDRESS]   serve (127.0.0.1 unless --host)
//   bun broker.ts --self-check                                                 the registry's reading, on fixtures
//
// Self-contained — no import but Bun's and node's own — since the federated project (deploy/federated/compose.yaml)
// mounts this one file into the stack's pinned Bun image, as the stack's forwarder is. Nothing it holds survives a
// restart; a brain re-registers the slots it holds (`held`) when it reconnects, and for `warm_s` after a start no
// background call is granted — so a restart hands out no slot a running call still holds, for the brains that
// reconnect within it.
//
// The protocol: a WebSocket at /v1/slots, the brain's broker key in an `x-brain-key` header on the upgrade (an unknown
// one is a 401 before it; a brain's 17th socket at once a 429), JSON text frames, each id a string the socket never
// reuses.
//   brain → broker  {op:"ask", id, base, model, cls, first?, max_wait_s?, waited_s?}
//                                     a slot for one call to `base`'s `model`; `waited_s` the time it waited already,
//                                     asked again after a drop, so it keeps its age (`max_wait_s` 0: goes first)
//                   {op:"held", id, base, model, cls}
//                                     one its call held before it connected: after the broker's restart, or its own
//                                     socket's drop (counted as it is, past the room if need be; said once a socket
//                                     outside the warm-up)
//                   {op:"done", id}   the call ended, or the ask is withdrawn; ignored for an id not held (lapsed)
//                   {op:"ping", id}   answered {op:"pong", id}: a brain's own liveness check (PR 3b-1's relay)
//                   {op:"synced", id} every call still running re-registered (`held`): the brain's kept grants no
//                                     held named are given back now, not at ORPHAN_MS
//   broker → brain  {op:"hello", brain, boot, lease_s, idle_s, warm_s_left, max_waiting, max_held, max_sockets,
//                    max_frame, servers: [{name, bases, slots, reserve, per_model}]}
//                                     on open; `boot` changes when the broker restarts
//                   {op:"go", id}     granted (a `held` too). It may come with no `queued` before it, and after the
//                                     brain's own `done` withdrew the ask — given back already, so the brain ignores it.
//                                     A live ask is granted at once unless `no`.
//                   {op:"queued", id} the ask waits
//                   {op:"no", id, why}
//                                     not brokered: `server` (no server of the registry's has that base: the brain's own
//                                     share holds it), `bad`, `id` (in use), `limit` (max_waiting background asks
//                                     waiting on the socket, or max_held in all: the brain holds the call and asks again
//                                     as one of its own ends — never its own share, which would run it uncounted; PR
//                                     3b-1's relay keeps max_waiting itself, parking the rest)
//                   {op:"lapsed", id} held past lease_s, taken back: the brain asks no `held` for it again
// A model is a name the brain uses the same way each call: unnamed is one model, `?`; a server with `per_model: false`
// (a decide tier serving one call at a time) is one pool whatever the model. A closed socket — closed, silent past
// idle_s (pings unanswered), or not reading its frames (1 MiB backed up in the broker, past the kernel's buffers) —
// withdraws every ask it had waiting, and keeps its grants counted ORPHAN_MS (5 s): a brain back within it takes each
// again with `held`, same id, counted once (PR 3b-1's relay re-registers its running calls so); after it, they are
// given back. A brain asks its asks again on its next socket.
// GET /health answers `ok`, with no key and no figures.
//
// The rule, per (server, model) — Ollama's parallel setting is per model — with `slots` the server's setting:
//   live         granted at once, always, and counted: the model server queues it anyway, and a wait here would add
//                one to it (draft 4 had it wait while every slot held a live call; not taken, 2026-11-10). Over
//                `slots` in all, or one brain over `slots` live, is logged at most once a minute.
//   background   granted while background holds fewer than max(1, slots − reserve) and live and background together
//                fewer than `slots`: a live call in flight, any brain's, takes background's room.
//   whose turn   the waiting brain that has had the least background slot time there — remembered with a half-life of
//                USE_HALF_LIFE_S (300 s), its grants' running time added, and a brain coming to a pool where others
//                are at work — asking, or back with calls running (`held`) — starting level with the least of them — ties going round from the brain served last: two
//                backlogged brains split the slot time whatever the room, about half each for calls well under the
//                half-life (a call is never cut short: one of 71 s beside 50 ms calls has 0.54, of 300 s 0.64); a
//                grant taken back at lease_s is charged all of it; a brain with one call at a time has less than
//                half beside a backlog, since a slot it frees goes on before its next ask comes (0.33 of a room of 2);
//                with no brain at work in a pool, all start level again; within a brain, the oldest of the asks it
//                put first (`first`, 2c-2's consolidation) or that have waited their `max_wait_s` (60 unset), else its
//                oldest — 2c-2's turn, held here brain-wide.
// The trust (SMD-3268, no implicit trust): a key per brain, the registry holding only its hash; a brain sees its own
// grants and asks, and `hello` names no other brain. A brain can call every call live, or say every call was held:
// counted and logged, not capped.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";

export const DEFAULT_PORT = 8095;
export const DEFAULT_LEASE_S = 900;
export const DEFAULT_WARM_S = 10;
/** A silent socket's bound: the relay's own silence limit (PR 3b-1's SILENCE_MS), so a brain cut off holds no grant
 *  into a dead socket longer than it takes the relay to give up on it (review pass 3: at 30 s, a partitioned brain's
 *  queued asks were granted into its dead socket and every other brain had 2% of the room for 35 s). */
export const DEFAULT_IDLE_S = 10;
/** A brain's max_wait_s unset: 2c-2's DEFAULT_MAX_WAIT_S. */
export const DEFAULT_MAX_WAIT_S = 60;
export const MAX_MAX_WAIT_S = 86_400;
/** The most a server's parallel setting may say: slots.ts's MAX_SLOTS. */
export const MAX_SLOTS = 16;
/** The most asks one socket may have waiting at once: past it a background ask is `no limit`, and its brain holds it
 *  and asks again as one ends. Live and `held` don't count: a relay carrying a brain's whole traffic is never refused
 *  a live call for a backlog (review pass 2). */
export const MAX_WAITING = 1024;
/** The most asks and grants one socket may hold at all, live included: a bound on a socket's memory. */
export const MAX_HELD = 4096;
/**
 * How long a closed socket's grants stay counted, for the brain to take back with `held` on its next socket (SMD-3379
 * PR 3b-1, review pass 2: given back at the close, they were handed to another brain while the calls ran on, and the
 * brain's `held` a moment later put the server over its slots for as long as they ran). A brain that does not come back
 * frees them after this.
 */
export const ORPHAN_MS = 5000;

/** A brain's background slot time is remembered with this half-life, so the turn evens slot time over the last
 *  minutes: longer than most calls, since a call is never cut short (review pass 3: at 60 s, a brain of 71 s calls had
 *  0.59 of the slot time beside one of 50 ms calls, of 300 s calls 0.74; at 300 s, 0.54 and 0.64). */
export const USE_HALF_LIFE_S = 300;
/** The most sockets one brain may hold open at once: 3b's brain holds one, its coordinator's. */
export const MAX_SOCKETS = 16;
/** The most a socket may have unread before it is closed. */
export const MAX_BUFFERED = 1 << 20;
/** A frame's largest size: an ask is well under 1 KiB. */
export const MAX_FRAME = 4096;
/** A broker key's mark: the key itself, which the registry never holds (its hash does). */
export const KEY_PREFIX = "slot_";

export type ModelServer = { name: string; bases: string[]; slots: number; reserve: number; perModel: boolean };
export type Brain = { name: string; hash: string };
export type Registry = { port: number; leaseS: number; warmS: number; idleS: number; servers: ModelServer[]; brains: Brain[] };

const NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** Words YAML 1.1 reads as a boolean or a null: a name the registry's reader would not see as written. */
const YAML_WORDS = new Set(["y", "n", "yes", "no", "on", "off", "true", "false", "null"]);
const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const isNum = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/** A model server's base as a share knows it: server-portable/slots.ts's normalisedBase, the same words (test-broker.ts holds them equal). */
export function normalisedBase(base: string): string {
  try {
    const u = new URL(base);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return base.replace(/\/+$/, "");
  }
}

/** Whether a name is one the registry takes for a server or a brain: a host label, and no word YAML reads as a boolean or a null. */
export const isName = (name: string): boolean => NAME.test(name) && !YAML_WORDS.has(name);

/** A key's hash as the registry holds it: sha256, hex, as the brain's own keys are (server-portable/auth.ts's hashKey). */
export const hashKey = (raw: string): string => createHash("sha256").update(raw, "utf8").digest("hex");

/** The registry's text read, or every way it is not one. */
export function parseRegistry(text: string): { registry?: Registry; problems: string[] } {
  const problems: string[] = [];
  let doc: unknown;
  try { doc = Bun.YAML.parse(text); } catch (e) { return { problems: [`does not parse as YAML: ${(e as Error).message}`] }; }
  if (!isMapping(doc)) return { problems: ["is not one YAML mapping"] };
  for (const k of Object.keys(doc)) if (!["broker", "servers", "brains"].includes(k)) problems.push(`${k}: not a key of the registry (broker, servers, brains)`);
  const broker = doc.broker ?? {};
  let port = DEFAULT_PORT, leaseS = DEFAULT_LEASE_S, warmS = DEFAULT_WARM_S, idleS = DEFAULT_IDLE_S;
  if (!isMapping(broker)) problems.push("broker: not a mapping");
  else {
    for (const k of Object.keys(broker)) if (!["port", "lease_s", "warm_s", "idle_s"].includes(k)) problems.push(`broker.${k}: not a key of broker (port, lease_s, warm_s, idle_s)`);
    if (broker.port !== undefined) { if (isInt(broker.port, 1, 65535)) port = broker.port; else problems.push("broker.port: a port, 1 to 65535"); }
    if (broker.lease_s !== undefined) { if (isInt(broker.lease_s, 1, 86_400)) leaseS = broker.lease_s; else problems.push("broker.lease_s: whole seconds, 1 to 86400 — longer than the longest call a brain makes"); }
    if (broker.warm_s !== undefined) { if (isNum(broker.warm_s, 0, 600)) warmS = broker.warm_s; else problems.push("broker.warm_s: seconds, 0 to 600"); }
    // Bun closes a socket silent this long; under 8 its pings would not be answered in time on a loaded host.
    if (broker.idle_s !== undefined) { if (isInt(broker.idle_s, 8, 600)) idleS = broker.idle_s; else problems.push("broker.idle_s: whole seconds, 8 to 600"); }
  }
  const servers: ModelServer[] = [];
  const baseOwner = new Map<string, string>();
  if (!isMapping(doc.servers) || Object.keys(doc.servers).length === 0) problems.push("servers: name at least one model server the brains share");
  else for (const [name, raw] of Object.entries(doc.servers)) {
    const at = `servers.${name}`;
    if (!isName(name)) { problems.push(`${at}: a name is lower-case letters, digits and hyphens, starting with a letter, and no word YAML reads as a boolean or a null`); continue; }
    if (!isMapping(raw)) { problems.push(`${at}: not a mapping`); continue; }
    for (const k of Object.keys(raw)) if (!["bases", "slots", "reserve", "per_model"].includes(k)) problems.push(`${at}.${k}: not a key of a server (bases, slots, reserve, per_model)`);
    const bases: string[] = [];
    if (!Array.isArray(raw.bases) || raw.bases.length === 0) problems.push(`${at}.bases: the base URLs brains reach it by, at least one`);
    else for (const b of raw.bases) {
      let u: URL | null = null;
      try { u = typeof b === "string" ? new URL(b) : null; } catch { u = null; }
      if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) { problems.push(`${at}.bases: ${JSON.stringify(b)} is no http(s) URL without credentials, query or fragment`); continue; }
      const n = normalisedBase(b as string);
      const owner = baseOwner.get(n);
      if (owner) { problems.push(`${at}.bases: ${n} is ${owner === name ? "named twice" : `servers.${owner}'s too`} — a base is one server's`); continue; }
      baseOwner.set(n, name);
      bases.push(n);
    }
    if (!isInt(raw.slots, 1, MAX_SLOTS)) problems.push(`${at}.slots: its parallel setting (Ollama: OLLAMA_NUM_PARALLEL), 1 to ${MAX_SLOTS}`);
    const slots = isInt(raw.slots, 1, MAX_SLOTS) ? raw.slots : 1;
    let reserve = 1;
    if (raw.reserve !== undefined) { if (isInt(raw.reserve, 0, slots)) reserve = raw.reserve; else problems.push(`${at}.reserve: the slots background never takes (it keeps at least one), 0 to its slots (${slots})`); }
    let perModel = true;
    if (raw.per_model !== undefined) { if (typeof raw.per_model === "boolean") perModel = raw.per_model; else problems.push(`${at}.per_model: true (each model its own slots, as Ollama's) or false (the server's slots whatever the model, as a one-at-a-time decide tier's)`); }
    servers.push({ name, bases, slots, reserve, perModel });
  }
  const brains: Brain[] = [];
  const hashOwner = new Map<string, string>();
  if (!isMapping(doc.brains) || Object.keys(doc.brains).length === 0) problems.push("brains: name at least one brain, with its key's hash");
  else for (const [name, raw] of Object.entries(doc.brains)) {
    const at = `brains.${name}`;
    if (!isName(name)) { problems.push(`${at}: a name is lower-case letters, digits and hyphens, starting with a letter, and no word YAML reads as a boolean or a null`); continue; }
    if (!isMapping(raw)) { problems.push(`${at}: not a mapping`); continue; }
    for (const k of Object.keys(raw)) if (k !== "key") problems.push(`${at}.${k}: not a key of a brain (key)`);
    const key = raw.key;
    if (typeof key === "string" && key.startsWith(KEY_PREFIX)) { problems.push(`${at}.key: that is the key itself — the registry holds its hash (federated.ts key prints both)`); continue; }
    if (typeof key === "number") { problems.push(`${at}.key: YAML read it as a number — quote the hash, as federated.ts key prints it`); continue; }
    if (typeof key !== "string" || !HEX64.test(key)) { problems.push(`${at}.key: the sha256 of the brain's key, 64 lower-case hex digits — \`bun deploy/federated/federated.ts key --brain ${name}\` prints it`); continue; }
    const owner = hashOwner.get(key);
    if (owner) { problems.push(`${at}.key: brains.${owner}'s too — a key is one brain's`); continue; }
    hashOwner.set(key, name);
    brains.push({ name, hash: key });
  }
  return problems.length ? { problems } : { registry: { port, leaseS, warmS, idleS, servers, brains }, problems };
}

/** The brain a key is, comparing its hash with every brain's in constant time, whichever matches. */
export function brainOf(brains: Brain[], key: string | null): Brain | null {
  if (!key) return null;
  const h = Buffer.from(hashKey(key), "hex");
  let found: Brain | null = null;
  for (const b of brains) if (timingSafeEqual(h, Buffer.from(b.hash, "hex")) && !found) found = b;
  return found;
}

type Conn = { id: number; brain: Brain; brainAt: number; heldLate: boolean; waiting: number; sent: (m: object) => void; held: Map<string, Ask | Grant> };
type Ask = { kind: "ask"; conn: Conn; id: string; pool: Pool; first: boolean; maxWaitMs: number; at: number };
type Grant = { kind: "grant"; conn: Conn; id: string; pool: Pool; live: boolean; at: number };
type Pool = {
  key: string; server: ModelServer;
  live: Set<Grant>; bg: Set<Grant>;
  /** Each brain's live grants here, by its index: counted as they come and go, not by a walk of `live`. */
  liveBy: number[];
  /** Each brain's asks waiting, by its index in the registry, in the order asked (a Set: a withdrawal is O(1)). */
  queues: Set<Ask>[];
  /** Each brain's background slot time here, ms, decayed (USE_HALF_LIFE_S) as of `usedAt`: with its grants running,
   *  whose turn it is. */
  used: number[];
  usedAt: number;
  /** The index of the brain served last, -1 before any: ties go round from it. */
  last: number;
};

/** What a test reads of the broker: each pool's counts, and each brain's asks waiting and slot time there. */
export type Snapshot = Record<string, { live: number; background: number; waiting: Record<string, number>; used: Record<string, number> }>;

export type Broker = { port: number; stop(): Promise<void>; snapshot(): Snapshot };

/** Starts serving the registry's brains. `port` 0 takes a free one (a test's). */
export function startBroker(reg: Registry, opts: { hostname?: string; port?: number; log?: (line: string) => void; now?: () => number; orphanMs?: number } = {}): Broker {
  const log = opts.log ?? ((line: string) => console.log(`slots: ${line}`));
  /** The broker's clock, in ms: performance.now() unless a test hands it one it moves itself. */
  const clock = opts.now ?? (() => performance.now());
  const started = clock();
  const warmUntil = started + reg.warmS * 1000;
  const pools = new Map<string, Pool>();
  const sockets = reg.brains.map(() => 0);
  const serverOf = new Map<string, ModelServer>();
  for (const s of reg.servers) for (const b of s.bases) serverOf.set(b, s);
  let nextConn = 1;
  const orphanMs = opts.orphanMs ?? ORPHAN_MS;
  /** A closed socket's grants, by brain and id, kept counted until the brain takes them back or ORPHAN_MS passes. */
  /** Each brain's kept grants by id, at most MAX_HELD a brain (the oldest given back past it: review pass 3, a brain
   *  reconnecting fast left 81,920 and 108 MB), each closed socket's freed by one timer. */
  const orphansBy = reg.brains.map(() => new Map<string, Grant>());
  const orphanTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Each brain's open sockets: a `held` moves a grant from a half-open old one rather than counting it twice. */
  const connsBy = reg.brains.map(() => new Set<Conn>());
  let stopping = false;
  /** A kept grant given back, if it is still kept. */
  const freeOrphan = (b: number, id: string) => { const g = orphansBy[b].get(id); if (!g) return; orphansBy[b].delete(id); release(g); };
  /** Connections and closes, said once a minute a brain and kind, with the count unsaid since (a link flapping). */
  const connSaid = new Map<string, { at: number; unsaid: number }>();
  const sayConn = (b: number, kind: string, line: string) => {
    const k = `${b}\n${kind}`, now = clock(), was = connSaid.get(k);
    if (was && now - was.at < 60_000) { was.unsaid++; return; }
    log(`${line}${was?.unsaid ? ` (and ${was.unsaid} more since the last said)` : ""}`);
    connSaid.set(k, { at: now, unsaid: 0 });
  };
  /** This start's id, in each hello: a brain that sees it change knows the broker restarted, not only its own socket. */
  const boot = crypto.randomUUID();

  // A pool lives while it holds a grant or an ask: a brain naming a new model each call costs nothing once it is done
  // (review pass 1: kept, 300k models grew the broker 18 MB to 530 MB).
  const poolFor = (server: ModelServer, asked: string): Pool => {
    // A server whose slots are the server's, whatever the model (`per_model: false`: a decide tier serving one call at
    // a time), is one pool however its brains name their models (review pass 2).
    const model = server.perModel ? asked : "*";
    const key = `${server.name}/${model}`;
    let p = pools.get(key);
    if (!p) { p = { key, server, live: new Set(), bg: new Set(), liveBy: reg.brains.map(() => 0), queues: reg.brains.map(() => new Set()), used: reg.brains.map(() => 0), usedAt: clock(), last: -1 }; pools.set(key, p); }
    return p;
  };
  const prune = (p: Pool) => { if (p.live.size === 0 && p.bg.size === 0 && p.queues.every((q) => q.size === 0)) pools.delete(p.key); };
  const room = (p: Pool) => p.bg.size < Math.max(1, p.server.slots - p.server.reserve) && p.live.size + p.bg.size < p.server.slots;
  const warming = () => clock() < warmUntil;

  /**
   * The over-capacity line and a brain's over-its-slots-live line, each at most once a minute a server (and brain):
   * kept here, not on a pool, which goes when it empties (review pass 2: a brain looping two live calls on a one-slot
   * server had each said a thousand times a second). Bounded by the registry's servers and brains.
   */
  const saidAt = new Map<string, number>();
  const sayOnce = (key: string, line: () => string) => { const now = clock(); if (now - (saidAt.get(key) ?? -Infinity) < 60_000) return; saidAt.set(key, now); log(line()); };
  const watch = (p: Pool, by?: Conn) => {
    if (p.live.size + p.bg.size > p.server.slots) sayOnce(p.server.name, () => `${p.key}: ${p.live.size} live and ${p.bg.size} background calls run on ${p.server.slots} slots — the server queues the rest`);
    if (!by) return;
    // Counted, not walked: a walk of `live` each grant made 64k live calls cost 6 s, every brain waiting (review pass 4).
    const mine = p.liveBy[by.brainAt];
    if (mine > p.server.slots) sayOnce(`${p.server.name}\n${by.brainAt}`, () => `${p.key}: brain ${by.brain.name} has ${mine} live calls running, past the server's ${p.server.slots} slots`);
  };
  /** Each brain's score in the pool at `t`: its remembered slot time, decayed to `t`, and its running grants' time. */
  const scores = (p: Pool, t: number) => {
    decay(p, t);
    const score = [...p.used];
    for (const g of p.bg) score[g.conn.brainAt] += t - g.at;
    return score;
  };
  /** Whether a brain has anything in the pool: an ask waiting or a background grant running. */
  const active = (p: Pool, b: number) => { if (p.queues[b].size) return true; for (const g of p.bg) if (g.conn.brainAt === b) return true; return false; };
  /**
   * A brain coming to a pool where others are at work starts level with the least of them, not at nothing (review pass
   * 3: else it held every slot for a half-life); with no brain at work, every brain starts level again, as a pool pruned
   * would (review pass 4). Done as a brain asks, or comes back with calls running (`held`), with nothing there yet.
   */
  const level = (p: Pool, b: number) => {
    if (active(p, b)) return;
    const t = clock();
    const score = scores(p, t);
    let floor = Infinity;
    for (let i = 0; i < score.length; i++) if (i !== b && active(p, i)) floor = Math.min(floor, score[i]);
    if (floor === Infinity) p.used.fill(0);
    else if (p.used[b] < floor) p.used[b] = floor;
  };
  /** Decays the pool's remembered slot time to now. */
  const decay = (p: Pool, now: number) => {
    const f = 0.5 ** ((now - p.usedAt) / (USE_HALF_LIFE_S * 1000));
    for (let i = 0; i < p.used.length; i++) p.used[i] *= f;
    p.usedAt = now;
  };

  const grant = (conn: Conn, id: string, p: Pool, live: boolean) => {
    const g: Grant = { kind: "grant", conn, id, pool: p, live, at: clock() };
    if (live) { p.live.add(g); p.liveBy[conn.brainAt]++; } else p.bg.add(g);
    conn.held.set(id, g);
    conn.sent({ op: "go", id });
    watch(p, live ? conn : undefined);
  };

  /**
   * Hands the pool's free background room out while any brain has an ask waiting: to the waiting brain that has had the
   * least background slot time here — its remembered time, decayed, and its grants' running time — ties going round
   * from the brain served last, so two backlogged brains split the slot time whatever the room, about half each for
   * calls well under the half-life (review pass 1: by turns, a brain of 5 ms calls had 6% beside one of 60 ms; review
   * pass 2: by grants held, 8% wherever the room is one slot); and within it, the oldest of its asks put first or past
   * their max_wait_s, else its oldest.
   */
  const pump = (p: Pool) => {
    if (warming()) return;
    const n = p.queues.length;
    while (room(p)) {
      const now = clock();
      const score = scores(p, now);
      let at = -1;
      for (let i = 1; i <= n; i++) {
        const b = (p.last + i + n) % n;
        if (p.queues[b].size && (at < 0 || score[b] < score[at])) at = b;
      }
      if (at < 0) return;
      const q = p.queues[at];
      // The oldest of its asks put first or past their max_wait_s, else its oldest — by when each began waiting, which
      // `waited_s` dates back, so not always the order asked.
      let a: Ask | undefined, oldest: Ask | undefined;
      for (const x of q) {
        if ((x.first || now - x.at >= x.maxWaitMs) && (!a || x.at < a.at)) a = x;
        if (!oldest || x.at < oldest.at) oldest = x;
      }
      a ??= oldest!;
      q.delete(a);
      a.conn.waiting--;
      p.last = at;
      a.conn.held.delete(a.id);
      grant(a.conn, a.id, p, false);
    }
  };

  const release = (x: Ask | Grant) => {
    if (x.conn.held.get(x.id) === x) x.conn.held.delete(x.id);
    if (x.kind === "ask") { if (x.pool.queues[x.conn.brainAt].delete(x)) x.conn.waiting--; prune(x.pool); return; }
    if (x.live) { if (!x.pool.live.delete(x)) return; x.pool.liveBy[x.conn.brainAt]--; } else {
      if (!x.pool.bg.delete(x)) return;
      const now = clock();
      decay(x.pool, now);
      x.pool.used[x.conn.brainAt] += now - x.at;
    }
    watch(x.pool);
    pump(x.pool);
    prune(x.pool);
  };

  const onFrame = (conn: Conn, text: string) => {
    let m: Record<string, unknown>;
    try { const v = JSON.parse(text); if (!isMapping(v)) throw 0; m = v; } catch { conn.sent({ op: "no", id: null, why: "bad" }); return; }
    const id = typeof m.id === "string" && m.id.length >= 1 && m.id.length <= 64 ? m.id : null;
    if (id === null) { conn.sent({ op: "no", id: null, why: "bad" }); return; }
    if (m.op === "done") { const x = conn.held.get(id); if (x) release(x); else freeOrphan(conn.brainAt, id); return; }
    // A brain's relay has re-registered every call it still runs: its kept grants no `held` named are given back now,
    // not at ORPHAN_MS (review pass 3: on a flapping link they sat 5 s a time with no call, the room idle 41%).
    if (m.op === "synced") { for (const oid of [...orphansBy[conn.brainAt].keys()]) freeOrphan(conn.brainAt, oid); return; }
    // A brain's liveness check (SMD-3379 PR 3b-1): answered, nothing else.
    if (m.op === "ping") { conn.sent({ op: "pong", id }); return; }
    if (m.op !== "ask" && m.op !== "held") { conn.sent({ op: "no", id, why: "bad" }); return; }
    const model = m.model === undefined || m.model === null ? "?" : typeof m.model === "string" && m.model.length >= 1 && m.model.length <= 256 ? m.model : null;
    const cls = m.cls === "live" || m.cls === "background" ? m.cls : null;
    const maxWait = m.max_wait_s === undefined ? DEFAULT_MAX_WAIT_S : isNum(m.max_wait_s, 0, MAX_MAX_WAIT_S) ? m.max_wait_s : null;
    const waited = m.waited_s === undefined ? 0 : isNum(m.waited_s, 0, MAX_MAX_WAIT_S) ? m.waited_s : null;
    if (typeof m.base !== "string" || m.base.length > 2048 || model === null || cls === null || maxWait === null || waited === null || (m.first !== undefined && typeof m.first !== "boolean")) { conn.sent({ op: "no", id, why: "bad" }); return; }
    if (conn.held.has(id)) { conn.sent({ op: "no", id, why: "id" }); return; }
    if (conn.held.size >= MAX_HELD || (m.op === "ask" && cls === "background" && conn.waiting >= MAX_WAITING)) { conn.sent({ op: "no", id, why: "limit" }); return; }
    const server = serverOf.get(normalisedBase(m.base));
    if (!server) { conn.sent({ op: "no", id, why: "server" }); return; }
    const p = poolFor(server, model);
    // A `held` outside the warm-up — a brain back after its socket dropped, its calls still running — is counted as
    // it is: those calls run whether counted or not. Said once a socket, since it can take background past its room.
    if (m.op === "held" && !warming() && !conn.heldLate) { conn.heldLate = true; log(`brain ${conn.brain.name} (socket ${conn.id}) re-registers held slots outside the warm-up: counted, past the room if need be`); }
    if (m.op === "held") {
      const live = cls === "live";
      const adopt = (g: Grant) => { g.conn = conn; conn.held.set(id, g); conn.sent({ op: "go", id }); };
      // Its own grant back, kept since its socket closed: taken up again, not counted twice — if it is still counted
      // (the lease's sweep may have taken it: then it lapsed); one of another pool or class given back, not doubled.
      const o = orphansBy[conn.brainAt].get(id);
      if (o) {
        orphansBy[conn.brainAt].delete(id);
        if (o.pool === p && o.live === live) {
          if ((live ? p.live : p.bg).has(o)) { adopt(o); return; }
          conn.sent({ op: "lapsed", id });
          return;
        }
        release(o);
      }
      // Its grant on another socket of its own still open — a half-open one the broker has not yet closed — moved, not
      // counted twice (review pass 3).
      for (const c of connsBy[conn.brainAt]) {
        if (c === conn) continue;
        const x = c.held.get(id);
        if (x?.kind === "grant" && x.pool === p && x.live === live) { c.held.delete(id); adopt(x); return; }
      }
      // A brain back with calls running starts level, as one asking does (review pass 2: its held calls made it look
      // at work, so its old score from before a partition shut the other brain out for 48 s).
      if (cls === "background") level(p, conn.brainAt);
      grant(conn, id, p, cls === "live");
      return;
    }
    if (cls === "live") { grant(conn, id, p, true); return; }
    // A brain coming to a pool where others are at work starts level with the least of them, not at nothing: else it
    // would hold every background slot until its time caught up with theirs, a half-life of the others waiting (review
    // pass 3: brain A backlogged ten minutes had none of the slots for the minute after B arrived, and waited 62 s).
    level(p, conn.brainAt);
    const a: Ask = { kind: "ask", conn, id, pool: p, first: m.first === true, maxWaitMs: maxWait * 1000, at: clock() - waited * 1000 };
    p.queues[conn.brainAt].add(a);
    conn.waiting++;
    conn.held.set(id, a);
    pump(p);
    if (conn.held.get(id) === a) conn.sent({ op: "queued", id });
  };

  const server = Bun.serve<Conn>({
    hostname: opts.hostname ?? "127.0.0.1",
    port: opts.port ?? reg.port,
    fetch(req, srv) {
      // The path alone, read so that no Host header, however written, throws (review pass 2: `a b` was a 500 and a stack).
      let url: URL;
      try { url = new URL(req.url); } catch { return new Response(null, { status: 400 }); }
      if (url.pathname === "/health") return req.method === "GET" ? new Response("ok\n") : new Response(null, { status: 405 });
      if (url.pathname !== "/v1/slots") return new Response(null, { status: 404 });
      if (req.method !== "GET") return new Response(null, { status: 405 });
      const brain = brainOf(reg.brains, req.headers.get("x-brain-key"));
      if (!brain) return new Response("no brain has that key\n", { status: 401 });
      const brainAt = reg.brains.indexOf(brain);
      if (sockets[brainAt] >= MAX_SOCKETS) return new Response(`brain ${brain.name} has ${MAX_SOCKETS} sockets open already\n`, { status: 429 });
      const conn: Conn = { id: nextConn++, brain, brainAt, heldLate: false, waiting: 0, sent: () => {}, held: new Map() };
      if (srv.upgrade(req, { data: conn })) return undefined;
      return new Response("a WebSocket upgrade, please\n", { status: 426 });
    },
    websocket: {
      maxPayloadLength: MAX_FRAME,
      idleTimeout: reg.idleS,
      sendPings: true,
      // A brain that stops reading is closed once 1 MiB waits unread, rather than sent to without end — Bun drops a
      // frame past its limit, and a `go` it never read would hold a slot until lease_s (review pass 1). Its close
      // withdraws its asks and keeps its grants for its return.
      backpressureLimit: MAX_BUFFERED,
      closeOnBackpressureLimit: true,
      open(ws: ServerWebSocket<Conn>) {
        const conn = ws.data;
        sockets[conn.brainAt]++;
        connsBy[conn.brainAt].add(conn);
        conn.sent = (m) => { ws.send(JSON.stringify(m)); };
        sayConn(conn.brainAt, "open", `brain ${conn.brain.name} connected (socket ${conn.id})`);
        conn.sent({ op: "hello", brain: conn.brain.name, boot, lease_s: reg.leaseS, idle_s: reg.idleS, warm_s_left: Math.max(0, Math.ceil(warmUntil - clock()) / 1000), max_waiting: MAX_WAITING, max_held: MAX_HELD, max_sockets: MAX_SOCKETS, max_frame: MAX_FRAME, servers: reg.servers.map((s) => ({ name: s.name, bases: s.bases, slots: s.slots, reserve: s.reserve, per_model: s.perModel })) });
      },
      message(ws: ServerWebSocket<Conn>, msg: string | Buffer) {
        if (typeof msg !== "string") { ws.data.sent({ op: "no", id: null, why: "bad" }); return; }
        onFrame(ws.data, msg);
      },
      close(ws: ServerWebSocket<Conn>) {
        const conn = ws.data;
        conn.sent = () => {};
        sockets[conn.brainAt]--;
        connsBy[conn.brainAt].delete(conn);
        // Its asks first, then its grants: a grant given back first would be handed to the closing socket's own next
        // ask, a grant no one would give back (review pass 1: a background slot held for lease_s, the pool wedged).
        const all = [...conn.held.values()];
        const asks = all.filter((x) => x.kind === "ask"), grants = all.filter((x) => x.kind === "grant");
        for (const x of asks) release(x);
        // Its grants kept counted a while, for the brain's next socket to take back (`held`, same id), else given back.
        const keep = orphanMs > 0 && !stopping;
        const kept: Grant[] = [];
        for (const x of grants) {
          if (!keep || x.kind !== "grant") { release(x); continue; }
          const mine = orphansBy[conn.brainAt];
          freeOrphan(conn.brainAt, x.id);
          mine.set(x.id, x);
          kept.push(x);
          // Past MAX_HELD kept a brain, its oldest given back.
          while (mine.size > MAX_HELD) { const [oldest] = mine.keys(); freeOrphan(conn.brainAt, oldest); }
        }
        if (kept.length) {
          const t = setTimeout(() => { orphanTimers.delete(t); for (const x of kept) if (orphansBy[conn.brainAt].get(x.id) === x) freeOrphan(conn.brainAt, x.id); }, orphanMs);
          orphanTimers.add(t);
        }
        sayConn(conn.brainAt, "close", `brain ${conn.brain.name} disconnected (socket ${conn.id})${all.length ? `, withdrawing ${asks.length} ask${asks.length === 1 ? "" : "s"}${grants.length ? ` and ${keep ? "keeping" : "giving back"} ${grants.length} grant${grants.length === 1 ? "" : "s"}${keep ? ` ${orphanMs / 1000} s for its return` : ""}` : ""}` : ""}`);
      },
    },
  });

  // The lease's backstop: a grant held past lease_s is taken back, and its socket told.
  const sweepMs = Math.max(250, Math.min(reg.leaseS * 250, 30_000));
  const sweep = setInterval(() => {
    const now = clock();
    for (const p of [...pools.values()]) for (const g of [...p.live, ...p.bg]) {
      if (now - g.at < reg.leaseS * 1000) continue;
      log(`${p.key}: brain ${g.conn.brain.name}'s ${g.live ? "live" : "background"} grant ${g.id} held past ${reg.leaseS} s, taken back`);
      g.conn.sent({ op: "lapsed", id: g.id });
      if (orphansBy[g.conn.brainAt].get(g.id) === g) orphansBy[g.conn.brainAt].delete(g.id);
      release(g);
    }
  }, sweepMs);
  // The warm-up's end: the asks it held are turned.
  const warm = reg.warmS > 0 ? setTimeout(() => { for (const p of [...pools.values()]) pump(p); }, reg.warmS * 1000 + 1) : null;
  log(`serving ${reg.brains.length} brain${reg.brains.length === 1 ? "" : "s"} on ${reg.servers.map((s) => `${s.name} (${s.slots} slots, ${s.reserve} reserved)`).join(", ")}${reg.warmS ? `; background held ${reg.warmS} s while brains re-register` : ""}`);

  return {
    port: server.port ?? 0,
    async stop() {
      stopping = true;
      clearInterval(sweep);
      if (warm) clearTimeout(warm);
      for (const t of orphanTimers) clearTimeout(t);
      orphanTimers.clear();
      await server.stop(true);
    },
    snapshot() {
      const out: Snapshot = {};
      for (const p of pools.values()) {
        const waiting: Record<string, number> = {};
        p.queues.forEach((q, i) => { if (q.size) waiting[reg.brains[i].name] = q.size; });
        const used: Record<string, number> = {};
        decay(p, clock());
        p.used.forEach((u, i) => { if (u) used[reg.brains[i].name] = Math.round(u); });
        out[p.key] = { live: p.live.size, background: p.bg.size, waiting, used };
      }
      return out;
    },
  };
}

function selfCheck() {
  const h = (c: string) => c.repeat(64);
  const ok = (text: string) => parseRegistry(text).registry;
  const problems = (text: string) => parseRegistry(text).problems.join("\n");
  const base = `servers:\n  ollama:\n    bases: [http://host.containers.internal:11434/v1]\n    slots: 3\nbrains:\n  stable:\n    key: ${h("a")}\n`;
  const r = ok(base);
  const cases: [string, boolean][] = [
    ["the smallest registry reads, with the defaults", !!r && r.port === DEFAULT_PORT && r.leaseS === DEFAULT_LEASE_S && r.warmS === DEFAULT_WARM_S && r.idleS === DEFAULT_IDLE_S && r.servers[0].reserve === 1 && r.servers[0].bases[0] === "http://host.containers.internal:11434/v1"],
    ["the example registry reads but for its placeholder keys, each naming the command that prints one", (() => { const pr = parseRegistry(readFileSync(new URL("./federation.example.yaml", import.meta.url), "utf8")).problems; return pr.length === 2 && pr.every((x) => /federated.ts key --brain (stable|canary)/.test(x)); })()],
    ["per_model defaults to true, takes false, and refuses anything else", ok(base)?.servers[0].perModel === true && ok(base.replace("slots: 3", "slots: 3\n    per_model: false"))?.servers[0].perModel === false && /per_model: true/.test(problems(base.replace("slots: 3", "slots: 3\n    per_model: no-way")))],
    ["a base is normalised: host lower-cased, trailing slashes gone", ok(base.replace("http://host.containers.internal:11434/v1", "HTTP://Host.Containers.Internal:11434/v1//"))?.servers[0].bases[0] === "http://host.containers.internal:11434/v1"],
    ["a reserve of one slot's server defaults to 1, and 0 is allowed", ok(base.replace("slots: 3", "slots: 1"))?.servers[0].reserve === 1 && ok(base.replace("slots: 3", "slots: 3\n    reserve: 0"))?.servers[0].reserve === 0],
    ["a reserve past the slots is refused", /reserve: the slots background never takes/.test(problems(base.replace("slots: 3", "slots: 3\n    reserve: 4")))],
    ["slots outside 1..16 are refused", [0, 17, 2.5, "3"].every((s) => /slots: its parallel setting/.test(problems(base.replace("slots: 3", `slots: ${JSON.stringify(s)}`))))],
    ["a base twice, in one server or two, is refused", /named twice/.test(problems(base.replace("bases: [http://host.containers.internal:11434/v1]", "bases: [http://host.containers.internal:11434/v1, http://host.containers.internal:11434/v1/]"))) && /servers.ollama's too/.test(problems(base.replace("brains:", "  other:\n    bases: [http://host.containers.internal:11434/v1]\n    slots: 1\nbrains:")))],
    ["a base with credentials, a query or no http is refused", ["http://u:p@h:1/v1", "http://h:1/v1?x=1", "ftp://h/v1", "not a url"].every((b) => /is no http\(s\) URL/.test(problems(base.replace("http://host.containers.internal:11434/v1", b))))],
    ["the key itself, in place of its hash, is refused by name", /that is the key itself/.test(problems(base.replace(h("a"), `${KEY_PREFIX}${h("b")}`)))],
    ["a hash not 64 lower-case hex is refused", [h("A"), h("a").slice(1), "x"].every((k) => /the sha256 of the brain's key/.test(problems(base.replace(h("a"), k))))],
    ["a hash YAML reads as a number is refused, naming the quotes", /quote the hash/.test(problems(base.replace(h("a"), "1".repeat(64))))],
    ["one hash for two brains is refused", /brains.stable's too/.test(problems(base + `  canary:\n    key: ${h("a")}\n`))],
    ["a name YAML reads as a word, or not a host label, is refused", ["null", "on", "Stable", "-x"].every((n) => /a name is lower-case letters/.test(problems(base.replace("  stable:", `  ${JSON.stringify(n)}:`))))],
    ["unknown keys are refused at each level", /extra: not a key of the registry/.test(problems(base + "extra: 1\n")) && /broker.pot: not a key of broker/.test(problems("broker:\n  pot: 1\n" + base)) && /servers.ollama.slot: not a key of a server/.test(problems(base.replace("slots: 3", "slots: 3\n    slot: 3"))) && /brains.stable.hash: not a key of a brain/.test(problems(base + "    hash: x\n"))],
    ["no server or no brain is refused", /servers: name at least one/.test(problems(`brains:\n  a:\n    key: ${h("a")}\n`)) && /brains: name at least one/.test(problems("servers:\n  o:\n    bases: [http://h:1/v1]\n    slots: 1\n"))],
    ["broker settings out of range are refused", /broker.port/.test(problems("broker:\n  port: 0\n" + base)) && /broker.lease_s/.test(problems("broker:\n  lease_s: 0\n" + base)) && /broker.warm_s/.test(problems("broker:\n  warm_s: -1\n" + base)) && /broker.idle_s/.test(problems("broker:\n  idle_s: 7\n" + base))],
    ["not YAML, or not a mapping, is refused", /does not parse/.test(problems("servers: [\n")) && /not one YAML mapping/.test(problems("- a\n"))],
    ["a key's brain is found by its hash, and no other key is", (() => { const reg = ok(base + `  canary:\n    key: ${hashKey("k2")}\n`)!; return brainOf(reg.brains, "k2")?.name === "canary" && brainOf(reg.brains, "k3") === null && brainOf(reg.brains, null) === null; })()],
  ];
  for (const [name, pass] of cases) console.log((pass ? "ok   " : "FAIL ") + name);
  process.exit(cases.every(([, pass]) => pass) ? 0 : 1);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--self-check") selfCheck();
  else {
    let path = "", host = "127.0.0.1";
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--registry" && args[i + 1]) path = args[++i];
      else if (args[i] === "--host" && args[i + 1]) host = args[++i];
      else { console.error("usage: bun broker.ts --registry PATH [--host ADDRESS] | --self-check"); process.exit(2); }
    }
    if (!path) { console.error("usage: bun broker.ts --registry PATH [--host ADDRESS] | --self-check"); process.exit(2); }
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch (e) { console.error(`slots: the registry at ${path} could not be read: ${(e as Error).message}`); process.exit(2); }
    const { registry, problems } = parseRegistry(text);
    if (!registry) { console.error(`slots: the registry at ${path}:\n${problems.map((p) => `  ${p}`).join("\n")}`); process.exit(2); }
    const broker = startBroker(registry, { hostname: host });
    const stop = () => { void broker.stop().then(() => process.exit(0)); };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  }
}
