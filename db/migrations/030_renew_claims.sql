-- ============================================================================
-- 030 — renew_claims: a heartbeat moves the deadline of every lease a worker
--        holds, so a lease has to outlast a missed beat, not a whole batch
--        (SMD-1023)
--
-- Why
--   015's claim_thoughts stamps one ttl_expires_at per CALL, for every row in
--   the batch, and nothing could move it. So the lease had to outlast the
--   whole batch rather than one thought: the eighth row of a batch of eight is
--   not started until the seven before it finish, and its clock has been
--   running since the claim. 015's header said as much ("the TTL is stamped
--   per claim call, so it has to outlast the whole batch"), and every consumer
--   carried the coupling as arithmetic of its own: reembed.ts grew its default
--   lease to batch × timeout and refused a shorter one; extract-entities.ts
--   and consolidate.ts refused a batch × timeout above the lease and defaulted
--   to one thought per claim so the product stayed small. reembed.ts's header
--   called that arithmetic "a stand-in for per-row lease renewal (SMD-1023)".
--
--   When a batch overran anyway, the next claim_thoughts by any worker
--   returned the unfinished rows to the pool, a second worker took and
--   repeated them (the same provider work twice), the first worker's
--   release_thought returned false, and after three expiries the reaper
--   marked the row failed — a cap written for a thought that kills every
--   worker that touches it, applied to a healthy row that was merely slow.
--
-- What
--   renew_claims(p_work_type, p_worker_id, p_ttl_seconds): every row this
--   worker holds under the key — status claimed, worker_id its own — has its
--   deadline moved to now() + p_ttl_seconds, and the ids of the rows renewed
--   are returned. A worker calls it on a timer while it holds rows (db/lease.ts
--   is the one implementation, shared by the three consumers): every
--   --heartbeat seconds, 60 by default or a third of the lease when that is
--   shorter. The lease's meaning changes with that, and for the better:
--   --ttl is how long a dead worker's rows stay out of the pool, and nothing
--   else. It no longer has anything to do with the batch, the timeout or the
--   number of calls a thought costs.
--
--   The sizing rule that replaces "the TTL must cover the batch": the lease
--   must cover a missed heartbeat, p_ttl_seconds >= 2 × the interval. The
--   consumers refuse a pair that does not (exit 2, the arithmetic shown) and
--   derive the interval from the lease when none is given (a third of it, at
--   most 60 s, at least 1 s), so the default pair — 900 s and 60 s — survives
--   fourteen missed beats, and only a one-second lease has no pair that fits.
--
--   The reaper's cap keeps the meaning 015's header gave it. Under a
--   heartbeating worker a lease expires only when the beats stop for the whole
--   lease: the process died, or lost the database for that long. A row that
--   expired three times is one whose worker died three times on it, not one
--   that was slow.
--
-- What it does not touch
--   claim_thoughts is not redefined; the claim stays one locking pass over the
--   pending index and the reaper stays its first statement, as 015 wrote them
--   (db/test-schema.ts [29] asserts 015 is still the last file to define it,
--   and db/test-live.ts [8a] and [8b] still hold the concurrent claims
--   disjoint). release_thought and release_claims_for_worker are untouched;
--   028's comments on last_error and release_thought stand as applied.
--   Upstream (schemas/thought-work-claims) left mid-batch renewal out to keep
--   the claim a single atomic statement; a separate function keeps that.
--
-- The rules of a renewal
--   * Only the holder's rows, and only while claimed. A pending row, a
--     terminal row, and a row another worker holds are not this worker's to
--     renew, and are not returned. A worker id that holds nothing renews
--     nothing; a name that names no worker is not an error.
--   * A deadline never moves backward. The new deadline is the later of the
--     row's current one and now() + p_ttl_seconds, so a beat made with a
--     shorter lease than the claim's leaves the row where it was.
--   * A lease past its deadline that no claim has yet reaped is still the
--     holder's, and is renewed: the reaper runs at the start of every
--     claim_thoughts call and nowhere else, and until it runs the row's status
--     is claimed and its worker_id is this worker. A renewal and a reaper that
--     reach the same row at the same moment contend on the row lock; the loser
--     re-evaluates its predicate on the winner's version under READ COMMITTED,
--     so the row ends either renewed and held (the reaper saw a deadline in
--     the future) or pending and unrenewed (the renewal saw a status that was
--     not claimed), never both.
--   * The ids returned are the rows still held. A row of the worker's batch
--     that is NOT among them was reaped and, in all likelihood, re-leased to
--     another worker: the consumer skips it rather than repeating the
--     provider's work, and its release, had it been attempted, would have
--     returned false as 015 says.
--   * An empty worker id and a non-positive lease are refused as claim_thoughts
--     refuses them: a lease of zero would stamp the rows already expired.
--
-- Cost
--   One statement per beat per worker, planned through
--   thought_work_claims_worker_idx — 015's partial index over the rows in
--   flight, keyed by worker_id — then filtered to the key: the rows a worker
--   holds are its batch, a handful, whatever the size of the pass. At the
--   default interval that is one small UPDATE a minute per worker against
--   provider calls of seconds to minutes. db/test-live.ts [8e] asserts the
--   plan reads that index and prints the round trip.
--
-- Safety
--   * Additive: one function, one column comment. `thoughts` gains no columns
--     and loses none; thought_work_claims gains none.
--   * No DELETE in this file. A renewal is an UPDATE of one column.
--   * Idempotent: CREATE OR REPLACE, and COMMENT ON replaces.
--
-- Prerequisites
--   Migration 015. Applied by `bun db/migrate.ts`.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- renew_claims — the heartbeat
--
-- Every lease this worker holds under the key is moved to now() + the lease,
-- never backward; the ids renewed are returned. See the header for the rules
-- and the race with the reaper.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION renew_claims(
  p_work_type   text,
  p_worker_id   text,
  p_ttl_seconds int DEFAULT 900
)
RETURNS TABLE (thought_id uuid)
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'renew_claims: p_worker_id must identify the worker';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 THEN
    RAISE EXCEPTION 'renew_claims: p_ttl_seconds must be positive, got %', p_ttl_seconds;
  END IF;

  RETURN QUERY
  UPDATE thought_work_claims c
     SET ttl_expires_at = GREATEST(c.ttl_expires_at, now() + make_interval(secs => p_ttl_seconds))
   WHERE c.work_type = p_work_type
     AND c.worker_id = p_worker_id
     AND c.status    = 'claimed'
  RETURNING c.thought_id;
END;
$$;

COMMENT ON FUNCTION renew_claims(text, text, int) IS
  'The heartbeat: move the deadline of every lease this worker holds under the work_type to now() plus p_ttl_seconds, never backward, and return the ids renewed. Only claimed rows whose worker_id is p_worker_id; a row of the caller''s batch not returned was reaped by a claim and is another worker''s now. Does not touch the claim statement (claim_thoughts is 015''s as applied).';

COMMENT ON COLUMN thought_work_claims.ttl_expires_at IS
  'The lease''s deadline while status is claimed, NULL otherwise (the CHECK keeps the two in step). Stamped by claim_thoughts at now() plus its p_ttl_seconds and moved forward by renew_claims on each heartbeat; a claim_thoughts call by any worker returns a row past it to the pool, or marks it failed at p_max_attempts. Since 030 the lease has to outlast a missed heartbeat, not a batch: it is how long a dead worker''s rows stay out of the pool.';
