-- =============================================================================
-- Migration 071: node_state's dependency columns read the ids they are asked
--                for — the gate stored and kept current on write, the links
--                probed by index (SMD-2267)
-- =============================================================================
--
-- WHY
--   068 made node_state's lifecycle and superseded_by lookups; its dependency
--   columns — blocked, blockers, unknown_blockers, in_dependencies — stayed
--   whole-brain reads (068: "they still compute every link"). Asked for forty
--   ids, node_state resolved every link and every blocker of the brain and
--   kept forty rows: 23 ms at 10,000 thoughts and 300 ms at 100,000 on a
--   brain with a fifth of its rows tickets and a link on half of them
--   (SMD-2267's probe). And node_dependencies()' gate — whether some source
--   row of a system states a known status — was a grouped pass over every
--   source row joined to its thought, on every call.
--
--   Of three shapes (a stored projection of every ticket's blockers, fed by
--   triggers on the links, the source rows and 068's heads; the gate alone
--   stored and the rest probed; or waiting for SMD-1997's fold) the maintainer
--   chose the second (2026-09-28): the gate is the one answer that is not a
--   function of a few rows near the ids, so it is the one stored; a blocker's
--   status is already a lookup since 068, and a ticket's links are two index
--   probes (053's), so the rest is read from the ids at read time and needs
--   no invalidation when a blocker's head moves.
--
-- WHAT
--   * ob1_source_gate — one row per thought_sources row: the system and
--     whether the thought's own metadata.status_type is one
--     node_lifecycle_types() knows (058's gate, per row: a status borrowed
--     through a Linear ticket claim does not count). A system gates while
--     some row of it does — one probe of a partial index. A mirror of rows,
--     not a count per system: a thought's delete cascades to its source row,
--     and by then its status is gone — a count could not be taken back down;
--     a row keyed by the thought is deleted by key.
--   * Fed by statement triggers with transition tables: on thought_sources
--     (INSERT — the new rows, upserted in one statement; UPDATE — the
--     thought_ids whose source row moved or changed system, so the board
--     sync's canonical-only re-record returns at once; DELETE — the deleted
--     rows' mirror rows, by key; and TRUNCATE, which empties the table), and
--     on thoughts (UPDATE — the ids whose status_type moved between known and
--     unknown; any other write returns at once, so a plain capture or edit
--     needs no privilege here). A new thought has no source row, and a
--     deleted one's goes by the cascade, so thoughts needs no INSERT or DELETE
--     trigger; TRUNCATE thoughts ... CASCADE truncates thought_sources, whose
--     TRUNCATE trigger fires.
--   * ob1_source_gate_reconcile(uuid[]) — the keyed delete-or-upsert from
--     thought_sources and thoughts, every row when NULL. Internal: it takes no
--     lock (its callers do), so a direct call races the triggers.
--   * ob1_rebuild_source_gate() — every row, under the tables' SHARE locks;
--     returns what it wrote and deleted, zeros when exact. The seed below, and
--     the repair after a write made with triggers disabled. READ COMMITTED
--     only, as 068's rebuild.
--   * ob1_node_projection_drift() — 068's two arms and a third, 'source_gate',
--     every mirror row against thought_sources and thoughts computed fresh.
--     Same signature, so 068's callers and its COMMENT's promise stand.
--   * source_thought() — 053's resolver, same signature and results: the
--     board sync's claim, for a linear identity no source row holds, found by
--     068's issue index rather than 001's GIN index, which read every issue
--     row's posting per blocker (the bench's brain, most of whose links name a
--     ticket it does not hold: this file's keyed read 47 ms until the
--     resolver moved, then 2.2 ms; every thought's 5 s on either reads, then
--     27 ms).
--   * node_dependencies() — same signature and rows; its gate a test against
--     the systems some mirror row gates, read once per call, not a pass over
--     every source row and its
--     thought (read for its gates, 15.7 ms against 45.8 at 100,000 thoughts,
--     bench-hybrid.ts).
--   * ob1_system_gates(text) — one system's gate as one probe of the partial
--     index, SET enable_seqscan = off so it is not inlined and its statement
--     is planned on the index: inline, the planner hashed the whole mirror or
--     scanned it to the first gating row, which for a system that never gates
--     is all of it, per link (70 ms for forty markdown ids at 100,000).
--   * ob1_source_gate_lock(uuid[]) — the gate's advisory locks for a set of
--     thoughts (below, Concurrency).
--   * ob1_node_dependencies_of(uuid[]) — each named thought's open blockers,
--     unknown blockers and whether some gating active link names its ticket,
--     every thought when NULL. Two branches under one GROUP BY thought_id,
--     each a one-time filter on the argument: NULL is 068's whole-brain read
--     (the dependency CTEs over node_dependencies()); ids are probes — a
--     thought's ticket identities (its source row by key, its ticket or issue
--     claim), each identity's links from both ends (053's target index for a
--     link naming it, the (system, identity) key and the facets' thought index
--     for a link its holder carries), the gate by index, and each blocker
--     through source_thought() into node_lifecycle() by primary key. Behind
--     OFFSET 0, the blocker's lookup is not flattened into a hash of every
--     thought's lifecycle (the probe: 11.8 ms, then 2.5).
--   * node_state() — same signature and rows, no top-level WITH: its two
--     dependency joins become one, to ob1_node_dependencies_of(p_ids), which a
--     caller that reads none of those columns still drops (a GROUP BY on the
--     join key is provably unique), so search's prefer_current plans no link.
--     Asked for forty ids on bench-hybrid.ts's brain (two links in three
--     naming a ticket it does not hold): 2.9 ms at 10,000 thoughts and 2.9 at
--     100,000, against 6.5 s and 656 s on the reads 068 left; every thought:
--     31 ms and 308, against 6.1 s and 732 s.
--
--   A caller who wants the keyed read passes the ids: node_state(NULL) joined
--   to a set of ids and read for its dependency columns computes every thought
--   (the one-time filter keeps NULL's branch), as it did before this file.
--
--   Concurrency. A source write and a status move of the same thought take
--   turns on an advisory transaction lock: a bucket of the thought's id, 256
--   buckets in class 22563 (ob1_source_gate_lock), taken exclusive in bucket
--   order by the thought_sources triggers' insert and update paths and by the
--   thoughts status trigger, each before it reads a status or writes a mirror
--   row, and each read a statement after the lock — so whichever goes second
--   reads what the first committed. A source row's delete takes none: it
--   drops the mirror row by key, and a status move meets it on that row. So a
--   transaction holds at most 256 of these locks — 769 with 068's 513, so ten
--   such wide transactions at once, not 068's fifteen, fill a default server's
--   shared lock table (max_locks_per_transaction 64, some 7,800 slots). The
--   status trigger sorts after 068's on thoughts, so a statement takes 068's
--   classes before 22563. A bucket is held until commit, so a transaction
--   that has written a source row holds up a status move of any thought in
--   that bucket, not only its own, until it commits; and one that has moved a
--   status — a plain note's too — holds up source writes and status moves in
--   its buckets (a bulk status UPDATE, all of them). Exclusive for status moves
--   too, not shared (pass 4, reverted in pass 5): a status move then a source
--   write of the same thought in one transaction — the write order below, and
--   ingest-records' — took the bucket shared and then asked for it exclusive,
--   and two such transactions over bucket-mates deadlocked ten times in ten.
--   Not the thought's row (FOR SHARE, until the second review pass): a source
--   writer's share lock crossed every lock taken in another order — a
--   multi-row UPDATE of thoughts in scan order, a delete's cascade, a take's
--   second thought — and deadlocked where main waited; it held off every edit
--   of the thought until commit; and it needed UPDATE on thoughts.
--   REPEATABLE READ is refused for an insert of a source row, a move of one to
--   another thought or system, and every status move between known and
--   unknown — a thought with no source row too, which the check cannot tell
--   apart from one whose source row a concurrent writer committed after the
--   snapshot, the case it exists for; a source row's delete, a canonical-only
--   re-record and an upsert that changes nothing run (the delete raises 40001
--   if its thought's status moved since the snapshot, on the mirror row the
--   move updated). SERIALIZABLE is left to
--   SSI (exact only when every writer of source rows and statuses is
--   serializable; after a mix, rebuild under READ COMMITTED).
--   What can still deadlock (40P01), retryable. Across statements, as 068's
--   ticket writes can: a transaction that takes a bucket in one statement and
--   later waits on a lock a status mover holds while that mover waits for the
--   bucket — the thought's row (a source write, then an edit of the thought),
--   a bucket-mate's row (then an edit of another thought in the bucket), 068's
--   classes (then a ticket row's write), or two such transactions each writing
--   source rows whose buckets the other already holds (two bulk writers of
--   thirty source rows each deadlocked five times in ten, where 068's own
--   ticket writes do the same), or two transactions each moving the statuses
--   of several thoughts in separate statements, plain notes included, whose
--   buckets cross (a one-statement bulk move takes its buckets in order and
--   does not). Write a thought before its source row, one thought per
--   transaction, as the repo's writers do: the transaction then takes the
--   bucket once, exclusive, for both. Within one statement: a
--   take (record_thought_source's p_take, two statements in one call) against
--   one status update of both its thoughts, when the update's trigger has taken
--   the new thought's bucket and reaches the old one's mirror row as the take
--   deletes it; and a multi-row delete of source rows against a multi-row
--   status move over the same thoughts, when the plans lock the mirror's rows in
--   different orders. A stress run of three connections writing source rows,
--   thoughts and statuses one statement at a time, at random (six seeds of
--   3,600 statements each), gave 0 and 4 deadlocks in two runs under READ
--   COMMITTED and 2 under SERIALIZABLE, against main's 1 and 1.

-- UPGRADE
--   Run `db/migrate.ts --grant <role>` again for every role granted before
--   this file (the capture group gains SELECT, INSERT, UPDATE and DELETE on
--   ob1_source_gate).
--
-- SAFETY
--   Additive: one table, one index, eight functions, five triggers; four
--   bodies redefined with their signatures unchanged — source_thought,
--   node_dependencies and node_state with their rows unchanged, drift with a
--   third arm. No
--   foreign keys, as 068's tables: the triggers own correctness and drift()
--   checks them. SECURITY INVOKER throughout, so the triggers run as the
--   writing role: db/config.mjs ROLE_GRANTS gives the capture group the four
--   privileges on ob1_source_gate, and a role granted before this file fails
--   preflight's write-privileges check with the exact GRANT until
--   `migrate.ts --grant` runs again — until then a write of a source row, a
--   delete of a thought that has one, a status move on any thought between a
--   known and an unknown status_type, and a read of the dependency columns
--   that reaches the gate (every whole-brain read — graph-centrality
--   --startable and --decay-blocked, node_dependencies()' gates — a keyed read
--   of a thought whose ticket a link names, and any read of node_state that is planned
--   with the whole-brain branch in it: a generic plan, or a call whose argument
--   is a subquery and so is not inlined) is refused on the new table; a delete
--   of a thought with no source row, an edit that moves no status between
--   those two, and a lifecycle read of node_state(<ids>) inlined with its ids
--   are not. The locks are advisory and need no
--   privilege. A migration that changes node_lifecycle_types() changes what
--   every mirror row should hold: it runs ob1_rebuild_source_gate() after
--   itself. Idempotent: IF NOT
--   EXISTS, DROP TRIGGER IF EXISTS, CREATE OR REPLACE, and the seed is a
--   reconcile. The seed runs after the triggers exist; CREATE TRIGGER holds
--   writers of both tables off until commit.
--   A write made with the tables' user triggers disabled (ALTER TABLE ...
--   DISABLE TRIGGER, session_replication_role = replica, pg_restore
--   --disable-triggers) bypasses the mirror: run SELECT * FROM
--   ob1_rebuild_source_gate() after it, beside 068's rebuild (drift() says
--   whether either is needed). MINOR under the version rules.
--
-- Expected outcome
--   SELECT count(*) FROM ob1_node_projection_drift() is 0, node_state() and
--   node_dependencies() list what 058's did, and node_state(<ids>), inlined
--   with its ids, costs what its ids' links cost, whatever the brain's size —
--   under a generic plan, or with a subquery for its argument, 068's filter
--   scans every thought (SMD-2380).
-- Dependencies: 053 (thought_sources, source_thought), 058 (the node_*
--   functions), 068 (ob1_ticket_head, ob1_superseded_by, the drift function).
-- =============================================================================

-- Each prerequisite named on its own, as 068 names its two. Driven by
-- test-upgrade.ts [20w].
DO $g$
BEGIN
  IF to_regclass('thought_sources') IS NULL OR to_regprocedure('source_thought(text, text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 071 needs 053 (thought_sources, source_thought); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character
      -- back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regclass('ob1_ticket_head') IS NULL OR to_regclass('ob1_superseded_by') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 071 needs 068 (ob1_ticket_head, ob1_superseded_by); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$g$;

-- thoughts before thought_sources, the order a writer of both takes them (a
-- delete of a thought, then its cascade): the triggers below would take
-- thought_sources' lock first, and a delete of a sourced thought during the
-- migration then deadlocked with it (fourth review pass).
LOCK TABLE thoughts, thought_sources IN SHARE ROW EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------
-- The mirror. No foreign key, as 068's two tables.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ob1_source_gate (
  thought_id uuid PRIMARY KEY,    -- a thought_sources row's thought
  system     text NOT NULL,       -- its system
  gates      boolean NOT NULL     -- the thought's own status_type is a known one
);
COMMENT ON TABLE ob1_source_gate IS
  'One row per thought_sources row: its system, and whether its thought''s own metadata.status_type is in node_lifecycle_types(). A system gates — can say a blocker is settled — while some row of it does (058''s gate, per row). Kept current by the thought_sources_node_gate_* and thoughts_node_source_gate_update triggers; ob1_node_projection_drift() checks it, ob1_rebuild_source_gate() repairs it. Migration 071 / SMD-2267.';

-- The gate: does any row of this system gate? One probe.
CREATE INDEX IF NOT EXISTS ob1_source_gate_system_idx
  ON ob1_source_gate (system) WHERE gates;

-- ---------------------------------------------------------------------------
-- Reconcile, rebuild
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_source_gate_reconcile(p_ids uuid[])
RETURNS TABLE (written int, deleted int)
LANGUAGE plpgsql
SET jit = off
-- Planned with its keys each time, as 068's reconcile (a plan cached while the
-- tables were small went on scanning them).
SET plan_cache_mode = force_custom_plan
AS $$
BEGIN
  written := 0; deleted := 0;
  IF p_ids IS NULL THEN
    WITH f AS MATERIALIZED (
           SELECT o.thought_id, o.system, coalesce(t.metadata->>'status_type' = ANY(node_lifecycle_types()), false) AS gates
             FROM thought_sources o JOIN thoughts t ON t.id = o.thought_id),
         d AS (DELETE FROM ob1_source_gate g WHERE NOT EXISTS (SELECT 1 FROM f WHERE f.thought_id = g.thought_id) RETURNING 1),
         w AS (INSERT INTO ob1_source_gate AS g (thought_id, system, gates) SELECT f.thought_id, f.system, f.gates FROM f
                 ON CONFLICT (thought_id) DO UPDATE SET system = EXCLUDED.system, gates = EXCLUDED.gates
                 WHERE (g.system, g.gates) IS DISTINCT FROM (EXCLUDED.system, EXCLUDED.gates)
               RETURNING 1)
    SELECT (SELECT count(*) FROM w), (SELECT count(*) FROM d) INTO written, deleted;
  ELSIF cardinality(p_ids) > 0 THEN
    WITH f AS MATERIALIZED (
           SELECT o.thought_id, o.system, coalesce(t.metadata->>'status_type' = ANY(node_lifecycle_types()), false) AS gates
             FROM thought_sources o JOIN thoughts t ON t.id = o.thought_id
            WHERE o.thought_id = ANY(p_ids)),
         d AS (DELETE FROM ob1_source_gate g WHERE g.thought_id = ANY(p_ids)
                 AND NOT EXISTS (SELECT 1 FROM f WHERE f.thought_id = g.thought_id) RETURNING 1),
         w AS (INSERT INTO ob1_source_gate AS g (thought_id, system, gates) SELECT f.thought_id, f.system, f.gates FROM f
                 ON CONFLICT (thought_id) DO UPDATE SET system = EXCLUDED.system, gates = EXCLUDED.gates
                 WHERE (g.system, g.gates) IS DISTINCT FROM (EXCLUDED.system, EXCLUDED.gates)
               RETURNING 1)
    SELECT (SELECT count(*) FROM w), (SELECT count(*) FROM d) INTO written, deleted;
  END IF;
  RETURN NEXT;
