/**
 * lease.ts — the heartbeat that keeps a worker's leases alive while it works,
 * and the one rule for sizing a lease against it.
 *
 * Shared by the three consumers of migration 015's table — reembed.ts,
 * extract-entities.ts and consolidate.ts — so the rule lives once (SMD-1023).
 * Before migration 031 a lease was stamped per claim and could not be moved,
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
 * refused before anything is claimed (`leaseRefusal`), as is either flag above
 * what the runtime holds: claim_thoughts and renew_claims take an int, so a
 * lease over 2,147,483,647 s would fail every claim on its signature, and a
 * timer holds a 32-bit millisecond count, so a heartbeat over 2,147,483 s
 * would overflow into a beat every millisecond. When no interval is
 * given it is derived from the lease (`heartbeatFor`): 60 s, or a third of the
 * lease when that is shorter, at least one second, so any lease of two seconds
 * or more has a heartbeat that fits and only a one-second lease is refused.
 *
 * What a beat learns. `renew_claims` returns the ids still held. A row the
 * worker thought it held that is not among them is no longer this worker's:
 * reaped (the beats stopped reaching the database for a whole lease), requeued
 * by 016's edit trigger while it waited its turn, or deleted with its claim
 * row. It goes into `lost`, the loop skips it rather than repeating the
 * provider's work, and asks the row which of the three it was (`lostReason`)
 * before naming and counting it — a deleted row is counted with the deleted,
 * not the lost. Two things keep the verdict itself honest. A row the loop
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
import { cleanForDisplay } from "../server-portable/consolidate.ts";

/** The lease when --ttl is not given: 015's default for claim_thoughts. */
export const DEFAULT_TTL_S = 900;
/** The heartbeat when --heartbeat is not given and the lease is long enough for it. */
export const DEFAULT_HEARTBEAT_S = 60;
/** The largest lease claim_thoughts and renew_claims take: their p_ttl_seconds is an int. */
export const MAX_TTL_S = 2147483647;
/** The longest interval a timer holds: a 32-bit signed millisecond count, whole seconds. */
export const MAX_HEARTBEAT_S = 2147483;

/** The heartbeat a lease implies when none is given: 60 s, or a third of the lease when that is shorter, whole seconds, at least one. */
export function heartbeatFor(ttlS: number): number {
  return Math.max(1, Math.min(DEFAULT_HEARTBEAT_S, Math.floor(ttlS / 3)));
}

/**
 * Why a lease and heartbeat pair is refused, or null: the lease must cover two
 * beats, so one missed beat cannot lapse it. `derived` says the heartbeat was
 * not given but taken from the lease, so the text does not quote a flag the
 * operator never passed.
 */
export function leaseRefusal(ttlS: number, heartbeatS: number, derived = false): string | null {
  if (ttlS > MAX_TTL_S) {
    return `--ttl ${ttlS} s is more than claim_thoughts and renew_claims take (an int, at most ${MAX_TTL_S} s): every claim would fail on its signature. Lower --ttl.`;
  }
  if (heartbeatS > MAX_HEARTBEAT_S) {
    return `--heartbeat ${heartbeatS} s is more than a timer can hold (at most ${MAX_HEARTBEAT_S} s, the 32-bit millisecond ceiling): the runtime would beat every millisecond instead. Lower --heartbeat.`;
  }
  if (ttlS >= 2 * heartbeatS) return null;
  return (
    `--ttl ${ttlS} s cannot cover two ${derived ? `beats of the ${heartbeatS} s heartbeat derived from it` : `heartbeats of --heartbeat ${heartbeatS} s`}: one delayed beat would let the lease expire, and another worker\n` +
    `  would repeat rows this one is still working on. The lease is how long a dead worker's rows stay out of the pool, and nothing else\n` +
    `  since migration 031; it need not cover the batch. ${heartbeatS <= 1 ? "Raise --ttl." : "Raise --ttl or lower --heartbeat."}`
  );
}

/** Who holds leases under a key right now, and until when: one row per worker, for --status. */
export type LeaseHolder = { worker_id: string; rows: number; deadline: string };

