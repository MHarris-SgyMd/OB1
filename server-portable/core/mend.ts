// The vector mender (SMD-2889): the server gives a thought saved without a
// vector its vector, by itself, once the provider answers and the egress gate
// allows the call. A capture lands vectorless when the provider did not answer
// (SMD-2888) or the gate refused the call (SMD-1903); board-sync's and an
// import's rows can too (db/ingest-records.ts writes them so on purpose).
// Before this nothing embedded such a row but a hand-run db/reembed.ts —
// whose pool takes these rows too, and which stays the tool for a model
// change or a whole brain at once.
//
// Why the servers, on a timer: a server is the one process every brain runs
// — the workers and the sleep scheduler are profiles a brain may not run —
// and it already holds what the call needs: the capture's embedder
// (embed.ts), the egress policy and the store. Both servers start one (the
// MCP server, index.ts, and the REST core, api.ts, which outlives it once the
// MCP endpoint is mcp-server/'s, SMD-2287), and a tick acts only while it
// holds the store's leader lock, so one tick acts at a time across processes
// and replicas. Each server keeps its own cursor and holds; the lock only
// takes turns. A few rows a tick, never the LLM drain the bulk passes are
// (entities.ts) — though a long row is a call per window and one for the
// whole, and a blurb call per window under OB1_CHUNK_CONTEXT.
//
// Resumable without a claim table: `embedding IS NULL` is the state. A tick
// reads pages in id order from a cursor until it has embedded MEND_BATCH
// rows, read MEND_SCAN rows, or reached the end, which ends the sweep: the
// next tick starts over. A row the gate refuses costs no call and no place in
// the tick's count. A row whose call fails is held for a number of sweeps that
// doubles with each failure. The write carries the stamp it read, so
// update_thought's guard refuses it over an edit made since (STALE_READ).
//
// The provider away, decided by two calls, not one (review pass 4: passes 2
// and 3 each read one outage-shaped failure as the provider's, or as the
// row's, and each way broke): an outage (providerDown) on a row makes it
// pending, and the next call decides —
// - answered: the provider is up, and the pending row failed alone — held as
//   its own and marked `alone`, so its outages never speak for the provider;
// - an outage too: the provider is away — both rows held as an outage's (1,
//   2, 4, up to MAX_OUTAGE_HOLD_SWEEPS) and the tick stops, two calls spent;
// - no next call this tick: alone if the provider answered this tick or the
//   last, else the provider away, as above.
// The provider answering after an outage lets the outage's holds go, and if
// it answers the tick right after the one that stopped, the rows that stopped
// it are marked `alone`: an outage of one tick is two texts that fail alone
// side by side. A row marked `alone` is held as its own on an outage, the tick
// going on. A sweep's end drops the holds of rows no longer waiting (mended by
// another writer, or deleted), and with no outage's hold still running the
// outage is over as far as this mender knows. Only an HTTP status counts as
// the provider answering: an egress refusal or a body that is not JSON is the
// row's failure and says nothing of the provider.

import { createEmbedder, providerDown, ProviderError, type Embedder } from "../embed.ts";
import { hostOf, mayLeaveBox, refusesEverything, type EgressRecord, type EgressSubject } from "../egress.ts";
import { chunkRecipe } from "../lineage.ts";
import type { VectorlessRow } from "../store.ts";
import type { Ctx } from "./context.ts";

/** Rows a tick may embed (a long row is several calls): a few beside live traffic, never a burst. Also the page it reads. */
export const MEND_BATCH = 8;
/** Rows a tick may read, refused and held ones included, before it stops: a brain of refused rows is walked a few hundred a tick, not eight. */
export const MEND_SCAN = 256;
/** Seconds between ticks when OB1_VECTOR_MEND_INTERVAL is unset. */
export const DEFAULT_MEND_INTERVAL_S = 60;
/** The longest interval the knob takes: a day. */
export const MAX_MEND_INTERVAL_S = 86_400;
/** The first tick's delay after start, so a restart with the provider back mends soon. */
export const FIRST_MEND_DELAY_MS = 5_000;
/** The most sweeps a failing row is held for; it doubles from one with each failure. */
export const MAX_HOLD_SWEEPS = 32;
/** The most sweeps a row an outage held waits: the provider's return lets it go anyway, once another row's call shows it. */
export const MAX_OUTAGE_HOLD_SWEEPS = 8;
/** The most a run of ticks that throw (the database away) stretches the interval, as a multiple of it. */
export const MAX_TICK_BACKOFF = 32;
/** The rows held at once; past it the hold that has stood longest unrenewed is dropped (the row is tried again). */
export const MAX_HELD_ROWS = 10_000;
/** setTimeout's ceiling: a longer delay fires at once (Bun, as Node), so every delay is clamped to it. */
const MAX_TIMER_MS = 2_147_483_647;
/** The actor the mender's writes record (thought_audit.actor_name): not a key, as db/reembed.ts's `reembed` is not. */
export const MENDER_ACTOR = "vector-mender";
/**
 * The doors a key's capture comes through — the servers' names, which each
 * stamps as thought_audit.origin (046): index.ts's SERVER_NAME and api.ts's
 * API_DOOR (test-thoughts holds the second to it). A row captured through one
 * was asked of the gate as a capture is; any other was a pass's write.
 */
