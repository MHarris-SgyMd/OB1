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
// takes turns. A few calls a tick, never the LLM drain the bulk passes are
// (entities.ts) — though a long row under OB1_CHUNK_CONTEXT is a call per
// window.
//
// Resumable without a claim table: `embedding IS NULL` is the state. A tick
// reads pages in id order from a cursor until it has made MEND_BATCH calls,
// read MEND_SCAN rows, or reached the end, which ends the sweep: the next tick
// starts over. A row the gate refuses costs no call and no place in the
// tick's calls. A row whose call fails is held for a number of sweeps that
// doubles with each failure. The write carries the stamp it read, so
// update_thought's guard refuses it over an edit made since (STALE_READ).
//
// The provider away, one rule: a call that meets an outage (providerDown)
// before any call of this tick was answered stops the tick, one call spent,
// and the cursor passes the row — each tick asks once, with the next row, so
// a text the provider fails alone holds back nothing. Two outages in a row
// after an answer — the provider went away mid-tick — stop it too; one alone
// is that row's own failure. Which it was is told later: the row a tick
// stopped on, when the next tick's call is answered, failed alone or met the
// outage's end, and twice is held; the same row stopping SUSPECT_TICKS ticks
// running with nothing answered between — the only row there is — is held
// too, briefly. When the provider answers again after an outage, the rows an
// outage held are tried again at once.

import { createEmbedder, providerDown, type Embedder } from "../embed.ts";
import { decideCalls, mayLeaveBox, type EgressSubject } from "../egress.ts";
import { chunkRecipe } from "../lineage.ts";
import type { VectorlessRow } from "../store.ts";
import type { Ctx } from "./context.ts";

/** Provider calls a tick may make: a few beside live traffic, never a burst. Also the page it reads. */
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
/** The most sweeps a row an outage may have caused is held for: the provider's return releases it anyway, when another row's call shows it. */
export const MAX_OUTAGE_HOLD_SWEEPS = 8;
/** Ticks running one row stops on, nothing answered between, before it is held: a text the provider fails alone, or the outage of a brain with one row waiting. */
export const SUSPECT_TICKS = 3;
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
  /** Rows given their vector. */
  mended: number;
  /** …of which with less than a capture would say it got: the head window's vector, or windows without their blurb. */
  degraded: number;
  /** Rows the egress gate refused: no call made. */
  refused: number;
  /** Rows whose call or write failed — a 4xx, a width mismatch, a write the database refused, an outage on that row alone — now held. */
  failed: number;
  /** Rows passed over: held after earlier failures. */
  held: number;
  /** Rows edited, deleted or given a vector by another writer between the read and the write: the next sweep reads them afresh. */
  raced: number;
  /** The provider's outage that stopped the tick, if one did. */
  down: { reason: string; detail: string } | null;
  /** The provider answered after an outage: the rows the outage held were let go. */
  recovered: boolean;
  /** The leader lock was not let go by the session that took it (a pooler in statement or transaction mode). */
  lockKept: boolean;
  /** The first failure's words, cut short, for the log line. */
  firstError: string | null;
  /** The tick reached the end of the rows: it ended a sweep. */
  sweepEnded: boolean;
};

type Hold = { failures: number; until: number; outage: boolean };

/**
 * What a mender carries from tick to tick: the cursor (the last id passed,
 * null to start a sweep), the sweep's number, the rows held and until which
 * sweep, and what the last outage left to tell.
 */
export type MendState = {
  cursor: string | null;
  sweep: number;
  held: Map<string, Hold>;
  /** The last tick stopped on an outage, and no call has been answered since. */
  down: boolean;
  /** The row the last tick stopped on, until a later call is answered. */
  stoppedAt: string | null;
  /** The row that stopped the ticks running with nothing answered, and how many. */
  lone: { id: string; ticks: number } | null;
  /** Rows a tick stopped on just before an answer, and how often: twice is a row the provider fails alone. */
  stoppedBeforeAnswer: Map<string, number>;
  /** The most rows held at once (MAX_HELD_ROWS; a suite asks for fewer). */
  maxHeld: number;
  /** An embedder that sends no blurb, for a row whose blurb the gate refuses (built once, on need). */
  bare?: Embedder;
};

