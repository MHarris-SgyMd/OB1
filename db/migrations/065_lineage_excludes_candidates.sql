-- =============================================================================
-- Migration 065: a derivation and its inputs are never paired for judgement —
--                consolidation_candidates leaves out every thought a
--                thought's derived_from names, in both directions (SMD-2292)
-- =============================================================================
--
-- WHY
--   064 (SMD-1812) makes a page a thought whose content is the render of its
--   sections and whose derived_from names the evidence the sections were
--   generated from. Once the re-embed worker gives the page thought a vector
--   and the extractor gives it entities, 029's consolidation_candidates(page)
--   returns the page's own evidence as a supersession candidate: measured on
--   PGlite in SMD-1812's third review pass — a one-section page paraphrasing
--   its evidence, after a re-embed and one shared entity, yielded its own
--   evidence at cosine 1. The judge (db/consolidate.ts) would then be asked
--   whether the page supersedes the thought it was derived from, and a
--   reviewer who accepted the verdict would archive the evidence while the
--   page's derived_from still named it — a derivation eating its input. The
--   same shape stands for any derived thought captured with derived_from (a
--   digest, a consolidation, a synthesis through upsert_thought); pages make
--   it routine (SMD-2143's wiki writers will produce many).
--
-- THE RULE
--   A pair one side of which names the other in derived_from is not a
--   conflict to be judged: the derivation exists BECAUSE of its input, says
--   what the input says by construction, and the relationship is already
--   recorded where 025's readers (trace_provenance, find_derivatives) and
--   063's rebuild find it. Re-deriving is rebuild_derived's door (SMD-1732);
--   supersession is for two claims about one subject that disagree. So the
--   candidate filter leaves the pair out — the newer side's derived_from
--   naming the older (the page and its evidence), and the older side's
--   naming the newer (a derivation whose input was captured later, or whose
--   created_at was moved back by hand). DIRECT members only: a page derived
--   from a digest derived from E is paired with E if they share an entity —
--   the array is one level, and walking it here would put 026's iterative
--   walk in a STABLE function every judged thought calls (stated, not
--   hidden; the derivations table, once every derived thought has a row
--   there, is where a deeper read belongs — SMD-1731). This is the fifth
--   restriction beside 029's four (SHARES AN ENTITY, OLDER, NEAREST, NOT
--   ALREADY DECIDED); it is stated here and in db/README.md because 029 is
--   frozen by release 1.0.0 — a released migration is append-only, its
--   comments included (check-fork-consistency, SMD-1804).
--
-- WHAT
--   consolidation_candidates redefined on 063's body, verbatim, plus
--   derived_from in the `me` row and two conditions on the pair, NULL-safe
--   (a thought with no derived_from has NULL there, and `NOT NULL` would
--   drop every row): the sentinel `ob1:lineage-excludes-the-pair` marks the
--   body for preflight, which warns when 029 or 063 is re-applied by hand
--   over this file (the exclusion gone, the pass would propose the pairs
--   again). Neither condition needs an index: o is reached by primary key
--   from the shared-entity join (tens of rows), and both containments are
--   per-row reads of rows already fetched. The containment is byte-exact, as
--   025's find_derivatives is: every function write since 025 stores the
--   elements lowercased (025's upsert_thought, 032's validate_derived_from,
--   064's page writer), so a mixed-case or malformed element reaches the
--   column only by a raw write, and such an element matches nothing — the
--   pair is judged, and no call errors (measured: [1], [null], an object, a
--   non-UUID string).
--
-- SAFETY
--   One body redefined on its own text with no arity change (CREATE OR
--   REPLACE keeps the ACL). Nothing runs at apply time but the DDL; no row
--   moves; no table is touched. A pair already proposed before this file is
--   left as it stands — a proposal is a reviewer's to decide, and
--   `bun db/consolidate.ts --list pending` shows it with both texts. MINOR
--   under FORK.md's version rules.
--
-- Prerequisites
--   025 (thoughts.derived_from), 029 (consolidation_candidates,
--   supersession_proposals), 063 (the stale status the body reads — probed
--   on the status CHECK 063 names). Applied by `bun db/migrate.ts`.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape). Every probe names an object that stands on a brain at
-- this file too, so a --reapply passes.
DO $qc$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'thoughts' AND column_name = 'derived_from') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 065 needs 025 (thoughts.derived_from); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regclass('supersession_proposals') IS NULL OR to_regprocedure('consolidation_candidates(uuid, int, float)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 065 needs 029 (supersession_proposals, consolidation_candidates); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'supersession_proposals_status_check' AND pg_get_constraintdef(oid) LIKE '%''stale''%') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 065 needs 063 (the stale proposal status this body reads); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- 063's body, verbatim, plus the pair rule: a thought and a member of its
-- derived_from are never paired, from either side. The sentinel sits inside
-- the body — preflight and the suites read pg_proc.prosrc, which holds what
-- stands between the dollar quotes and nothing above them.
CREATE OR REPLACE FUNCTION consolidation_candidates(
  p_thought_id     uuid,
  p_k              int   DEFAULT 5,
  p_min_similarity float DEFAULT 0
)
RETURNS TABLE (older_id uuid, similarity float, shared_entities int)
LANGUAGE sql
STABLE
AS $$
  WITH me AS (
    SELECT t.id, t.embedding, t.created_at, t.supersedes, t.derived_from
      FROM thoughts t
     WHERE t.id = p_thought_id
       AND t.embedding IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM thoughts s WHERE s.supersedes = t.id)
  ),
  shared AS (
    SELECT b.thought_id, count(DISTINCT a.entity_id)::int AS n
      FROM thought_entities a
      JOIN thought_entities b ON b.entity_id = a.entity_id AND b.thought_id <> a.thought_id
     WHERE a.thought_id = p_thought_id
     GROUP BY b.thought_id
  )
  SELECT o.id,
         1 - (o.embedding <=> me.embedding),
         s.n
    FROM me
    JOIN shared s ON true
    JOIN thoughts o ON o.id = s.thought_id
   WHERE o.embedding IS NOT NULL
     AND (o.created_at AT TIME ZONE 'UTC')::date < (me.created_at AT TIME ZONE 'UTC')::date
     AND o.supersedes IS DISTINCT FROM me.id
     AND me.supersedes IS DISTINCT FROM o.id
     AND NOT EXISTS (SELECT 1 FROM thoughts s WHERE s.supersedes = o.id)
     -- 063: a stale proposal does not hold the pair — the pass judges it again.
     AND NOT EXISTS (SELECT 1 FROM supersession_proposals p WHERE p.older_id = o.id AND p.newer_id = me.id AND p.status <> 'stale')
     -- 065 (ob1:lineage-excludes-the-pair): a derivation and its input are
     -- never paired — the newer side naming the older (a page and its
     -- evidence) or the older naming the newer. COALESCE: a NULL derived_from
     -- is "names nothing", not unknown.
     AND NOT COALESCE(me.derived_from @> jsonb_build_array(o.id::text), false)
     AND NOT COALESCE(o.derived_from @> jsonb_build_array(me.id::text), false)
     AND 1 - (o.embedding <=> me.embedding) >= COALESCE(p_min_similarity, 0)
   ORDER BY o.embedding <=> me.embedding, o.id
   LIMIT GREATEST(COALESCE(p_k, 5), 1)
$$;

COMMENT ON FUNCTION consolidation_candidates(uuid, int, float) IS
  'The older thoughts a thought is judged against for a supersession: sharing at least one entity (016), captured at least a calendar day (UTC) earlier, nearest by exact cosine, at or above p_min_similarity, at most p_k; pairs already proposed and thoughts already superseded are left out — since 063 a pair whose proposal is stale (rebuild_derived found a text moved) is judged again; since 065 a pair one side of which names the other in derived_from (a page and its evidence, a digest and its sources) is never judged: re-deriving is rebuild_derived''s door, not supersession''s. Migrations 029, 063, 065.';
