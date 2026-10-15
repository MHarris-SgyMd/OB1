// The vector mender (SMD-2889): the server gives a thought saved without a
// vector its vector, by itself, once the provider answers and the egress gate
// allows the call. A capture lands vectorless when the provider did not answer
// (SMD-2888) or the gate refused the call (SMD-1903), and before this nothing
// embedded such a row but a hand-run db/reembed.ts — whose pool takes these
// rows too, and which stays the tool for a model change or a whole brain.
//
// Why the server, on a timer: it is the one process every brain runs — the
// workers and the sleep scheduler are profiles a brain may not run — and it
// already holds what the call needs: the capture's embedder (embed.ts), the
// egress policy and the store. A small pass, a few rows a minute, and never
// the LLM drain the bulk passes are (entities.ts).
//
// Resumable without a claim table: `embedding IS NULL` is the state. A tick
// reads a page in id order from a cursor, so a row the gate refuses or the
// provider fails never holds back the rows behind it; a short page ends the
// sweep and the next tick starts over. Two servers mending at once cost a
// duplicate provider call, never a wrong write: the write carries the stamp
// it read, and update_thought's guard refuses the later one (STALE_READ).

import { providerDown } from "../embed.ts";
import { mayLeaveBox, type EgressSubject } from "../egress.ts";
import { chunkRecipe } from "../lineage.ts";
import type { VectorlessRow } from "../store.ts";
import type { Ctx } from "./context.ts";

/** Rows a tick reads and may embed: a few calls a minute beside live traffic, never a burst. */
export const MEND_BATCH = 8;
/** Seconds between ticks when OB1_VECTOR_MEND_INTERVAL is unset. */
export const DEFAULT_MEND_INTERVAL_S = 60;
/** The first tick's delay after start, so a restart with the provider back mends soon. */
export const FIRST_MEND_DELAY_MS = 5_000;
/** The longest a run of failing ticks stretches the interval, as a multiple of it. */
export const MAX_MEND_BACKOFF = 32;
/** The actor the mender's writes record (thought_audit.actor_context): not a key, as db/reembed.ts's `reembed` is not. */
export const MENDER_ACTOR = "vector-mender";

/**
 * OB1_VECTOR_MEND_INTERVAL: whole seconds between ticks, `0` or `off` for no
 * mender. A value that does not read falls back to the default and says so —
 * a typo must not switch the mender off unseen.
 */
export function mendIntervalFrom(raw: string | undefined): { intervalS: number; problem: string | null } {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "") return { intervalS: DEFAULT_MEND_INTERVAL_S, problem: null };
  if (v === "off" || v === "0") return { intervalS: 0, problem: null };
  if (/^[0-9]+$/.test(v) && Number(v) > 0) return { intervalS: Number(v), problem: null };
  return { intervalS: DEFAULT_MEND_INTERVAL_S, problem: `OB1_VECTOR_MEND_INTERVAL=${JSON.stringify(raw)} is not a whole number of seconds or "off"; the vector mender runs every ${DEFAULT_MEND_INTERVAL_S} s` };
}

/** What a tick did. `down` is the provider's outage that stopped it, if one did. */
export type MendTick = {
  /** Rows given their vector. */
  mended: number;
  /** Rows the egress gate refused: no call made. */
  refused: number;
  /** Rows whose call failed for a reason other than an outage — a 4xx, a width mismatch — or whose write was refused. */
  failed: number;
  /** Rows edited, deleted or given a vector by another writer between the read and the write: the next sweep reads them afresh. */
  raced: number;
  down: { reason: string; detail: string } | null;
  /** The first failure's words, for the log line. */
  firstError: string | null;
};

/** The cursor a tick resumes from: the last id it passed, null to start a sweep. */
export type MendState = { cursor: string | null };

const actorName = (row: VectorlessRow): string | undefined => {
  const name = row.metadata?.actor_name;
  return typeof name === "string" && name !== "" ? name : undefined;
};

/**
 * Whether this row's text may go to the provider. Asked of two subjects, and
 * sent only when both are allowed:
 *
 * - the capture's own — the key that wrote the text and the text — so an
 *   allow term reads as it did for the capture, and a `source:` the caller
 *   claimed cannot open the gate (SMD-1941: the capture's subject carries no
 *   source, egress.ts EGRESS_UNITS);
 * - the row's, as a pass reads it — the key, the row's metadata and the
 *   text — so a deny term over `source:`, `type:` or `topic:` keeps the row
 *   home, as db/reembed.ts's gate does.
 *
 * The chat endpoint is asked too when windows carry a blurb (OB1_CHUNK_CONTEXT):
 * the blurb sends the text there.
 */
export function mendAllowed(ctx: Ctx, row: VectorlessRow): { allowed: boolean; subject: EgressSubject } {
  const cfg = ctx.embedConfig();
  const actor = actorName(row);
  const asCapture: EgressSubject = { kind: "re-embed", ...(actor ? { actor } : {}), content: row.content };
  const asRow: EgressSubject = { ...asCapture, ...(row.metadata ? { metadata: row.metadata } : {}) };
  const endpoints = cfg.chunkContext ? [cfg.embeddings, cfg.chat] : [cfg.embeddings];
  const allowed = endpoints.every((e) => mayLeaveBox(asCapture, e, cfg.egress).allowed && mayLeaveBox(asRow, e, cfg.egress).allowed);
  return { allowed, subject: asCapture };
}

