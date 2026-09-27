-- =============================================================================
-- Migration 060: node_state reads a stored projection kept current on write —
--                every ticket's head and every thought's newest superseder
--                (SMD-2256)
-- =============================================================================
--
-- WHY
--   058's node_lifecycle() found each ticket's head with a window over every
--   issue row and a correlated NOT EXISTS, and node_state() each thought's
--   newest superseder with a DISTINCT ON over every pointer — on every call,
--   whatever ids were passed (058: "the ids narrow the rows, not the work").
--   059's search_thoughts_current, prefer_current's function, joins it once
--   per search: +10.7 ms over the hybrid's 1.1 at 10,000 thoughts, +129 ms at
--   100,000, over the budget pre-registered for the flag (at most the
--   hybrid's own median at 10,000). A narrowing that kept the reads and met
--   the budget was prototyped and declined (the ticket carries its numbers):
--   the maintainer chose SMD-1997's direction, a projection stored and kept
--   current on write, so a lifecycle is a lookup for every caller.
--
--   It is fed by the row store, not the log. Every writer reaches thoughts —
--   the three functions, board-sync's in-place head updates, ingest-records'
--   raw upsert, 029's raw supersedes, 025's ON DELETE SET NULL, every test's
--   raw UPDATE — and the log misses what the superseder rule reads (an update
--   event carries no created_at move) and a load with triggers disabled.
--   SMD-1997's fold of status transitions from thought_audit later replaces
--   what feeds these tables, not the tables or the node_* signatures
--   (docs/event-log-as-truth.md).
--
-- WHAT
--   * ob1_ticket_head — one row per issue key a row carries: its head (the
--     issue row nothing supersedes, then the newest metadata.linear_updated_at,
--     then the id — 058's rule) and the head's status, status_type and
--     synced_at. Keyed by md5(issue)::uuid with the issue beside it, so a key
--     of any length never fails a write that succeeds without this file (a
--     btree entry is capped near 2.7 kB); every read rechecks the issue.
--   * ob1_superseded_by — one row per thought some row's supersedes names:
--     the newest successor by (created_at, id) descending — 058's rule.
--   * ob1_superseders_of(uuid[]) and ob1_ticket_heads_of(text[]) — the two
--     rules, once each, NULL for every key: the seed, the rebuild and the
--     triggers all compute through them. Each is a one-time-filtered branch
--     for NULL UNION ALL a branch keyed by unnest(), so a small key set is
--     index probes whatever plan is cached (a runtime `p IS NULL OR x =
--     ANY(p)` is never folded, and the OR takes the index away — SMD-2256's
--     prototype). "Nothing supersedes it" is read from ob1_superseded_by, so
--     superseders are always reconciled before heads.
--   * ob1_node_projection_reconcile(text[], uuid[]) — superseders, then
--     heads: a keyed delete of what vanished and an upsert of what changed.
--   * ob1_rebuild_node_projection() — every key, under the exclusive lock;
--     returns what it wrote and deleted, zeros when exact. The seed below,
--     and the repair after a write made with triggers disabled.
--   * ob1_node_projection_drift() — every stored row against 058's formulas,
--     verbatim and independent of the two rule functions; zero rows when the
--     projection is exact.
--   * Three statement triggers on thoughts, AFTER INSERT / UPDATE / DELETE
--     with transition tables, one function: a statement that touches no row
--     carrying an issue key or a supersedes pointer returns at once (a plain
--     capture needs no privilege here); otherwise the keys it moved — both
--     sides of an issue key's move, the targets of a pointer's move and their
--     issues, a successor's created_at — are locked and reconciled. None
--     writes thoughts.
--   * node_lifecycle() and node_state() read the tables, same signatures,
--     same rows. node_state has no top-level WITH: PostgreSQL does not pull a
--     subquery holding one up into its caller, so 059's join computed the
--     whole brain and hash-joined the window to it. Now the dependency joins
--     (still reads — blockers, unknown_blockers, in_dependencies and
--     node_dependencies()' gate over the status scalar, SMD-2267) are
--     removed from a plan that does not read them, and the rest is driven by
--     primary key from the caller's ids. The tables of a removed join are
--     not permission-checked either, so the search's columns no longer need
--     SELECT on thought_sources.
--
--   Concurrency. Under READ COMMITTED two writers of one ticket's rows would
--   each recompute from a snapshot without the other's row, and the later
--   upsert would keep a stale head. So before it recomputes, the trigger takes
--   transaction advisory locks — a shared global (22560, 0), then each
--   superseder key (22562, hashtext(id)) and each issue key (22561,
--   hashtext(issue)), in hash order — and re-reads the pointer targets' issues
--   until no new key appears; each recompute is a statement after the grant,
--   so it sees every write committed before it. Writers of one ticket
--   serialise until commit. A statement moving more keys than
--   ob1.node_projection_bulk_keys (256) takes the global lock exclusively
--   instead, so a whole-table UPDATE cannot fill the lock table. Under
--   REPEATABLE READ or SERIALIZABLE every key is rewritten, so a concurrent
--   writer of the same key raises a serialization failure rather than skew.
--
-- SAFETY
--   Additive: two tables, one index, six functions, three triggers, and two
--   bodies redefined with their signatures, columns and rows unchanged.
--   SECURITY INVOKER throughout (no SECURITY DEFINER in this repo), so the
--   triggers run as the writing role: db/config.mjs ROLE_GRANTS gives the
--   capture group SELECT, INSERT, UPDATE and DELETE on both tables, and a
--   role granted before this file fails preflight's write-privileges check
--   with the exact GRANT until `migrate.ts --grant` runs again — until then a
--   write of a ticket row or a pointer, and every lifecycle read, is refused
--   on the new tables. Idempotent: IF NOT EXISTS, DROP TRIGGER IF EXISTS,
--   CREATE OR REPLACE, and the seed is a reconcile, not a wipe. The seed runs
--   after the triggers exist; CREATE TRIGGER holds writers off until commit.
--   A write made with thoughts' user triggers disabled bypasses the
--   projection: run SELECT * FROM ob1_rebuild_node_projection() after it
--   (drift() says whether one is needed). MINOR under the version rules.
--
-- Expected outcome
--   SELECT count(*) FROM ob1_node_projection_drift() is 0, node_state() lists
--   what 058's did, and search_thoughts_current adds node_state's lookups to
--   the hybrid's own cost at its wider window (bench-hybrid.ts: +1.05 to +1.86
--   ms at 10,000 thoughts, inside the budget 059 missed; +2.4 to +3.2 ms at
--   100,000, about 1.6 of it the window).
-- Dependencies: 025 (thoughts.supersedes), 058 (node_state).
-- =============================================================================

-- Each prerequisite named on its own, as 058 names its two. Driven by
-- test-upgrade.ts [20m].
DO $g$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'thoughts' AND column_name = 'supersedes') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 060 needs 025 (thoughts.supersedes); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('node_state(uuid[])') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 060 needs 058 (node_state); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$g$;

-- ---------------------------------------------------------------------------
-- The two tables. No foreign keys either way: the triggers own correctness
-- (a cascade would hide their bugs from drift()), and a key would add
-- referential locks on thoughts to every write.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ob1_ticket_head (
  issue_key   uuid PRIMARY KEY,   -- md5(issue)::uuid
  issue       text NOT NULL,      -- metadata->>'issue'
  head_id     uuid NOT NULL,      -- the head row
  status      text,
  status_type text,
  synced_at   text                -- the head's metadata->>'linear_updated_at'
);
COMMENT ON TABLE ob1_ticket_head IS
  'Every issue key a thought carries, with its head (the issue row nothing supersedes, then the newest linear_updated_at, then the id) and the head''s status, status_type and synced_at. A projection of thoughts kept current by the thoughts_node_projection_* triggers; ob1_node_projection_drift() checks it, ob1_rebuild_node_projection() repairs it. Migration 060 / SMD-2256.';

CREATE TABLE IF NOT EXISTS ob1_superseded_by (
  old_id uuid PRIMARY KEY,        -- a thought some row's supersedes names
  new_id uuid NOT NULL            -- its newest successor by (created_at, id) descending
);
COMMENT ON TABLE ob1_superseded_by IS
  'Every thought some row supersedes, with its newest successor by (created_at, id) descending. A projection of thoughts kept current by the thoughts_node_projection_* triggers; ob1_node_projection_drift() checks it, ob1_rebuild_node_projection() repairs it. Migration 060 / SMD-2256.';

-- Finds an issue's rows for the triggers' keyed recompute. 025's partial
-- idx_thoughts_supersedes already serves the superseder rule.
CREATE INDEX IF NOT EXISTS thoughts_issue_key_idx
  ON thoughts ((md5(metadata->>'issue')::uuid)) WHERE metadata ? 'issue';

-- ---------------------------------------------------------------------------
-- The two rules, once each. NULL computes every key.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_superseders_of(p_ids uuid[])
RETURNS TABLE (old_id uuid, new_id uuid)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT ON (c.old_id) c.old_id, c.new_id
    FROM (SELECT s.supersedes AS old_id, s.id AS new_id, s.created_at
            FROM thoughts s WHERE p_ids IS NULL AND s.supersedes IS NOT NULL
          UNION ALL
          SELECT s.supersedes, s.id, s.created_at
            FROM (SELECT DISTINCT k FROM unnest(p_ids) k) u JOIN thoughts s ON s.supersedes = u.k) c
   ORDER BY c.old_id, c.created_at DESC, c.new_id DESC
$$;
COMMENT ON FUNCTION ob1_superseders_of(uuid[]) IS
  'The superseder rule, once: for each thought named (every superseded thought when NULL), its newest successor by (created_at, id) descending — 058''s. What ob1_superseded_by holds. Migration 060 / SMD-2256.';

CREATE OR REPLACE FUNCTION ob1_ticket_heads_of(p_issues text[])
RETURNS TABLE (issue_key uuid, issue text, head_id uuid, status text, status_type text, synced_at text)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT ON (c.issue) md5(c.issue)::uuid, c.issue, c.id, c.status, c.status_type, c.synced_at
    FROM (SELECT p.metadata->>'issue' AS issue, p.id, p.metadata->>'status' AS status,
                 p.metadata->>'status_type' AS status_type, p.metadata->>'linear_updated_at' AS synced_at
            FROM thoughts p
           WHERE p_issues IS NULL AND p.metadata ? 'issue' AND p.metadata->>'issue' IS NOT NULL
          UNION ALL
          SELECT p.metadata->>'issue', p.id, p.metadata->>'status', p.metadata->>'status_type', p.metadata->>'linear_updated_at'
            FROM (SELECT DISTINCT k FROM unnest(p_issues) k WHERE k IS NOT NULL) u
            JOIN thoughts p ON p.metadata ? 'issue' AND md5(p.metadata->>'issue')::uuid = md5(u.k)::uuid
                           AND p.metadata->>'issue' = u.k) c
    LEFT JOIN ob1_superseded_by x ON x.old_id = c.id
   ORDER BY c.issue, (x.old_id IS NULL) DESC, c.synced_at DESC NULLS LAST, c.id
$$;
COMMENT ON FUNCTION ob1_ticket_heads_of(text[]) IS
  'The ticket-head rule, once: for each issue key named (every key a row carries when NULL), the issue row nothing supersedes, then the newest linear_updated_at, then the id — 058''s — with its status, status_type and synced_at. Reads ob1_superseded_by for "nothing supersedes it", so it is reconciled first. What ob1_ticket_head holds. Migration 060 / SMD-2256.';

-- ---------------------------------------------------------------------------
-- Reconcile: superseders, then heads. Keyed when given keys, every key when
-- NULL. Outside READ COMMITTED every key is rewritten (see WHY).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_node_projection_reconcile(p_issues text[], p_ids uuid[])
RETURNS TABLE (heads_written int, heads_deleted int, superseders_written int, superseders_deleted int)
LANGUAGE plpgsql
SET jit = off
AS $$
DECLARE
  v_force boolean := current_setting('transaction_isolation') <> 'read committed';
BEGIN
  heads_written := 0; heads_deleted := 0; superseders_written := 0; superseders_deleted := 0;
  IF p_ids IS NULL THEN
    WITH f AS MATERIALIZED (SELECT * FROM ob1_superseders_of(NULL)),
         d AS (DELETE FROM ob1_superseded_by s WHERE NOT EXISTS (SELECT 1 FROM f WHERE f.old_id = s.old_id) RETURNING 1),
         w AS (INSERT INTO ob1_superseded_by AS s (old_id, new_id) SELECT f.old_id, f.new_id FROM f
                 ON CONFLICT (old_id) DO UPDATE SET new_id = EXCLUDED.new_id
                 WHERE v_force OR s.new_id IS DISTINCT FROM EXCLUDED.new_id
               RETURNING 1)
    SELECT (SELECT count(*) FROM w), (SELECT count(*) FROM d) INTO superseders_written, superseders_deleted;
  ELSIF cardinality(p_ids) > 0 THEN
    WITH f AS MATERIALIZED (SELECT * FROM ob1_superseders_of(p_ids)),
         d AS (DELETE FROM ob1_superseded_by s WHERE s.old_id = ANY(p_ids)
                 AND NOT EXISTS (SELECT 1 FROM f WHERE f.old_id = s.old_id) RETURNING 1),
         w AS (INSERT INTO ob1_superseded_by AS s (old_id, new_id) SELECT f.old_id, f.new_id FROM f
                 ON CONFLICT (old_id) DO UPDATE SET new_id = EXCLUDED.new_id
                 WHERE v_force OR s.new_id IS DISTINCT FROM EXCLUDED.new_id
               RETURNING 1)
    SELECT (SELECT count(*) FROM w), (SELECT count(*) FROM d) INTO superseders_written, superseders_deleted;
  END IF;

  IF p_issues IS NULL THEN
    WITH f AS MATERIALIZED (SELECT * FROM ob1_ticket_heads_of(NULL)),
         d AS (DELETE FROM ob1_ticket_head h WHERE NOT EXISTS (SELECT 1 FROM f WHERE f.issue_key = h.issue_key) RETURNING 1),
         w AS (INSERT INTO ob1_ticket_head AS h (issue_key, issue, head_id, status, status_type, synced_at)
                 SELECT f.issue_key, f.issue, f.head_id, f.status, f.status_type, f.synced_at FROM f
                 ON CONFLICT (issue_key) DO UPDATE SET issue = EXCLUDED.issue, head_id = EXCLUDED.head_id, status = EXCLUDED.status,
                                                       status_type = EXCLUDED.status_type, synced_at = EXCLUDED.synced_at
                 WHERE v_force OR (h.issue, h.head_id, h.status, h.status_type, h.synced_at)
                          IS DISTINCT FROM (EXCLUDED.issue, EXCLUDED.head_id, EXCLUDED.status, EXCLUDED.status_type, EXCLUDED.synced_at)
               RETURNING 1)
    SELECT (SELECT count(*) FROM w), (SELECT count(*) FROM d) INTO heads_written, heads_deleted;
  ELSIF cardinality(p_issues) > 0 THEN
    WITH f AS MATERIALIZED (SELECT * FROM ob1_ticket_heads_of(p_issues)),
         d AS (DELETE FROM ob1_ticket_head h WHERE h.issue_key = ANY(ARRAY(SELECT md5(k)::uuid FROM unnest(p_issues) k))
                 AND NOT EXISTS (SELECT 1 FROM f WHERE f.issue_key = h.issue_key) RETURNING 1),
         w AS (INSERT INTO ob1_ticket_head AS h (issue_key, issue, head_id, status, status_type, synced_at)
                 SELECT f.issue_key, f.issue, f.head_id, f.status, f.status_type, f.synced_at FROM f
                 ON CONFLICT (issue_key) DO UPDATE SET issue = EXCLUDED.issue, head_id = EXCLUDED.head_id, status = EXCLUDED.status,
                                                       status_type = EXCLUDED.status_type, synced_at = EXCLUDED.synced_at
                 WHERE v_force OR (h.issue, h.head_id, h.status, h.status_type, h.synced_at)
                          IS DISTINCT FROM (EXCLUDED.issue, EXCLUDED.head_id, EXCLUDED.status, EXCLUDED.status_type, EXCLUDED.synced_at)
               RETURNING 1)
    SELECT (SELECT count(*) FROM w), (SELECT count(*) FROM d) INTO heads_written, heads_deleted;
  END IF;
  RETURN NEXT;
END
$$;
COMMENT ON FUNCTION ob1_node_projection_reconcile(text[], uuid[]) IS
  'Brings ob1_superseded_by, then ob1_ticket_head, to what the two rules compute for the keys given (every key when NULL; an empty array touches neither table): deletes what vanished, upserts what changed, and returns the counts. Takes no lock itself — the triggers and ob1_rebuild_node_projection() do. Migration 060 / SMD-2256.';

CREATE OR REPLACE FUNCTION ob1_rebuild_node_projection()
RETURNS TABLE (heads_written int, heads_deleted int, superseders_written int, superseders_deleted int)
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(22560, 0);
  RETURN QUERY SELECT * FROM ob1_node_projection_reconcile(NULL, NULL);
END
$$;
COMMENT ON FUNCTION ob1_rebuild_node_projection() IS
  'Reconciles the whole node_state projection under the exclusive lock (22560, 0) and returns what it wrote and deleted — zeros when it was exact. 060''s seed, and the repair after a write made with thoughts'' user triggers disabled. Migration 060 / SMD-2256.';

-- 058's two formulas verbatim, independent of the rule functions above: what
-- a verifier must not share with the thing it verifies.
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
          ORDER BY s.supersedes, s.created_at DESC, s.id DESC)
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
$$;
COMMENT ON FUNCTION ob1_node_projection_drift() IS
  'Every row where the node_state projection differs from 058''s formulas computed fresh — projection (head or superseded_by), key, the stored row and the fresh one as text, NULL where one side has none. Zero rows when exact. Computes the whole brain: a check, not a read path. Migration 060 / SMD-2256.';

