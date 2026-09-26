-- =============================================================================
-- Migration 058: node_state — one read of a thought's lifecycle, blockers and
--                supersession, for every ranking surface (SMD-2074)
-- =============================================================================
--
-- WHY
--   db/graph-centrality.ts learnt to read a thought's lifecycle (SMD-1994: the
--   status board-sync stamps on metadata), whether an open blocker holds it
--   (SMD-2061/2181: 053's blocks / blocked_by link facets) and which sources
--   can say a blocker is settled (SMD-2218) — as two SQL fragments private to
--   that one script. Attention is not actionability in search either, and a
--   second ranking surface would have copied the joins. The server cannot
--   import a db/ script (its image carries db/config.mjs and db/version.mjs
--   alone) and its PostgREST store reaches only RPCs, so the one definition
--   every consumer shares is SQL, here. graph-centrality is its first reader;
--   search is the second (SMD-2074's second PR).
--
--   The status is `metadata.status_type`, a TRANSITIONAL, LOSSY scalar: the
--   board sync overwrites it each pass, and the transitions themselves are on
--   thought_audit since 046. Under SMD-1997's event log node_state is the first
--   read-model fold (docs/event-log-as-truth.md); when that fold lands it
--   replaces the two reads of the scalar — node_lifecycle()'s body and
--   node_dependencies()' gate, which reads a source row's own status_type —
--   and the signatures below are what it keeps, so no caller changes. The link
--   facets and the supersedes pointer are already event-shaped (append and
--   close; a pointer on the newer row).
--
-- WHAT
--   Five functions holding graph-centrality's rules as they stood at
--   ec9693ef — the ticket-head rule and the blocker resolution verbatim, the
--   rest reshaped into rows a second reader can use (closed facets as rows,
--   the gate per system, the unknown blockers per thought) — so its reports
--   are byte-identical on top of them (test-schema [44], and the live drop-in
--   diff in changes/smd-2074.md), bar one count noted there.
--
--   * node_lifecycle_types() / node_settled_types() — IMMUTABLE: the six
--     status types this schema knows (Linear's) and the two that settle a
--     ticket (completed, canceled). The one place each set is written;
--     graph-centrality refuses to run when its own constants disagree.
--   * node_lifecycle() — per thought: status, status_type, synced_at (the
--     source's own watermark, metadata.linear_updated_at, as text) and
--     created_at. A row's lifecycle is its TICKET's: one head per
--     metadata.issue — the row nothing supersedes, then the newest sync, then
--     the id — and every row carrying `ticket` or `issue` reads its head's
--     keys, falling back to its own; a row with no ticket reads its own. Reads
--     `thoughts` alone, so a role without thought_sources can call it.
--   * node_dependencies() — one row per blocks / blocked_by link facet, open or
--     closed: the system, the blocked and the blocker identity (a `blocks`
--     facet names its holder the blocker, a `blocked_by` its target), whether
--     it is active (valid_until unset), when it last changed, and whether its
--     system GATES — some source row of that system states, on its own
--     metadata, a known status_type (SMD-2218: a status borrowed through a
--     Linear ticket claim does not count). A system that states none cannot
--     say a blocker is settled, so its links hold nothing.
--   * node_state(p_ids) — per thought (every thought when p_ids is NULL, else
--     those named): node_lifecycle()'s five columns, then
--       open             — known and not settled; NULL when the status_type is
--                          missing or unknown (no claim either way);
--       blockers         — the ticket's OPEN blockers, from its gating active
--                          links: a blocker is open unless its own lifecycle,
--                          read through source_thought() (053), is settled; a
--                          blocker the brain does not hold, or with no known
--                          status, stays. Sorted, a `linear` one bare and
--                          another system's as system:key; NULL when none.
--                          Raw facts: a settled thought keeps its ticket's.
--       blocked          — the rule: blockers, and the thought itself not
--                          settled (Linear keeps a relation after a ticket
--                          completes; that ticket is settled, not blocked);
--       unknown_blockers — those blockers with no known status;
--       in_dependencies  — some gating active link names its ticket, either
--                          side;
--       superseded_by    — the newest thought whose `supersedes` names it
--                          (created_at, then id, descending — the rule the
--                          server's supersededAmong labels with); NULL when
--                          current.
--     A row's ticket is its source identity (thought_sources), else its
--     `ticket`, else its `issue` (the board sync's linear claim).
--
--   Coverage and freshness are columns, not a count function: a node carries
--   a lifecycle when its status_type is in node_lifecycle_types() (`open` is
--   non-NULL exactly then); freshness is synced_at, and created_at the node's
--   age — never thoughts.updated_at, which every UPDATE moves. The dependency
--   read's are node_dependencies()'s active, gates and changed_at. Each
--   consumer aggregates them over the population it ranks.
--
--   Functions, not a view: no migration ships one and a view needs its own
--   grant row. p_ids narrows the ROWS, not the work: the lifecycle (a window
--   over every ticket row) and the dependency resolution are computed for the
--   whole brain whatever ids are passed, and the filter applies last — a
--   search calling it per query pays that each time (first review pass; the
--   second PR measures it and, if it must, narrows the reads to the tickets of
--   the ids under this same signature). LANGUAGE sql, one SELECT
--   each, no SET, not STRICT, not SECURITY DEFINER — so a caller's planner
--   inlines them and a NULL p_ids folds away. String bodies, so the functions
--   record no dependencies and a reset drops them in any order.
--
-- SAFETY
--   Additive: five functions, reads only, STABLE (the two type sets
--   IMMUTABLE), SECURITY INVOKER, no GRANT (EXECUTE is PUBLIC; the tables'
--   privileges decide — node_lifecycle() needs SELECT on thoughts, the capture
--   group; node_dependencies() and node_state() also thought_sources, the
--   structure group, and thought_facets, the capture group; db/config.mjs
--   ROLE_GRANTS). Idempotent: CREATE OR REPLACE. MINOR under the version
--   rules. The guard first, 052's shape: without 025's pointer or 053's tables
--   the bodies would fail at CREATE bare, so refuse naming the migration.
--
--   One trap for whoever edits this next (012's): CREATE OR REPLACE cannot
--   change a function's return type, and each RETURNS TABLE below IS one —
--   node_state's columns are the contract search reads. A later migration that
--   reshapes one must DROP FUNCTION it first (no grant or dependency is lost:
--   none is issued, and string bodies record none), and adding a column is a
--   reshape.
--
-- Expected outcome
--   SELECT * FROM node_state() lists every thought with its lifecycle and
--   blockers; graph-centrality --startable reads it.
-- Dependencies: 001, 025 (thoughts.supersedes), 042 (thought_facets), 053
--   (thought_sources, the link kind, source_thought).
-- =============================================================================

-- Each prerequisite named on its own, as 056 names its two. Driven by
-- test-upgrade.ts [20k].
DO $g$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'thoughts' AND column_name = 'supersedes') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 058 needs 025 (thoughts.supersedes); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regclass('thought_sources') IS NULL OR to_regprocedure('source_thought(text, text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 058 needs 053 (thought_sources, source_thought); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$g$;

-- ---------------------------------------------------------------------------
-- The two status sets
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION node_lifecycle_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$ SELECT '{triage,backlog,unstarted,started,completed,canceled}'::text[] $$;

COMMENT ON FUNCTION node_lifecycle_types() IS
  'The status types node_state knows — Linear''s six state types, in board order. A status_type outside them is unknown: no lifecycle, no claim that a blocker is settled. graph-centrality.ts''s LIFECYCLE_TYPES must equal it. Migration 058 / SMD-2074.';

CREATE OR REPLACE FUNCTION node_settled_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$ SELECT '{completed,canceled}'::text[] $$;

COMMENT ON FUNCTION node_settled_types() IS
  'The status types that settle a node: a settled blocker blocks nothing and a settled thought is not blocked. graph-centrality.ts''s LIFECYCLE_FILTERS.done must equal it. Migration 058 / SMD-2074.';

-- ---------------------------------------------------------------------------
-- node_lifecycle — the status, the seam SMD-1997's fold replaces
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION node_lifecycle()
RETURNS TABLE (thought_id uuid, status text, status_type text, synced_at text, created_at timestamptz)
LANGUAGE sql
STABLE
AS $$
  WITH heads AS (
    SELECT p.metadata->>'issue' AS issue, p.metadata->>'status' AS status, p.metadata->>'status_type' AS status_type, p.metadata->>'linear_updated_at' AS synced_at,
           row_number() OVER (PARTITION BY p.metadata->>'issue'
                              ORDER BY (NOT EXISTS (SELECT 1 FROM thoughts s WHERE s.supersedes = p.id)) DESC, p.metadata->>'linear_updated_at' DESC NULLS LAST, p.id) AS rn
      FROM thoughts p WHERE p.metadata ? 'issue')
  SELECT t.id,
         coalesce(h.status, t.metadata->>'status'),
         coalesce(h.status_type, t.metadata->>'status_type'),
         coalesce(h.synced_at, t.metadata->>'linear_updated_at'),
         t.created_at
    FROM thoughts t
    LEFT JOIN heads h ON h.rn = 1 AND h.issue = coalesce(t.metadata->>'ticket', t.metadata->>'issue')
$$;

COMMENT ON FUNCTION node_lifecycle() IS
  'Every thought''s lifecycle: status, status_type, synced_at (the source watermark, metadata.linear_updated_at, as text) and created_at. A row carrying `ticket` or `issue` reads its ticket''s head (the issue row nothing supersedes, then the newest sync, then the id), falling back to its own keys; any other row reads its own. Reads thoughts only. metadata.status_type is a transitional lossy scalar (the transitions are thought_audit''s since 046): SMD-1997''s fold replaces this body — and node_dependencies()'' gate, the other read of it — not this signature. Migration 058 / SMD-2074.';

-- ---------------------------------------------------------------------------
-- node_dependencies — the blocks / blocked_by links, and which systems gate
-- ---------------------------------------------------------------------------
-- The gate is one grouped pass over the source rows, joined, not a correlated
-- EXISTS: projected rather than filtered (coverage reads `gates` for every
-- facet), the planner ran an EXISTS once per facet, and a system that states no
-- status — the one the gate is for — scanned every one of its rows for each of
-- its links (first review pass: 5.4 s against 0.36 s at 2,000 such links).
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
         g.gates
    FROM thought_facets f
    JOIN thought_sources s ON s.thought_id = f.thought_id AND s.system = f.payload->>'system'
    JOIN (SELECT o.system, coalesce(bool_or(t.metadata->>'status_type' = ANY(node_lifecycle_types())), false) AS gates
            FROM thought_sources o JOIN thoughts t ON t.id = o.thought_id
           GROUP BY o.system) g ON g.system = s.system
   WHERE f.kind = 'link' AND f.payload->>'relation' IN ('blocks', 'blocked_by')
$$;

COMMENT ON FUNCTION node_dependencies() IS
  'One row per blocks / blocked_by link facet (053), open or closed: system, the blocked and blocker identities (a blocks facet names its holder the blocker, a blocked_by its target), active (valid_until unset), changed_at (the later of written and closed) and gates — whether some source row of the system states a known status_type on its own metadata (a status borrowed through a Linear ticket claim does not count). A system that does not gate cannot say a blocker is settled, so node_state reads only gating active links. Migration 058 / SMD-2074 (the gate SMD-2218).';

-- ---------------------------------------------------------------------------
-- node_state — the per-thought read
-- ---------------------------------------------------------------------------
-- `lc` is referenced twice (the rows, and a blocker's own lifecycle), so it is
-- computed once. A blocker resolves once per distinct link through
-- source_thought(), 053's resolver, and reads that thought's lifecycle row, so
-- a blocker's status is its ticket head's.
CREATE OR REPLACE FUNCTION node_state(p_ids uuid[] DEFAULT NULL)
RETURNS TABLE (thought_id uuid, status text, status_type text, synced_at text, created_at timestamptz,
               open boolean, blocked boolean, blockers text[], unknown_blockers text[],
               in_dependencies boolean, superseded_by uuid)
LANGUAGE sql
STABLE
AS $$
  WITH lc AS (SELECT l.thought_id, l.status, l.status_type, l.synced_at, l.created_at FROM node_lifecycle() l),
       ticket_of AS (
         SELECT ts.thought_id, ts.system, ts.identity FROM thought_sources ts
         UNION
         SELECT t.id, 'linear', coalesce(t.metadata->>'ticket', t.metadata->>'issue') FROM thoughts t WHERE t.metadata ? 'ticket' OR t.metadata ? 'issue'),
       deps AS MATERIALIZED (SELECT DISTINCT d.system, d.blocked, d.blocker FROM node_dependencies() d WHERE d.active AND d.gates),
       blockers AS MATERIALIZED (
         SELECT d.system, d.blocked, bl.status_type AS blocker_status,
                CASE WHEN d.system = 'linear' THEN d.blocker ELSE d.system || ':' || d.blocker END AS shown
           FROM (SELECT d.system, d.blocked, d.blocker, source_thought(d.system, d.blocker) AS blocker_id FROM deps d) d
           LEFT JOIN lc bl ON bl.thought_id = d.blocker_id
          WHERE bl.status_type IS NULL OR NOT bl.status_type = ANY(node_settled_types())),
       dependency AS (
         SELECT k.thought_id,
                array_agg(DISTINCT b.shown ORDER BY b.shown) AS blockers,
                array_agg(DISTINCT b.shown ORDER BY b.shown)
                  FILTER (WHERE b.blocker_status IS NULL OR NOT b.blocker_status = ANY(node_lifecycle_types())) AS unknown_blockers
           FROM ticket_of k JOIN blockers b ON b.system = k.system AND b.blocked = k.identity
          GROUP BY k.thought_id),
       named AS (
         SELECT DISTINCT k.thought_id FROM ticket_of k
           JOIN (SELECT n.system, n.blocked AS identity FROM deps n UNION SELECT n.system, n.blocker FROM deps n) n
             ON n.system = k.system AND n.identity = k.identity),
       superseders AS (
         SELECT DISTINCT ON (s.supersedes) s.supersedes AS old_id, s.id AS new_id
           FROM thoughts s WHERE s.supersedes IS NOT NULL
          ORDER BY s.supersedes, s.created_at DESC, s.id DESC)
  SELECT l.thought_id, l.status, l.status_type, l.synced_at, l.created_at,
         CASE WHEN l.status_type = ANY(node_lifecycle_types()) THEN NOT l.status_type = ANY(node_settled_types()) END,
         (d.blockers IS NOT NULL AND NOT coalesce(l.status_type = ANY(node_settled_types()), false)),
         d.blockers,
         d.unknown_blockers,
         nm.thought_id IS NOT NULL,
         sp.new_id
    FROM lc l
    LEFT JOIN dependency d   ON d.thought_id  = l.thought_id
    LEFT JOIN named nm       ON nm.thought_id = l.thought_id
    LEFT JOIN superseders sp ON sp.old_id     = l.thought_id
   WHERE p_ids IS NULL OR l.thought_id = ANY(p_ids)
$$;

COMMENT ON FUNCTION node_state(uuid[]) IS
  'Per thought (every thought when p_ids is NULL, else those named): node_lifecycle()''s columns; open (known and not settled, NULL when the status_type is missing or unknown); blocked (open blockers, and the thought itself not settled); blockers (its ticket''s open blockers from gating active links, a blocker settled only by its own known lifecycle, sorted, linear bare and another system''s as system:key, NULL when none — kept on a settled thought); unknown_blockers (those with no known status); in_dependencies (a gating active link names its ticket); superseded_by (the newest thought superseding it, NULL when current). Coverage is open IS NOT NULL; freshness is synced_at and created_at, never updated_at. p_ids narrows the rows, not the work: the whole brain is computed and filtered last. The one read graph-centrality and search rank by. Migration 058 / SMD-2074.';