export const newMendState = (maxHeld = MAX_HELD_ROWS): MendState =>
  ({ cursor: null, sweep: 0, held: new Map(), down: false, stoppedAt: null, lone: null, stoppedBeforeAnswer: new Map(), maxHeld });

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
 * `subject` is what the embedder's own gate is asked with.
 */
export function mendAllowed(ctx: Ctx, row: VectorlessRow): { embeddings: boolean; blurbs: boolean; subject: EgressSubject } {
  const cfg = ctx.embedConfig();
  const asRow: EgressSubject = { kind: "re-embed", ...(row.metadata ? { metadata: row.metadata } : {}), content: row.content };
  const actor = actorName(row);
  const withActor: EgressSubject = { ...asRow, ...(actor ? { actor } : {}) };
  const byKey = row.origin !== null && SERVER_DOORS.includes(row.origin);
  const subjects: EgressSubject[] = byKey ? [{ kind: "re-embed", ...(actor ? { actor } : {}), content: row.content }, withActor] : [asRow, withActor];
  const allows = (endpoint: typeof cfg.embeddings) => subjects.every((s) => mayLeaveBox(s, endpoint, cfg.egress).allowed);
  return { embeddings: allows(cfg.embeddings), blurbs: !cfg.chunkContext || allows(cfg.chat), subject: subjects[0] };
}

const cut = (s: string) => (s.length > 300 ? `${s.slice(0, 300)}…` : s);

/** A fault the database answered — it carries a SQLSTATE — as against a database not there to answer. */
const databaseAnswered = (e: unknown): boolean => {
  const errno = typeof e === "object" && e !== null ? (e as { errno?: unknown }).errno : undefined;
  return typeof errno === "string" && /^[0-9A-Z]{5}$/.test(errno);
};

/**
 * One tick: under the leader lock, vectorless rows in id order from the
 * cursor, each embedded by the capture's path and written through
 * update_thought with the stamp it read, until MEND_BATCH calls, MEND_SCAN
 * rows, or the end. `stopped` is read before each row and before each
 * write: a stop starts no further call, and writes nothing the call it cut
 * short answered. A database that stops answering throws out of the tick
 * (the loop backs off); a write it refuses holds the row.
 */
