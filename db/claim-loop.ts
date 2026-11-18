/**
 * The claim workers' loop (SMD-4308): one worker of a pass, from its first
 * claim to the return of its leases. consolidate.ts, extract-entities.ts and
 * reembed.ts each held a copy of it around their own work on a thought; here
 * it is once, and each engine passes what is its own — how its rows are read,
 * and what it does with one.
 *
 * What the loop holds: the worker's id and its heartbeat (db/lease.ts), the
 * admit gate before each claim, --limit's count of what is taken and being
 * claimed, the claim itself, the row a beat found no longer this worker's, and
 * the finally that returns what is still held; and, for the thought in hand,
 * what an error its call threw means (thoughtFault), the record of a
 * failure the worker stops after (recordFailedAndStop), the set-back of a
 * call its caller aborted (setBackAborted) and the release of a finished
 * claim with what it finds (releaseFinished). The release statement itself,
 * and each engine's own exceptions, are still the engine's. Re-embed takes
 * the loop and the set-back alone: its reading of an embedding call's error
 * has no pauses and a probe its caller can abort, and its release says and
 * counts three things the claim passes' does not.
 *
 * The engine's state is read where the loop needs it, not copied: a flag that
 * changes under a running worker — the stop, the hard stop, the pass's gate,
 * whether the pass retries the last outage's suspects — is given as a function,
 * and a count the engine reports is told through `count`.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { SQL } from "bun";
import { PROVIDER_ERROR_CHARS } from "../server-portable/embed.ts";
import { admitted, idleWhile, reportLost, setBack, setFront, sleepUnless, startHeartbeat, type Admit, type Heartbeat, type InHandCall } from "./lease.ts";
import { ALONE_OUTAGES, databaseUnavailable, followClassify, isOut, probedFault, TRANSIENT_PAUSES_MS, type FollowerFault, type Probe, type ProviderOutage, type Unreturned } from "./worker-bootstrap.ts";

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
  /** After a wait at the admit gate, an engine's own reason to end this worker beside the loop's (re-embed: the record's model moved). */
  afterGate?: () => boolean;
  /** Before each claim, inside the claim's own error handling: true ends this worker with nothing claimed (re-embed's follower reads the record's model). */
  beforeClaim?: () => Promise<boolean>;
  /** Where an engine's return of its leases differs from the claim passes' (re-embed's). */
  leaseReturn?: {
    /** The line for a return the database refused, in place of the loop's. */
    refusedLine?: (workerId: string, message: string) => string;
    /** Whether a return that freed rows is said: the loop says it for a one-shot run alone. */
    saysReturned?: boolean;
    /** The worker leaves the pass's active set whatever the Writer does with the refusal's line. */
    inactiveWhateverTheWriter?: boolean;
  };
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
        if (o.stopping() || outage.reason !== null || limitReached() || o.afterGate?.()) return;
      }
      let batch: Claimed[];
      let byId: Map<string, Row>;
      let readAt = 0;
      try {
        if (o.beforeClaim && (await o.beforeClaim())) return;
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
      const message = (e as Error).message;
      err(o.leaseReturn?.refusedLine?.(workerId, message) ?? `  ${workerId}: could not return its leases (${message}); they expire within ${TTL} s${o.follow ? ", or return when the database answers again" : ""}`);
    } finally {
      if (o.leaseReturn?.inactiveWhateverTheWriter) o.activeWorkers.delete(workerId);
    }
    o.activeWorkers.delete(workerId);
    // Outside the release's try: a Writer's throw here is the Writer's, not a
    // lease left unreturned.
    if (freed > 0 && (o.leaseReturn?.saysReturned ?? !o.follow)) err(`  ${workerId}: returned ${freed} unfinished row(s) to the pool`);
  }
}

