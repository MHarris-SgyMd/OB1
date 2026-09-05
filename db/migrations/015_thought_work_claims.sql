-- ============================================================================
-- 015 — thought_work_claims: a lease per thought, so parallel workers never
--        process the same thought twice
--
-- Why
--   Every bulk pass over the corpus has been single-threaded or racy, with no
--   third option. Two workers that both SELECT the next batch of unprocessed
--   thoughts pick overlapping rows: at best they duplicate the work, at worst
--   they write conflicting results into the same row. And a script that walks
--   the table once, with no record of where it got to, cannot be resumed after
--   it dies halfway.
--
--   This is not hypothetical here. Changing the embedding model means
--   re-embedding every thought (db/config.mjs says so; migration 006 records
--   the model so preflight can refuse a mismatch), and until now the answer to
--   "how" was a script you write, run once, and hope survives. The same shape
--   is waiting for entity extraction (SMD-947), a chunk-context backfill
--   (migration 013's header defers to this migration by name), and the
--   whole-content vector upgrade that change 27 left to re-capture.
--
-- Ported from schemas/thought-work-claims. Four departures, each a reason:
--
--   1. THE DATABASE PICKS THE BATCH. Upstream's claim_thoughts takes an array
--      of candidate ids the WORKER chose with its own query and returns the
--      subset it won. That claim is race-safe — the (thought_id, work_type)
--      primary key and INSERT ... ON CONFLICT DO NOTHING let exactly one
--      inserter win — but every worker selects from the same newest page, so
--      the losers get an empty result and back off; upstream's README lists
--      "workers keep backing off" under Troubleshooting. Here the pool lives in
--      this table (enqueue_thoughts), and claim_thoughts takes the next batch
--      itself with SELECT ... FOR UPDATE SKIP LOCKED. A worker's candidate rows
--      are locked for the duration of the claiming statement, so a concurrent
--      worker skips them instead of waiting on them or colliding with them,
--      and the two return disjoint sets whatever their timing. Two things do
--      the work and both are needed: the row lock keeps two claimers running
--      at the same moment apart, and the status predicate — re-evaluated on
--      the current row version under READ COMMITTED whenever a lock was
--      waited for — keeps a claim committed a moment earlier from being handed
--      out twice. db/test-live.ts [8] runs the workers concurrently, and
--      asserts on ids rather than counts.
--
--   2. NOTHING FOR SUPABASE. No `service_role` grant, no RLS, no REVOKE from
--      `anon`/`authenticated`, no `NOTIFY pgrst`. The application connects as
--      the role that owns these tables, so each of those would grant or deny
--      nothing; migrations 004, 008 and 010 set the precedent and
--      db/test-schema.ts [10] enforces it. The functions are SECURITY INVOKER
--      as upstream's are.
--
--   3. AN EXPIRED LEASE GOES BACK TO THE POOL; IT IS NOT DELETED. Upstream's
--      reaper DELETEs expired 'claimed' rows so the primary-key slot opens for
--      a fresh INSERT, and loses attempt_count and last_error with them. Here
--      the row IS the pool entry, so expiry sets it back to 'pending' and the
--      next claim increments attempt_count. Once a row has been handed out
--      p_max_attempts times and expired every time it is marked 'failed'
--      instead — a thought that kills every worker that touches it (an
--      out-of-memory on a pathological document) must not cycle through the
--      pool for ever. Expiry is enforced at the start of every claim_thoughts
--      call, by the same index the claim uses; a TTL that is only recorded
--      would strand rows exactly as no TTL would.
--
--   4. TERMINAL ROWS ARE THE RECORD OF THE PASS. 'succeeded' and 'failed' rows
--      stay, and enqueue_thoughts skips them by primary key. Re-running a pass
--      therefore does nothing for the rows already processed and picks up the
--      thoughts captured since — resume-after-crash and catch-up are one
--      mechanism. Clear a work_type's terminal rows by hand to start over.
--
-- The job key
--   `work_type` names the pass AND its target: `reembed:qwen3-embedding:4b@1024`,
--   not `reembed`. Two passes with different keys share nothing but the table —
--   the primary key is per key, so a re-embed and an entity-extraction pass
--   run at once without contending — and a later re-embed to a third model is a
--   new pool rather than a no-op against the first pass's terminal rows.
--   db/reembed.ts derives its default key from the configured model and width
--   and takes `--job` for a backfill under the same model.
--
-- Claims are per thought, taken in batches
--   One row per (thought, key), claimed p_batch at a time in one statement.
--   Per-thought rows are what let a worker release each thought as it finishes
--   and let an expired lease return only the thoughts still unfinished; a
--   per-batch lease would return the whole batch, done rows included. The TTL
--   is stamped per claim call, so it has to outlast the whole batch, not one
--   thought — db/reembed.ts's defaults (8 per batch, 900 s) leave close to two
--   minutes per thought.
--
-- Audit
--   Nothing here writes thought_audit. A worker's write to `thoughts` fires
--   008's trigger like any other update — and for a re-embed that trigger
--   records nothing, because 008 diffs the embedding's PRESENCE, not its
--   value (a vector-to-vector change is `{}` and `{}` is not an event). So a
--   full re-embed does NOT double the audit table, and the claim row is the
--   per-thought record of the pass: which key, which worker, when, how many
--   attempts, what went wrong. SMD-946 expected an audit row per thought;
--   db/test-live.ts [9] asserts the count is unchanged, so the expectation is
--   corrected here rather than quietly unmet.
--
-- Cost of a claim
--   Flat across the pass, and the first draft's was not. Measured on
--   pgvector/pgvector:0.8.6-pg16 in a container: 100,000 pending rows under one
--   key, one caller taking batches of 16 until the pool was empty (6,251 calls,
--   each its own transaction), against a 0.15 ms round trip for SELECT 1:
--
--     claim shape                           first 100   at 50,000 done   last 100
--     WHERE pending LIMIT 16                  0.48 ms        1.61 ms       2.90 ms
--       …after VACUUM at 50,000 done                         1.59 ms
--     WHERE pending ORDER BY enqueued_at      0.48 ms        0.56 ms       0.47 ms
--       …after VACUUM at 50,000 done                         0.45 ms
--
--   The first shape lets the planner take a sequential scan that stops after
--   sixteen pending rows: the cheapest estimate, correct at the start, and
--   linear in the rows already done by the end, because those sit at the
--   front of the heap and VACUUM cannot move them. The second makes a
--   sequential scan sort the whole pool, so the planner takes the partial index
--   thought_work_claims_pending_idx whatever the statistics say, and the scan
--   skips only the entries for rows just taken (dead until VACUUM) and the rows
--   other claimers hold at that moment. db/test-live.ts [8] holds the last
--   hundred claims of a 10,000-row pass to within twice the first hundred and
--   checks the plan. A large enqueue also leaves the table's statistics
--   describing the table before it, and the reaper's plan is chosen from them:
--   enqueue_thoughts runs ANALYZE whenever it added rows, rather than leaving
--   each consumer to wait a minute for autovacuum.
--
-- Safety
--   * Additive. `thoughts` gains no columns and loses none.
--   * No DELETE in this file. Expiry and clean release are UPDATEs.
--   * ON DELETE CASCADE from thoughts: a deleted thought takes its claims with
--     it, and the worker that held one sees release_thought return false.
--   * Idempotent.
--
-- Prerequisites
--   Migration 001. Applied by `bun db/migrate.ts`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS thought_work_claims (
  thought_id      uuid        NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  -- The pass and its target, e.g. reembed:qwen3-embedding:4b@1024. See header.
  work_type       text        NOT NULL CHECK (work_type <> ''),
  status          text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'succeeded', 'failed')),
  -- The holder while claimed; the last holder afterwards. NULL until first claimed.
  worker_id       text,
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  claimed_at      timestamptz,
  -- Set while claimed, NULL otherwise. The CHECK below keeps the two in step.
  ttl_expires_at  timestamptz,
  finished_at     timestamptz,
  -- Times a worker took the row and did not hand it back cleanly.
  attempt_count   int         NOT NULL DEFAULT 0,
  last_error      text,
  PRIMARY KEY (thought_id, work_type),
  CHECK ((status = 'claimed') = (ttl_expires_at IS NOT NULL))
);