/**
 * One tick: a page of vectorless rows from the cursor, each embedded by the
 * capture's path and written through update_thought with the stamp it read.
 * An outage stops the tick where it is — the cursor stays on the row, so the
 * provider is asked once a tick until it answers. `stopped` is read before
 * each row: a stop starts no further call.
 */
export async function mendOnce(ctx: Ctx, state: MendState, stopped: () => boolean = () => false): Promise<MendTick> {
  const tick: MendTick = { mended: 0, refused: 0, failed: 0, raced: 0, down: null, firstError: null };
  const store = await ctx.store();
  const rows = await store.listVectorless({ limit: MEND_BATCH, after: state.cursor });
  const fail = (words: string) => {
    tick.failed++;
    tick.firstError ??= words;
  };
  for (const row of rows) {
    if (stopped()) return tick;
    const gate = mendAllowed(ctx, row);
    if (!gate.allowed) {
      tick.refused++;
      state.cursor = row.id;
      continue;
    }
    let embedded;
    try {
      embedded = await ctx.embedder.embedCapture(row.content, gate.subject);
    } catch (e) {
      const down = providerDown(e);
      if (down) {
        tick.down = down;
        return tick;
      }
      fail(`${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      state.cursor = row.id;
      continue;
    }
    // The stop came while the provider answered: the pool is closing, and the
    // row stays vectorless for the next start.
    if (stopped()) return tick;
    const result = await store.updateThought({
      id: row.id,
      content: row.content,
      embedding: embedded.embedding,
      chunks: embedded.chunks,
      ifUnchangedSince: row.updatedAt,
      actor: { name: MENDER_ACTOR, via: ctx.door },
      embeddingModel: embedded.model,
      lineage: embedded.chunks.length ? { chunks: chunkRecipe(ctx.embedConfig(), embedded) } : undefined,
    });
    state.cursor = row.id;
    if (result.ok) tick.mended++;
    // Edited, deleted or re-captured since the read: whatever the row holds
    // now, the next sweep reads it afresh — a row that still has no vector is
    // on that page again.
    else if (result.error === "STALE_READ" || result.error === "NOT_FOUND" || result.error === "DUPLICATE_CONTENT") tick.raced++;
    else fail(`${row.id}: update_thought ${result.error}`);
  }
  // A short page is the end of the sweep: the next tick starts over.
  if (rows.length < MEND_BATCH) state.cursor = null;
  return tick;
}

/**
 * The loop: a tick FIRST_MEND_DELAY_MS after start, then one every
 * `intervalS`, never two at once. A tick that mended nothing and failed at
 * least one row doubles the wait, up to MAX_MEND_BACKOFF times — a provider
 * that refuses every row (a width mismatch, a bad key) is not asked eight
 * times a minute forever; a mend resets it. An outage keeps the interval, so
 * the provider's return is noticed within one.
 *
 * Says a line when a tick mended something, when the counts of rows it
 * refuses or fails change, and when the provider stops answering — never one
 * per idle tick.
 */
export function startVectorMender(ctx: Ctx, opts: { intervalS: number; log?: (line: string) => void; firstDelayMs?: number }): { stop(): void; ticks(): number } {
  const log = opts.log ?? ((line: string) => console.log(line));
  const state: MendState = { cursor: null };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backoff = 1;
  let ticks = 0;
  let wasDown = false;
  let said = "0/0";
  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(run, ms);
    // The mender never holds the process open: a stop exits as it would without it.
    (timer as { unref?: () => void }).unref?.();
  };
  const run = async () => {
    try {
      const t = await mendOnce(ctx, state, () => stopped);
      ticks++;
      if (stopped) return;
      if (t.down) {
        if (!wasDown) log(`vector mender: the embedding provider is unavailable (${t.down.detail}); rows without a vector wait, and are tried every ${opts.intervalS} s`);
        wasDown = true;
      } else wasDown = false;
      if (t.mended > 0) log(`vector mender: ${t.mended} thought${t.mended === 1 ? "" : "s"} given a vector`);
      // Keyed on the counts alone: the first failure's row differs tick to tick.
      const counts = `${t.refused}/${t.failed}`;
      if (counts !== said) {
        if (t.refused + t.failed) log(`vector mender: left without a vector this tick — ${t.refused} refused by the egress gate, ${t.failed} failed${t.firstError ? ` (first: ${t.firstError})` : ""}`);
        said = counts;
      }
      // An outage alone resets the wait too: the provider's return is what it waits for.
      backoff = t.mended > 0 || (t.down && t.failed === 0) ? 1 : t.failed > 0 ? Math.min(backoff * 2, MAX_MEND_BACKOFF) : backoff;
    } catch (e) {
      ticks++;
      // After a stop the pool is closing and its errors are expected.
      if (stopped) return;
      log(`vector mender: the tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    schedule(opts.intervalS * 1000 * backoff);
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