END
$$;
COMMENT ON FUNCTION ob1_source_gate_reconcile(uuid[]) IS
  'Brings ob1_source_gate to thought_sources and thoughts for the thoughts given (every row when NULL; an empty array touches nothing): deletes what vanished, upserts what changed, and returns the counts. Takes no lock itself — the triggers and ob1_rebuild_source_gate() do — so it is internal: a direct call races the triggers (call the rebuild instead). Migration 071 / SMD-2267.';

CREATE OR REPLACE FUNCTION ob1_rebuild_source_gate()
RETURNS TABLE (written int, deleted int)
LANGUAGE plpgsql
AS $$
BEGIN
  -- Its snapshot must postdate the locks, as 068's rebuild's (a row a writer
  -- deleted after an older snapshot would be written back).
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('ob1_rebuild_source_gate() must run under READ COMMITTED; this transaction is %s', upper(current_setting('transaction_isolation'))),
      HINT = 'BEGIN ISOLATION LEVEL READ COMMITTED; then call it (a call outside a transaction takes the default level, which is what refused it).',
      ERRCODE = 'feature_not_supported';
  END IF;
  -- thoughts before thought_sources, the order a writer of both takes them
  -- (the row, then its source row): SHARE holds off every writer of either
  -- until the reconcile commits.
  LOCK TABLE thoughts IN SHARE MODE;
  LOCK TABLE thought_sources IN SHARE MODE;
  RETURN QUERY SELECT * FROM ob1_source_gate_reconcile(NULL);