export async function mendOnce(ctx: Ctx, state: MendState, stopped: () => boolean = () => false): Promise<MendTick> {
  const tick: MendTick = { skipped: false, mended: 0, degraded: 0, refused: 0, failed: 0, held: 0, raced: 0, down: null, recovered: false, lockKept: false, firstError: null, sweepEnded: false };
  const store = await ctx.store();
  // A suite's fake store may hold no lock: it acts alone.
  const release = store.mendLock ? await store.mendLock() : async () => true;
  if (!release) return { ...tick, skipped: true };
  const cap = (m: Map<string, unknown>) => {
    if (m.size > state.maxHeld) m.delete(m.keys().next().value as string);
  };
  const hold = (id: string, words: string, outage: boolean) => {
    const prior = state.held.get(id)?.failures ?? 0;
    // Re-set, not updated, so the map's order is the order of the latest failures and the cap drops the stalest.
    state.held.delete(id);
    // Held for 1, 2, 4 … sweeps: the first failure skips the next sweep.
    state.held.set(id, { failures: prior + 1, until: state.sweep + 1 + Math.min(2 ** prior, outage ? MAX_OUTAGE_HOLD_SWEEPS : MAX_HOLD_SWEEPS), outage });
    cap(state.held);
    tick.failed++;
    tick.firstError ??= cut(`${id}: ${words}`);
  };
  let answered = false;
  let outagesInARow = 0;
  // The provider answered a call of this tick: whatever the last outage left is told now.
  const answer = () => {
    answered = true;
    outagesInARow = 0;
    if (state.stoppedAt) {
      const n = (state.stoppedBeforeAnswer.get(state.stoppedAt) ?? 0) + 1;
      state.stoppedBeforeAnswer.delete(state.stoppedAt);
      if (n >= 2) hold(state.stoppedAt, "the provider failed this text alone, twice", false);
      else {
        state.stoppedBeforeAnswer.set(state.stoppedAt, n);
        cap(state.stoppedBeforeAnswer);
      }
      state.stoppedAt = null;
    }
    state.lone = null;
    if (state.down) {
      state.down = false;
      tick.recovered = true;
      for (const [id, h] of state.held) if (h.outage) state.held.delete(id);
    }
  };
  try {
    let calls = 0;
    let scanned = 0;
    while (calls < MEND_BATCH && scanned < MEND_SCAN) {
      const rows = await store.listVectorless({ limit: MEND_BATCH, after: state.cursor });
      for (const row of rows) {
        if (stopped()) return tick;
        if (calls >= MEND_BATCH || scanned >= MEND_SCAN) return tick;
        scanned++;
        state.cursor = row.id;
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
        calls++;
        let embedded;
        try {
          embedded = await embedder.embedCapture(row.content, gate.subject);
        } catch (e) {
          const down = providerDown(e);
          if (!down) {
            // The provider answered — with a refusal of this input.
            answer();
            hold(row.id, e instanceof Error ? e.message : String(e), false);
            continue;
          }
          outagesInARow++;
          if (!answered || outagesInARow >= 2) {
            // The provider, as far as this tick can tell: stop, one call
            // spent; the cursor has passed the row.
            tick.down = down;
            state.down = true;
            state.stoppedAt = row.id;
            state.lone = state.lone?.id === row.id ? { id: row.id, ticks: state.lone.ticks + 1 } : { id: row.id, ticks: 1 };
            // Held once already as an outage's and stopping the tick again: held again at once, for longer.
            if (state.lone.ticks >= SUSPECT_TICKS || state.held.get(row.id)?.outage) {
              hold(row.id, `${down.detail}, ${SUSPECT_TICKS} ticks running with nothing else answered`, true);
              state.lone = null;
              state.stoppedAt = null;
            }
            return tick;
          }
          // Answered earlier this tick: an outage on this row alone, so far.
          hold(row.id, down.detail, true);
          continue;
        }
        answer();
        // The stop came while the provider answered: the pool is closing, and
        // the row stays vectorless for the next start.
        if (stopped()) return tick;
        const egress = decideCalls(gate.subject, ctx.embedConfig(), ctx.embedConfig().egress).record;
        let result;
        try {
          result = await store.updateThought({
            id: row.id,
            content: row.content,
            embedding: embedded.embedding,
            chunks: embedded.chunks,
            ifUnchangedSince: row.updatedAt,
            // `background`: db/sleep.ts reads past it; `egress`: the decision that let the text go, as a capture's audit row carries it.
            actor: { name: MENDER_ACTOR, via: ctx.door, background: MENDER_ACTOR, ...(egress ? { egress } : {}) },
            embeddingModel: embedded.model,
            lineage: embedded.chunks.length ? { chunks: chunkRecipe(cfg, embedded) } : undefined,
          });
        } catch (e) {
          // The database not there to answer is the tick's, not the row's:
          // thrown, the loop backs off. One it answered with a refusal (a
          // vector it cannot read) holds the row.
          if (!databaseAnswered(e)) throw e;
          hold(row.id, `update_thought: ${e instanceof Error ? e.message : String(e)}`, false);
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
        state.cursor = null;
        state.sweep++;
        tick.sweepEnded = true;
        break;
      }
    }
    return tick;
  } finally {
    const let_go = await release().catch(() => false);
    if (!let_go) tick.lockKept = true;
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
 * when its words differ from the last, and once if the lock was not let go.
 * Never one per idle tick.
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
  let kindChecked = false;
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
      const wasDown = state.down;
      const t = await mendOnce(ctx, state, () => stopped);
      ticks++;
      backoff = 1;
      threw = "";
      if (t.lockKept && !lockSaid) {
        log("vector mender: the leader lock was not let go by the session that took it — a pooler in statement or transaction mode between this server and Postgres? Point DATABASE_URL at Postgres itself, or set OB1_VECTOR_MEND_INTERVAL=off on every server but one");
        lockSaid = true;
      }
      if (stopped || t.skipped) return;
      if (t.down && !wasDown) log(`vector mender: the embedding provider is unavailable (${t.down.detail}); rows without a vector wait, and are tried every ${opts.intervalS} s`);
      if (t.recovered) log("vector mender: the embedding provider answers again");
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
