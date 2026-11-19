// The slot broker (SMD-3379 PR 3a): the federated coordinator's slot service (docs/brain-coordinator.md, row 2). One
// process on the host, beside the model servers the brains on it share, that hands their model calls the servers'
// slots: a live call at once, always; a background call in turn across the brains, within the room the live calls
// leave. So one brain's passes yield to another brain's live work, a brain alone may use every background slot, and
// two backlogged brains split them (SMD-3034's host rule, the ticket's Verify 4). A brain asks it through its coordinator
// (PR 3b-1); while it is down, or for a base it does not broker, a brain keeps its own share (PR 2's semaphore).
//
//   bun --no-install --no-env-file broker.ts --registry PATH [--host ADDRESS] [--port N]
//                                                 serve (127.0.0.1 unless --host; the registry's port unless --port)
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
//                   {op:"done", id}   the call ended, or the ask is withdrawn; a grant kept from its closed socket
//                                     given back; ignored for an id neither held nor kept (lapsed)
//                   {op:"ping", id}   answered {op:"pong", id}: a brain's own liveness check (PR 3b-1's relay)
//                   {op:"synced", id} every call still running re-registered (`held`): that relay's kept grants (ids
//                                     `<id>:…`) no held named are given back now, not at KEEP_MS, and those of a relay
//                                     no open socket speaks for (a coordinator replaced) — but for two relays on one key
//   broker → brain  {op:"hello", brain, boot, lease_s, idle_s, warm_s_left, max_waiting, max_held, max_sockets,
//                    max_frame, servers: [{name, bases, slots, reserve, per_model, residency}]}
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
// withdraws every ask it had waiting, and keeps its grants counted KEEP_MS (5 s): a brain back within it takes each
// again with `held`, same id, counted once (PR 3b-1's relay re-registers its running calls so); after it, they are
// given back — at once where the brain's relay has synced on a newer socket, or the socket was found dead by a probe.
// A brain asks its asks again on its next socket; an ask naming a grant or ask on another of its sockets still open
// moves it, and a held naming a grant. The broker keeps its own liveness, on real time: it pings a socket
// quiet a third of idle_s, ends one silent idle_s (Bun's own idle clock is reset by every send, so a dead socket being
// granted to never closed), and grants nothing into one silent half of it; a brain's new socket pings its others, and
// one not answering within PROBE_MS (2 s) is ended — a client stalled that long is ended with it. Two relays on one
// key at once are said once, and each keeps its own grants.
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
//                are at work — asking, or back with calls running (`held`) — starting level with the least of them —
//                ties going round from the brain served last: two
//                backlogged brains split the slot time whatever the room, about half each for calls well under the
//                half-life (a call is never cut short: one of 71 s beside 50 ms calls has 0.54, of 300 s 0.64); a
//                grant taken back at lease_s is charged all of it; a brain with one call at a time has less than
//                half beside a backlog, since a slot it frees goes on before its next ask comes (0.33 of a room of 2);
//                with no brain at work in a pool, all start level again; within a brain, the oldest of the asks it
//                put first (`first`, 2c-2's consolidation) or that have waited their `max_wait_s` (60 unset), else its
//                oldest — 2c-2's turn, held here brain-wide.
// Residency (PR 3c-1), per server whose registry entry names `ps` — its list of the models it has loaded now (Ollama's
// GET /api/ps), read every PS_S (3 s; every second while a load is under way), a model's name read as Ollama's list
// writes it (`tagged`). A server holds only so many models: one asked for that is not loaded may put
// another out, which waits for every call on that one to end while each later load queues behind it (measured in PR
// 3b-3b: a 22 GiB model's load waited 24 minutes for a model background calls kept busy, live embeds queued behind it).
// So, for background alone — a live call is granted at once, as ever:
//   loaded       an ask for a model the list names goes as above;
//   not loaded   it goes at once where the server has no model loaded. Else it waits until the server's last
//                background load ended `stay_s` ago (the registry's, 60 unset): a model background just loaded
//                stays that long, whatever another brain's asks say (review pass 1: at the asker's bound alone, a
//                brain asking with 0 had 74 calls to another's 23; pass 2: nor is it put out sooner for being idle
//                5 s). Then it goes once the loaded models have had no background call for BG_QUIET_S (5 s) and no
//                live call for LIVE_QUIET_S (120 s), or once it has waited its `max_wait_s` (decided 2026-11-18:
//                the ask's own bound) and no live call runs on the server at that moment — no drain begins under
//                a live call, whose model the load might have to wait for (review pass 1: live calls overlapping
//                without a gap, the load never came, and the model drained for it was put out);
//   the drain    then the server's other models are granted no background, and once none of theirs runs the ask
//                is granted, one load at a time a server, and they stay held until the list names its model or
//                its calls have ended and the list is next read. A drain not done in HOLD_S (120 s) — a call that
//                long, or one never given back — is given up, the others going on, and none is begun for another
//                HOLD_S: no load is granted while background still runs on a model it may put out (review pass 2:
//                granted at the bound, it was left out of the rule 120 s on, and its asks went by the room beside
//                the busy model, as before 3c-1). A live call to a model not loaded holds the others the same
//                way, at once, and background to no model but its own goes while it is under way.
// The list unread at the start, or unreadable PS_STALE_S (10 s) — no answer in 2 s, no 200, a redirect, over 1 MiB, not
// its shape — is no rule at all, each change said once: the rule above the line, as before 3c-1. A model whose
// calls end with the list never naming it, UNLISTED_AFTER (3) reads running:
//   the list the same at each   it disturbs nothing — a name the server lists another way, a model it does not know —
//                               and is left out of the rule until it is listed, said once;
//   the list changed            it may have put models out and not loaded — its next load waits BACKOFF_S (60 s)
//                               more each time, ten at most, said at the third (review pass 2: left out, its 44
//                               failed loads in 570 s each put out what was idle, and another brain had a fifth
//                               of its calls); such a load begins no stay, so what it put out is loaded again at once.
// One load that has held the others HOLD_S — a load waiting on a model live calls keep busy, a call never given back
// — is left out for HOLD_S and held to again, turn about, while it lasts (pass 2: left out until listed, the others'
// background kept its load waiting 245 s past the live calls' end). A live call running HOLD_S and more — a brain
// gives its call up at OB1_LLM_TIMEOUT, 120 s unset — holds back no load (pass 2: one never given back, and no background load for lease_s). A
// model unnamed (`?`) is taken for loaded: no list could name it. So a brain's call of either class to a model not listed holds a server's other background — HOLD_S a
// load at most, and until the list's next read where it ends unlisted — said once a minute a brain with the count
// since, and not capped, as its live calls are not; and an ask's age (`waited_s`) and `max_wait_s` are its brain's
// own word, which order the loads across brains while `stay_s` keeps the turns.
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
export const KEEP_MS = 5000;
/** How long a brain stays held to per-relay rules after two of its relays were last seen live at once. */
export const TWIN_LAPSE_MS = 60_000;
/** How long a brain's older socket, pinged as its newer one opens, may go unanswering before it is ended. */
export const PROBE_MS = 2000;

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
/** How often a server's loaded models are read (`ps`), and how often while a load is wanted or under way. */
export const PS_S = 3;
export const PS_FAST_S = 1;
/** A read's bound, and the list's: Ollama's own is a few hundred bytes a model. */
export const PS_TIMEOUT_MS = 2000;
export const PS_MAX_BYTES = 1 << 20;
export const PS_MAX_MODELS = 256;
/** A list unreadable this long is no list: the server has no residency rule until it reads again. */
export const PS_STALE_S = 10;
/** A loaded model with a live call this lately is not put out for background work, short of the ask's max_wait_s. */
export const LIVE_QUIET_S = 120;
/** Loaded models with a background call ended this lately are still at work: a pass asking one call at a time has
 *  none running for an instant between two (review pass 1: 18 loads for 10 calls, each put out as its call ended). */
