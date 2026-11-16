/**
 * The claim workers' loop (SMD-4308): one worker of a pass, from its first
 * claim to the return of its leases. consolidate.ts and extract-entities.ts
 * each held a copy of it around their own work on a thought; here it is once,
 * and each engine passes what is its own — how its rows are read, and what it
 * does with one.
 *
 * What the loop holds: the worker's id and its heartbeat (db/lease.ts), the
 * admit gate before each claim, --limit's count of what is taken and being
 * claimed, the claim itself, the row a beat found no longer this worker's, and
 * the finally that returns what is still held. What a thought's processing
 * does with a provider's error, and how its claim is released, is still each
 * engine's.
 *
 * The engine's state is read where the loop needs it, not copied: a flag that
 * changes under a running worker — the stop, the hard stop, the pass's gate,
 * whether the pass retries the last outage's suspects — is given as a function,
 * and a count the engine reports is told through `count`.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { SQL } from "bun";
import { admitted, reportLost, setFront, startHeartbeat, type Admit, type Heartbeat } from "./lease.ts";
import { followClassify, type ProviderOutage, type Unreturned } from "./worker-bootstrap.ts";

/** A row of claim_thoughts: the thought, and which attempt at it this claim is. */
export type Claimed = { thought_id: string; attempt: number };

/** What the loop hands an engine with each claimed thought. */
export type ClaimHand = {
  workerId: string;
  hb: Heartbeat;
  /**
   * A suspect of this follower's outage handed back at the pool's front (SMD-2641, review pass 1), out of the
   * heartbeat's set first; the database refusing it, the finally returns it with this worker's leases, where it stood.
   * Handed back, it leaves --limit's `taken`, as a set-back does: the finally gives back only the rows still held
   * (review pass 2: a --limit follower ended at its limit, its suspects never retried).
   */
  backFirst: (id: string) => Promise<void>;
  /** When the batch's rows were read (performance.now()): each thought's first `asked` (SMD-3379 PR 1c-3a, review pass 1). */
  readAt: number;
};

export type ClaimWorkerOptions<Row extends { id: string }> = {
  sql: SQL;
  job: string;
  /** The worker id's first word: the engine's name. */
  prefix: string;
  /** Which of the pass's workers this is. */
  n: number;
  ttlS: number;
  heartbeatS: number;
  batch: number;
  /** --limit, 0 for none. */
  limit: number;
  follow: boolean;
  admit: Admit | undefined;
  /** The pass's gate signal, read at each wait: a pass makes its own. */
  gate: () => AbortSignal;
  err: (line: string) => void;
  /** The Writer's err for a line written on a timer or an event, where a throw has no caller. */
  errAside: (line: string) => void;
  stopping: () => boolean;
  hardStopped: () => boolean;
  outage: ProviderOutage;
  /** This pass retries the last outage's suspects (SMD-2641): one thought a claim. */
  isolated: () => boolean;
  /** The isolated pass has none left to retry: the next pass is polled at once. */
  pollNow: () => void;
  /** --limit's thoughts taken, shared by the pass's workers. */
  taken: Set<string>;
  /** --limit's claims in flight, shared by the pass's workers. */
  claiming: { n: number };
  /** Whether --limit is met by what is taken and being claimed: the engine's rule, which its pass reads too. */
  limitReached: () => boolean;
  activeWorkers: Set<string>;
  unreturned: Unreturned;
  inCall: { end(workerId: string): void };
  count: { lost(): void; vanished(): void; beats(n: number): void };
  /** The claimed thoughts' rows, as the engine reads them; one missing was deleted since its claim. */
  readRows: (ids: string[]) => Promise<Row[]>;
  /** The engine's work on one claimed thought, its release included: "stop" ends this worker, "next" goes on. */
  row: (b: Claimed, row: Row | undefined, hand: ClaimHand) => Promise<"stop" | "next">;
  /** First in the finally, before anything is returned. */
  finallyFirst?: (workerId: string) => void;
  /** In the finally, before the worker's leases are returned. */
  beforeReturn?: (workerId: string) => Promise<void>;
};