END
$$;
COMMENT ON FUNCTION ob1_rebuild_source_gate() IS
  'Reconciles the whole of ob1_source_gate under SHARE locks on thoughts and thought_sources and returns what it wrote and deleted — zeros when it was exact. Refuses to run outside READ COMMITTED. 071''s seed, the repair after a write made with either table''s user triggers disabled (beside ob1_rebuild_node_projection(), 068''s), and a step for any migration that changes node_lifecycle_types(), which every mirror row is computed from. Migration 071 / SMD-2267.';

-- 068's two arms verbatim, and the mirror's: every stored row against its
-- tables computed fresh.
CREATE OR REPLACE FUNCTION ob1_node_projection_drift()
RETURNS TABLE (projection text, key text, stored text, fresh text)
LANGUAGE sql
STABLE
AS $$
  WITH heads AS (
         SELECT p.metadata->>'issue' AS issue, p.id, p.metadata->>'status' AS status, p.metadata->>'status_type' AS status_type,
                p.metadata->>'linear_updated_at' AS synced_at,
                row_number() OVER (PARTITION BY p.metadata->>'issue'
                                   ORDER BY (NOT EXISTS (SELECT 1 FROM thoughts s WHERE s.supersedes = p.id)) DESC, p.metadata->>'linear_updated_at' DESC NULLS LAST, p.id) AS rn
           FROM thoughts p WHERE p.metadata ? 'issue'),
       fresh_head AS (SELECT md5(issue)::uuid AS issue_key, issue, id, status, status_type, synced_at FROM heads WHERE rn = 1 AND issue IS NOT NULL),
       fresh_sup AS (
         SELECT DISTINCT ON (s.supersedes) s.supersedes AS old_id, s.id AS new_id
           FROM thoughts s WHERE s.supersedes IS NOT NULL
          ORDER BY s.supersedes, s.created_at DESC, s.id DESC),
       fresh_gate AS (
         SELECT o.thought_id, o.system, coalesce(t.metadata->>'status_type' = ANY(node_lifecycle_types()), false) AS gates
           FROM thought_sources o JOIN thoughts t ON t.id = o.thought_id)
  SELECT 'head', coalesce(f.issue, h.issue),
         CASE WHEN h.issue_key IS NOT NULL THEN row(h.issue_key, h.issue, h.head_id, h.status, h.status_type, h.synced_at)::text END,
         CASE WHEN f.issue_key IS NOT NULL THEN row(f.issue_key, f.issue, f.id, f.status, f.status_type, f.synced_at)::text END
    FROM fresh_head f FULL JOIN ob1_ticket_head h ON h.issue_key = f.issue_key
   WHERE (h.issue_key, h.issue, h.head_id, h.status, h.status_type, h.synced_at)
         IS DISTINCT FROM (f.issue_key, f.issue, f.id, f.status, f.status_type, f.synced_at)
  UNION ALL
  SELECT 'superseded_by', coalesce(f.old_id, s.old_id)::text, s.new_id::text, f.new_id::text
    FROM fresh_sup f FULL JOIN ob1_superseded_by s ON s.old_id = f.old_id
   WHERE s.new_id IS DISTINCT FROM f.new_id
  UNION ALL
  SELECT 'source_gate', coalesce(f.thought_id, g.thought_id)::text,
         CASE WHEN g.thought_id IS NOT NULL THEN row(g.thought_id, g.system, g.gates)::text END,
         CASE WHEN f.thought_id IS NOT NULL THEN row(f.thought_id, f.system, f.gates)::text END
    FROM fresh_gate f FULL JOIN ob1_source_gate g ON g.thought_id = f.thought_id
   WHERE (g.thought_id, g.system, g.gates) IS DISTINCT FROM (f.thought_id, f.system, f.gates)