/** What an engine gives the loop to read a provider's error with: its own state where it is read, and where the two engines differ. */
export type FaultHost = {
  sql: SQL;
  job: string;
  follow: boolean;
  err: (line: string) => void;
  outage: ProviderOutage;
  /** The pass's halt, read at each use: a pass makes its own. */
  halt: () => AbortController;
  stopping: () => boolean;
  hardStopped: () => boolean;
  inCall: { get(workerId: string): InHandCall | undefined };
  /**
   * What to do with the error. Under --follow it is worker-bootstrap.ts's `fault` (SMD-2636 PR 3a), with the engine's
   * own reading of a refused request and of a missing model; a run without --follow keeps classifyError's rules.
   */
  read: (e: unknown) => FollowerFault;
  /** The one-token call that decides what no rule reads, on the model the error's call was made to, given the call's whole timeout. */
  probe: (e: unknown) => Promise<Probe>;
  /** Whether a probe after this error already found no answer (consolidation's ProviderDown): a suspect alone is blamed on it, not probed twice (SMD-2641). */
  probedOut?: (e: unknown) => boolean;
  /** A probe refused the request: the engine notes whose refusal it was, for its closing remedy. */
  onProbeRefused?: (p: Probe) => void;
  /** An outage begins at this error, the worker's count of them already told; `begins`: no outage stood when it was read. */
  onOutage?: (e: unknown, begins: boolean) => void;
  /** The provider refuses the request itself: the engine keeps what to fix and stops every worker. */
  fatal: (e: unknown, configError: string) => void;
  /** A pause on the provider ended. */
  onPaused?: (workerId: string) => void;
  count: { providerStop(): void; failed(): void; lost(): void };
  /** The pauses before a failing provider is an outage (TRANSIENT_PAUSES_MS); a suite's own, to run them without the wall clock. */
  pausesMs?: readonly number[];
};

/** The thought a streak of calls is for, and what the streak has learnt. */
export type FaultThought = {
  id: string;
  workerId: string;
  /** How many calls of this streak have failed before this one. */
  attempt: number;
  /**
   * Whether any error in this thought's streak could be its own (`fault`'s suspect): the streak's, not its last
   * error's — a call that crashes the provider and then meets a gateway's 503 while it restarts is still the suspect
   * (SMD-3311 review pass 5; after the subject sweep's streakPoison, which reads the streak's first error alone).
   */
  streak: { suspect: boolean };
  backFirst: (id: string) => Promise<void>;
};

/** What the worker does next: stop, the thought back in the pool; call again; or the thought failed, the worker stopping after it or not. */
export type FaultTurn = { then: "stop" } | { then: "again" } | { then: "failed"; error: string; stopAfter: boolean };

/**
 * What a thought's processing does with an error its call threw (SMD-4308; consolidate.ts and extract-entities.ts each
 * held a copy): the database's first, then the provider's. Throws the database's end, for the follower to end on.
 */