export const SERVER_DOORS: readonly string[] = ["open-brain", "open-brain-api"];

/**
 * OB1_VECTOR_MEND_INTERVAL: whole seconds between ticks, 1 to a day, `0` or
 * `off` for no mender. A value that does not read falls back to the default
 * and says so — a typo must not switch the mender off unseen.
 */
export function mendIntervalFrom(raw: string | undefined): { intervalS: number; problem: string | null } {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "") return { intervalS: DEFAULT_MEND_INTERVAL_S, problem: null };
  if (v === "off" || v === "0") return { intervalS: 0, problem: null };
  if (/^[0-9]+$/.test(v) && Number(v) >= 1 && Number(v) <= MAX_MEND_INTERVAL_S) return { intervalS: Number(v), problem: null };
  return { intervalS: DEFAULT_MEND_INTERVAL_S, problem: `OB1_VECTOR_MEND_INTERVAL=${JSON.stringify(raw)} is not a whole number of seconds from 1 to ${MAX_MEND_INTERVAL_S}, or "off"; the vector mender runs every ${DEFAULT_MEND_INTERVAL_S} s` };
}

/** What a tick did. */
export type MendTick = {
  /** Another process holds the leader lock: this tick read and wrote nothing. */
  skipped: boolean;
  /** The egress policy refuses every call to the embedding endpoint: nothing was read (its words). */
  refusedAll: string | null;
  /** Rows given their vector. */
  mended: number;
  /** …of which with less than a capture would say it got: the head window's vector, or windows without their blurb. */
  degraded: number;
  /** Rows the egress gate refused: no call made. */
  refused: number;
  /** Rows whose call or write failed — a 4xx, a width mismatch, a write the database refused, an outage — now held. */
  failed: number;
  /** Rows passed over: held after earlier failures. */
  held: number;
  /** Rows edited, deleted or given a vector by another writer between the read and the write: the next sweep reads them afresh. */
  raced: number;
  /** The provider's outage that stopped the tick, if one did. */
  down: { reason: string; detail: string } | null;
  /** The provider answered after an outage: the rows the outage held were let go. */
  recovered: boolean;
  /** The leader lock was not let go by the session that took it, which is still open (a pooler in statement or transaction mode). */
  lockKept: boolean;
  /** The first failure's words, cut short, for the log line. */
  firstError: string | null;
  /** The tick reached the end of the rows: it ended a sweep. */
  sweepEnded: boolean;
};

/**
 * A held row: how often it failed, the sweep it waits for, whether an outage
 * held it (the provider's return lets it go), and whether it fails alone —
 * its outages are its own, never the provider's.
 */
type Hold = { failures: number; until: number; outage: boolean; alone: boolean };

/** What a mender carries from tick to tick. */
export type MendState = {
  /** The last id passed; null to start a sweep. */
  cursor: string | null;
  sweep: number;
  held: Map<string, Hold>;
  /** An outage stopped a tick, and nothing has said it is over: no call answered, and an outage's hold still runs. */
  down: boolean;
  /** The rows the last tick stopped on, when it stopped on an outage: marked alone if the next tick's call is answered. */
  stoppedOn: string[];
  /** The last tick's calls included one the provider answered. */
  answeredLastTick: boolean;
  /** The ids read this sweep, so its end drops the holds of rows no longer waiting. */
  seen: Set<string>;
  /** The most rows held at once (MAX_HELD_ROWS; a suite asks for fewer). */
  maxHeld: number;
  /** An embedder that sends no blurb, for a row whose blurb the gate refuses (built once, on need). */
  bare?: Embedder;
};