$$;
COMMENT ON FUNCTION ob1_node_projection_drift() IS
  'Every row where the node_state projection differs from its formulas computed fresh — projection (head or superseded_by, 058''s formulas; source_gate, each source row''s system and whether its thought states a known status_type), key, the stored row and the fresh one as text, NULL where one side has none. Zero rows when exact. Computes the whole brain: a check, not a read path. Migration 068 / SMD-2256; the gate, 071 / SMD-2267.';

-- ---------------------------------------------------------------------------
-- The triggers
-- ---------------------------------------------------------------------------
-- The lock: an advisory transaction lock per bucket of the thought's id, 256
-- buckets in class 22563, taken in bucket order by every writer that reads a
-- thought's status for the mirror or moves it — so a source write and a status
-- move of one thought take turns, and whichever comes second reads what the
-- first committed. Not the thought's row (FOR SHARE, until the second review
-- pass): a source writer's share lock on the thoughts it wrote crossed every
-- lock taken in another order — a multi-row UPDATE of thoughts in scan order,
-- a delete's cascade, a take's second thought — and deadlocked where main
-- waited (fifteen 40P01 in a stress run of mixed writers, against one on
-- main); and it held off every edit of those thoughts until commit, and needed
-- UPDATE on thoughts. A bucket is held by nothing but these writers, and each
-- takes its buckets after its own row writes and before it touches a mirror
-- row. A take (record_thought_source's p_take) is two statements, the old
-- holder's source row out and then the new one's in, and takes the second
-- thought's bucket in the second: locking both buckets up front, as pass 2
-- first did, put a bucket before a source row's lock where every trigger puts
-- the row first, and a stress run of mixed writers gave 23 deadlocks against 4
-- without it (six seeds of 3,600 statements; main, none or one).
CREATE OR REPLACE FUNCTION ob1_source_gate_lock(p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  b int;
BEGIN
  FOR b IN SELECT DISTINCT hashtext(x::text) & 255 FROM unnest(p_ids) x WHERE x IS NOT NULL ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(22563, b);
  END LOOP;
END
$$;
COMMENT ON FUNCTION ob1_source_gate_lock(uuid[]) IS
  'Takes the gate''s advisory transaction locks for the thoughts given — class 22563, a bucket of 256 per thought id, exclusive, in bucket order — so a transaction holds at most 256 of them. The thought_sources triggers'' insert and update paths and the thoughts status trigger take them before they read a thought''s status or write a mirror row. Migration 071 / SMD-2267.';

CREATE OR REPLACE FUNCTION ob1_source_gate_sync()
RETURNS trigger
LANGUAGE plpgsql
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_ids uuid[];   -- thoughts whose source row appeared, vanished or changed system
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Every thought's delete cascades here, and the cascade's statement fires
    -- this trigger whether or not it deleted a row: one that deleted none
    -- returns before touching the mirror, so a role without it deletes an
    -- unsourced thought as before (first review pass: every delete was
    -- refused). The cascade's trigger runs as the caller (its AFTER triggers
    -- are queued to the outer statement).
    IF NOT EXISTS (SELECT 1 FROM old_rows) THEN
      RETURN NULL;
    END IF;
    -- thought_id is thought_sources' key, so a thought whose source row this
    -- statement deleted has none: its mirror row goes by key, with no read of
    -- thought_sources or thoughts and no lock — a status move of the thought
    -- meets the delete on the mirror row itself, and whichever goes second
    -- finds the row as the first left it. A re-insert of the thought's source
    -- row waits on the key until this commits, and its own trigger recomputes
    -- the row afresh. (A lock here, pass 1's, deadlocked a thought's delete
    -- with a delete of its source row, and a take with a delete of the old
    -- holder — second review pass.)
    DELETE FROM ob1_source_gate g WHERE g.thought_id = ANY(ARRAY(SELECT o.thought_id FROM old_rows o));
    RETURN NULL;
  ELSIF TG_OP = 'INSERT' THEN
    -- A new source row adds a mirror row and removes none: the buckets, then
    -- one upsert — a fresh statement, so it reads the status a move that held
    -- the bucket committed. An INSERT that inserted nothing (an upsert that
    -- took its conflict branch) returns. One upsert rather than a reconcile per
    -- insert: that cost 0.26 ms a record_thought_source (SMD-2267's paired
    -- timing).
    IF NOT EXISTS (SELECT 1 FROM new_rows) THEN
      RETURN NULL;
    END IF;
    IF current_setting('transaction_isolation') = 'repeatable read' THEN
      RAISE EXCEPTION USING
        MESSAGE = 'this write moves a source row, and node_state''s gate (migration 071) cannot be kept under REPEATABLE READ',
        HINT = 'Run it under READ COMMITTED (the default), or SERIALIZABLE if every writer of source rows and statuses is serializable.',
        ERRCODE = 'feature_not_supported';
    END IF;
    PERFORM ob1_source_gate_lock(ARRAY(SELECT n.thought_id FROM new_rows n));
    INSERT INTO ob1_source_gate AS g (thought_id, system, gates)
    SELECT n.thought_id, n.system, coalesce(t.metadata->>'status_type' = ANY(node_lifecycle_types()), false)
      FROM new_rows n JOIN thoughts t ON t.id = n.thought_id
    ON CONFLICT (thought_id) DO UPDATE SET system = EXCLUDED.system, gates = EXCLUDED.gates
     WHERE (g.system, g.gates) IS DISTINCT FROM (EXCLUDED.system, EXCLUDED.gates);
    RETURN NULL;
  ELSE
    -- Every pair of images, as 068's trigger pairs them: a side unmatched (the
    -- thought_id moved) or a system moved names both ids; the canonical, the
    -- hash and the run moving alone name none.
    SELECT array_agg(DISTINCT k.id) FILTER (WHERE k.id IS NOT NULL) INTO v_ids
      FROM (SELECT r.thought_id, r.system FROM old_rows r) o
      FULL JOIN (SELECT r.thought_id, r.system FROM new_rows r) n ON n.thought_id = o.thought_id
      CROSS JOIN LATERAL (VALUES (o.thought_id), (n.thought_id)) k(id)
     WHERE o.system IS DISTINCT FROM n.system;
  END IF;
  IF v_ids IS NULL THEN
    RETURN NULL;
  END IF;
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'this write moves a source row, and node_state''s gate (migration 071) cannot be kept under REPEATABLE READ',
      HINT = 'Run it under READ COMMITTED (the default), or SERIALIZABLE if every writer of source rows and statuses is serializable.',
      ERRCODE = 'feature_not_supported';
  END IF;
  -- The buckets, then the reconcile — a fresh statement, which reads the
  -- status a move that held the bucket committed; a move arriving later waits
  -- for this and finds the mirror row.
  PERFORM ob1_source_gate_lock(v_ids);
  PERFORM ob1_source_gate_reconcile(v_ids);
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION ob1_source_gate_sync() IS
  'The thought_sources_node_gate_* row-change triggers'' body. A DELETE returns when it deleted nothing, and otherwise drops the deleted rows'' mirror rows by key (thought_id is the source row''s key), reading nothing else and taking no lock. An INSERT takes the new rows'' buckets (ob1_source_gate_lock) and upserts their mirror rows in one statement. An UPDATE takes, from the transition tables, the thoughts whose source row vanished, appeared or changed system; returns at once when there are none; otherwise takes their buckets and reconciles their mirror rows. The INSERT and UPDATE paths refuse under REPEATABLE READ. Migration 071 / SMD-2267.';