export async function thoughtFault(o: FaultHost, t: FaultThought, e: unknown): Promise<FaultTurn> {
  const { err, outage } = o;
  const { id, workerId, attempt, streak } = t;
  const pauses = o.pausesMs ?? TRANSIENT_PAUSES_MS;
  const STOP: FaultTurn = { then: "stop" };
  /**
   * Another worker's outage halted this thought's streak mid-pause (SMD-2641): a suspect of that outage too when
   * the streak could be its own — a crash meets every call in flight, and whose pauses end first, beginning the
   * outage, is a race — so it is retried alone after it, not beside the rest, and says so (review pass 3). Not on
   * a stopping pass.
   */
  const joinHalted = async (): Promise<void> => {
    if (o.stopping() || outage.reason === null || !streak.suspect) return;
    outage.begin(outage.reason, id);
    await t.backFirst(id);
    err(`  ${workerId}: ${id} was pausing on the provider when it stopped answering — a suspect of the outage too, back in the pool unrecorded`);
  };
  // The database went away under the thought: not the thought's, so
  // nothing is recorded; the worker ends, and the follower waits
  // for the database before its next pass (SMD-2599).
  if (o.follow && databaseUnavailable(e)) {
    err(`  ${workerId}: the database is not answering (${(e as Error).message}) — this worker stops, recording nothing for ${id}`);
    return STOP;
  }
  // Any other database error in the thought's processing — its reads and its writes — is read as re-embed's is
  // (followClassify, SMD-2636 PR 4): the end — a privilege or a function gone, a statement cancelled or past its
  // statement_timeout — ends the follower, its row failed, the error thrown for the sleep scheduler's budget to read; a
  // moment's — a deadlock, a lock not available, resources, a read-only transaction — sends the thought back
  // unrecorded, what it wrote so far standing, and stops this worker; any other — a function's own guard, the
  // thought's data — is the thought's, recorded failed below (`fault` reads it so). Before, every one was the thought's.
  // Not past the hard stop, which abandons the thought: a write cancelled with it — the sleep scheduler's migration
  // stop hard-stops the passes and cancels their statements waiting on a lock, 57014 — is no end (review pass 1).
  const dbVerdict = o.follow && !o.hardStopped() ? followClassify(e) : null;
  if (dbVerdict === "db-end") throw e;
  if (dbVerdict === "db-moment") {
    err(`  ${workerId}: the write met the database's moment (${(e as Error).message.split("\n")[0]}) — ${id} goes back to the pool unrecorded`);
    return STOP;
  }
  const msg = (e as Error).message.slice(0, PROVIDER_ERROR_CHARS);
  const read = o.read(e);
  let act = read.act;
  streak.suspect ||= read.suspect;
  // The probe decides — a deadline with no answer, a 4xx no rule reads — given the call's whole
  // timeout, as a model busy with another worker's call may need it: answered, the thought's;
  // refused, the request's; no answer, the provider's. A stopping pass hands the thought back,
  // and another worker's outage is joined unprobed (review pass 1).
  let probeWhy: string | null = null;
  /** The probe answered: the thought's, and said so, so an operator reads why it failed and that a retry revisits it (review pass 3). */
  let probeAnswered = false;
  /** A probe after this error found no answer — that one, or the engine's own before it threw: a suspect alone is blamed on it, not probed twice (SMD-2641). */
  let probedOut = o.probedOut?.(e) ?? false;
  if (act === "probe") {
    if (o.stopping()) return STOP;
    if (outage.reason !== null) act = "outage";
    else {
      const p = await o.probe(e);
      act = probedFault(p);
      probeAnswered = p.state === "up";
      probedOut = isOut(p);
      // The refusal is the probe's, said beside the call's (review pass 2).
      if (p.state === "refused") {
        o.onProbeRefused?.(p);
        probeWhy = p.why;
      }
    }
  }
  let down = o.follow && (act === "outage" || (act === "pause" && attempt >= pauses.length));
  const begins = outage.reason === null;
  // A suspect retried alone that errs again (SMD-2641): blamed only on a probe made at once, or the one
  // just made — answered, the provider up while this thought fails, its own; refused, the request's; no
  // answer, an outage it was alone at, and at the ALONE_OUTAGES-th its own.
  let blamed: "outage" | "answered" | "alone" | null = null;
  if (down && !o.stopping() && streak.suspect && outage.blames(id)) {
    const p = probedOut ? null : await o.probe(e);
    if (p?.state === "refused") {
      o.onProbeRefused?.(p);
      act = "fatal";
      probeWhy = p.why;
      down = false;
    } else if (!o.stopping()) blamed = outage.blame(id, msg, p?.state === "up");
  }
  if (down) {
    // On a stopping pass the thought goes back to the pool, as a transient's does.
    if (o.stopping()) return STOP;
    if ((blamed ?? outage.begin(msg, streak.suspect ? id : undefined)) === "outage") {
      o.count.providerStop();
      o.onOutage?.(e, begins);
      o.halt().abort();
      const alone = blamed === "outage" && outage.aloneAt(id) > 0 ? ` — alone in flight, the one-token call after it unanswered (${outage.aloneAt(id)} of ${ALONE_OUTAGES} before it is recorded failed)` : "";
      err(`  ${workerId}: the provider is not answering (${msg.slice(0, 160)}) — ${id} goes back to the pool unrecorded${alone}, and the follower waits for the provider`);
      // A suspect goes back at the pool's front, for the isolated pass to claim first (review pass 1).
      if (streak.suspect) await t.backFirst(id);
      return STOP;
    }
    // Isolated, `begin` never says "thought": only the blame says whose.
    if (blamed !== "alone") {
      return { then: "failed", error: `provider error again with this thought alone in flight, and a one-token call right after answered, so this thought's: ${msg} (--retry-failed revisits it)`, stopAfter: false };
    }
    // Its own, and the provider not answering all the same: the outage begins, no suspect made, and
    // this worker stops after recording it. A thought's doing all the same (ProviderOutage's byThought, SMD-4254).
    outage.begin(msg, undefined, true);
    o.count.providerStop();
    o.halt().abort();
    return { then: "failed", error: `provider error again with this thought alone in flight at ${ALONE_OUTAGES} outages, the one-token call after each unanswered, so this thought's: ${msg} (--retry-failed revisits it)`, stopAfter: true };
  }
  if (act === "thought") {
    return { then: "failed", error: probeAnswered ? `${msg} (a one-token call right after answered, so this thought's; --retry-failed revisits it)` : msg, stopAfter: false };
  }
  if (act === "fatal") {
    // Every thought would fail the same way. Stop everyone, mark
    // nothing, and say what to fix; this row goes back with the
    // leases the finally returns.
    o.fatal(e, probeWhy === null ? msg : `a one-token call was refused (${probeWhy.slice(0, 160)}), right after ${msg}`);
    err(`  ${workerId}: the provider refuses the request itself (${msg.slice(0, 160)}) — stopping every worker; nothing is marked failed`);
    return STOP;
  }
  if (o.stopping() || outage.reason !== null) {
    // A transient error on a stopping pass, or one another worker's
    // outage has halted: neither called again nor recorded failed —
    // the thought goes back to the pool with the leases the finally
    // returns (SMD-2401, SMD-2599); one whose streak could be its own
    // joins the outage as its suspect (SMD-2641).
    await joinHalted();
    return STOP;
  }
  if (attempt < pauses.length) {
    err(`  ${workerId}: provider unavailable (${msg.slice(0, 120)}); pausing ${pauses[attempt] / 1000} s`);
    // A first stop wakes the pause too, and the thought goes back
    // the same way: main slept the pause out, called again, and
    // recorded the thought failed "after 3 retries" after one (SMD-2401).
    // So does another worker's outage (SMD-2599).
    // No call in hand while it pauses, and the next call's time starts after it (SMD-3379 PR 1b-2, review pass 1).
    await idleWhile(o.inCall.get(workerId), sleepUnless(pauses[attempt], o.halt().signal));
    o.onPaused?.(workerId);
    if (o.stopping() || outage.reason !== null) {
      await joinHalted();
      return STOP;
    }
    return { then: "again" };
  }
  // Still failing after the pauses. This row is recorded failed
  // with the error — if the provider is down it is one row per
  // worker, and if this thought is what draws the error every
  // time it is now visible instead of cycling for ever — and the
  // worker stops, its other leases going back to the pool.
  return { then: "failed", error: `provider error after ${attempt} retries: ${msg}`, stopAfter: true };
}