/** One worker of a pass: claims until a stop, an outage, --limit or an empty pool, and returns what it still holds. */
export async function claimWorker<Row extends { id: string }>(o: ClaimWorkerOptions<Row>): Promise<void> {
  const { sql, err, errAside, outage, taken, claiming, limitReached } = o;
  const JOB = o.job;
  const TTL = o.ttlS;
  const LIMIT = o.limit;
  const workerId = `${o.prefix}-${hostname()}-${process.pid}-${o.n}-${randomUUID().slice(0, 8)}`;
  o.activeWorkers.add(workerId);
  const hb = startHeartbeat({
    sql, job: JOB, workerId, ttlS: TTL, everyS: o.heartbeatS,
    onLost: (ids) => { if (!o.hardStopped()) errAside(`  ${workerId}: ${ids.length} row(s) no longer this worker's at the last beat — reaped, requeued by an edit, or deleted; each is named as the loop reaches it, or at its release if it was the row in hand`); },
    onError: (e, consecutive) => { if (consecutive === 1) errAside(`  ${workerId}: heartbeat failed (${e.message}); the leases hold ${TTL} s from the last beat that reached the database`); },
  });
  const backFirst = async (id: string): Promise<void> => {
    hb.held.delete(id);
    const back = await setFront(sql, JOB, workerId, id).catch(() => null);
    if (back === null) hb.held.add(id);
    else if (back && LIMIT > 0) taken.delete(id);
  };
  try {
    while (!o.stopping() && outage.reason === null && !limitReached()) {
      // The last outage's suspects all retried (SMD-2641): the isolated pass ends, the next polled at once with every worker.
      if (o.isolated() && !outage.isolating()) {
        o.pollNow();
        return;
      }
      // The admit gate before each claim (SMD-3379 PR 1b): a worker waits
      // here holding no claim, and a stop while it waits ends it.
      if (o.admit) {
        if (!(await admitted(o.admit, o.gate()))) return;
        if (o.stopping() || outage.reason !== null || limitReached()) return;
      }
      let batch: Claimed[];
      let byId: Map<string, Row>;
      let readAt = 0;
      try {
        const room = LIMIT > 0 ? LIMIT - taken.size - claiming.n : o.batch;
        if (room <= 0) return;
        const want = Math.min(o.isolated() ? 1 : o.batch, room);
        claiming.n += want;
        try {
          batch = (await sql`
            SELECT thought_id, attempt FROM claim_thoughts(${JOB}, ${workerId}, ${want}, ${TTL})`) as Claimed[];
        } finally {
          claiming.n -= want;
        }
        // Tracked under --limit only: a follower without one runs for months (review pass 4).
        if (LIMIT > 0) for (const b of batch) taken.add(b.thought_id);
        if (batch.length === 0) return;
        // A thought no suspect, its suspects at the pool's front: none is left there to retry (review pass 1).
        if (o.isolated()) for (const b of batch) outage.claimed(b.thought_id);
        const ids = batch.map((b) => b.thought_id);
        hb.claimed(ids);
        readAt = performance.now();
        const rows = await o.readRows(ids);
        byId = new Map(rows.map((r) => [r.id, r]));
      } catch (e) {
        // A follower outlasts the database going away; the end — a function
        // missing, a grant revoked, a statement cancelled or past its
        // statement_timeout — ends the run, as the pass's own errors do
        // (review pass 3) and as re-embed's claim does (followClassify's
        // db-end, SMD-2636 PR 4: a timeout here cost the poll, every poll,
        // the sleep scheduler's budget never told); a passing one — a
        // serialization failure, a lock — costs this worker its poll (review pass 4).
        if (o.follow && followClassify(e) === "db-end") throw e;
        err(`  ${workerId}: ${(e as Error).message} — this worker stops`);
        return;
      }
      for (const b of batch) {
        if (o.stopping() || outage.reason !== null) return;
        if (hb.lost.has(b.thought_id)) {
          // A beat found this row no longer ours. Nothing to release, and
          // repeating the provider's work would only race the holder; the row
          // says why (db/lease.ts reportLost), and which count it joins.
          if ((await reportLost(sql, JOB, workerId, b.thought_id, err)) === "deleted") o.count.vanished();
          else o.count.lost();
          continue;
        }
        if ((await o.row(b, byId.get(b.thought_id), { workerId, hb, backFirst, readAt })) === "stop") return;
      }
    }
  } finally {
    o.finallyFirst?.(workerId);
    o.inCall.end(workerId);
    hb.stop();
    o.count.beats(hb.beats);
    // Rows still held are handed back unfinished: out of --limit's count
    // before the release goes out, so another worker's claim of one counts it.
    for (const id of hb.held) taken.delete(id);
    let freed = 0;
    if (o.beforeReturn) await o.beforeReturn(workerId);
    try {
      [{ n: freed }] = await sql`SELECT release_claims_for_worker(${JOB}, ${workerId}) AS n`;
    } catch (e) {
      // A follower returns them once the database answers again (SMD-2599).
      if (o.follow) o.unreturned.add(workerId);
      err(`  ${workerId}: could not return its leases (${(e as Error).message}); they expire within ${TTL} s${o.follow ? ", or return when the database answers again" : ""}`);
    }
    o.activeWorkers.delete(workerId);
    // Outside the release's try: a Writer's throw here is the Writer's, not a
    // lease left unreturned.
    if (freed > 0 && !o.follow) err(`  ${workerId}: returned ${freed} unfinished row(s) to the pool`);
  }
}