export const newMendState = (maxHeld = MAX_HELD_ROWS): MendState =>
  ({ cursor: null, sweep: 0, held: new Map(), down: false, stoppedOn: [], answeredLastTick: false, seen: new Set(), maxHeld });

const actorName = (row: VectorlessRow): string | undefined => {
  const name = row.metadata?.actor_name;
  return typeof name === "string" && name !== "" ? name : undefined;
};

/**
 * Whether this row's text may go to the provider, asked the question its
 * writer's own gate asked:
 *
 * - a row a key captured through a server (its capture's origin a server
 *   door) as the capture was asked — the key that wrote the text and the
 *   text, so an allow term reads as it did then and a `source:` the caller
 *   claimed cannot open the gate (SMD-1941) — AND as a pass asks of a row,
 *   its metadata too, so a deny term over `source:`, `type:` or `topic:`
 *   keeps the row home as db/reembed.ts's gate would;
 * - any other row — an import, board-sync's, a raw write — as db/reembed.ts
 *   asks, the row's metadata and text with no actor, since its actor_name
 *   may be a label the writing tool chose and opens nothing; AND with that
 *   actor_name beside them, so a deny term naming it keeps the row home —
 *   board-sync's own gate asked with its name, and a key that edited the
 *   row since stamped its own (review pass 2). Under deny the second can
 *   open nothing the first refuses; under allow it can only close.
 *
 * `embeddings` is the answer for the embedding call; `blurbs` whether the
 * chat endpoint may take the text too, for the windows' blurbs under
 * OB1_CHUNK_CONTEXT — refused, the windows go in bare, as a capture's do.
 * `subject` is what the embedder's own gate is asked with — the first
 * subject only, so that gate alone would miss a row's `topic:` deny term; it
 * never sees a text this check refused, both reading the policy fixed at
 * start (review pass 4). `record` is the decision for the audit row: the
 * endpoints not declared local, the chat one where blurbs were asked for,
 * allowed or not.
 */
export function mendAllowed(ctx: Ctx, row: VectorlessRow): { embeddings: boolean; blurbs: boolean; subject: EgressSubject; record: EgressRecord | undefined } {
  const cfg = ctx.embedConfig();
  const asRow: EgressSubject = { kind: "re-embed", ...(row.metadata ? { metadata: row.metadata } : {}), content: row.content };
  const actor = actorName(row);
  const withActor: EgressSubject = { ...asRow, ...(actor ? { actor } : {}) };
  const byKey = row.origin !== null && SERVER_DOORS.includes(row.origin);
  const subjects: EgressSubject[] = byKey ? [{ kind: "re-embed", ...(actor ? { actor } : {}), content: row.content }, withActor] : [asRow, withActor];
  // Every subject asked; the first refusal is the decision, else the first subject's allow.
  const decide = (endpoint: typeof cfg.embeddings) => {
    const all = subjects.map((s) => mayLeaveBox(s, endpoint, cfg.egress));
    return all.find((d) => !d.allowed) ?? all[0];
  };
  const emb = decide(cfg.embeddings);
  const chat = cfg.chunkContext ? decide(cfg.chat) : null;
  const blurbs = chat === null || chat.allowed;
  const record: EgressRecord = { policy: cfg.egress.mode };
  if (!cfg.embeddings.local) record.embeddings = { to: hostOf(cfg.embeddings.base), allowed: emb.allowed, rule: emb.rule };
  // A refused blurb is recorded too, as a capture's decideCalls records a refused call.
  if (chat && !cfg.chat.local) record.chat = { to: hostOf(cfg.chat.base), allowed: chat.allowed, rule: chat.rule };
  return { embeddings: emb.allowed, blurbs, subject: subjects[0], record: record.embeddings || record.chat ? record : undefined };
}

const cut = (s: string) => (s.length > 300 ? `${s.slice(0, 300)}…` : s);

/**
 * A fault the database answered about the write itself — it carries a
 * SQLSTATE — as against a database not there to answer: no SQLSTATE, or a
 * class that says the server is going or gone, or out of room (08 the
 * connection, 53 resources, 57 an operator's intervention such as a shutdown,
 * 58 the system) — review pass 3.
 */
const databaseAnswered = (e: unknown): boolean => {
  const errno = typeof e === "object" && e !== null ? (e as { errno?: unknown }).errno : undefined;
  return typeof errno === "string" && /^[0-9A-Z]{5}$/.test(errno) && !/^(08|53|57|58)/.test(errno);
};

