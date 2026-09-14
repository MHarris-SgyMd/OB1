/**
 * lease.ts — the heartbeat that keeps a worker's leases alive while it works,
 * and the one rule for sizing a lease against it.
 *
 * Shared by the three consumers of migration 015's table — reembed.ts,
 * extract-entities.ts and consolidate.ts — so the rule lives once (SMD-1023).
 * Before migration 030 a lease was stamped per claim and could not be moved,
 * so each worker carried arithmetic of its own to keep a batch inside it:
 * reembed.ts grew its default lease to --batch × the timeout, the other two
 * refused the product above the lease and defaulted to one thought per claim.
 * A heartbeat retires all of it. While a worker holds rows it calls
 * `renew_claims` every --heartbeat seconds, which moves every deadline it holds
 * to now() + --ttl; so the lease has to outlast a MISSED BEAT, not the batch,
 * and --ttl means one thing: how long a dead worker's rows stay out of the
 * pool.
 *
 * The rule: --ttl >= 2 × --heartbeat, so one delayed beat — the event loop
 * busy, a slow round trip — cannot let a lease lapse. A pair that breaks it is
 * refused before anything is claimed (`leaseRefusal`), and when no interval is
 * given it is derived from the lease (`heartbeatFor`): 60 s, or a third of the
 * lease when that is shorter, at least one second, so any lease of two seconds
 * or more has a heartbeat that fits and only a one-second lease is refused.
 *
 * What a beat learns. `renew_claims` returns the ids still held. A row the
 * worker thought it held that is not among them was reaped — the beats stopped
 * for a whole lease, which under a live process means the database was
 * unreachable for that long — and is another worker's now: it goes into
 * `lost`, the loop skips it rather than repeating the provider's work, and the
 * run's summary counts it. Two things keep that reading honest. A row the loop
 * has finished is removed from `held` BEFORE its release is sent, so a beat in
 * flight across a release does not read the release as a loss: a loss is an id
 * that was held when the beat was sent AND is still held when it returns AND
 * was not returned. And a claim made while a beat was in flight voids that
 * beat's verdict: the loop hands every batch to `claimed()`, which bumps a
 * generation the beat compares on return, because an id released and won back
 * inside one round trip would otherwise look lost. `claimed()` also takes the
 * ids out of `lost` — a claim returning an id is proof the lease is this
 * worker's again (016's edit trigger requeues a row mid-extraction, and a
 * near-empty pool hands it straight back), and a row marked lost for ever
 * would be skipped while held, returned by the finally, and reported pending.
 */

import type { SQL } from "bun";

/** The lease when --ttl is not given: 015's default for claim_thoughts. */
export const DEFAULT_TTL_S = 900;
/** The heartbeat when --heartbeat is not given and the lease is long enough for it. */
export const DEFAULT_HEARTBEAT_S = 60;

/** The heartbeat a lease implies when none is given: 60 s, or a third of the lease when that is shorter, whole seconds, at least one. */
export function heartbeatFor(ttlS: number): number {
  return Math.max(1, Math.min(DEFAULT_HEARTBEAT_S, Math.floor(ttlS / 3)));
}

/** Why a lease and heartbeat pair is refused, or null: the lease must cover two beats, so one missed beat cannot lapse it. */
export function leaseRefusal(ttlS: number, heartbeatS: number): string | null {
  if (ttlS >= 2 * heartbeatS) return null;
  return (
    `--ttl ${ttlS} s cannot cover two heartbeats of --heartbeat ${heartbeatS} s: one delayed beat would let the lease expire, and another worker\n` +
    `  would repeat rows this one is still working on. The lease is how long a dead worker's rows stay out of the pool, and nothing else\n` +
    `  since migration 030; it need not cover the batch. ${heartbeatS <= 1 ? "Raise --ttl." : "Raise --ttl or lower --heartbeat."}`
  );
}

export type Heartbeat = {
  /** Ids this worker holds and has not yet released. `claimed()` adds a batch; the loop removes each row before releasing it. */
  held: Set<string>;
  /** A batch the claim returned: into `held`, out of `lost` (the claim is proof the lease is ours again), and any beat in flight is voided. */
  claimed(ids: string[]): void;
  /** Ids a beat found no longer this worker's — reaped and re-leased. The loop skips them. */
  lost: Set<string>;
  /** Beats sent, and the current run of consecutive errors (0 after a beat that answered). */
  beats: number;
  consecutiveErrors: number;
  /** Stop the timer, and void any beat still in flight. Idempotent; the worker's finally calls it before returning the leases. */
  stop(): void;
};

/**
 * Start beating for one worker. One `renew_claims` call every `everyS` seconds
 * while `held` is non-empty; nothing is sent while it is empty, so an idle
 * worker between batches costs nothing. Beats never overlap: a tick that finds
 * one in flight is skipped, and the next carries the deadline forward. The
 * timer is unref'd, so it never holds the process open on its own — the worker
 * stops it in its finally, and a process that exits another way leaves the
 * leases to expire as it would have anyway.
 */
export function startHeartbeat(opts: {
  sql: SQL;
  job: string;
  workerId: string;
  ttlS: number;
  everyS: number;
  /** Called with the ids a beat found lost, once per beat that found any. */
  onLost?: (ids: string[]) => void;
  /** Called on each beat that failed, with the length of the current run of failures (1 on the first). */
  onError?: (e: Error, consecutive: number) => void;
}): Heartbeat {
  const held = new Set<string>();
  const lost = new Set<string>();
  let inFlight = false;
  let stopped = false;
  // Bumped by every claim; a beat whose generation moved while it was in
  // flight draws no verdict (see the header).
  let generation = 0;
  const hb: Heartbeat = {
    held,
    lost,
    beats: 0,
    consecutiveErrors: 0,
    claimed(ids) {
      generation++;
      for (const id of ids) {
        lost.delete(id);
        held.add(id);
      }
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
  const beat = async () => {
    if (inFlight || stopped || held.size === 0) return;
    inFlight = true;
    const sent = [...held];
    const sentAt = generation;
    try {
      hb.beats++;
      const rows = (await opts.sql`SELECT thought_id FROM renew_claims(${opts.job}, ${opts.workerId}, ${opts.ttlS})`) as { thought_id: string }[];
      hb.consecutiveErrors = 0;
      // Stopped meanwhile: the finally is returning the leases, and this beat
      // would read every one of them as lost. Claimed meanwhile: an id may
      // have been released and won back inside this round trip.
      if (stopped || sentAt !== generation) return;
      const still = new Set(rows.map((r) => r.thought_id));
      // Lost: held when the beat was sent, still held now, not renewed. A row
      // released meanwhile left `held` before its release went out, so it is
      // not read as lost.
      const gone = sent.filter((id) => held.has(id) && !still.has(id));
      if (gone.length > 0) {
        for (const id of gone) {
          held.delete(id);
          lost.add(id);
        }
        opts.onLost?.(gone);
      }
    } catch (e) {
      hb.consecutiveErrors++;
      opts.onError?.(e as Error, hb.consecutiveErrors);
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void beat(), Math.max(1, opts.everyS) * 1000);
  timer.unref?.();
  return hb;
}