CREATE OR REPLACE FUNCTION ob1_source_gate_status()
RETURNS trigger
LANGUAGE plpgsql
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_ids uuid[];   -- thoughts whose status_type moved between known and unknown
BEGIN
  -- Every pair of images, as above: a thought listed twice on a side (a
  -- writable CTE, a cascade) still shows its first old status beside its last
  -- new one; extra pairs only add ids, and the update reads the row fresh.
  SELECT array_agg(DISTINCT k.id) FILTER (WHERE k.id IS NOT NULL) INTO v_ids
    FROM (SELECT r.id, coalesce(r.metadata->>'status_type' = ANY(node_lifecycle_types()), false) AS known FROM old_rows r) o
    FULL JOIN (SELECT r.id, coalesce(r.metadata->>'status_type' = ANY(node_lifecycle_types()), false) AS known FROM new_rows r) n ON n.id = o.id
    CROSS JOIN LATERAL (VALUES (o.id), (n.id)) k(id)
   WHERE o.known IS DISTINCT FROM n.known;
  IF v_ids IS NULL THEN
    RETURN NULL;
  END IF;
  -- Its snapshot would not see a mirror row a source writer committed after
  -- it, and the move would be lost without a conflict.
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'this write moves a thought''s status_type between known and unknown, and node_state''s gate (migration 071) cannot be kept under REPEATABLE READ',
      HINT = 'Run it under READ COMMITTED (the default), or SERIALIZABLE if every writer of source rows and statuses is serializable.',
      ERRCODE = 'feature_not_supported';
  END IF;
  -- The buckets, then the update — a fresh statement: a source writer that
  -- held a bucket first has committed its mirror row, and this finds it; one
  -- arriving later waits for this and reads the status it commits. Exclusive,
  -- as the source paths take them: shared (pass 4), a transaction that moved
  -- a status and then wrote the thought's source row asked for the bucket it
  -- held shared as exclusive, and two such over bucket-mates deadlocked (fifth
  -- review pass). This trigger sorts after 068's on thoughts, so a statement
  -- takes 068's classes before this one.
  PERFORM ob1_source_gate_lock(v_ids);
  UPDATE ob1_source_gate g
     SET gates = coalesce(t.metadata->>'status_type' = ANY(node_lifecycle_types()), false)
    FROM thoughts t
   WHERE g.thought_id = ANY(v_ids) AND t.id = g.thought_id
     AND g.gates IS DISTINCT FROM coalesce(t.metadata->>'status_type' = ANY(node_lifecycle_types()), false);
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION ob1_source_gate_status() IS
  'thoughts_node_source_gate_update''s body: from an UPDATE''s transition tables, the thoughts whose status_type moved between one node_lifecycle_types() knows and any other; returns at once when there are none; refuses under REPEATABLE READ; otherwise takes their buckets (ob1_source_gate_lock) and sets their mirror rows'' gates from the rows as they stand. Migration 071 / SMD-2267.';