export const BG_QUIET_S = 5;
/** A model background loaded stays this long before background loads another, unless the registry says (`stay_s`). */
export const DEFAULT_STAY_S = 60;
/** The longest a drain waits on background still running — then given up, and none begun for as long again — and
 *  the longest one load holds a server's other background, its model then left out of the rule (review pass 1: a
 *  grant never given back held every drain to lease_s; a name the list never wrote held the others while its calls
 *  overlapped). */
export const HOLD_S = 120;
/** A model whose calls ended at this many reads running with the list not naming it is left out of the rule, or
 *  said to be backing off. */
export const UNLISTED_AFTER = 3;
/** What each load that changed the list and never showed in it adds to the wait before the model's next, and the most. */
export const BACKOFF_S = 60;
export const BACKOFF_MOST = 10;
/** The least time between two reads of a list begun for a call's end (review pass 1: 7,000 a second, a brain's to drive). */
export const PS_GAP_MS = 250;
/** The most models a server's residency remembers ended calls or misses for: a brain naming a new one each call. */
export const MAX_NOTED = 256;
/** A server of this many pools or fewer is turned at each change; a larger one at the broker's next tick. */
export const TURN_NOW = 64;
/** A broker key's mark: the key itself, which the registry never holds (its hash does). */
export const KEY_PREFIX = "slot_";

export type ModelServer = { name: string; bases: string[]; slots: number; reserve: number; perModel: boolean; ps: string | null; stayS: number };
export type Brain = { name: string; hash: string };
export type Registry = { port: number; leaseS: number; warmS: number; idleS: number; servers: ModelServer[]; brains: Brain[] };

const NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** Words YAML 1.1 reads as a boolean or a null: a name the registry's reader would not see as written. */
const YAML_WORDS = new Set(["y", "n", "yes", "no", "on", "off", "true", "false", "null"]);
const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const isNum = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
/** The relay an id is of: its prefix to the first ":", which that relay's `synced` named; "" for none. */
const relayOf = (id: string): string => (id.includes(":") ? id.slice(0, id.indexOf(":")) : "");

/** A model server's base as a share knows it: server-portable/slots.ts's normalisedBase, the same words (test-broker.ts holds them equal). */
export function normalisedBase(base: string): string {
  try {
    const u = new URL(base);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return base.replace(/\/+$/, "");
  }
}

/** A model's name as Ollama's list writes it: lower-cased, and `:latest` where it says no tag. */
export function tagged(model: string): string {
  const m = model.toLowerCase();
  return m.slice(m.lastIndexOf("/") + 1).includes(":") ? m : `${m}:latest`;
}

/** The models a server's list names (Ollama's /api/ps: `{models: [{name, model}]}`), each `tagged`; null for any other shape. */
export function loadedOf(text: string): string[] | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isMapping(v) || !Array.isArray(v.models) || v.models.length > PS_MAX_MODELS) return null;
  const out = new Set<string>();
  for (const m of v.models) {
    if (!isMapping(m)) return null;
    const names = [m.name, m.model].filter((x): x is string => typeof x === "string" && x.length >= 1 && x.length <= 256);
    if (!names.length) return null;
    for (const n of names) out.add(tagged(n));
  }
  return [...out];
}

/** A server's list read: its text, or why not — in the broker's words, never the server's. */
export async function readList(url: string): Promise<{ text: string } | { why: string }> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(PS_TIMEOUT_MS), headers: { accept: "application/json" } });
    if (res.status !== 200 || !res.body) {
      try { await res.body?.cancel(); } catch { /* gone already */ }
      return { why: res.status >= 300 && res.status < 400 ? "a redirect, not followed" : `HTTP ${res.status}` };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > PS_MAX_BYTES) { try { await reader.cancel(); } catch { /* gone already */ } return { why: "a list over 1 MiB" }; }
      chunks.push(value);
    }
    return { text: Buffer.concat(chunks).toString("utf8") };
  } catch (e) {
    return { why: (e as Error)?.name === "TimeoutError" ? `no answer in ${PS_TIMEOUT_MS / 1000} s` : "no answer" };
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
    for (const k of Object.keys(raw)) if (!["bases", "slots", "reserve", "per_model", "ps", "stay_s"].includes(k)) problems.push(`${at}.${k}: not a key of a server (bases, slots, reserve, per_model, ps, stay_s)`);
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
    let ps: string | null = null;
    if (raw.ps !== undefined) {
      let u: URL | null = null;
      try { u = typeof raw.ps === "string" ? new URL(raw.ps) : null; } catch { u = null; }
      if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) problems.push(`${at}.ps: where its loaded models are listed (Ollama: http://<host>:11434/api/ps), an http(s) URL without credentials, query or fragment`);
      else if (!perModel) problems.push(`${at}.ps: a server with per_model: false is one pool whatever the model — it has no residency to read`);
      else ps = u.href;
    }
    let stayS = DEFAULT_STAY_S;
    if (raw.stay_s !== undefined) {
      if (raw.ps === undefined) problems.push(`${at}.stay_s: how long a model background loaded stays — a server with no ps has no such rule`);
      else if (isNum(raw.stay_s, 0, 86_400)) stayS = raw.stay_s;
      else problems.push(`${at}.stay_s: seconds a model background loaded stays before background loads another, 0 to 86400 (${DEFAULT_STAY_S} unset)`);
    }
    servers.push({ name, bases, slots, reserve, perModel, ps, stayS });
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