COMMENT ON TABLE thought_work_claims IS
  'One lease per (thought, work_type) for parallel bulk passes. pending rows are the pool; claim_thoughts hands them out with FOR UPDATE SKIP LOCKED under a TTL; expired leases return to the pool; succeeded and failed rows stay as the record of the pass and block re-enqueue.';
COMMENT ON COLUMN thought_work_claims.work_type IS
  'The pass and its target, e.g. reembed:qwen3-embedding:4b@1024. Passes with different keys share nothing but the table.';
COMMENT ON COLUMN thought_work_claims.worker_id IS
  'The worker holding the lease while status is claimed; afterwards the last holder. Make it globally unique per process — hostname, pid and a random suffix — since release_claims_for_worker matches on it alone.';
COMMENT ON COLUMN thought_work_claims.attempt_count IS
  'Times a worker took this row and did not hand it back cleanly. Incremented by claim_thoughts, decremented by release_claims_for_worker; at p_max_attempts an expired lease is marked failed rather than returned to the pool.';

-- The reaper (work_type, 'claimed', ttl_expires_at < now()) reads this index;
-- so does a per-status count.
CREATE INDEX IF NOT EXISTS thought_work_claims_status_idx
  ON thought_work_claims (work_type, status, ttl_expires_at);

-- The claim reads this one: the pool for a key, oldest first. Partial, so it
-- holds only the rows still to do (and, until the next VACUUM, entries for the
-- rows just taken). See "Cost of a claim" in the header for why the claim
-- orders by enqueued_at rather than taking any sixteen rows.
CREATE INDEX IF NOT EXISTS thought_work_claims_pending_idx
  ON thought_work_claims (work_type, enqueued_at)
  WHERE status = 'pending';

