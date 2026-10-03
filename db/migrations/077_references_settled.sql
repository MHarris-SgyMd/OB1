-- =============================================================================
-- Migration 077: prefer_current also ranks below a thought whose tickets are
--                all finished — node_state read one hop out (SMD-2271)
-- =============================================================================
--
-- WHY
--   059's prefer_current demotes a thought by its OWN lifecycle: a ticket row
--   whose status is settled, a note filed under one, or a thought a newer one
--   supersedes. A session summary has none of these — no ticket of its own,
--   and its one `supersedes` slot holds its own checkpoint chain, so
--   consolidation cannot retire it either. On the dogfood brain "what should
--   we work on next" returned summaries recommending SMD-2074, SMD-1295 and
--   SMD-1875, all Done, above the tickets' own Done rows.
--
--   The rule was priced before this file (evals/eval-transitive-freshness.ts,
--   SMD-2271 PR 1, evals/README.md). Its first registration failed: every
--   rule that demotes by the tickets a thought is about also demoted a hit two
--   blind graders called current, each naming an open ticket. The second
--   registration's `central+share-veto`, the one written here, qualified: no
--   labelled current hit demoted in any window it was judged on (every row it
--   demotes there labelled), the planning queries' stale hits in the top 10
--   cut from 21 to 14 and, on four held-out phrasings, from 17 to 8 — though
--   those mostly re-surface the same summaries, so the out-of-sample evidence
--   is the no-current-demoted one. The maintainer's calls: inside
--   prefer_current, no new flag; the eval first, then this file.
--
-- WHAT
--   * ticket_references(content, metadata) — IMMUTABLE: the ticket keys a
--     thought names, one row each: in_body when its text holds the key,
--     central when metadata.topics or metadata.action_items (string elements
--     alone) holds it, or the text opens with a session summary's header
--     naming it (`Session summary — SMD-1234 — …`). A key is Linear's TEAM-123
--     shape between ASCII lookarounds — `(?<![A-Za-z0-9_])` and
--     `(?![A-Za-z0-9_])`, what JavaScript's `\b` is beside an ASCII letter or
--     digit; `\m`/`\M` would take the locale's letters as word characters, and
--     `\b` is a backspace here. evals/transitive-freshness.ts's refsOf is the
--     same reading, and test-schema [69] holds the two row for row.
--   * ticket_references_settled(content, metadata) — STABLE: the settled keys
--     that decide a demotion, sorted (byte order), or NULL when none does.
--     A key counts only when ob1_ticket_head (068) holds a head for it with a
--     status in node_lifecycle_types(), as 059 ignores an unknown status. Then:
--       - a known key in the text that is NOT settled vetoes (the thought may
--         be putting that open ticket forward);
--       - else, with known central keys, they decide: all settled demotes;
--       - else, with no known central key, three or more known keys in the
--         text, every one settled (the veto saw to that), demote.
--   * search_thoughts_current(…, min_trust) — 075's body; a row with no
--     lifecycle of its own (node_state's open IS NULL — a ticket row's own
--     status always wins) is also demoted when ticket_references_settled says
--     so: the same weight, search_demote_weight(), once whatever the reasons,
--     and the same re-sort. Its `demoted` gains one reason, `references
--     settled work (SMD-1, SMD-2)` — the deciding keys in the text so a
--     reader sees why; window_demoted counts it. The columns, the 7-argument
--     form and both forms' privileges are unchanged (CREATE OR REPLACE, the
--     same RETURNS TABLE: a reshape would fail --reapply at 075's CREATE OR
--     REPLACE, the 012 trap).
--
--   Nothing is stored: the references are read from the window's own rows at
--   search time and the heads from 068's table, so one ticket's completion
--   (board-sync's head update, 068's trigger) moves exactly the thoughts that
--   reference it on the next search, and writes none of them (test-schema
--   [69]). The cost is the regex over each window row's text: 3.6 ms over 100
--   typical dogfood thoughts, 25 ms over its 100 largest (up to 200 kB each);
--   db/bench-hybrid.ts's prefer_current arm reports it.
--
-- NOT HERE
--   * Re-deriving a stale summary (SMD-2243's pool). A finished plan with no
--     ticket key is invisible to this rule; a summary that also names an open
--     ticket anywhere is vetoed (14 of 21 planning stale hits remain).
--
-- SAFETY
--   Additive: two functions, and 075's 8-argument search_thoughts_current
--   body redefined with its signature, columns, settings and privileges
--   unchanged. The default search is untouched (the servers call the hybrid
--   without prefer_current). STABLE/IMMUTABLE, LANGUAGE sql with string
--   bodies (no recorded dependency, so a reset drops them in any order and
--   058's drop-before-create replays), SECURITY INVOKER, no GRANT: EXECUTE is
--   PUBLIC and ticket_references_settled reads ob1_ticket_head, which every
--   lifecycle read (node_state, so prefer_current) has needed since 068.
--   A --reapply puts 075's body back on the way and this file replaces it
--   again. MINOR under the version rules.
--
-- Expected outcome
--   SELECT ticket_references_settled('Session summary — SMD-1 — …', '{}')
--   returns {SMD-1} when SMD-1's head is Done and the text names no open
--   ticket.
-- Dependencies: 058 (node_state, node_lifecycle_types, node_settled_types),
--   068 (ob1_ticket_head), 075 (the 8-argument search_thoughts_current).
-- =============================================================================

-- The prerequisites, by name. A plpgsql body binds its calls when it runs, so
-- without this a hand apply ahead of 075 or 068 would succeed and every
-- prefer_current search fail at its first call.
DO $g$
BEGIN
  IF to_regclass('public.ob1_ticket_head') IS NULL OR to_regprocedure('node_state(uuid[])') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 077 needs 068 (ob1_ticket_head, node_state); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('search_thoughts_current(vector, text, float, int, jsonb, float, float, text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 077 needs 075 (the 8-argument search_thoughts_current); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$g$;

-- ---------------------------------------------------------------------------
-- 1. ticket_references — the keys a thought names, and where.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ticket_references(p_content text, p_metadata jsonb)
RETURNS TABLE (issue text, in_body boolean, central boolean)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $f$
  WITH found AS (
    SELECT m[1] AS issue, true AS in_body, false AS central
      FROM regexp_matches(coalesce(p_content, ''), '(?<![A-Za-z0-9_])([A-Z][A-Z0-9]+-[0-9]+)(?![A-Za-z0-9_])', 'g') AS m
    UNION ALL
    SELECT m[1], false, true
      FROM (SELECT e #>> '{}' AS t
              FROM unnest(ARRAY['topics', 'action_items']) AS f(k),
                   jsonb_array_elements(CASE WHEN jsonb_typeof(p_metadata -> f.k) = 'array' THEN p_metadata -> f.k ELSE '[]'::jsonb END) AS e
             WHERE jsonb_typeof(e) = 'string') AS el,
           regexp_matches(el.t, '(?<![A-Za-z0-9_])([A-Z][A-Z0-9]+-[0-9]+)(?![A-Za-z0-9_])', 'g') AS m
    UNION ALL
    SELECT substring(p_content FROM '^Session summary — ([A-Z][A-Z0-9]+-[0-9]+) —'), false, true
  )
  SELECT issue, bool_or(in_body), bool_or(central)
    FROM found
   WHERE issue IS NOT NULL
   GROUP BY issue
   ORDER BY issue COLLATE "C"
$f$;

COMMENT ON FUNCTION ticket_references(text, jsonb) IS
  'The ticket keys a thought names, one row each: in_body when its text holds the key, central when metadata.topics or metadata.action_items (string elements alone) holds it or the text opens with a session summary header naming it (Session summary — SMD-1234 — …). A key is Linear''s TEAM-123 shape between ASCII lookarounds, as JavaScript''s \b reads it beside an ASCII letter or digit; evals/transitive-freshness.ts''s refsOf is the same reading. IMMUTABLE. Migration 077 / SMD-2271.';

-- ---------------------------------------------------------------------------
-- 2. ticket_references_settled — the rule (central+share-veto).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ticket_references_settled(p_content text, p_metadata jsonb)
RETURNS text[]
LANGUAGE sql
STABLE
AS $f$
  WITH k AS (
    SELECT r.issue, r.in_body, r.central, h.status_type = ANY (node_settled_types()) AS settled
      FROM ticket_references(p_content, p_metadata) AS r
      JOIN ob1_ticket_head AS h ON h.issue_key = md5(r.issue)::uuid AND h.issue = r.issue
     WHERE h.status_type = ANY (node_lifecycle_types()))
  SELECT CASE
           -- The open veto: an open ticket named anywhere in the text.
           WHEN bool_or(in_body AND NOT settled) THEN NULL
           -- Central keys decide when there are any: every one settled.
           WHEN bool_or(central) THEN
             CASE WHEN bool_and(settled) FILTER (WHERE central)
                  THEN array_agg(issue ORDER BY issue COLLATE "C") FILTER (WHERE central) END
           -- Else three or more keys in the text, every one settled.
           WHEN count(*) FILTER (WHERE in_body) >= 3 THEN array_agg(issue ORDER BY issue COLLATE "C") FILTER (WHERE in_body)
         END
    FROM k
$f$;

COMMENT ON FUNCTION ticket_references_settled(text, jsonb) IS
  'The settled ticket keys that decide prefer_current''s transitive demotion of a thought, sorted, or NULL. Of ticket_references(content, metadata), only keys ob1_ticket_head (068) holds with a status in node_lifecycle_types() count: a known key in the text that is not settled vetoes; else known central keys decide (all settled demotes); else three or more known keys in the text, all settled, demote. The rule evals/eval-transitive-freshness.ts chose (central+share-veto). STABLE. Migration 077 / SMD-2271.';

-- ---------------------------------------------------------------------------
-- 3. search_thoughts_current(…, min_trust) — 075's body, the transitive
--    demotion beside the reflexive one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION search_thoughts_current(
  query_embedding  vector({{EMBEDDING_DIM}}),
  query_text       text,
  match_threshold  float,
  match_count      int,
  filter           jsonb,
  recency_weight   float,
  half_life_days   float,
  min_trust        text
)
RETURNS TABLE (
  id               uuid,
  content          text,
  metadata         jsonb,
  created_at       timestamptz,
  similarity       float,
  matched_needles  text[],
  needles          text[],
  needle_counts    int[],
  common_needles   text[],
  literal_only     boolean,
  score            float,     -- fused × the weight: the rank's own score
  fused            float,     -- the hybrid's score, before the weight
  demoted          text[],    -- the status_type, 'superseded' and/or 'references settled work (…)' that weighted it; NULL when not
  window_rows      int,       -- every row: the window's size
  window_known     int,       -- every row: how many in the window carry a lifecycle
  window_demoted   int,       -- every row: how many in the window were demoted
  window_synced_at text,      -- every row: the latest source watermark in the window
  window_exact     boolean    -- every row: the top N is the whole admitted list, weighted
)
LANGUAGE plpgsql
STABLE
SET jit = off
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH n AS (SELECT least(greatest(coalesce(match_count, 10), 1), 100) AS v_count),
  win AS (
    SELECT h.*, least(100, 4 * n.v_count) AS w
      FROM n, search_thoughts_hybrid(query_embedding, query_text, match_threshold, least(100, 4 * n.v_count),
                                     filter, recency_weight, half_life_days, min_trust)
           WITH ORDINALITY AS h(hid, hcontent, hmetadata, hcreated_at, hsim, hmatched, hneedles, hcounts, hcommon, hliteral, hfused, ord)),
  st AS (
    SELECT win.*, s.status_type, s.synced_at, s.open,
           coalesce(s.open = false, false) AS settled,
           s.superseded_by IS NOT NULL AS superseded,
           -- 077: a row with no lifecycle of its own, by the tickets it names.
           CASE WHEN s.open IS NULL THEN ticket_references_settled(win.hcontent, win.hmetadata) END AS refs
      FROM win LEFT JOIN node_state(NULL) s ON s.thought_id = win.hid),
  dm AS (
    SELECT st.*, (st.settled OR st.superseded OR st.refs IS NOT NULL) AS dem FROM st),
  agg AS (
    SELECT count(*)::int AS rows_,
           count(*) FILTER (WHERE open IS NOT NULL)::int AS known,
           count(*) FILTER (WHERE dem)::int AS dem,
           max(synced_at) FILTER (WHERE open IS NOT NULL) AS synced,
           max(w) AS w
      FROM dm)
  SELECT dm.hid, dm.hcontent, dm.hmetadata, dm.hcreated_at, dm.hsim, dm.hmatched, dm.hneedles, dm.hcounts, dm.hcommon, dm.hliteral,
         (dm.hfused * CASE WHEN dm.dem THEN search_demote_weight() ELSE 1 END)::float,
         dm.hfused::float,
         nullif(array_remove(ARRAY[CASE WHEN dm.settled THEN dm.status_type END,
                                   CASE WHEN dm.superseded THEN 'superseded' END,
                                   CASE WHEN dm.refs IS NOT NULL THEN 'references settled work (' || array_to_string(dm.refs, ', ') || ')' END], NULL), '{}'),
         a.rows_, a.known, a.dem, a.synced,
         (a.rows_ < a.w OR a.rows_ - a.dem >= (SELECT v_count FROM n))
    FROM dm CROSS JOIN agg a
   ORDER BY 11 DESC, dm.dem, dm.ord
   LIMIT (SELECT v_count FROM n);
END
$$;

COMMENT ON FUNCTION search_thoughts_current(vector, text, float, int, jsonb, float, float, text) IS
  'search_thoughts_hybrid with settled and superseded thoughts, and thoughts whose tickets are all finished, ranked below current ones, for search_thoughts'' opt-in prefer_current: over the hybrid''s top min(100, 4N), a thought node_state (058) says is settled (its ticket completed or canceled — a note filed under a Done ticket included) or superseded, or one with no lifecycle of its own that ticket_references_settled (077) says references settled work, weighs search_demote_weight() (0.25) of its fused score, once; the window is re-sorted (ties to the current row, then the hybrid''s order) and cut to N. In practice every current match in the window ranks first; an exact-literal hit on a demoted thought is demoted too, keeping a quarter of its literal bonus (1/61 per literal it holds), so on a query of literals only, or holding several literals, it can still outrank current rows. Blocked or unknown status does not demote a thought (superseded still does). Returns the hybrid''s columns, then fused, demoted (why: the status type, superseded, references settled work with the deciding keys), and on every row the window''s size, lifecycle coverage, demoted count, latest source watermark and whether the top N is exact. min_trust (075) is passed to the hybrid; every argument required. Migration 059 / SMD-2255 (SMD-2074); plpgsql since 068; min_trust 075 / SMD-1724; references 077 / SMD-2271.';

COMMENT ON FUNCTION search_thoughts_current(vector, text, float, int, jsonb, float, float) IS
  'search_thoughts_current with no min_trust: the 8-argument form called with NULL, under 059''s defaults. The form the servers call. Migration 059 / SMD-2255 (SMD-2074); plpgsql since 068; a wrapper since 075 / SMD-1724; the 8-argument form reads references since 077 / SMD-2271.';