export async function leaseHolders(sql: SQL, job: string): Promise<LeaseHolder[]> {
  return (await sql`
    SELECT worker_id, count(*)::int AS rows, min(ttl_expires_at)::text AS deadline
      FROM thought_work_claims WHERE work_type = ${job} AND status = 'claimed'
     GROUP BY worker_id ORDER BY worker_id`) as LeaseHolder[];
}

/**
 * The --status line for one holder. The deadline moves on every beat while the
 * holder lives; a dead holder's stands until the reaper. worker_id is text any
 * claimant wrote, so it is cleaned before it reaches a terminal.
 */
export function describeHolder(h: LeaseHolder): string {
  return `    held by ${cleanForDisplay(h.worker_id)}: ${h.rows} rows, earliest lease deadline ${h.deadline} — moved forward on each heartbeat while the holder lives, so a deadline still ahead means it was alive at its last beat; a dead holder's rows return when it passes, or at once with SELECT release_claims_for_worker(job, worker_id), which a live holder would read as a lost lease`;
}

/**
 * What became of a row a beat found no longer this worker's — asked of the
 * row, so the loop names it rightly. `reaped` is the reaper's own verdict: 015
 * marks a row failed at its last allowed expiry WITHOUT changing worker_id, so
 * a failed row still naming this worker was failed by the reaper while this
 * worker held it (the beats stopped reaching the database for a whole lease on
 * its third attempt), not finished by anyone else; --retry-failed returns it.
 */
type LostReason =
  | { kind: "deleted" }
  | { kind: "pending" }
  | { kind: "claimed"; worker: string }
  | { kind: "reaped" }
  | { kind: "finished"; status: string; worker: string };

async function lostReason(sql: SQL, job: string, workerId: string, id: string): Promise<LostReason> {
  const rows = (await sql`SELECT status, worker_id FROM thought_work_claims WHERE thought_id = ${id}::uuid AND work_type = ${job}`) as
    { status: string; worker_id: string | null }[];
  if (rows.length === 0) return { kind: "deleted" };
  const { status, worker_id } = rows[0];
  if (status === "pending") return { kind: "pending" };
  if (status === "claimed") return { kind: "claimed", worker: worker_id ?? "?" };
  if (status === "failed" && worker_id === workerId) return { kind: "reaped" };
  return { kind: "finished", status, worker: worker_id ?? "?" };
}

/**
 * The lost-at-top step the three loops share: ask the row, print the line, say
 * which count the row joins — "deleted" for a deleted thought, "lost" for the
 * rest. A read that fails is printed as such, not thrown: the next row's
 * write or the next claim is where a database gone stops the worker.
 */
export async function reportLost(sql: SQL, job: string, workerId: string, id: string): Promise<"deleted" | "lost"> {
  const why = await lostReason(sql, job, workerId, id).catch(() => null);
  console.error(`  ${id}: ${describeLoss(why)}`);
  return why?.kind === "deleted" ? "deleted" : "lost";
}

/** The line a worker prints for a lost row, from what the row said. Every kind but `deleted` is a row the run did not finish. */
function describeLoss(why: LostReason | null): string {
  if (why === null) return "no longer this worker's, and the row could not be read; skipping";
  switch (why.kind) {
    case "pending": return "back in the pool — reaped after a missed lease, requeued by an edit, or returned by hand with release_claims_for_worker — for a later claim, this run's or the next's; skipping";
    case "claimed": return `another worker (${cleanForDisplay(why.worker)}) holds it now; skipping`;
    case "reaped": return "marked failed by the reaper while this worker held it — its lease had expired for the last allowed time (last_error says so); --retry-failed returns it; skipping";
    case "finished": return `already ${why.status} under ${cleanForDisplay(why.worker)}; skipping`;
    case "deleted": return "deleted while it was leased";
  }
}

export type Heartbeat = {
  /** Ids this worker holds and has not yet released. `claimed()` adds a batch; the loop removes each row before releasing it. */
  held: Set<string>;
  /** A batch the claim returned: into `held`, out of `lost` (the claim is proof the lease is ours again), and any beat in flight is voided. */
  claimed(ids: string[]): void;
  /** Ids a beat found no longer this worker's — reaped, requeued by an edit, or deleted; `lostReason` says which. The loop skips them. */
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