-- ---------------------------------------------------------------------------
-- The triggers: what a statement moved, locked, then reconciled.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_node_projection_sync()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_issues  text[];   -- issue keys whose head may have moved
  v_ids     uuid[];   -- superseded thoughts whose newest successor may have moved
  v_targets uuid[];   -- thoughts whose superseded-ness may have moved (their issue's head with it)
  v_locked  text[] := '{}';
  v_more    text[];
  v_bulk    int := coalesce(nullif(current_setting('ob1.node_projection_bulk_keys', true), '')::int, 256);
  k         text;
  i         uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT n.metadata->>'issue') FILTER (WHERE n.metadata->>'issue' IS NOT NULL),
           array_agg(DISTINCT n.supersedes) FILTER (WHERE n.supersedes IS NOT NULL)
      INTO v_issues, v_ids
      FROM new_rows n WHERE n.metadata ? 'issue' OR n.supersedes IS NOT NULL;
    v_targets := v_ids;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT o.metadata->>'issue') FILTER (WHERE o.metadata->>'issue' IS NOT NULL),
           array_agg(DISTINCT o.supersedes) FILTER (WHERE o.supersedes IS NOT NULL)
      INTO v_issues, v_ids
      FROM old_rows o WHERE o.metadata ? 'issue' OR o.supersedes IS NOT NULL;
    v_targets := v_ids;
  ELSE
    -- A row seen on one side only (its id changed, or it gained or lost both
    -- the key and the pointer) moved everything it names.
    SELECT array_agg(DISTINCT m.issue) FILTER (WHERE m.issue IS NOT NULL),
           array_agg(DISTINCT m.sb) FILTER (WHERE m.sb IS NOT NULL),
           array_agg(DISTINCT m.target) FILTER (WHERE m.target IS NOT NULL)
      INTO v_issues, v_ids, v_targets
      FROM (SELECT o.id AS oid, n.id AS nid, o.metadata AS om, n.metadata AS nm,
                   o.supersedes AS os, n.supersedes AS ns, o.created_at AS oc, n.created_at AS nc
              FROM (SELECT r.id, r.metadata, r.supersedes, r.created_at FROM old_rows r
                     WHERE r.metadata ? 'issue' OR r.supersedes IS NOT NULL) o
              FULL JOIN (SELECT r.id, r.metadata, r.supersedes, r.created_at FROM new_rows r
                          WHERE r.metadata ? 'issue' OR r.supersedes IS NOT NULL) n ON n.id = o.id) r
      CROSS JOIN LATERAL (
        SELECT r.oid IS NULL OR r.nid IS NULL
                 OR (r.om->>'issue', r.om->>'status', r.om->>'status_type', r.om->>'linear_updated_at')
                    IS DISTINCT FROM (r.nm->>'issue', r.nm->>'status', r.nm->>'status_type', r.nm->>'linear_updated_at') AS head_moved,
               r.oid IS NULL OR r.nid IS NULL OR r.os IS DISTINCT FROM r.ns AS pointer_moved,
               r.oid IS NULL OR r.nid IS NULL OR r.os IS DISTINCT FROM r.ns OR r.oc IS DISTINCT FROM r.nc AS successor_moved) f
      CROSS JOIN LATERAL (VALUES (r.om->>'issue', r.os), (r.nm->>'issue', r.ns)) v(issue, pointer)
      CROSS JOIN LATERAL (SELECT CASE WHEN f.head_moved THEN v.issue END AS issue,
                                 CASE WHEN f.successor_moved THEN v.pointer END AS sb,
                                 CASE WHEN f.pointer_moved THEN v.pointer END AS target) m;
  END IF;

  IF v_issues IS NULL AND v_ids IS NULL THEN
    RETURN NULL;
  END IF;
  -- Never NULL past here: NULL means every key to the rules.
  v_issues := coalesce(v_issues, '{}');
  v_ids := coalesce(v_ids, '{}');
  v_targets := coalesce(v_targets, '{}');

  IF cardinality(v_issues) + cardinality(v_ids) > v_bulk THEN
    PERFORM pg_advisory_xact_lock(22560, 0);
    v_issues := v_issues || coalesce((SELECT array_agg(DISTINCT t.metadata->>'issue') FROM thoughts t
                                       WHERE t.id = ANY(v_targets) AND t.metadata->>'issue' IS NOT NULL), '{}');
  ELSE
    PERFORM pg_advisory_xact_lock_shared(22560, 0);
    FOR i IN SELECT x FROM unnest(v_ids) x ORDER BY hashtext(x::text), x LOOP
      PERFORM pg_advisory_xact_lock(22562, hashtext(i::text));
    END LOOP;
    -- With no pointer moved there is no target to read: lock the keys and go.
    -- Otherwise read the targets' issues, lock every key not yet locked, and
    -- read them again in a statement after the grant, until no new key
    -- appears: a concurrent move of a target's key is seen once its writer
    -- commits.
    IF cardinality(v_targets) = 0 THEN
      FOR k IN SELECT x FROM unnest(v_issues) x ORDER BY hashtext(x), x LOOP
        PERFORM pg_advisory_xact_lock(22561, hashtext(k));
      END LOOP;
    ELSE LOOP
      v_issues := ARRAY(SELECT DISTINCT x FROM unnest(v_issues || coalesce(
                    (SELECT array_agg(t.metadata->>'issue') FROM thoughts t
                      WHERE t.id = ANY(v_targets) AND t.metadata->>'issue' IS NOT NULL), '{}')) x);
      v_more := ARRAY(SELECT x FROM unnest(v_issues) x WHERE NOT x = ANY(v_locked) ORDER BY hashtext(x), x);
      EXIT WHEN cardinality(v_more) = 0;
      FOREACH k IN ARRAY v_more LOOP
        PERFORM pg_advisory_xact_lock(22561, hashtext(k));
      END LOOP;
      v_locked := v_locked || v_more;
    END LOOP;
    END IF;
  END IF;

  PERFORM ob1_node_projection_reconcile(v_issues, v_ids);
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION ob1_node_projection_sync() IS
  'The thoughts_node_projection_* triggers'' body: from a statement''s transition tables, the issue keys whose head may have moved (both sides of a key''s move, the issues of every pointer target) and the thoughts whose newest successor may have moved; returns at once when the statement touched no row carrying an issue key or a supersedes pointer; otherwise takes the advisory locks (22560 shared, 22562 per superseder, 22561 per issue, in hash order; 22560 exclusive past ob1.node_projection_bulk_keys, default 256) and reconciles. Never writes thoughts. Migration 060 / SMD-2256.';