CREATE OR REPLACE FUNCTION ob1_source_gate_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- TRUNCATE holds ACCESS EXCLUSIVE on thought_sources, which excludes every
  -- writer of it.
  DELETE FROM ob1_source_gate WHERE true;
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION ob1_source_gate_truncate() IS
  'thought_sources_node_gate_truncate''s body: emptying thought_sources — directly or through a cascading truncation of thoughts — leaves no source row, so the mirror is emptied. Migration 071 / SMD-2267.';

DROP TRIGGER IF EXISTS thought_sources_node_gate_insert ON thought_sources;
CREATE TRIGGER thought_sources_node_gate_insert
  AFTER INSERT ON thought_sources REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_source_gate_sync();
DROP TRIGGER IF EXISTS thought_sources_node_gate_update ON thought_sources;
CREATE TRIGGER thought_sources_node_gate_update
  AFTER UPDATE ON thought_sources REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_source_gate_sync();
DROP TRIGGER IF EXISTS thought_sources_node_gate_delete ON thought_sources;
CREATE TRIGGER thought_sources_node_gate_delete
  AFTER DELETE ON thought_sources REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_source_gate_sync();
DROP TRIGGER IF EXISTS thought_sources_node_gate_truncate ON thought_sources;
CREATE TRIGGER thought_sources_node_gate_truncate
  AFTER TRUNCATE ON thought_sources
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_source_gate_truncate();
DROP TRIGGER IF EXISTS thoughts_node_source_gate_update ON thoughts;
CREATE TRIGGER thoughts_node_source_gate_update
  AFTER UPDATE ON thoughts REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_source_gate_status();

-- The seed: a reconcile of every row, so a replay over a current mirror
-- writes nothing.
SELECT * FROM ob1_rebuild_source_gate();
ANALYZE ob1_source_gate;

-- ---------------------------------------------------------------------------
-- node_dependencies — 058's rows, the gate a join to the stored systems
-- ---------------------------------------------------------------------------
-- The gating systems as one array, computed once per call (an initplan), and
-- each link's system tested against it. Not a correlated EXISTS per facet:
-- projected rather than filtered, the planner ran it once per link and, for a
-- system with no gating row, scanned the mirror each time (SMD-2267's probe:
-- 56 ms against 24 for node_state() at 10,000 thoughts) — 058's lesson, on the
-- smaller table. Nor a join to the gating systems: under a row estimate of
-- one for the links it became a nested loop re-reading every gating row per
-- link, and graph-centrality's coverage read took 3.5 s at 30,000 thoughts
-- against 21 ms before this file (first review pass).
CREATE OR REPLACE FUNCTION node_dependencies()
RETURNS TABLE (system text, blocked text, blocker text, active boolean, changed_at timestamptz, gates boolean)
LANGUAGE sql
STABLE
AS $$
  SELECT s.system,
         CASE WHEN f.payload->>'relation' = 'blocked_by' THEN s.identity ELSE f.payload->>'target' END,
         CASE WHEN f.payload->>'relation' = 'blocked_by' THEN f.payload->>'target' ELSE s.identity END,
         f.valid_until IS NULL,
         greatest(f.created_at, f.valid_until),
         s.system = ANY(ARRAY(SELECT DISTINCT o.system FROM ob1_source_gate o WHERE o.gates))
    FROM thought_facets f
    JOIN thought_sources s ON s.thought_id = f.thought_id AND s.system = f.payload->>'system'
   WHERE f.kind = 'link' AND f.payload->>'relation' IN ('blocks', 'blocked_by')
$$;
COMMENT ON FUNCTION node_dependencies() IS
  'One row per blocks / blocked_by link facet (053), open or closed: system, the blocked and blocker identities (a blocks facet names its holder the blocker, a blocked_by its target), active (valid_until unset), changed_at (the later of written and closed) and gates — whether some source row of the system states a known status_type on its own metadata (a status borrowed through a Linear ticket claim does not count). A system that does not gate cannot say a blocker is settled, so node_state reads only gating active links. The gate reads ob1_source_gate, kept current on write. Migration 058 / SMD-2074 (the gate SMD-2218); stored, 071 / SMD-2267.';