/**
 * A thought failed by a provider still failing: its failure recorded, and said, before the worker stops (SMD-4308; the
 * engines each held a copy). The caller stops the worker whatever this finds.
 */
export async function recordFailedAndStop(o: FaultHost, t: {
  id: string;
  workerId: string;
  hb: Heartbeat;
  error: string;
  /** The database kept the record from being made: what the engine counted for the thought is taken back. */
  unrecorded?: () => void;
}): Promise<void> {
  const { sql, err } = o;
  const { id, workerId, hb } = t;
  hb.held.delete(id);
  let recorded = false;
  try {
    const rows = (await sql`SELECT release_thought(${id}::uuid, ${o.job}, ${workerId}, 'failed', ${t.error}) AS ok`) as { ok: boolean }[];
    recorded = rows[0]?.ok === true;
  } catch (e) {
    // The database went away under the failure's record: nothing is
    // recorded, the row is this worker's again for the finally to
    // return, and it is not counted lost (review pass 3).
    if (o.follow && databaseUnavailable(e)) {
      hb.held.add(id);
      t.unrecorded?.();
      err(`  ${workerId}: the database is not answering (${(e as Error).message}) — recording nothing for ${id}; it returns to the pool when the database answers`);
      return;
    }
    err(`  ${id}: could not record the failure (${(e as Error).message})`);
  }
  if (recorded) {
    o.count.failed();
    // A suspect no longer once its failure is recorded — not before,
    // so one the database kept from its record stays one (review pass 4).
    o.outage.settled(id);
  }
  // The hard stop's release beat this one: the caller's own stop, not a lapse (SMD-2425).
  else if (o.hardStopped()) return;
  else {
    // Not ours to record: the lease lapsed during the pauses, or the
    // row was returned by hand. Counted with the rows this worker lost.
    o.count.lost();
    err(`  ${id}: the claim was no longer this worker's at release; the failure below was not recorded`);
  }
  // Said once the record is settled, not before (review pass 4).
  err(`  ${workerId}: provider still failing — this worker stops after this thought; ${o.follow ? "the next poll goes on" : "re-run when it is back"}`);
  err(`  ${id}: ${t.error}`);
}