DROP TRIGGER IF EXISTS thoughts_node_projection_insert ON thoughts;
CREATE TRIGGER thoughts_node_projection_insert
  AFTER INSERT ON thoughts REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_node_projection_sync();
DROP TRIGGER IF EXISTS thoughts_node_projection_update ON thoughts;
CREATE TRIGGER thoughts_node_projection_update
  AFTER UPDATE ON thoughts REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_node_projection_sync();
DROP TRIGGER IF EXISTS thoughts_node_projection_delete ON thoughts;
CREATE TRIGGER thoughts_node_projection_delete
  AFTER DELETE ON thoughts REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_node_projection_sync();

-- The seed: a reconcile of every key, so a replay over a current projection
-- writes nothing.
SELECT * FROM ob1_rebuild_node_projection();
ANALYZE thoughts, ob1_ticket_head, ob1_superseded_by;

-- ---------------------------------------------------------------------------
-- The two reads, same signatures and rows as 058's.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION node_lifecycle()
RETURNS TABLE (thought_id uuid, status text, status_type text, synced_at text, created_at timestamptz)
LANGUAGE sql
STABLE
AS $$
  SELECT t.id,
         coalesce(h.status, t.metadata->>'status'),
         coalesce(h.status_type, t.metadata->>'status_type'),
         coalesce(h.synced_at, t.metadata->>'linear_updated_at'),
         t.created_at
    FROM thoughts t
    LEFT JOIN ob1_ticket_head h ON h.issue_key = md5(coalesce(t.metadata->>'ticket', t.metadata->>'issue'))::uuid
                               AND h.issue = coalesce(t.metadata->>'ticket', t.metadata->>'issue')