/** A provider fault in words that carry nothing of the text: its status or kind, never its body (review pass 4: a provider echoing its input put the text in the log). */
const faultWords = (e: unknown): string => {
  if (e instanceof ProviderError) {
    if (e.kind === "http") return `the provider answered ${e.status}`;
    if (e.kind === "timeout") return "the request timed out (OB1_LLM_TIMEOUT)";
    if (e.kind === "body") return "the provider's answer was not JSON";
    return e.message; // egress: the gate's words, its rule and host
  }
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" ? `${(e as Error).name ?? "Error"} ${code}` : cut(e instanceof Error ? e.message : String(e));
};

/**
 * One tick: under the leader lock, vectorless rows in id order from the
 * cursor, each embedded by the capture's path and written through
 * update_thought with the stamp it read, until MEND_BATCH rows embedded (one
 * more to decide a pending row), MEND_SCAN rows read, or the end. `stopped`
 * is read before each row and before each write: a stop starts no further
 * call, and writes nothing the call it cut short answered. A database that
 * stops answering throws out of the tick (the loop backs off); a write it
 * refuses holds the row. A policy that refuses every call to the embedding
 * endpoint reads nothing.
 */
export async function mendOnce(ctx: Ctx, state: MendState, stopped: () => boolean = () => false): Promise<MendTick> {
  const tick: MendTick = { skipped: false, refusedAll: null, mended: 0, degraded: 0, refused: 0, failed: 0, held: 0, raced: 0, down: null, recovered: false, lockKept: false, firstError: null, sweepEnded: false };
  const cfg0 = ctx.embedConfig();
  const everything = refusesEverything(cfg0.embeddings, cfg0.egress);
  if (everything) return { ...tick, refusedAll: everything };
  const store = await ctx.store();
  // A suite's fake store may hold no lock: it acts alone.
  const release = store.mendLock ? await store.mendLock() : async () => true;
  if (!release) return { ...tick, skipped: true };
  const prevStoppedOn = state.stoppedOn;
  const prevAnswered = state.answeredLastTick;
  state.stoppedOn = [];
  const hold = (id: string, words: string, outage: boolean, alone = false) => {
    const prior = state.held.get(id);
    const failures = (prior?.failures ?? 0) + 1;
    // Re-set, not updated, so the map's order is the order of the latest failures and the cap drops the stalest.
    state.held.delete(id);
    // Held for 1, 2, 4 … sweeps: the first failure skips the next sweep.
    state.held.set(id, { failures, until: state.sweep + 1 + Math.min(2 ** (failures - 1), outage ? MAX_OUTAGE_HOLD_SWEEPS : MAX_HOLD_SWEEPS), outage, alone: alone || (prior?.alone ?? false) });
    if (state.held.size > state.maxHeld) state.held.delete(state.held.keys().next().value as string);
    tick.failed++;
    tick.firstError ??= `${id}: ${words}`;
  };
  let answered = false;
  /** The row whose outage the next call decides, and the outage it met. */
  let pending: { id: string; down: { reason: string; detail: string } } | null = null;
  const stopDown = (ids: string[], down: { reason: string; detail: string }) => {
    for (const id of ids) hold(id, down.detail, true);
    tick.down = down;
    state.down = true;
    state.stoppedOn = ids;
  };
  // The provider answered a call of this tick: a pending row failed alone, and an outage it was away for is over.
  const answer = () => {
    answered = true;
    if (pending) {
      hold(pending.id, `${pending.down.detail}, while the provider answered the next call`, false, true);
      pending = null;
    }
    if (state.down) {
      state.down = false;
      tick.recovered = true;
      for (const [id, h] of state.held) {
        if (!h.outage) continue;
        // An outage of one tick is the two texts that stopped it failing alone.
        if (prevStoppedOn.includes(id)) Object.assign(h, { outage: false, alone: true });
        else h.until = state.sweep;
      }
    }
  };
  // The tick ends with a row pending and no call after it: alone if the
  // provider answered this tick or the last, else the provider away.
  const settle = () => {
    if (!pending) return;
    if (answered || prevAnswered) hold(pending.id, `${pending.down.detail}, while the provider answered other calls`, false, true);
    else stopDown([pending.id], pending.down);
    pending = null;
  };
  try {
    let embeddedRows = 0;
    let scanned = 0;
    const room = () => (embeddedRows < MEND_BATCH || pending !== null) && scanned < MEND_SCAN;
    while (room()) {
      const rows = await store.listVectorless({ limit: MEND_BATCH, after: state.cursor });
      for (const row of rows) {
        if (stopped()) {
          pending = null;
          return tick;
        }
        if (!room()) {
          settle();
          return tick;
        }
        scanned++;
        state.cursor = row.id;
        state.seen.add(row.id);
        const h = state.held.get(row.id);
        if (h && state.sweep < h.until) {
          tick.held++;
          continue;
        }
        const gate = mendAllowed(ctx, row);
        if (!gate.embeddings) {
          tick.refused++;
          continue;
        }
        // Blurbs refused: the windows go in bare, as a capture's do, and the recipe says no blurb was asked for.
        const cfg = gate.blurbs ? ctx.embedConfig() : { ...ctx.embedConfig(), chunkContext: false };
        const embedder = gate.blurbs ? ctx.embedder : (state.bare ??= createEmbedder(() => ({ ...ctx.embedConfig(), chunkContext: false })));
        embeddedRows++;
        let embedded;
        try {
          embedded = await embedder.embedCapture(row.content, gate.subject);
        } catch (e) {
          const down = providerDown(e);
          if (!down) {
            // An HTTP status is the provider answering, with a refusal of this
            // input; any other fault (an egress refusal, a body that is not
            // JSON) is the row's, and says nothing of the provider.
            if (e instanceof ProviderError && e.kind === "http") answer();
            hold(row.id, faultWords(e), false);
            continue;
          }
          if (h?.alone) {
            // It fails alone: its outage is its own.
            hold(row.id, down.detail, false, true);
            continue;
          }
          if (pending) {
            // A second outage in a row: the provider is away.
            stopDown([pending.id, row.id], down);
            pending = null;
            return tick;
          }
          pending = { id: row.id, down };
          continue;
        }
        answer();
        // The stop came while the provider answered: the pool is closing, and
        // the row stays vectorless for the next start.
        if (stopped()) return tick;
        let result;
        try {
          result = await store.updateThought({
            id: row.id,
            content: row.content,
            embedding: embedded.embedding,
            chunks: embedded.chunks,
            ifUnchangedSince: row.updatedAt,
            // `background`: db/sleep.ts reads past it; `egress`: the decision that let the text go, as a capture's audit row carries it.
            actor: { name: MENDER_ACTOR, via: ctx.door, background: MENDER_ACTOR, ...(gate.record ? { egress: gate.record } : {}) },
            embeddingModel: embedded.model,
            lineage: embedded.chunks.length ? { chunks: chunkRecipe(cfg, embedded) } : undefined,
          });
        } catch (e) {
          // The database not there to answer is the tick's, not the row's:
          // thrown, the loop backs off. One it answered with a refusal (a
          // vector it cannot read) holds the row.
          if (!databaseAnswered(e)) throw e;
          hold(row.id, `update_thought: ${cut(e instanceof Error ? e.message : String(e))}`, false);
          continue;
        }
        if (result.ok) {
          state.held.delete(row.id);
          tick.mended++;
          if (embedded.wholeContentFellBack || embedded.contextFailures > 0) tick.degraded++;
        } else if (result.error === "STALE_READ" || result.error === "NOT_FOUND" || result.error === "DUPLICATE_CONTENT") {
          // Edited, deleted or re-captured since the read: whatever the row
          // holds now, the next sweep reads it afresh.
          state.held.delete(row.id);
          tick.raced++;
        } else hold(row.id, `update_thought ${result.error}`, false);
      }
      if (rows.length < MEND_BATCH) {
        settle();
        // The sweep's end: the holds of rows no longer waiting go, and with
        // no outage's hold still running nothing says the provider is away.
        for (const id of state.held.keys()) if (!state.seen.has(id)) state.held.delete(id);
        if (![...state.held.values()].some((x) => x.outage && x.until > state.sweep)) state.down = false;
        state.seen = new Set();
        state.cursor = null;
        state.sweep++;
        tick.sweepEnded = true;
        break;
      }
    }
    settle();
    return tick;
  } finally {
    state.answeredLastTick = answered;
    // A release that throws went with its connection, and the lock with it.
    const letGo = await release().catch(() => true);
    if (!letGo) tick.lockKept = true;
  }
}