-- ---------------------------------------------------------------------------
-- source_thought — 053's resolver, its board-sync fallback by 068's index
-- ---------------------------------------------------------------------------
-- A blocker the brain holds no source row for resolves through the board
-- sync's claim, metadata @> {source: linear, issue: <identity>}, and 001's GIN
-- index answers that by reading the posting list of every row carrying an
-- issue key: 6 ms per blocker at 10,000 thoughts, for one the brain does not
-- hold at all, and more as tickets accumulate (SMD-2267's bench, two in three
-- of whose links name such a ticket: this file's keyed read 47 ms, every
-- thought's 5 s on 068's reads as on these). The same rows by 068's md5 index on the
-- issue: containment of a top-level scalar is equality of that key's value
-- (an array holding it does not contain it below the top level), so the two
-- keys are compared as jsonb, and the md5 of the issue's text narrows the
-- probe to the rows with that text. A NULL identity keeps 053's form, which
-- matches an issue that is JSON null; nothing else changes.
CREATE OR REPLACE FUNCTION source_thought(p_system text, p_identity text)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT thought_id FROM thought_sources WHERE system = p_system AND identity = p_identity),
    -- The board sync's claim (SMD-1954): a linear ticket row is the one carrying
    -- metadata.issue, and of a twin chain the head — the row nothing supersedes.
    (SELECT t.id FROM thoughts t
      WHERE p_system = 'linear' AND p_identity IS NOT NULL
        AND t.metadata ? 'issue' AND md5(t.metadata->>'issue')::uuid = md5(p_identity)::uuid
        AND t.metadata->'issue' = to_jsonb(p_identity) AND t.metadata->'source' = '"linear"'::jsonb
        AND NOT EXISTS (SELECT 1 FROM thoughts n WHERE n.supersedes = t.id)
      ORDER BY t.created_at DESC, t.id LIMIT 1),
    (SELECT t.id FROM thoughts t
      WHERE p_system = 'linear' AND p_identity IS NULL
        AND t.metadata @> jsonb_build_object('source', 'linear', 'issue', p_identity)
        AND NOT EXISTS (SELECT 1 FROM thoughts n WHERE n.supersedes = t.id)
      ORDER BY t.created_at DESC, t.id LIMIT 1)
  )
$$;
COMMENT ON FUNCTION source_thought(text, text) IS
  'The thought a source identity names, or NULL: thought_sources first; for `linear`, the head of the board sync''s twin chain claiming metadata.issue (SMD-1954), so a link facet''s target resolves on a brain the sync filled before 053. Readers resolve link targets through this; the link itself stores the identity. Migration 053 / SMD-1867; the claim found by 068''s issue index, 071 / SMD-2267.';

-- ---------------------------------------------------------------------------
-- ob1_system_gates — one system's gate, by the partial index
-- ---------------------------------------------------------------------------
-- The keyed read asks it once per link. Written inline, the planner chose
-- for it: an EXISTS became a semi-join over the whole mirror (30,001 rows
-- read for forty ids at 100,000 thoughts), and a scalar LIMIT 1 a sequential
-- scan that stops at the first gating row — at once for a system that gates,
-- the whole mirror per link for one that never does (70 ms for forty markdown
-- ids; SMD-2267's probe) — the system being an outer column, the planner
-- cannot see that it is one no row gates. The SET keeps the function from
-- being inlined, and plans its one statement on the index; its plan is
-- cached for the calling query.
CREATE OR REPLACE FUNCTION ob1_system_gates(p_system text)
RETURNS boolean
LANGUAGE sql
STABLE
SET enable_seqscan = off
AS $$ SELECT EXISTS (SELECT 1 FROM ob1_source_gate g WHERE g.system = p_system AND g.gates) $$;
COMMENT ON FUNCTION ob1_system_gates(text) IS
  'Whether a system gates — some source row of it states a known status_type on its own thought (058''s gate, SMD-2218) — as one probe of ob1_source_gate''s partial index. The keyed dependency read''s gate. Migration 071 / SMD-2267.';

-- ---------------------------------------------------------------------------
-- ob1_node_dependencies_of — the dependency columns, every thought or the ids
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_node_dependencies_of(p_ids uuid[])
RETURNS TABLE (thought_id uuid, blockers text[], unknown_blockers text[], in_dependencies boolean)
LANGUAGE sql
STABLE
AS $$
  -- A row per (thought, link naming its ticket): shown is the open blocker a
  -- blocked-side link contributes (NULL for a blocker-side link or a settled
  -- blocker), unknown whether that blocker has no known status. A thought is
  -- listed only when some gating active link names its ticket, so
  -- in_dependencies is true on every row.
  SELECT r.thought_id,
         array_agg(DISTINCT r.shown ORDER BY r.shown) FILTER (WHERE r.shown IS NOT NULL),
         array_agg(DISTINCT r.shown ORDER BY r.shown) FILTER (WHERE r.shown IS NOT NULL AND r.unknown),
         true
    FROM (
      -- Every thought: 058's reads over node_dependencies(), as 068 ran them.
      SELECT w.thought_id, w.shown, w.unknown
        FROM (WITH ticket_of AS (
                     SELECT ts.thought_id, ts.system, ts.identity FROM thought_sources ts
                     UNION
                     SELECT t.id, 'linear', coalesce(t.metadata->>'ticket', t.metadata->>'issue') FROM thoughts t WHERE t.metadata ? 'ticket' OR t.metadata ? 'issue'),
                   deps AS MATERIALIZED (SELECT DISTINCT d.system, d.blocked, d.blocker FROM node_dependencies() d WHERE d.active AND d.gates),
                   blockers AS MATERIALIZED (
                     SELECT d.system, d.blocked, bl.status_type AS blocker_status,
                            CASE WHEN d.system = 'linear' THEN d.blocker ELSE d.system || ':' || d.blocker END AS shown
                       FROM (SELECT d.system, d.blocked, d.blocker, source_thought(d.system, d.blocker) AS blocker_id FROM deps d) d
                       LEFT JOIN node_lifecycle() bl ON bl.thought_id = d.blocker_id
                      WHERE bl.status_type IS NULL OR NOT bl.status_type = ANY(node_settled_types()))
              SELECT k.thought_id, b.shown, (b.blocker_status IS NULL OR NOT b.blocker_status = ANY(node_lifecycle_types())) AS unknown
                FROM ticket_of k JOIN blockers b ON b.system = k.system AND b.blocked = k.identity
              UNION ALL
              SELECT k.thought_id, NULL, NULL FROM ticket_of k
                JOIN (SELECT n.system, n.blocked AS identity FROM deps n UNION SELECT n.system, n.blocker FROM deps n) n
                  ON n.system = k.system AND n.identity = k.identity) w
       WHERE p_ids IS NULL
      UNION ALL
      -- The ids named: each ticket identity's links, probed.
      SELECT k.thought_id,
             CASE WHEN d.blocked_side AND (bl.status_type IS NULL OR NOT bl.status_type = ANY(node_settled_types()))
                  THEN CASE WHEN d.system = 'linear' THEN d.blocker ELSE d.system || ':' || d.blocker END END,
             bl.status_type IS NULL OR NOT bl.status_type = ANY(node_lifecycle_types())
        FROM (SELECT ts.thought_id, ts.system, ts.identity FROM thought_sources ts WHERE ts.thought_id = ANY(p_ids)
              UNION
              SELECT t.id, 'linear', coalesce(t.metadata->>'ticket', t.metadata->>'issue') FROM thoughts t
               WHERE t.id = ANY(p_ids) AND (t.metadata ? 'ticket' OR t.metadata ? 'issue')) k
        CROSS JOIN LATERAL (
          -- A link naming k as its target: a blocks facet makes k the blocked
          -- and its holder the blocker, a blocked_by facet makes k the
          -- blocker. The holder's source row of the link's system gives the
          -- holder's identity, as node_dependencies() joins it.
          SELECT f.payload->>'relation' = 'blocks' AS blocked_side, s.system, s.identity AS blocker
            FROM thought_facets f
            JOIN thought_sources s ON s.thought_id = f.thought_id AND s.system = f.payload->>'system'
           WHERE f.kind = 'link' AND f.payload->>'system' = k.system AND f.payload->>'target' = k.identity
             AND f.payload->>'relation' IN ('blocks', 'blocked_by') AND f.valid_until IS NULL
          UNION ALL
          -- A link the thought whose source identity is k carries: a
          -- blocked_by facet makes k the blocked and its target the blocker, a
          -- blocks facet makes k the blocker.
          SELECT f.payload->>'relation' = 'blocked_by', h.system, f.payload->>'target'
            FROM thought_sources h
            JOIN thought_facets f ON f.thought_id = h.thought_id AND f.kind = 'link'
           WHERE h.system = k.system AND h.identity = k.identity
             AND f.payload->>'system' = h.system AND f.payload->>'relation' IN ('blocks', 'blocked_by') AND f.valid_until IS NULL) d
        -- The blocker's lifecycle, by key; OFFSET 0 so it is not flattened
        -- into a hash of every thought's (SMD-2267's probe: 11.8 ms, then 2.5).
        LEFT JOIN LATERAL (SELECT l.status_type
                             FROM (SELECT source_thought(d.system, d.blocker) AS id WHERE d.blocked_side OFFSET 0) b
                             JOIN node_lifecycle() l ON l.thought_id = b.id
                           OFFSET 0) bl ON true
       -- The gate, a probe of the partial index per link (ob1_system_gates).
       WHERE ob1_system_gates(d.system)) r
   GROUP BY r.thought_id