-- "What is worker X holding?" — release_claims_for_worker. Partial, so it holds
-- only the in-flight rows rather than the whole history of every pass.
CREATE INDEX IF NOT EXISTS thought_work_claims_worker_idx
  ON thought_work_claims (worker_id)
  WHERE status = 'claimed';

-- ---------------------------------------------------------------------------
-- enqueue_thoughts — build or extend the pool for a key
--
-- Every thought when p_thought_ids is NULL; those ids otherwise. Rows that
-- already exist for the key — pending, in flight or terminal — are skipped by
-- primary key, which is what makes a re-run add only what is new. Returns the
-- number added. An id that names no thought fails the foreign key rather than
-- being skipped: a caller that selected ids a moment ago and finds one gone
-- should hear about it, not count it as enqueued.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enqueue_thoughts(
  p_work_type   text,
  p_thought_ids uuid[] DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_n int;
BEGIN
  IF p_work_type IS NULL OR p_work_type = '' THEN
    RAISE EXCEPTION 'enqueue_thoughts: p_work_type must name the pass, e.g. reembed:<model>@<dim>';
  END IF;

  IF p_thought_ids IS NULL THEN
    INSERT INTO thought_work_claims (thought_id, work_type)
    SELECT t.id, p_work_type FROM thoughts t
    ON CONFLICT (thought_id, work_type) DO NOTHING;
  ELSE
    INSERT INTO thought_work_claims (thought_id, work_type)
    SELECT DISTINCT u.id, p_work_type FROM unnest(p_thought_ids) AS u(id)
    ON CONFLICT (thought_id, work_type) DO NOTHING;
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- A large enqueue leaves the table's statistics describing the table before
  -- it, and the reaper's plan is chosen from them. Autovacuum would catch up
  -- within a minute; the first claims of a pass need not wait for it, and
  -- doing it here means every consumer gets it rather than the one that knew.
  -- ANALYZE, unlike VACUUM, may run inside a transaction.
  IF v_n > 0 THEN
    ANALYZE thought_work_claims;
  END IF;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION enqueue_thoughts(text, uuid[]) IS
  'Add thoughts to the pool for a work_type — every thought when p_thought_ids is NULL. Existing rows for the key are skipped by primary key, so a re-run adds only what is new. Returns the number added.';

-- ---------------------------------------------------------------------------
-- claim_thoughts — take the next batch under a lease
--
-- Two statements. The first returns expired leases to the pool — or, once a
-- row has been handed out p_max_attempts times, marks it failed. The second
-- takes up to p_batch pending rows with FOR UPDATE SKIP LOCKED and stamps them
-- claimed. Returns what was taken, with the attempt this is for each row, so a
-- worker can see it is retrying somebody else's crash.
--
-- The CTE is MATERIALIZED explicitly. Postgres would refuse to inline a query
-- carrying FOR UPDATE anyway, but the batch bound and the single locking pass
-- both depend on that, so the file says so rather than relying on the planner
-- to.
--
-- ORDER BY enqueued_at is there for the plan, and the order is a side effect.
-- Without it the cheapest ESTIMATE for "sixteen pending rows" is a sequential
-- scan that stops after sixteen hits — correct at the start of a pass and
-- linear in the rows already done by the end, since those sit at the front of
-- the heap (measured: see the header). With it, a sequential scan would have
-- to sort the whole pool, so the planner takes the partial index whatever the
-- statistics say. Rows come oldest-enqueued first as a consequence; under
-- concurrency that is a tendency, not a guarantee, and callers must not rely
-- on it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_thoughts(
  p_work_type    text,
  p_worker_id    text,
  p_batch        int DEFAULT 16,
  p_ttl_seconds  int DEFAULT 900,
  p_max_attempts int DEFAULT 3
)
RETURNS TABLE (thought_id uuid, attempt int)
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'claim_thoughts: p_worker_id must identify the worker';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 THEN
    RAISE EXCEPTION 'claim_thoughts: p_ttl_seconds must be positive, got %', p_ttl_seconds;
  END IF;

  -- Expired leases. Back to the pool, keeping the attempt count and the last
  -- holder's name for diagnosis; to failed once the row has used its attempts.
  UPDATE thought_work_claims c
     SET status         = CASE WHEN c.attempt_count >= COALESCE(p_max_attempts, 3) THEN 'failed' ELSE 'pending' END,
         last_error     = CASE WHEN c.attempt_count >= COALESCE(p_max_attempts, 3)
                               THEN format('lease expired %s times; last held by %s', c.attempt_count, c.worker_id)
                               ELSE c.last_error END,
         finished_at    = CASE WHEN c.attempt_count >= COALESCE(p_max_attempts, 3) THEN now() ELSE NULL END,
         ttl_expires_at = NULL
   WHERE c.work_type = p_work_type
     AND c.status = 'claimed'
     AND c.ttl_expires_at < now();

  RETURN QUERY
  WITH picked AS MATERIALIZED (
    SELECT c.thought_id
      FROM thought_work_claims c
     WHERE c.work_type = p_work_type
       AND c.status = 'pending'
     ORDER BY c.enqueued_at
     LIMIT GREATEST(COALESCE(p_batch, 16), 1)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE thought_work_claims c
     SET status         = 'claimed',
         worker_id      = p_worker_id,
         claimed_at     = now(),
         ttl_expires_at = now() + make_interval(secs => p_ttl_seconds),
         attempt_count  = c.attempt_count + 1
    FROM picked
   WHERE c.thought_id = picked.thought_id
     AND c.work_type  = p_work_type
     AND c.status     = 'pending'
  RETURNING c.thought_id, c.attempt_count;
END;
$$;

COMMENT ON FUNCTION claim_thoughts(text, text, int, int, int) IS
  'Return expired leases for the work_type to the pool (or mark them failed at p_max_attempts), then take up to p_batch pending rows with FOR UPDATE SKIP LOCKED under a p_ttl_seconds lease. Concurrent callers receive disjoint sets. Returns (thought_id, attempt).';

-- ---------------------------------------------------------------------------
-- release_thought — finish one claim
--
-- Only the holder may, and only while the row is still claimed. False means
-- the lease expired and another worker has it, the thought was deleted, or the
-- caller never held it; the worker's own write to `thoughts`, if it made one,
-- stands either way.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION release_thought(
  p_thought_id uuid,
  p_work_type  text,
  p_worker_id  text,
  p_status     text,
  p_error      text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_n int;
BEGIN
  IF p_status NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'release_thought: p_status must be succeeded or failed, got %', p_status;
  END IF;

  UPDATE thought_work_claims c
     SET status         = p_status,
         last_error     = p_error,
         ttl_expires_at = NULL,
         finished_at    = now()
   WHERE c.thought_id = p_thought_id
     AND c.work_type  = p_work_type
     AND c.worker_id  = p_worker_id
     AND c.status     = 'claimed';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

COMMENT ON FUNCTION release_thought(uuid, text, text, text, text) IS
  'Mark one claim succeeded or failed. Only the holder of a still-claimed row may; returns false otherwise (expired and re-leased, deleted, or never held).';

-- ---------------------------------------------------------------------------
-- release_claims_for_worker — clean shutdown
--
-- Everything the worker still holds goes straight back to the pool, without
-- waiting for the TTL, and without counting as an attempt: the worker did not
-- start on those rows, or did not finish, and is saying so. Returns how many.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION release_claims_for_worker(
  p_work_type text,
  p_worker_id text
)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_n int;
BEGIN
  UPDATE thought_work_claims c
     SET status         = 'pending',
         ttl_expires_at = NULL,
         attempt_count  = GREATEST(c.attempt_count - 1, 0)
   WHERE c.work_type = p_work_type
     AND c.worker_id = p_worker_id
     AND c.status    = 'claimed';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION release_claims_for_worker(text, text) IS
  'Clean shutdown: return every row this worker still holds for the work_type to the pool immediately, not counting the attempt. Returns how many.';
