-- ============================================================================
-- 024 — thought_stats_summary(): the whole corpus in one aggregate
--
-- Why (Linear SMD-1249; upstream NateBJones-Projects/OB1#470 is the same shape)
--   thought_stats computes its aggregates in application code. The tool loops
--   store.pageThoughtMeta(offset, 1000) and tallies type/topic/people counts in
--   JS, up to a STATS_MAX_ROWS = 100,000 ceiling, then sets truncated = true and
--   returns anyway. Two problems, and only one is speed.
--
--   The cap is a correctness cliff. Past 100,000 thoughts the breakdowns are
--   computed from an arbitrary newest-100k prefix while `Total thoughts` is the
--   real total — a corpus-wide number beside partial aggregates, with a one-line
--   note the only tell. That is the exact defect class fork fix 3 (SMD-970)
--   removed from Supabase's silent 1000-row page: fix 3 made the boundary
--   explicit and visible; it did not delete the boundary. This does.
--
--   And the reason for the walk is gone on this path. The old comment said the
--   ceiling kept a very large brain from exhausting the Edge Function's time
--   budget. There is no Edge Function here: store-sql.ts talks to Postgres
--   directly over Bun.sql, and Postgres aggregates the whole table in one
--   statement. store-postgrest.ts (Workers) keeps the capped walk, because
--   PostgREST cannot call this and cannot aggregate server-side; the two stores
--   already differ this way elsewhere, and now say so at the interface.
--
--   Adapted from upstream's recipes/edge-function-cost-optimization migration,
--   which has exactly this function. Only that function — NOT its 3-arg
--   upsert_thought(text, jsonb, vector), which overlaps 004/007/022, where 022's
--   chunk-replacement semantics are load-bearing and further along than theirs.
--
-- STABLE, and no ROWS
--   Reads only; the same statement sees the same rows throughout, so STABLE (not
--   VOLATILE) — it may be folded and the planner may cache it within a query.
--   019 declared ROWS on match_thoughts/…_hybrid because those RETURN SETOF and
--   the row estimate drives the plan above them. This returns a single jsonb
--   scalar: ROWS does not apply and is deliberately absent. LANGUAGE SQL (not
--   plpgsql) so the body is one inlinable statement, as upstream wrote it.
--   No SET search_path clause: the body touches only thoughts.metadata and
--   created_at, never the `vector` type, so migration 023-era search_path
--   concerns (SMD-1247) do not reach it.
--
-- The plan, measured not assumed (the fork's rule, SMD-925/019)
--   The topic and people arms unnest metadata->'topics' / ->'people' across the
--   whole table, and there is no index for that (GIN on metadata would not serve
--   jsonb_array_elements_text anyway). EXPLAIN (ANALYZE, BUFFERS) confirms a full
--   scan of thoughts feeding each arm — a HashAggregate over a Seq Scan up to
--   ~10,000 rows, a parallel Finalize GroupAggregate above it — and that is the
--   right cost for this tool: thought_stats is a human-invoked summary, called
--   once, never in a loop or a hot path, and the heap it scans is small (metadata
--   is inline jsonb, not the TOASTed vector, so this is nothing like
--   match_thoughts' detoast cost in 019). If a brain ever makes even this too
--   slow, the answer is a materialised summary refreshed on capture, not an
--   index — out of scope here and noted, not built.
--
--   Measured against the page walk it replaces (db/bench-stats.ts, median of 5,
--   content-only rows, pgvector image, also in FORK.md change 45):
--
--     rows        function    page walk    walk round trips
--       1,000      1.15 ms      1.03 ms      2
--      10,000      7.79 ms      9.13 ms     11
--     100,000     91.1  ms    286.1  ms    101
--
--   Below ~10,000 rows it is a wash on wall-clock — one aggregate has a fixed
--   cost the walk's first small page does not — and the win there is one round
--   trip instead of many and no truncation, not speed. At 100,000 it is ~3x and
--   one round trip against 101; past 100,000, where the old walk capped, the
--   walk is not merely slower but wrong, and this is the only path that stays
--   correct.
--
-- What it returns (jsonb, one row)
--   { total, first_ts, last_ts, types{}, topics{}, people{} } — the same numbers
--   the tool renders today. types is every distinct metadata.type by count;
--   topics and people are the top 10 each by count. The tool re-sorts and takes
--   its own top 10, so key order here is not relied on.
-- ============================================================================

CREATE OR REPLACE FUNCTION thought_stats_summary()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH totals AS (
    SELECT
      count(*)::int   AS total,
      min(created_at) AS first_ts,
      max(created_at) AS last_ts
    FROM thoughts
  ),
  -- Only rows whose metadata.type is a non-empty string, matching the tool's
  -- `if (m.type)`: a missing key, JSON null, or "" is not a type.
  type_counts AS (
    SELECT coalesce(jsonb_object_agg(t, cnt), '{}'::jsonb) AS types
    FROM (
      SELECT metadata->>'type' AS t, count(*) AS cnt
      FROM thoughts
      WHERE coalesce(metadata->>'type', '') <> ''
      GROUP BY metadata->>'type'
      ORDER BY count(*) DESC
    ) s
  ),
  -- topics and people are string arrays. Unnest ONLY when the value is actually
  -- a JSON array — the tool guards with Array.isArray, and
  -- jsonb_array_elements_text raises on a non-array (an object or a bare string),
  -- so a single malformed row must not error the whole summary. Drop NULL
  -- elements (a JSON null inside the array) before aggregating, because
  -- jsonb_object_agg rejects a NULL key; the tool never produced such a row and
  -- degenerate metadata should not crash the count.
  topic_counts AS (
    SELECT coalesce(jsonb_object_agg(topic, cnt), '{}'::jsonb) AS topics
    FROM (
      SELECT topic, count(*) AS cnt
      FROM thoughts,
           jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(metadata->'topics') = 'array'
                  THEN metadata->'topics' ELSE '[]'::jsonb END) AS topic
      WHERE topic IS NOT NULL
      GROUP BY topic
      ORDER BY count(*) DESC
      LIMIT 10
    ) x
  ),
  people_counts AS (
    SELECT coalesce(jsonb_object_agg(person, cnt), '{}'::jsonb) AS people
    FROM (
      SELECT person, count(*) AS cnt
      FROM thoughts,
           jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(metadata->'people') = 'array'
                  THEN metadata->'people' ELSE '[]'::jsonb END) AS person
      WHERE person IS NOT NULL
      GROUP BY person
      ORDER BY count(*) DESC
      LIMIT 10
    ) x
  )
  SELECT jsonb_build_object(
    'total',    (SELECT total    FROM totals),
    'first_ts', (SELECT first_ts FROM totals),
    'last_ts',  (SELECT last_ts  FROM totals),
    'types',    (SELECT types    FROM type_counts),
    'topics',   (SELECT topics   FROM topic_counts),
    'people',   (SELECT people   FROM people_counts)
  );
$$;

COMMENT ON FUNCTION thought_stats_summary() IS
  'Aggregate the whole thoughts corpus in one statement for thought_stats: {total, first_ts, last_ts, types{}, topics{}, people{}}. types is every metadata.type by count; topics and people the top 10 each. Replaces the app-side page walk on the direct-SQL path (store-sql.ts), which capped at 100,000 rows and under-reported past it; the PostgREST store keeps the walk. STABLE, LANGUAGE SQL; scans thoughts once per arm. SMD-1249.';