type Conn = {
  id: number; brain: Brain; brainAt: number; heldLate: boolean; waiting: number; sent: (m: object) => void; held: Map<string, Ask | Grant>;
  /** When it was last heard (performance.now, real time even under a test's clock): a frame or a pong. */
  heardAt: number;
  /** heardAt on the test's clock, which charges slot time. */
  heardClock: number;
  /** Ends the socket at once (its close handler runs): the broker's own liveness. */
  end: () => void;
  /** The id prefix of the relay that sent `synced` on it, once it has. */
  syncedPrefix?: string;
  /** When the brain's newer socket asked it whether it lives (a ping at that socket's open). */
  probedAt?: number;
  closed?: boolean;
  /** Ended for not answering a newer socket's probe: dead by that, its grants given back, not kept. */
  probeEnded?: boolean;
  ping?: () => void;
};
type Ask = { kind: "ask"; conn: Conn; id: string; pool: Pool; first: boolean; maxWaitMs: number; at: number };
type Grant = {
  kind: "grant"; conn: Conn; id: string; pool: Pool; live: boolean; at: number;
  /** For a call to a model its server's list did not name: the list as it was at the grant (`Residency.sig`). */
  sig?: string | null;
};
type Pool = {
  key: string; server: ModelServer;
  /** Its model as the server's list would name it (`tagged`; "" for one unnamed, or a server's one pool), its
   *  server's residency where a list is read, and what the rule last counted it as: 0, or a model not loaded with a
   *  call running — 1 background's alone, 2 a live one — since `pendAt`, a load background began where `bgLoad`. */
  model: string; res: Residency | null; cls: 0 | 1 | 2; pendAt: number; bgLoad: boolean;
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

/** A server's residency (PR 3c-1): what its list last named, and the load wanted or under way. */
type Residency = {
  server: ModelServer; url: string;
  /** The models the list named at its last good read; null while unread, or unreadable PS_STALE_S: no rule. */
  loaded: Set<string> | null;
  /** When the list last read and when a read last began (performance.now), the reads begun, and the one under way. */
  goodAt: number; readAt: number; seq: number; reading: Promise<void> | null;
  /** Why the list could not be read, as last said; null once it reads. */
  off: string | null;
  /** A read begun as this one or later must end before background goes on: a call to a model not listed has ended,
   *  and what the server holds now is not known. */
  verifyFrom: number | null;
  pools: Set<Pool>;
  /** The pool of a model not loaded that goes next, the server's other background draining for it since `wantAt`;
   *  and when a drain was last given up (`restAt`). */
  want: Pool | null; wantAt: number; restAt: number;
  /** Background and live grants running on the server; its pools of a model not loaded with a call running, and
   *  those of them with a live one. */
  bgN: number; liveRun: number; pendN: number; liveN: number;
  /** On the broker's clock: when a live call on a loaded model last ended (one running is counted, `liveRun`), when
   *  a background call last ended, and when a load background began last ended. */
  liveAt: number; bgAt: number; changedAt: number;
  /** The models with a call ended unlisted since the last read, each with the list as it was when that call was
   *  granted; each one's misses running — the list the same after the call as before it (`quiet`), or changed
   *  (`loud`), and when its next load may begin; those left out of the rule, and until when on the broker's clock
   *  (Infinity: until listed). Each kept to MAX_NOTED (`note`). */
  ended: Map<string, string | null>; misses: Map<string, { quiet: number; loud: number; until: number }>; unlisted: Map<string, number>;
  /** The last list read, as one string: whether a read changed it. */
  sig: string | null;
  kicked: boolean;
  /** A read owed PS_GAP_MS after the last began. */
  timer: ReturnType<typeof setTimeout> | null;
};

/** What a test reads of a server's residency: the models listed (null: no rule), the pool drained for, the pools
 *  loading, the models left out of the rule, and how many models it remembers ended calls or misses for. */
export type ResidencyView = Record<string, { loaded: string[] | null; want: string | null; loading: string[]; unlisted: string[]; noted: number }>;

/** What a test reads of the broker: each pool's counts, and each brain's asks waiting and slot time there. */
export type Snapshot = Record<string, { live: number; background: number; waiting: Record<string, number>; used: Record<string, number> }>;

export type Broker = {
  port: number; stop(): Promise<void>; snapshot(): Snapshot;
  /** Each server's residency; the broker's tick run now; every server's list read now (a test's, each). */
  residency(): ResidencyView; turn(): void; refresh(): Promise<void>;
};

/** Starts serving the registry's brains. `port` 0 takes a free one (a test's). */
export function startBroker(reg: Registry, opts: { hostname?: string; port?: number; log?: (line: string) => void; now?: () => number; keepMs?: number; twinLapseMs?: number; psMs?: number; psStaleMs?: number } = {}): Broker {
  const log = opts.log ?? ((line: string) => console.log(`slots: ${line}`));
  /** The broker's clock, in ms: performance.now() unless a test hands it one it moves itself. */
  const clock = opts.now ?? (() => performance.now());
  const started = clock();
  const warmUntil = started + reg.warmS * 1000;
  const pools = new Map<string, Pool>();
  const sockets = reg.brains.map(() => 0);
  const serverOf = new Map<string, ModelServer>();
  for (const s of reg.servers) for (const b of s.bases) serverOf.set(b, s);
  /** Each server's residency, for those whose registry entry names `ps`. */
  const residencies = new Map<ModelServer, Residency>();
  for (const s of reg.servers) if (s.ps) residencies.set(s, { server: s, url: s.ps, loaded: null, goodAt: -Infinity, readAt: -Infinity, seq: 0, reading: null, off: null, verifyFrom: null, pools: new Set(), want: null, wantAt: 0, restAt: -Infinity, bgN: 0, liveRun: 0, pendN: 0, liveN: 0, liveAt: -Infinity, bgAt: -Infinity, changedAt: -Infinity, ended: new Map(), misses: new Map(), unlisted: new Map(), sig: null, kicked: false, timer: null });
  const psMs = opts.psMs ?? PS_S * 1000;
  const psStaleMs = opts.psStaleMs ?? PS_STALE_S * 1000;
  let nextConn = 1;
  const keepMs = opts.keepMs ?? KEEP_MS;
  const twinLapseMs = opts.twinLapseMs ?? TWIN_LAPSE_MS;
  const idleMs = reg.idleS * 1000;
  /** Each brain's kept grants by id, at most MAX_HELD a brain (the oldest given back past it: review pass 3, a brain
   *  reconnecting fast left 81,920 and 108 MB), each closed socket's freed by one timer. */
  const keptBy = reg.brains.map(() => new Map<string, { g: Grant; token: number }>());
  let keepings = 0;
  const keepTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Each brain's open sockets: a `held` moves a grant from a half-open old one rather than counting it twice. */
  const connsBy = reg.brains.map(() => new Set<Conn>());
  let stopping = false;
  /** Brains seen with two relays speaking at once — two coordinators on one key — said once, kept to per-relay rules. */
  const twins = reg.brains.map(() => false);
  const twinsSeen = reg.brains.map(() => 0);
  /** The relays speaking on a brain's open sockets; two at once marks it twins, said once. */
  const noteTwins = (b: number): Set<string> => {
    const relays = (cs: Conn[]) => new Set(cs.map((c) => c.syncedPrefix).filter((x): x is string => !!x));
    const speaking = relays([...connsBy[b]]);
    // Twins only by sockets alive by the probe: a coordinator swapped behind a half-open socket is no second coordinator
    // (review pass 7: its old socket, not yet probed out, marked the brain twins for the broker's life). The mark lapses
    // TWIN_LAPSE_MS after two live relays were last seen — looked for each tick of the broker's liveness, not only at
    // a socket's event (review pass 8: twins steady 60 s lapsed at one's close, its grant given back, 2 calls on 1 slot)
    // — so a misconfiguration put right does not pin the brain.
    const live = relays([...connsBy[b]].filter((c) => !(c.probedAt !== undefined && c.heardAt < c.probedAt)));
    const now = performance.now();
    if (live.size > 1) {
      if (!twins[b]) log(`brain ${reg.brains[b].name}: two relays speak on its key at once — two coordinators share it, a misconfiguration; each keeps its own grants, and each reconnect may count a call twice for a moment`);
      twins[b] = true;
      twinsSeen[b] = now;
    } else if (twins[b] && now - twinsSeen[b] >= twinLapseMs) twins[b] = false;
    return speaking;
  };
  /** A kept grant given back, if it is still kept. */
  const freeKept = (b: number, id: string) => { const o = keptBy[b].get(id); if (!o) return; keptBy[b].delete(id); release(o.g); };
  /** Connections and closes, said once a minute a brain and kind, with the count unsaid since (a link flapping). */
  const connSaid = new Map<string, { at: number; unsaid: number }>();
  /** A line said once a minute a key, with the count unsaid since: bounded by the registry's servers and brains. */
  const sayEvery = (k: string, line: string) => {
    const now = clock(), was = connSaid.get(k);
    if (was && now - was.at < 60_000) { was.unsaid++; return; }
    log(`${line}${was?.unsaid ? ` (and ${was.unsaid} more since the last said)` : ""}`);
    connSaid.set(k, { at: now, unsaid: 0 });
  };
  const sayConn = (b: number, kind: string, line: string) => sayEvery(`${b}\n${kind}`, line);
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
    if (!p) {
      // An unnamed model is no name a list could say: taken for loaded, and counted with the server's background
      // (review pass 1: outside the rule's counts, a load was granted while its call ran).
      const res = residencies.get(server) ?? null;
      p = { key, server, model: asked === "?" || !server.perModel ? "" : tagged(model), res, cls: 0, pendAt: 0, bgLoad: false, live: new Set(), bg: new Set(), liveBy: reg.brains.map(() => 0), queues: reg.brains.map(() => new Set()), used: reg.brains.map(() => 0), usedAt: clock(), last: -1 };
      pools.set(key, p);
      res?.pools.add(p);
    }
    return p;
  };
  // Only the pool the map holds: a pool pruned while a move still had it in hand must not drop its successor (review
  // pass 5: a moved ask's withdrawal pruned the pool the new ask then queued into, unseen, over-granted).
  const prune = (p: Pool) => {
    if (pools.get(p.key) !== p || p.live.size || p.bg.size || !p.queues.every((q) => q.size === 0)) return;
    pools.delete(p.key);
    const r = p.res;
    if (!r) return;
    r.pools.delete(p);
    // The pool its server drained for has no ask left: the server's other background goes on.
    if (r.want === p) { r.want = null; kick(r); }
  };
  /** An ask taken out of its queue without a prune: its pool may be in hand. */
  const withdraw = (x: Ask) => { if (x.conn.held.get(x.id) === x) x.conn.held.delete(x.id); if (x.pool.queues[x.conn.brainAt].delete(x)) x.conn.waiting--; };
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

  // Asks on a socket heard from lately: none is granted into one silent half its idle_s, which may be dead and kept
  // open by the grants themselves — Bun resets a socket's idle clock at each send (review pass 4 of 3a: a half-open
  // socket's grants held the whole room 12–15 s).
  const heard = (x: Ask) => performance.now() - x.conn.heardAt <= idleMs / 2;

  // Residency (PR 3c-1; the file's head says the rule).
  /** Whether the rule takes a pool's model for loaded: its server's list names it — or it is outside the rule: no
   *  list read, no name, or a name left out (`unlisted`). */
  const resident = (p: Pool) => { const r = p.res; return !r || r.loaded === null || p.model === "" || r.loaded.has(p.model) || r.unlisted.has(p.model); };
  /** Whether background may be granted in the pool now, by its server's residency. */
  const mayGrant = (p: Pool) => {
    const r = p.res;
    if (!r || r.loaded === null) return true;
    // The calls to a model not listed have ended: nothing more until the list is next read (a read that fails ends
    // the wait too, the last list standing its PS_STALE_S).
    if (r.verifyFrom !== null) return false;
    // A load under way — a model not loaded with a call running: background to that model alone, and where a live call
    // waits on one, to no pool but a live call's.
    if (r.liveN > 0) return p.cls === 2;
    if (r.pendN > 0) return p.cls >= 1;
    // A load wanted: its pool alone, once no other background runs on the server.
    if (r.want) return r.want === p && r.bgN === 0;
    return resident(p);
  };
  /** A key set last in a map kept to MAX_NOTED, its oldest dropped past that. */
  const note = <V>(m: Map<string, V>, k: string, v: V) => { m.delete(k); m.set(k, v); while (m.size > MAX_NOTED) { const [oldest] = m.keys(); m.delete(oldest); } };
  /** A pool counted anew, after its grants or its server's list changed: its server's loads under way kept by count, not walked. */
  const mark = (p: Pool) => {
    const r = p.res;
    if (!r) return;
    const cls = resident(p) ? 0 : p.live.size ? 2 : p.bg.size ? 1 : 0;
    const was = p.cls;
    if (cls === was) return;
    if (was === 2) r.liveN--;
    if (was >= 1) r.pendN--;
    if (cls === 2) r.liveN++;
    if (cls >= 1) r.pendN++;
    p.cls = cls;
    if (was === 0) p.pendAt = clock();
    if (cls > was) return;
    if (cls === 0) {
      // A load background began is over, the list naming it: the server's stay runs from here, not from its grant
      // (review pass 1: a load 55 s long left its model 5 s). One never listed loaded nothing to stay.
      if (p.bgLoad) { p.bgLoad = false; if (r.loaded?.has(p.model)) r.changedAt = clock(); }
      // Its calls all ended and the list never named it: whether it loaded, and what it put out, is not known until
      // the list is next read — a read begun from now, which the server's background waits for.
      if (!resident(p)) { r.verifyFrom = r.seq + 1; soon(r); }
    }
    kick(r);
  };
  /** A model left out of the rule until the list names it, or `until` on the broker's clock if sooner, said. */
  const leaveOut = (r: Residency, model: string, until: number, why: string) => {
    r.misses.delete(model);
    r.ended.delete(model);
    note(r.unlisted, model, until);
    log(`${r.server.name}/${model}: ${why}: left out of the residency rule ${until === Infinity ? "until it is listed" : `${HOLD_S} s, or until it is listed`}`);
  };
  /** Whether a live call younger than HOLD_S runs on the server: one older — a brain gives its call up at OB1_LLM_TIMEOUT, 120 s unset — holds back no load. */
  const liveNow = (r: Residency, now: number) => {
    if (r.liveRun === 0) return false;
    for (const p of r.pools) for (const g of p.live) if (now - g.at < HOLD_S * 1000) return true;
    return false;
  };
  /** Whether a pool has an ask waiting on a socket heard from. */
  const asking = (p: Pool) => { for (const q of p.queues) for (const x of q) if (heard(x)) return true; return false; };
  /** What a server is open to now: a drain for an ask past its max_wait_s (`aged`), a load for any ask (`free`). */
  const openTo = (r: Residency, now: number, live = r.liveRun > 0) => {
    if (r.loaded!.size === 0) return { aged: false, free: true };
    const stayed = !live && now - r.changedAt >= r.server.stayS * 1000;
    return {
      aged: stayed && now - r.restAt >= HOLD_S * 1000,
      free: stayed && r.bgN === 0 && now - r.bgAt >= BG_QUIET_S * 1000 && now - r.liveAt >= LIVE_QUIET_S * 1000,
    };
  };
  /**
   * A server's loads and drains kept in bounds, and the model not loaded that goes next chosen, where none is and no
   * load is under way: once the server's last background load ended stay_s ago, the one whose ask has waited longest
   * of those past their max_wait_s, with no live call running there — else, where the loaded models have had no
   * background call for BG_QUIET_S and no live one for LIVE_QUIET_S, the one asked for first; any, where none is loaded.
   */
  const settle = (r: Residency) => {
    if (r.loaded === null) { r.want = null; return; }
    const now = clock();
    // A load that has held the server's other background HOLD_S, the list still not naming it: its model left out
    // for HOLD_S, then held to again while its calls run on.
    if (r.pendN > 0) for (const p of [...r.pools]) if (p.cls > 0 && now - p.pendAt >= HOLD_S * 1000) { leaveOut(r, p.model, now + HOLD_S * 1000, `a call to it has run ${HOLD_S} s and the server's loaded models do not name it`); mark(p); }
    let back = false;
    for (const [m, until] of [...r.unlisted]) if (until <= now) { r.unlisted.delete(m); back = true; }
    if (back) for (const p of [...r.pools]) mark(p);
    const w = r.want;
    if (w && (pools.get(w.key) !== w || resident(w) || !asking(w))) r.want = null;
    // A drain not done in HOLD_S: given up, the server's other background going on, and none begun for HOLD_S more.
    if (r.want && r.bgN > 0 && now - r.wantAt >= HOLD_S * 1000) {
      sayEvery(`${r.server.name}\ngave-up`, `${r.want.key}: ${r.bgN} background call${r.bgN === 1 ? "" : "s"} on ${r.server.name} still running ${HOLD_S} s into the drain for it: given up, and no drain begun for ${HOLD_S} s`);
      r.want = null;
      r.restAt = now;
    }
    if (r.want || r.pendN > 0 || r.verifyFrom !== null) return;
    const { aged: stayed, free } = openTo(r, now, liveNow(r, now));
    if (!stayed && !free) return;
    let aged: Pool | null = null, agedAt = Infinity, idle: Pool | null = null, idleAt = Infinity;
    for (const p of r.pools) {
      // Not a model backing off: its last loads changed the list and never showed in it.
      if (resident(p) || (r.misses.get(p.model)?.until ?? 0) > now) continue;
      for (const q of p.queues) for (const x of q) {
        if (!heard(x)) continue;
        if (x.at < idleAt) { idle = p; idleAt = x.at; }
        if (stayed && x.at < agedAt && now - x.at >= x.maxWaitMs) { aged = p; agedAt = x.at; }
      }
    }
    r.want = aged ?? (free ? idle : null);
    r.wantAt = now;
  };
  /** A server's residency settled and each of its pools turned. */
  const turn = (r: Residency) => { settle(r); for (const p of [...r.pools]) pump(p); };
  /** The same once this event is done — a small server's; a large one's waits for the broker's tick (a second at most). */
  const kick = (r: Residency) => {
    if (r.kicked || r.pools.size > TURN_NOW) return;
    r.kicked = true;
    queueMicrotask(() => { r.kicked = false; if (!stopping) turn(r); });
  };
  /** A read for a call's end: now, or PS_GAP_MS after the last began — a brain's calls set no pace for the list's reads. */
  const soon = (r: Residency) => {
    if (r.reading || r.timer || stopping) return;
    const wait = PS_GAP_MS - (performance.now() - r.readAt);
    if (wait <= 0) { void read(r); return; }
    r.timer = setTimeout(() => { r.timer = null; if (!stopping) void read(r); }, wait);
  };
  /** A server's list read and taken up; one read at a time, a caller during one given that one. */
  const read = (r: Residency): Promise<void> => {
    if (r.reading) return r.reading;
    const mine = ++r.seq;
    r.readAt = performance.now();
    r.reading = readList(r.url).then((got) => {
      r.reading = null;
      if (stopping) return;
      const names = "text" in got ? loadedOf(got.text) : null;
      if (names) {
        const first = r.loaded === null;
        r.goodAt = performance.now();
        r.loaded = new Set(names);
        const sig = names.slice().sort().join("\n");
        r.sig = sig;
        for (const m of names) { r.misses.delete(m); if (r.unlisted.delete(m)) log(`${r.server.name}/${m}: listed now, and under the residency rule again`); }
        // Each model with a call ended since the last read, and not listed: a miss (a call's end, not the pool's
        // emptying: review pass 1, two streams overlapping never emptied it, and the others had 12 calls for 110).
        // With the list as it was when the call was granted, the call disturbed nothing: UNLISTED_AFTER such reads
        // running and the rule leaves the model be — else a name the list writes another way would hold the
        // server's other background through every call to it. With the list changed since, it may have put models
        // out and loaded nothing: its next load waits, longer each time. A read under way as the call ended counts
        // as any other: one that lists the model after begins the counts again.
        for (const [m, before] of [...r.ended]) {
          r.ended.delete(m);
          if (r.loaded.has(m)) continue;
          const was = r.misses.get(m) ?? { quiet: 0, loud: 0, until: 0 };
          if (before !== sig) {
            const loud = was.loud + 1, wait = Math.min(loud, BACKOFF_MOST) * BACKOFF_S;
            note(r.misses, m, { quiet: 0, loud, until: clock() + wait * 1000 });
            if (loud === UNLISTED_AFTER) log(`${r.server.name}/${m}: its calls ended ${UNLISTED_AFTER} times with the server's loaded models changed and never naming it — a model that does not load: its next load waits ${wait} s, and ${BACKOFF_S} s more each time`);
          } else if (was.quiet + 1 < UNLISTED_AFTER) note(r.misses, m, { ...was, quiet: was.quiet + 1 });
          else leaveOut(r, m, Infinity, `its calls ended at ${UNLISTED_AFTER} reads running, the server's loaded models the same and never naming it — a name it lists another way, or a model it does not know`);
        }
        if (first) log(`${r.server.name}: its loaded models read${r.off !== null ? " again" : ""} (${names.length} loaded): the residency rule is on`);
        r.off = null;
      } else if (performance.now() - r.goodAt > psStaleMs) {
        const why = "text" in got ? "not a list of models" : got.why;
        if (r.off === null) log(`${r.server.name}: its loaded models could not be read (${why}): no residency rule there until they can`);
        r.off = why;
        r.loaded = null;
        r.sig = null;
      }
      if (r.verifyFrom !== null && mine >= r.verifyFrom) r.verifyFrom = null;
      for (const p of [...r.pools]) mark(p);
      turn(r);
      if (r.verifyFrom !== null) soon(r);
    });
    return r.reading;
  };

  const grant = (conn: Conn, id: string, p: Pool, live: boolean) => {
    const g: Grant = { kind: "grant", conn, id, pool: p, live, at: clock() };
    if (live) { p.live.add(g); p.liveBy[conn.brainAt]++; } else p.bg.add(g);
    conn.held.set(id, g);
    conn.sent({ op: "go", id });
    const r = p.res;
    if (r) {
      if (live) r.liveRun++; else r.bgN++;
      // A call to a model not loaded is a load: the choice of the next begins again after it.
      if (!resident(p)) { r.want = null; g.sig = r.sig; if (!live && p.cls === 0) p.bgLoad = true; }
      mark(p);
    }
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
    while (room(p) && mayGrant(p)) {
      const now = clock();
      const score = scores(p, now);
      let at = -1;
      const has = (b: number) => { for (const x of p.queues[b]) if (heard(x)) return true; return false; };
      for (let i = 1; i <= n; i++) {
        const b = (p.last + i + n) % n;
        if (p.queues[b].size && has(b) && (at < 0 || score[b] < score[at])) at = b;
      }
      if (at < 0) return;
      const q = p.queues[at];
      // The oldest of its asks put first or past their max_wait_s, else its oldest — by when each began waiting, which
      // `waited_s` dates back, so not always the order asked.
      let a: Ask | undefined, oldest: Ask | undefined;
      for (const x of q) {
        if (!heard(x)) continue;
        if ((x.first || now - x.at >= x.maxWaitMs) && (!a || x.at < a.at)) a = x;
        if (!oldest || x.at < oldest.at) oldest = x;
      }
      a ??= oldest;
      // None heard now, though one was a moment ago: the next turn's.
      if (!a) return;
      q.delete(a);
      a.conn.waiting--;
      p.last = at;
      a.conn.held.delete(a.id);
      if (p.res && p.cls === 0 && !resident(p)) sayEvery(`${p.server.name}\nload`, `${p.key}: not loaded, and granted after ${Math.round((now - a.at) / 1000)} s — ${p.server.name}'s other background waits while it loads`);
      grant(a.conn, a.id, p, false);
    }
  };

  const release = (x: Ask | Grant) => {
    if (x.conn.held.get(x.id) === x) x.conn.held.delete(x.id);
    if (x.kind === "ask") { withdraw(x); prune(x.pool); return; }
    const r = x.pool.res;
    if (x.live) {
      if (!x.pool.live.delete(x)) return;
      x.pool.liveBy[x.conn.brainAt]--;
      if (r) {
        r.liveRun--;
        // Whatever the list says of its model yet: a live call that loaded one and ended before the list named it
        // is live use of a loaded model all the same (review pass 2: the model was put out for background at once).
        r.liveAt = clock();
        // The server's last live call over: an ask come of age under it may be chosen now.
        if (r.liveRun === 0 && !r.want && r.pendN === 0) kick(r);
      }
    } else {
      if (!x.pool.bg.delete(x)) return;
      if (r) { r.bgN--; r.bgAt = clock(); }
      const now = clock();
      decay(x.pool, now);
      // Charged up to its socket's last sign of life, not past it: a grant into a socket that died, or kept for one that
      // never came back, is no slot time the brain had (review pass 5: two dead grants of 15 s starved it 40 s after).
      const until = x.conn.closed ? Math.min(now, x.conn.heardClock) : now;
      x.pool.used[x.conn.brainAt] += Math.max(0, until - x.at);
    }
    if (r) {
      // A call ended on a model the list does not name: the next read begun says whether it is a miss.
      if (!resident(x.pool)) note(r.ended, x.pool.model, x.sig ?? null);
      mark(x.pool);
      // The last background call running on the server: the pool it drained for is granted now.
      if (r.bgN === 0 && !x.live && r.want) pump(r.want);
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
    if (m.op === "done") { const x = conn.held.get(id); if (x) release(x); else freeKept(conn.brainAt, id); return; }
    // A brain's relay has re-registered every call it still runs: its kept grants no `held` named are given back now,
    // not at KEEP_MS (review pass 3: on a flapping link they sat 5 s a time with no call, the room idle 41%): its own,
    // by its ids' prefix (the id), and — one relay to a brain, as there should be — those of a relay no open socket speaks
    // for, a coordinator replaced, whose old calls ended with it (review pass 5: kept 5 s past a restart). Two relays seen
    // on one key at once (a misconfiguration) keep each other's (review pass 4: one's synced freed the other's, which its
    // held then counted past the room; review pass 6, the same returned by pass 5's rule).
    if (m.op === "synced") {
      conn.syncedPrefix = id;
      const speaking = noteTwins(conn.brainAt);
      for (const oid of [...keptBy[conn.brainAt].keys()]) {
        const pre = relayOf(oid);
        if (pre === id || (!twins[conn.brainAt] && !speaking.has(pre))) freeKept(conn.brainAt, oid);
      }
      return;
    }
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
    let p = poolFor(server, model);
    const adopt = (g: Grant) => { g.conn = conn; conn.held.set(id, g); conn.sent({ op: "go", id }); };
    if (m.op === "held") {
      // A `held` outside the warm-up — a brain back after its socket dropped, its calls still running — is counted as
      // it is: those calls run whether counted or not. Said once a socket, since it can take background past its room.
      if (!warming() && !conn.heldLate) { conn.heldLate = true; log(`brain ${conn.brain.name} (socket ${conn.id}) re-registers held slots outside the warm-up: counted, past the room if need be`); }
      const live = cls === "live";
      // Its own grant back, kept since its socket closed: taken up again, not counted twice — if it is still counted
      // (the lease's sweep may have taken it: then it lapsed); one of another pool or class given back, not doubled.
      const o = keptBy[conn.brainAt].get(id)?.g;
      if (o) {
        keptBy[conn.brainAt].delete(id);
        if (o.pool === p && o.live === live) {
          if ((live ? p.live : p.bg).has(o)) { adopt(o); return; }
          conn.sent({ op: "lapsed", id });
          return;
        }
        release(o);
        p = poolFor(server, model);
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
      if (p.res && p.cls === 0 && !resident(p)) sayEvery(`${server.name}\nheld-load\n${conn.brainAt}`, `${p.key}: brain ${conn.brain.name} re-registers a call to a model not loaded — ${server.name}'s other background waits while it loads`);
      grant(conn, id, p, cls === "live");
      return;
    }
    if (cls === "live") {
      if (p.res && p.cls !== 2 && !resident(p)) sayEvery(`${server.name}\nlive-load\n${conn.brainAt}`, `${p.key}: brain ${conn.brain.name}'s live call to a model not loaded — ${server.name}'s other background waits while it loads`);
      grant(conn, id, p, true);
      // Background waiting for the live call's own model goes with it, now.
      if (p.cls === 2) pump(p);
      return;
    }
    // An ask its relay asked again on a new socket while the old one is half-open, not yet closed here: the old one's
    // grant moved and answered go, or its ask withdrawn and its age kept (review pass 4: counted on both, 7–12 s wasted).
    let olderAt = Infinity;
    for (const c of connsBy[conn.brainAt]) {
      if (c === conn) continue;
      const x = c.held.get(id);
      if (x?.kind === "grant" && x.pool === p && !x.live) { c.held.delete(id); adopt(x); return; }
      if (x?.kind === "ask" && x.pool === p) { olderAt = Math.min(olderAt, x.at); withdraw(x); }
    }
    // A brain coming to a pool where others are at work starts level with the least of them, not at nothing: else it
    // would hold every background slot until its time caught up with theirs, a half-life of the others waiting (review
    // pass 3: brain A backlogged ten minutes had none of the slots for the minute after B arrived, and waited 62 s).
    level(p, conn.brainAt);
    const a: Ask = { kind: "ask", conn, id, pool: p, first: m.first === true, maxWaitMs: maxWait * 1000, at: Math.min(clock() - waited * 1000, olderAt) };
    p.queues[conn.brainAt].add(a);
    conn.waiting++;
    conn.held.set(id, a);
    pump(p);
    if (conn.held.get(id) !== a) return;
    conn.sent({ op: "queued", id });
    // The server asked to choose, where this ask could be chosen now (not at each ask: review pass 1, 16,384 asks
    // took 3.7 s to queue; pass 2, as long again on an idle server within a quiet).
    const r = p.res;
    if (r && !r.want && r.pendN === 0 && r.verifyFrom === null && !resident(p)) {
      const now = clock(), to = openTo(r, now);
      if (to.free || (to.aged && now - a.at >= a.maxWaitMs)) kick(r);
    }
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
      const conn: Conn = { id: nextConn++, brain, brainAt, heldLate: false, waiting: 0, sent: () => {}, held: new Map(), heardAt: performance.now(), heardClock: clock(), end: () => {} };
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
        conn.end = () => { try { ws.terminate(); } catch { /* closing already */ } };
        conn.ping = () => { try { ws.ping(); } catch { /* closing */ } };
        conn.heardAt = performance.now();
        conn.heardClock = clock();
        // The brain's other sockets asked at once whether they live: one that is the dead side of the link this socket
        // replaces is ended in 2 s, not at idle_s (review pass 5: a coordinator swapped behind one held the room 15 s).
        // A probe already pending is left to run its course: opens coming fast must not keep a dead socket alive.
        for (const c of connsBy[conn.brainAt]) if (c !== conn && (c.probedAt === undefined || c.heardAt >= c.probedAt)) { c.probedAt = performance.now(); c.ping?.(); }
        sayConn(conn.brainAt, "open", `brain ${conn.brain.name} connected (socket ${conn.id})`);
        conn.sent({ op: "hello", brain: conn.brain.name, boot, lease_s: reg.leaseS, idle_s: reg.idleS, warm_s_left: Math.max(0, Math.ceil(warmUntil - clock()) / 1000), max_waiting: MAX_WAITING, max_held: MAX_HELD, max_sockets: MAX_SOCKETS, max_frame: MAX_FRAME, servers: reg.servers.map((s) => ({ name: s.name, bases: s.bases, slots: s.slots, reserve: s.reserve, per_model: s.perModel, residency: s.ps !== null })) });
      },
      pong(ws: ServerWebSocket<Conn>) {
        ws.data.heardAt = performance.now();
        ws.data.heardClock = clock();
        // A probed socket answering is alive after all: two relays now speaking are twins.
        if (ws.data.syncedPrefix) noteTwins(ws.data.brainAt);
      },
      message(ws: ServerWebSocket<Conn>, msg: string | Buffer) {
        ws.data.heardAt = performance.now();
        ws.data.heardClock = clock();
        if (typeof msg !== "string") { ws.data.sent({ op: "no", id: null, why: "bad" }); return; }
        onFrame(ws.data, msg);
      },
      close(ws: ServerWebSocket<Conn>) {
        const conn = ws.data;
        conn.sent = () => {};
        sockets[conn.brainAt]--;
        connsBy[conn.brainAt].delete(conn);
        conn.closed = true;
        // Its asks first, then its grants: a grant given back first would be handed to the closing socket's own next
        // ask, a grant no one would give back (review pass 1: a background slot held for lease_s, the pool wedged).
        const all = [...conn.held.values()];
        const asks = all.filter((x) => x.kind === "ask"), grants = all.filter((x): x is Grant => x.kind === "grant");
        for (const x of asks) release(x);
        // Its grants kept counted a while, for the brain's next socket to take back (`held`, same id), else given back.
        const keep = keepMs > 0 && !stopping;
        // A relay already synced on a newer socket has named every call it still runs there: its grants left here are
        // given back, not kept (review pass 4); and a brain whose relay has synced there keeps nothing of this socket, a
        // replaced coordinator's never coming back (review pass 5).
        const synced = noteTwins(conn.brainAt);
        const token = ++keepings;
        let kept = 0;
        for (const x of grants) {
          // Given back now: no keeping; a socket the probe found dead; or the brain's relay synced on a newer socket — any
          // relay, but for twins only the grant's own (review pass 6).
          const pre = relayOf(x.id);
          if (!keep || conn.probeEnded || (twins[conn.brainAt] ? synced.has(pre) : synced.size > 0)) { release(x); continue; }
          const mine = keptBy[conn.brainAt];
          freeKept(conn.brainAt, x.id);
          mine.set(x.id, { g: x, token });
          kept++;
          // Past MAX_HELD kept a brain, its oldest given back.
          while (mine.size > MAX_HELD) { const [oldest] = mine.keys(); freeKept(conn.brainAt, oldest); }
        }
        if (kept) {
          // This close's keeping alone: a grant taken back and kept again by a later close is that close's to free
          // (review pass 4: this timer freed it 498 ms after the later close).
          const t = setTimeout(() => { keepTimers.delete(t); const mine = keptBy[conn.brainAt]; for (const [oid, o] of [...mine]) if (o.token === token) freeKept(conn.brainAt, oid); }, keepMs);
          keepTimers.add(t);
        }
        sayConn(conn.brainAt, "close", `brain ${conn.brain.name} disconnected (socket ${conn.id})${all.length ? `, withdrawing ${asks.length} ask${asks.length === 1 ? "" : "s"}${kept ? ` and keeping ${kept} grant${kept === 1 ? "" : "s"} ${keepMs / 1000} s for its return` : ""}${grants.length > kept ? ` and giving back ${grants.length - kept} grant${grants.length - kept === 1 ? "" : "s"}` : ""}` : ""}`);
      },
    },
  });

  /** Each server's residency settled — an ask come of age, a live call's quiet run out — and every pool turned. */
  const turnAll = () => { for (const r of residencies.values()) settle(r); for (const p of [...pools.values()]) pump(p); };
  // The broker's own liveness, on real time: a socket not heard from (frame or pong) for idle_s is ended, its close
  // handler doing the rest; one quiet a third of it is pinged; and each pool turned again, so a socket heard from anew
  // has its asks granted (review pass 4: Bun's idle clock, reset at each send, never closed a dead socket being granted to).
  const live = setInterval(() => {
    const now = performance.now();
    for (const set of connsBy) for (const c of [...set]) {
      if (now - c.heardAt > idleMs) { c.end(); continue; }
      if (c.probedAt !== undefined && c.heardAt < c.probedAt && now - c.probedAt > PROBE_MS) {
        c.probeEnded = true;
        // Each said: a probe end is rare, and one open may end two (review pass 7: a throttled line hid the second).
        log(`brain ${c.brain.name}'s socket ${c.id} did not answer the ping its newer socket's open sent within ${PROBE_MS / 1000} s: ended, its grants given back`);
        c.end();
        continue;
      }
      if (now - c.heardAt > idleMs / 3) c.ping?.();
    }
    for (let b = 0; b < twins.length; b++) if (twins[b]) noteTwins(b);
    turnAll();
  }, Math.max(100, Math.min(1000, idleMs / 4)));
  // Each server's list, read every PS_S, and every PS_FAST_S while a load is under way there.
  const psTick = residencies.size ? setInterval(() => {
    const now = performance.now();
    for (const r of residencies.values()) {
      const every = r.pendN > 0 ? Math.min(psMs, PS_FAST_S * 1000) : psMs;
      if (!r.reading && now - r.readAt >= every - 20) void read(r);
    }
  }, Math.max(50, Math.min(psMs, PS_FAST_S * 1000))) : null;
  for (const r of residencies.values()) void read(r);
  // The lease's backstop: a grant held past lease_s is taken back, and its socket told.
  const sweepMs = Math.max(250, Math.min(reg.leaseS * 250, 30_000));
  const sweep = setInterval(() => {
    const now = clock();
    for (const p of [...pools.values()]) for (const g of [...p.live, ...p.bg]) {
      if (now - g.at < reg.leaseS * 1000) continue;
      log(`${p.key}: brain ${g.conn.brain.name}'s ${g.live ? "live" : "background"} grant ${g.id} held past ${reg.leaseS} s, taken back`);
      g.conn.sent({ op: "lapsed", id: g.id });
      if (keptBy[g.conn.brainAt].get(g.id)?.g === g) keptBy[g.conn.brainAt].delete(g.id);
      release(g);
    }
  }, sweepMs);
  // The warm-up's end: the asks it held are turned.
  const warm = reg.warmS > 0 ? setTimeout(() => { for (const p of [...pools.values()]) pump(p); }, reg.warmS * 1000 + 1) : null;
  log(`serving on port ${server.port}: ${reg.brains.length} brain${reg.brains.length === 1 ? "" : "s"} on ${reg.servers.map((s) => `${s.name} (${s.slots} slots, ${s.reserve} reserved${s.ps ? ", its loaded models read" : ""})`).join(", ")}${reg.warmS ? `; background held ${reg.warmS} s while brains re-register` : ""}`);

  return {
    port: server.port ?? 0,
    async stop() {
      stopping = true;
      clearInterval(sweep);
      clearInterval(live);
      if (psTick) clearInterval(psTick);
      for (const r of residencies.values()) if (r.timer) clearTimeout(r.timer);
      if (warm) clearTimeout(warm);
      for (const t of keepTimers) clearTimeout(t);
      keepTimers.clear();
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
    residency() {
      const out: ResidencyView = {};
      for (const r of residencies.values()) out[r.server.name] = { loaded: r.loaded ? [...r.loaded].sort() : null, want: r.want?.key ?? null, loading: [...r.pools].filter((p) => p.cls > 0).map((p) => p.key).sort(), unlisted: [...r.unlisted.keys()].sort(), noted: r.ended.size + r.misses.size + r.unlisted.size };
      return out;
    },
    turn: turnAll,
    async refresh() { await Promise.all([...residencies.values()].map((r) => (r.reading ?? Promise.resolve()).then(() => read(r)))); },
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
    ["slots not a whole number from 1 to 16 are refused", [0, 17, 2.5, "3"].every((s) => /slots: its parallel setting/.test(problems(base.replace("slots: 3", `slots: ${JSON.stringify(s)}`))))],
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
    ["ps is no key by default; a server's list is taken as an http(s) URL without credentials, query or fragment", r?.servers[0].ps === null && ok(base.replace("slots: 3", "slots: 3\n    ps: http://host.containers.internal:11434/api/ps"))?.servers[0].ps === "http://host.containers.internal:11434/api/ps" && ["ftp://h/api/ps", "http://u:p@h:1/api/ps", "http://h:1/api/ps?x=1", "http://h:1/api/ps#x", "api/ps", 7].every((u) => /ps: where its loaded models are listed/.test(problems(base.replace("slots: 3", `slots: 3\n    ps: ${JSON.stringify(u)}`))))],
    ["stay_s is 60 unset, taken with ps from 0 to 86400, and refused without ps or out of range", ok(base.replace("slots: 3", "slots: 3\n    ps: http://h:1/api/ps"))?.servers[0].stayS === DEFAULT_STAY_S && DEFAULT_STAY_S === 60 && ok(base.replace("slots: 3", "slots: 3\n    ps: http://h:1/api/ps\n    stay_s: 0"))?.servers[0].stayS === 0 && ok(base.replace("slots: 3", "slots: 3\n    ps: http://h:1/api/ps\n    stay_s: 2.5"))?.servers[0].stayS === 2.5 && /stay_s: how long a model background loaded stays — a server with no ps/.test(problems(base.replace("slots: 3", "slots: 3\n    stay_s: 10"))) && [-1, 86401, "60"].every((v) => /stay_s: seconds a model background loaded stays/.test(problems(base.replace("slots: 3", `slots: 3\n    ps: http://h:1/api/ps\n    stay_s: ${JSON.stringify(v)}`))))],
    ["ps on a server with per_model: false is refused: one pool has no residency", /ps: a server with per_model: false is one pool/.test(problems(base.replace("slots: 3", "slots: 3\n    per_model: false\n    ps: http://h:1/api/ps")))],
    ["a model's name is read as a list writes it: lower-cased, :latest where it says no tag, a registry's port no tag", tagged("Qwen2.5") === "qwen2.5:latest" && tagged("qwen2.5:7b") === "qwen2.5:7b" && tagged("hf.co/a/B") === "hf.co/a/b:latest" && tagged("reg:5000/a/b") === "reg:5000/a/b:latest" && tagged("reg:5000/a/b:q4") === "reg:5000/a/b:q4"],
    ["a list's models are read by name and by model, each once; an empty list is a list", loadedOf('{"models":[{"name":"A:1","model":"a:1","size":1},{"model":"b"}]}')?.join() === "a:1,b:latest" && loadedOf('{"models":[]}')?.length === 0],
    ["anything else is no list: not JSON, no models, a model with no name, more than PS_MAX_MODELS", ["", "[]", "{}", '{"models":{}}', '{"models":[{}]}', '{"models":["a"]}', '{"models":[{"name":7}]}', JSON.stringify({ models: Array.from({ length: PS_MAX_MODELS + 1 }, (_, i) => ({ name: `m${i}` })) })].every((t) => loadedOf(t) === null)],
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
    let path = "", host = "127.0.0.1", port: number | undefined;
    const usage = "usage: bun broker.ts --registry PATH [--host ADDRESS] [--port N] | --self-check";
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--registry" && args[i + 1]) path = args[++i];
      else if (args[i] === "--host" && args[i + 1]) host = args[++i];
      // The registry's port unless given; 0 takes a free one, which the start line names (a test's).
      else if (args[i] === "--port" && /^\d+$/.test(args[i + 1] ?? "") && Number(args[i + 1]) <= 65535) port = Number(args[++i]);
      else { console.error(usage); process.exit(2); }
    }
    if (!path) { console.error(usage); process.exit(2); }
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch (e) { console.error(`slots: the registry at ${path} could not be read: ${(e as Error).message}`); process.exit(2); }
    const { registry, problems } = parseRegistry(text);
    if (!registry) { console.error(`slots: the registry at ${path}:\n${problems.map((p) => `  ${p}`).join("\n")}`); process.exit(2); }
    const broker = startBroker(registry, { hostname: host, ...(port !== undefined ? { port } : {}) });
    const stop = () => { void broker.stop().then(() => process.exit(0)); };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  }
}