$$;
COMMENT ON FUNCTION ob1_node_dependencies_of(uuid[]) IS
  'For each thought named (every thought when NULL) that some gating active blocks / blocked_by link names by its ticket: its open blockers (sorted, a linear one bare and another system''s as system:key), those with no known status, and in_dependencies (always true — a thought no such link names is not listed). The ids read their links by index; NULL reads 058''s whole-brain formulation. What node_state''s dependency columns read. Migration 071 / SMD-2267.';

-- ---------------------------------------------------------------------------
-- node_state — 068's, its two dependency joins one keyed join
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION node_state(p_ids uuid[] DEFAULT NULL)
RETURNS TABLE (thought_id uuid, status text, status_type text, synced_at text, created_at timestamptz,
               open boolean, blocked boolean, blockers text[], unknown_blockers text[],
               in_dependencies boolean, superseded_by uuid)
LANGUAGE sql
STABLE
AS $$
  SELECT l.thought_id, l.status, l.status_type, l.synced_at, l.created_at,
         CASE WHEN l.status_type = ANY(node_lifecycle_types()) THEN NOT l.status_type = ANY(node_settled_types()) END,
         (d.blockers IS NOT NULL AND NOT coalesce(l.status_type = ANY(node_settled_types()), false)),
         d.blockers,
         d.unknown_blockers,
         coalesce(d.in_dependencies, false),
         sp.new_id
    FROM node_lifecycle() l
    LEFT JOIN ob1_node_dependencies_of(p_ids) d ON d.thought_id = l.thought_id
    LEFT JOIN ob1_superseded_by sp ON sp.old_id = l.thought_id
   WHERE p_ids IS NULL OR l.thought_id = ANY(p_ids)
$$;
COMMENT ON FUNCTION node_state(uuid[]) IS
  'Per thought (every thought when p_ids is NULL, else those named): node_lifecycle()''s columns; open (known and not settled, NULL when the status_type is missing or unknown); blocked (open blockers, and the thought itself not settled); blockers (its ticket''s open blockers from gating active links, a blocker settled only by its own known lifecycle, sorted, linear bare and another system''s as system:key, NULL when none — kept on a settled thought); unknown_blockers (those with no known status); in_dependencies (a gating active link names its ticket); superseded_by (the newest thought superseding it, NULL when current — ob1_superseded_by''s). Coverage is open IS NOT NULL; freshness is synced_at and created_at, never updated_at. No top-level WITH, so a caller''s planner pulls it up: a read of the lifecycle and superseded_by columns is primary-key lookups from the caller''s ids, and the dependency join runs only when its columns are read — by index from p_ids when given (inlined with its ids; a generic plan scans every thought, SMD-2380), every link when NULL (ob1_node_dependencies_of, the gate stored). The one read graph-centrality and search rank by. Migration 058 / SMD-2074; stored, 068 / SMD-2256; keyed, 071 / SMD-2267.';