/** What an engine gives the loop to hand a claim back or finish it with: its own state where it is read. */
export type ReleaseHost = {
  sql: SQL;
  job: string;
  follow: boolean;
  err: (line: string) => void;
  hardStopped: () => boolean;
  outage: ProviderOutage;
  /** --limit, 0 for none, and its thoughts taken. */
  limit: number;
  taken: Set<string>;
  count: { failed(): void; lost(): void; vanished(): void };
  /** The pass's progress line, after a thought is settled. */
  progress: () => void;
};

/**
 * The pass's caller aborted the call in hand (abortInHand): the thought to the back of the queue, what it wrote so far
 * standing, and the worker goes on with its next claim (SMD-3379 PR 1b-2; SMD-4308: the engines each held a copy).
 * "stop" when the database refuses the set-back: the claim is left for the finally's release. `gone`: not ours to set
 * back — deleted, or edited or reaped meanwhile — and said so (review pass 1). `call` names the call in the line.
 */
export async function setBackAborted(o: ReleaseHost, t: { id: string; workerId: string; hb: Heartbeat }, call: string): Promise<"stop" | { gone?: "deleted" | "lost" }> {
  const { id, workerId, hb } = t;
  hb.held.delete(id);
  let back: boolean;
  try {
    back = await setBack(o.sql, o.job, workerId, id);
  } catch (re) {
    hb.held.add(id);
    o.err(`  ${workerId}: could not set ${id} back in the queue after its ${call} was aborted (${(re as Error).message}) — this worker stops, returning it with its leases`);
    return "stop";
  }
  if (back && o.limit > 0) o.taken.delete(id);
  return back ? {} : { gone: await reportLost(o.sql, o.job, workerId, id, o.err) };
}

/**
 * The release of a thought the engine finished, succeeded or failed, and what the release found (SMD-4308: the engines
 * each held a copy). The thought is out of the heartbeat's set already. "stop" ends the worker; "next" goes on.
 */
export async function releaseFinished(o: ReleaseHost, t: { id: string; workerId: string; hb: Heartbeat }, f: {
  /** The engine's release statement: whether the claim was still this worker's. */
  release: () => Promise<boolean>;
  /** The thought's error when it failed, null when it succeeded. */
  failed: string | null;
  /** What the engine does to a thought, for "deleted while it was being …". */
  doing: string;
  /** Why a claim may be no longer this worker's at release, as the engine knows them. */
  lapsedWhy: string;
  /** The engine's counts of a thought finished. */
  succeeded: () => void;
}): Promise<"stop" | "next"> {
  const { sql, err } = o;
  const { id, hb } = t;
  let ok: boolean;
  let gone = false;
  try {
    ok = await f.release();
    if (!ok) {
      const [{ exists }] = await sql`SELECT EXISTS (SELECT 1 FROM thoughts WHERE id = ${id}::uuid) AS exists`;
      gone = !exists;
    }
  } catch (e) {
    // The database went away under the release: the row is this
    // worker's again, for the finally to return and --limit to give
    // back (review pass 4).
    if (o.follow && databaseUnavailable(e)) hb.held.add(id);
    err(`  ${id}: could not release the claim (${(e as Error).message}) — this worker stops`);
    return "stop";
  }
  if (gone) {
    o.count.vanished();
    err(`  ${id}: deleted while it was being ${f.doing}`);
    return "next";
  }
  if (!ok) {
    // The hard stop's release beat this one to the row: not a lapse to
    // report, the caller's own stop; a release that went through first
    // is counted below as any is — as reembed's (SMD-2425).
    if (o.hardStopped()) return "stop";
    // Not ours to finish: counted with the rows this worker lost, not
    // the ones it finished, so the workers' summaries add up.
    err(`  ${id}: the claim was no longer this worker's at release — ${f.lapsedWhy}; the row is the pool's or another worker's now`);
    if (f.failed !== null) err(`  ${id}: ${f.failed} (not recorded — the row was not this worker's)`);
    o.count.lost();
    o.progress();
    return "next";
  }
  if (f.failed !== null) {
    o.count.failed();
    err(`  ${id}: ${f.failed}`);
  } else {
    f.succeeded();
  }
  o.outage.settled(id);
  o.progress();
  return "next";
}