$$;
COMMENT ON FUNCTION node_lifecycle() IS
  'Every thought''s lifecycle: status, status_type, synced_at (the source watermark, metadata.linear_updated_at, as text) and created_at. A row carrying `ticket` or `issue` reads its ticket''s head (the issue row nothing supersedes, then the newest sync, then the id), falling back to its own keys; any other row reads its own. The head is ob1_ticket_head''s, kept current on write (060); it reads thoughts and that table. metadata.status_type is a transitional lossy scalar (the transitions are thought_audit''s since 046): SMD-1997''s fold replaces what feeds the table — and node_dependencies()'' gate, the other read of it — not this signature. Migration 058 / SMD-2074; stored, 060 / SMD-2256.';

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
         nm.thought_id IS NOT NULL,
         sp.new_id
    FROM node_lifecycle() l
    LEFT JOIN (
      WITH ticket_of AS (
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
      SELECT k.thought_id,
             array_agg(DISTINCT b.shown ORDER BY b.shown) AS blockers,
             array_agg(DISTINCT b.shown ORDER BY b.shown)
               FILTER (WHERE b.blocker_status IS NULL OR NOT b.blocker_status = ANY(node_lifecycle_types())) AS unknown_blockers
        FROM ticket_of k JOIN blockers b ON b.system = k.system AND b.blocked = k.identity
       GROUP BY k.thought_id) d ON d.thought_id = l.thought_id
    LEFT JOIN (
      WITH ticket_of AS (
             SELECT ts.thought_id, ts.system, ts.identity FROM thought_sources ts
             UNION
             SELECT t.id, 'linear', coalesce(t.metadata->>'ticket', t.metadata->>'issue') FROM thoughts t WHERE t.metadata ? 'ticket' OR t.metadata ? 'issue'),
           deps AS MATERIALIZED (SELECT DISTINCT d.system, d.blocked, d.blocker FROM node_dependencies() d WHERE d.active AND d.gates)
      SELECT DISTINCT k.thought_id FROM ticket_of k
        JOIN (SELECT n.system, n.blocked AS identity FROM deps n UNION SELECT n.system, n.blocker FROM deps n) n
          ON n.system = k.system AND n.identity = k.identity) nm ON nm.thought_id = l.thought_id
    LEFT JOIN ob1_superseded_by sp ON sp.old_id = l.thought_id
   WHERE p_ids IS NULL OR l.thought_id = ANY(p_ids)
$$;
COMMENT ON FUNCTION node_state(uuid[]) IS
  'Per thought (every thought when p_ids is NULL, else those named): node_lifecycle()''s columns; open (known and not settled, NULL when the status_type is missing or unknown); blocked (open blockers, and the thought itself not settled); blockers (its ticket''s open blockers from gating active links, a blocker settled only by its own known lifecycle, sorted, linear bare and another system''s as system:key, NULL when none — kept on a settled thought); unknown_blockers (those with no known status); in_dependencies (a gating active link names its ticket); superseded_by (the newest thought superseding it, NULL when current — ob1_superseded_by''s). Coverage is open IS NOT NULL; freshness is synced_at and created_at, never updated_at. No top-level WITH, so a caller''s planner pulls it up: a read of the lifecycle and superseded_by columns is primary-key lookups from the caller''s ids, and the dependency joins run only when their columns are read (they still compute every link — SMD-2267). The one read graph-centrality and search rank by. Migration 058 / SMD-2074; stored, 060 / SMD-2256.';

-- The window search_thoughts_current reads is at most 100 rows; without the
-- estimate the planner assumes a set-returning function's 1,000 and, on a
-- brain of ten thousand, hash-joins the whole of thoughts to a window of
-- forty rather than looking forty up. A later migration that redefines the
-- hybrid restates it (CREATE OR REPLACE resets an unstated ROWS to 1,000).
ALTER FUNCTION search_thoughts_hybrid(vector, text, float, int, jsonb, float, float) ROWS 100;
