-- ============================================================================
-- 026 — trace_provenance bounds its WORK, not only its output
--
-- Why (Linear SMD-1288, a follow-up 025's own trace_provenance header named)
--   025's trace_provenance walked UP the derived_from chain with a
--   `WITH RECURSIVE … UNION ALL` and an outer `ORDER BY depth, thought_id
--   LIMIT v_node_cap`. Its guards were real but partial: the `visited` array +
--   `parent.id = ANY(w.visited)` + the depth clamp bounded CYCLES, and the outer
--   LIMIT bounded OUTPUT. Neither bounded the WORK in between.
--
--   The reason is structural: a recursive CTE's `visited` is PER-PATH. Each
--   branch of the recursion carries its own copy, and rows produced in one
--   iteration cannot see one another, so two paths that reach the same node both
--   keep going. On a cycle-free but DENSE DAG — a thought whose derived_from
--   fans out to several sources, each fanning out again, sources reused across
--   branches — that expands multiplicatively: up to ~fanout^depth PATHS (a
--   5-way derivation ten deep is ~10M) are all materialised by the UNION ALL
--   before the outer LIMIT can trim a single row. The read did far more work
--   than its handful of returned rows suggested.
--
--   No shipped writer produces such a row: upsert_thought validates derived_from
--   (an array of existing UUIDs, small fan-out for a real synthesis) and
--   update_thought does not touch the column. It takes a hand-written deep,
--   dense DAG (direct SQL, COPY, a future writer). 025's review found it
--   MEDIUM-adversarial and deferred it here, and 025's header names SMD-1288 as
--   the ticket that bounds the work. This migration is that bound.
--
-- The fix — change the SHAPE, keep the contract
--   A recursive CTE cannot share a visited set across sibling branches; that is
--   exactly why the work is unbounded, and no clamp bolted onto the CTE fixes
--   it. So trace_provenance becomes an ITERATIVE, level-by-level breadth-first
--   walk in plpgsql that carries a WALK-GLOBAL `v_seen` set. A node enters
--   v_seen — and so the frontier — at most once, so its derived_from is scanned
--   at most once. The walk is now O(V + E) over the REACHABLE subgraph, not
--   O(fanout^depth); and the loop stops the moment the node cap is reached, so a
--   graph larger than the cap costs the cap, not the graph. (The ticket's option
--   1, a walk-global visited via a different shape, plus option 2, terminate
--   past node_cap. Option 3, a statement_timeout backstop, is declined: once the
--   bound is structural — O(V+E), cap-terminated — a timeout would only mask a
--   regression, not add a guarantee.)
--
--   Measured before/after on the same dense DAG, one shared Postgres, via
--   db/measure-1288.ts (each layer derives from every node of the next, so
--   root→leaf paths = fanout^depth while distinct nodes = fanout*depth+1):
--
--     fan-out 4, 8 layers (33 nodes, ~65,536 paths; trace depth 8):
--       OLD (025 per-path CTE):  ~202 ms, and its 250-row output cap was spent
--         on DUPLICATE shallow paths — it never reached the deepest layers.
--       NEW (026 walk-global BFS): ~3.4 ms, 117 edge-rows covering ALL 33
--         distinct nodes. ~60× faster AND more complete.
--     fan-out 6, 10 layers (61 nodes, ~60,000,000 paths; trace depth 10):
--       OLD: did not finish — killed by a 20 s guard timeout.
--       NEW: ~3.8 ms.
--
--   Two things to read there. The speed (fanout^depth → V+E), and the
--   completeness: the old outer LIMIT bounded OUTPUT by counting duplicate
--   paths, so on a dense graph it capped out among shallow repeats and never
--   surfaced the deep distinct ancestors; the new walk emits each derivation
--   edge once and reaches every node within the cap. The ratios are a property
--   of the shape, not of one machine. (Recorded again in FORK.md's 026 section.)
--
-- What the output contract keeps (Verify: the 025 guarantees still hold)
--   Same signature, same RETURNS TABLE, same clamps (depth 1..10, nodes
--   1..2000). The linear chain still returns child@0, parent@1, grandparent@2,
--   every row cycle=false, each parented by the thought that derived from it. A
--   forced cycle still yields a cycle=true row and a bounded row count. The
--   `cycle` flag's meaning is refined to fit a global-visited walk, and is more
--   correct on a DAG than the per-path flag was:
--
--     * A DIAMOND — two direct sources that share a grandparent, the common
--       dense-provenance shape — reaches the shared ancestor twice WITHIN one
--       depth level. v_seen is a start-of-level snapshot (updated only after the
--       level's rows are emitted), so both edges see the ancestor as not-yet-seen
--       and emit it cycle=false, once from each of its two parents — 025's
--       per-path output — while it is EXPANDED only once.
--     * A true BACK-EDGE to a node discovered at a strictly earlier level (the
--       forced gp → child → parent → gp) is flagged cycle=true and not
--       re-expanded: the walk terminates.
--     * Cross-depth re-convergence in a DAG (a node reachable at two different
--       depths) is also flagged cycle=true. This is the one honest imprecision:
--       a global-visited walk cannot tell a re-convergence from a real cycle
--       without the per-path ancestry that is exactly the blow-up being removed.
--       It only ever OVER-flags a repeat; it never loops and never drops a
--       distinct ancestor.
--
-- What a successor to trace_provenance must carry
--   The walk-global dedup (each node expanded once) and its sentinel
--   `ob1:provenance-walk-bounded` — dropping either reopens SMD-1288. The
--   depth/node clamps. 025's defensive element cleaning: coerce a non-array
--   derived_from to '[]' and keep only UUID-shaped elements BEFORE the ::uuid
--   cast, so a hand-written bad element is skipped rather than raising inside the
--   read, while the PK join stays index-driven. The plain SECURITY INVOKER,
--   ungranted, tier-free body 025 departures 1 and 2 established.
--
-- Safety
--   * One function, by CREATE OR REPLACE, same signature and same RETURNS TABLE
--     (so REPLACE is legal — a changed OUT-column list would need a DROP). No
--     column, index, constraint, or other function is touched: find_derivatives
--     (a single-level @> lookup) is unaffected, and so are upsert_thought, the
--     audit trigger, and the two provenance columns.
--   * Privileges unchanged: plain SECURITY INVOKER, no GRANT (none survives off
--     Supabase; the precedent 004/008/010/016/025 set).
--   * Idempotent: CREATE OR REPLACE; the COMMENT is re-issued.
--
-- Prerequisites
--   Migration 025 (the columns this reads and the trace_provenance body this
--   replaces). Applied by `bun db/migrate.ts`.
--
-- Expected outcome
--   trace_provenance returns the same ancestor set as before on every well-formed
--   chain, but expands each reachable node once — a dense DAG that made the old
--   walk materialise fanout^depth paths now costs O(V + E), and any walk stops at
--   the node cap. find_derivatives is unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION trace_provenance(
  p_thought_id uuid,
  p_max_depth  int DEFAULT 3,
  p_node_cap   int DEFAULT 250
)
RETURNS TABLE (
  thought_id        uuid,
  depth             int,
  parent_id         uuid,
  content           text,
  type              text,
  source_type       text,
  derivation_method text,
  created_at        timestamptz,
  cycle             boolean
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  -- Clamp the walk. The caps bound it regardless of what the caller asks; the
  -- shape below (walk-global v_seen, cap-terminated loop) is what makes the WORK
  -- bounded too, not only these numbers — see the header and SMD-1288.
  v_max_depth int    := GREATEST(1, LEAST(COALESCE(p_max_depth, 3), 10));
  v_node_cap  int    := GREATEST(1, LEAST(COALESCE(p_node_cap, 250), 2000));
  v_seen      uuid[];        -- every node discovered so far; WALK-GLOBAL, so a
                             -- node reused across branches is expanded once.
  v_frontier  uuid[];        -- the nodes to expand at the current level.
  v_next      uuid[];        -- the not-yet-seen parents found this level.
  v_depth     int    := 0;
  v_emitted   int    := 0;   -- rows returned so far; the loop stops at the cap.
  v_rows      int;
  -- ob1:provenance-walk-bounded — a CONTRACT SENTINEL (the 014 convention),
  -- read by db/test-schema.ts. It marks that this walk expands each node once
  -- via a walk-global seen set — the bound SMD-1288 required and the per-path
  -- recursive CTE could not give. A redefinition must keep the property and this
  -- string, or the test fails.
BEGIN
  IF p_thought_id IS NULL THEN RETURN; END IF;

  -- Depth 0: the root itself. If it does not exist, the walk is empty (the same
  -- as the old CTE's anchor returning no row).
  RETURN QUERY
    SELECT t.id, 0, NULL::uuid, t.content,
           t.metadata->>'type', t.metadata->>'source_type',
           t.metadata->>'derivation_method', t.created_at, false
    FROM thoughts t
    WHERE t.id = p_thought_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RETURN; END IF;

  v_seen     := ARRAY[p_thought_id];
  v_frontier := ARRAY[p_thought_id];
  v_emitted  := 1;

  -- One iteration per depth level. Expand the whole frontier together, emit its
  -- parents, then keep only the not-yet-seen parents as the next frontier. A
  -- node enters v_seen (and the frontier) at most once, so its derived_from is
  -- scanned at most once: O(V + E), not O(fanout^depth). The loop also ends the
  -- moment the cap is reached.
  WHILE v_depth < v_max_depth
        AND v_frontier IS NOT NULL AND array_length(v_frontier, 1) > 0
        AND v_emitted < v_node_cap LOOP
    v_depth := v_depth + 1;

    -- Emit every (child -> parent) edge from the current frontier. `cycle` is
    -- tested against v_seen as the START-OF-LEVEL snapshot: v_seen is not
    -- updated until after this emit and the next-frontier query below, so a
    -- shared ancestor reached twice WITHIN this level reads as not-yet-seen on
    -- both edges (a diamond keeps 025's cycle=false output), while a back-edge
    -- to an earlier level reads cycle=true and is not re-expanded. Order tree
    -- edges (cycle=false) before repeat edges, then by id, so a truncating cap
    -- keeps real ancestors over repeat markers, deterministically.
    --
    -- 025's element cleaning, verbatim: a row written outside upsert_thought
    -- could hold a non-array or non-UUID derived_from; coerce a non-array to '[]'
    -- and keep only UUID-shaped elements BEFORE the ::uuid cast, so a bad element
    -- is skipped rather than raising inside the read, and the PK join to `parent`
    -- stays index-driven.
    RETURN QUERY
      SELECT parent.id, v_depth, edge.child, parent.content,
             parent.metadata->>'type', parent.metadata->>'source_type',
             parent.metadata->>'derivation_method', parent.created_at,
             (parent.id = ANY(v_seen)) AS is_cycle
      FROM (
        SELECT DISTINCT w.child AS child, p.parent_id_text
        FROM unnest(v_frontier) AS w(child)
        JOIN thoughts t ON t.id = w.child
        CROSS JOIN LATERAL (
          SELECT elem AS parent_id_text
          FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(t.derived_from) = 'array' THEN t.derived_from ELSE '[]'::jsonb END
          ) AS elem
          WHERE elem ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ) AS p
      ) AS edge
      JOIN thoughts parent ON parent.id = edge.parent_id_text::uuid
      ORDER BY (parent.id = ANY(v_seen)) ASC, parent.id ASC
      LIMIT (v_node_cap - v_emitted);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_emitted := v_emitted + v_rows;

    -- The not-yet-seen parents become the next level's frontier and enter v_seen
    -- now — after the emit, so this level's cycle flags were computed against the
    -- start-of-level set. A second scan of the same small, PK-joined frontier;
    -- the alternative (capturing the emitted rows into a variable) cannot ride a
    -- RETURN QUERY. DISTINCT so a diamond's shared parent is expanded once.
    SELECT array_agg(DISTINCT parent.id)
      INTO v_next
      FROM unnest(v_frontier) AS w(child)
      JOIN thoughts t ON t.id = w.child
      CROSS JOIN LATERAL (
        SELECT elem AS parent_id_text
        FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(t.derived_from) = 'array' THEN t.derived_from ELSE '[]'::jsonb END
        ) AS elem
        WHERE elem ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ) AS p
      JOIN thoughts parent ON parent.id = p.parent_id_text::uuid
      WHERE NOT (parent.id = ANY(v_seen));

    v_seen     := v_seen || COALESCE(v_next, ARRAY[]::uuid[]);
    v_frontier := COALESCE(v_next, ARRAY[]::uuid[]);
  END LOOP;
END;
$$;

COMMENT ON FUNCTION trace_provenance(uuid, int, int) IS
  'Walks UP the derived_from chain from a thought (depth 0) to its ancestors. Iterative breadth-first with a WALK-GLOBAL seen set: each reachable node is expanded once, so the walk is O(V+E), not O(fanout^depth) on a dense DAG (migration 026 / SMD-1288). Depth clamped 1-10, node count clamped 1-2000, and the walk stops at the cap. cycle=true marks an edge to an already-discovered node (a real back-edge, or a DAG re-convergence at a greater depth) — it is returned once and not re-expanded; a same-level diamond stays cycle=false from each parent. type/source_type/derivation_method come from metadata.';