/**
 * The loop: a tick FIRST_MEND_DELAY_MS after start, then one every
 * `intervalS`, never two at once. A tick that throws — the database away —
 * doubles the wait, up to MAX_TICK_BACKOFF times, and a tick that runs resets
 * it; a failing row is the row's to wait out (mendOnce), never the loop's.
 * Over the PostgREST store it starts nothing: no session holds the lock there
 * and no capture row says a row's writer (said once).
 *
 * Says a line when a tick mended something, when the provider stops
 * answering and when it answers again, at a sweep's end when the rows it left
 * (refused; failed or held) differ from the last sweep's, a tick that throws
 * when its words differ from the last, once if the policy refuses every call,
 * and once if the lock was not let go. Never one per idle tick.
 */
export function startVectorMender(ctx: Ctx, opts: { intervalS: number; log?: (line: string) => void; firstDelayMs?: number }): { stop(): void; ticks(): number } {
  const log = opts.log ?? ((line: string) => console.log(line));
  const state = newMendState();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backoff = 1;
  let ticks = 0;
  let threw = "";
  let lockSaid = false;
  let refusedSaid = false;
  let kindChecked = false;
  let saidDown = false;
  let sweep = { refused: 0, failed: 0, held: 0, firstError: null as string | null };
  let lastSweep = "0/0";
  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(run, Math.min(ms, MAX_TIMER_MS));
    // The mender never holds the process open: a stop exits as it would without it.
    (timer as { unref?: () => void }).unref?.();
  };
  const run = async () => {
    try {
      if (!kindChecked && (await ctx.store()).kind === "postgrest") {
        log("vector mender: not started — the PostgREST store holds no session for the leader lock and no capture row to say a row's writer; a thought saved without a vector waits for db/reembed.ts");
        stopped = true;
        return;
      }
      kindChecked = true;
      const t = await mendOnce(ctx, state, () => stopped);
      ticks++;
      backoff = 1;
      threw = "";
      if (stopped) return;
      if (t.lockKept && !lockSaid) {
        log("vector mender: the leader lock was not let go by the session that took it — a pooler in statement or transaction mode between this server and Postgres? Point DATABASE_URL at Postgres itself, or set OB1_VECTOR_MEND_INTERVAL=off on every server but one");
        lockSaid = true;
      }
      if (t.refusedAll && !refusedSaid) log(`vector mender: idle — ${t.refusedAll}`);
      refusedSaid = t.refusedAll !== null;
      if (t.skipped || t.refusedAll) return;
      if (t.down && !saidDown) log(`vector mender: the embedding provider is unavailable (${t.down.detail}); rows without a vector wait, and are tried as their holds end`);
      if (t.recovered && saidDown) log("vector mender: the embedding provider answers again");
      // Said once an outage begins, and again only after this mender saw it end.
      saidDown = state.down;
      if (t.mended > 0) log(`vector mender: ${t.mended} thought${t.mended === 1 ? "" : "s"} given a vector${t.degraded ? ` (${t.degraded} with the head window's vector or windows without their blurb, as a capture would store them)` : ""}`);
      sweep = { refused: sweep.refused + t.refused, failed: sweep.failed + t.failed, held: sweep.held + t.held, firstError: sweep.firstError ?? t.firstError };
      if (t.sweepEnded) {
        // Keyed on the sweep's counts alone — the first failure's row differs
        // sweep to sweep — and a failing row's two states (tried and failed,
        // held) as one, so its hold schedule says nothing new.
        const key = `${sweep.refused}/${sweep.failed + sweep.held}`;
        if (key !== lastSweep && key !== "0/0") {
          log(`vector mender: left without a vector this sweep — ${sweep.refused} refused by the egress gate, ${sweep.failed} failed${sweep.firstError ? ` (first: ${sweep.firstError})` : ""}, ${sweep.held} held after earlier failures`);
        }
        lastSweep = key;
        sweep = { refused: 0, failed: 0, held: 0, firstError: null };
      }
    } catch (e) {
      ticks++;
      // After a stop the pool is closing and its errors are expected.
      if (stopped) return;
      backoff = Math.min(backoff * 2, MAX_TICK_BACKOFF);
      const words = cut(e instanceof Error ? e.message : String(e));
      if (words !== threw) log(`vector mender: the tick failed: ${words}; tried again in ${opts.intervalS * backoff} s`);
      threw = words;
    } finally {
      if (!stopped) schedule(opts.intervalS * 1000 * backoff);
    }
  };
  schedule(opts.firstDelayMs ?? FIRST_MEND_DELAY_MS);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    ticks: () => ticks,
  };
}
