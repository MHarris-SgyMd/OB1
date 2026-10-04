-- =============================================================================
-- Migration 078: two different tickets are never paired for judgement —
--                consolidation_candidates leaves out a pair whose two thoughts
--                carry two different ticket identities (SMD-2448)
-- =============================================================================
--
-- WHY
--   The first full consolidation pass under consolidate:qwen2.5:7b@p3
--   (2026-10-01, the stable dogfood brain) judged 1,001 thoughts and recorded
--   98 proposals; on review 2 were accepted and 96 rejected. 68 of the 98
--   paired two thoughts carrying different ticket identities
--   (metadata->>'issue', written by board-sync): a parent and its child,
--   tickets Linear already relates or blocks, a ticket and its follow-up.
--   Counted over every proposal the brain holds (2026-10-04): 93 of 128 —
--   24 of 24 under @p2 (2026-09-21) and 69 of 104 under @p3 — all rejected;
--   no proposal paired two rows of one ticket, and neither accepted proposal
--   involves a ticket row. Two different tickets are two records, each with
--   its own status, which board-sync keeps current and node_state (058, 068)
--   reads; one "superseding" the other would archive a record that is still
--   valid. The judge reads a finished ticket's Problem statement as a live
--   claim and calls tickets that build on each other a conflict (SMD-1873).
--
-- THE RULE
--   A pair both of whose thoughts carry a ticket identity, and the two
--   identities differ, is not a candidate. The identity is
--   metadata->>'issue' exactly as 068's projection keys a ticket (the text,
--   no normalisation): the board's own key, never a ticket id matched in
--   free text. Two rows with ONE identity — two writers of one ticket, the
--   SMD-1958 case — stay candidates: those can be genuine duplicates. A
--   thought with no identity (a note, a session summary, a page) is judged
--   against a ticket row as before. This is the sixth restriction beside
--   029's four and 066's; it is stated here and in db/README.md because 029
--   is frozen by release 1.0.0 (check-fork-consistency, SMD-1804).
--   Not taken: the text rule (a note that names ticket X paired with X's
--   row is lineage, not a conflict) — measured on the 128 it would leave out
--   10 more pairs, all rejected, and none of the accepted two, but 35 pairs
--   without two identities are too few to call it clean; it waits on a
--   larger review set (SMD-2448's third Work item).
--
-- WHAT
--   consolidation_candidates redefined on 066's body, verbatim, plus the
--   thought's identity in the `me` row and one NULL-safe condition on the
--   pair: a side with no identity has NULL there, and `NOT NULL` would drop
--   every row. The sentinel `ob1:distinct-tickets-not-paired` marks the body
--   for preflight, which warns naming this file when 063 or 066 is re-applied
--   by hand over it. consolidation_ticket_pairs_left_out(thought, floor)
--   counts the pairs this rule removes for one thought — every other term of
--   the candidate rule met, at or above the floor, with no p_k cut — so
--   `db/consolidate.ts` says how many pairs a run left out and how many the
--   next run would (--dry-run, --status). Its body is the candidate body
--   with the new condition turned round: the kept candidates and the count
--   partition 066's list (test-schema [70] holds the sum). Neither needs an
--   index: o is reached by primary key from the shared-entity join, and the
--   identity is a per-row read of rows already fetched.
--
-- SAFETY
--   One body redefined on its own text with no arity change (CREATE OR
--   REPLACE keeps the ACL), and one function added, read-only. Nothing runs
--   at apply time but the DDL; no row moves. A proposal already standing on
--   two tickets is left as it is: a reviewer's to decide (`bun
--   db/consolidate.ts --list pending` shows it with both texts). A pending
--   one holds its pair, as any does; a stale one the pass settles as no
--   longer a candidate, naming this rule (067's leftover path, which reads
--   the rule's terms). record_supersession_proposal has no ticket guard: the
--   rule lives in the candidate filter, the worker's one source of pairs.
--   MINOR under FORK.md's version rules.
--
-- Prerequisites
--   025 (thoughts.derived_from, which 066's terms read), 029
--   (consolidation_candidates, supersession_proposals), 063 (the stale
--   status the body reads). Applied by `bun db/migrate.ts`.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape) — 066's probes, since this body carries 066's terms.
DO $qc$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'thoughts' AND column_name = 'derived_from') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 078 needs 025 (thoughts.derived_from); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regclass('supersession_proposals') IS NULL OR to_regprocedure('consolidation_candidates(uuid, int, float)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 078 needs 029 (supersession_proposals, consolidation_candidates); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'supersession_proposals_status_check' AND pg_get_constraintdef(oid) LIKE '%''stale''%') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 078 needs 063 (the stale proposal status this body reads); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- 066's body, verbatim, plus the ticket rule. The sentinel sits inside the
-- body — preflight and the suites read pg_proc.prosrc.
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
    SELECT t.id, t.embedding, t.created_at, t.supersedes, t.derived_from, t.metadata->>'issue' AS issue
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
     -- 066 (ob1:lineage-excludes-the-pair): a derivation and its input are
     -- never paired — the newer side naming the older (a page and its
     -- evidence) or the older naming the newer. COALESCE: a NULL derived_from
     -- is "names nothing", not unknown.
     AND NOT COALESCE(me.derived_from @> jsonb_build_array(o.id::text), false)
     AND NOT COALESCE(o.derived_from @> jsonb_build_array(me.id::text), false)
     -- 078 (ob1:distinct-tickets-not-paired): two different tickets are two
     -- records, each with its own lifecycle — never one superseding the other.
     -- COALESCE: a side with no ticket identity is "no identity", not unknown;
     -- one identity on both sides (two writers of one ticket) stays a pair.
     AND NOT COALESCE(me.issue <> o.metadata->>'issue', false)
     AND 1 - (o.embedding <=> me.embedding) >= COALESCE(p_min_similarity, 0)
   ORDER BY o.embedding <=> me.embedding, o.id
   LIMIT GREATEST(COALESCE(p_k, 5), 1)
$$;

COMMENT ON FUNCTION consolidation_candidates(uuid, int, float) IS
  'The older thoughts a thought is judged against for a supersession: sharing at least one entity (016), captured at least a calendar day (UTC) earlier, nearest by exact cosine, at or above p_min_similarity, at most p_k; pairs already proposed and thoughts already superseded are left out — since 063 a pair whose proposal is stale (rebuild_derived found a text moved) is judged again; since 066 a pair one side of which names the other in derived_from (a page and its evidence, a digest and its sources) is never judged: re-deriving is rebuild_derived''s door, not supersession''s; since 078 a pair whose two thoughts carry two different ticket identities (metadata->>''issue'') is never judged: two tickets are two records, each with its own lifecycle. Migrations 029, 063, 066, 078.';

-- The candidate body with 078's condition turned round and no p_k cut: the
-- pairs the rule removes for one thought, every other term met.
CREATE OR REPLACE FUNCTION consolidation_ticket_pairs_left_out(
  p_thought_id     uuid,
  p_min_similarity float DEFAULT 0
)
RETURNS int
LANGUAGE sql
STABLE
AS $$
  WITH me AS (
    SELECT t.id, t.embedding, t.created_at, t.supersedes, t.derived_from, t.metadata->>'issue' AS issue
      FROM thoughts t
     WHERE t.id = p_thought_id
       AND t.embedding IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM thoughts s WHERE s.supersedes = t.id)
  ),
  shared AS (
    SELECT b.thought_id
      FROM thought_entities a
      JOIN thought_entities b ON b.entity_id = a.entity_id AND b.thought_id <> a.thought_id
     WHERE a.thought_id = p_thought_id
     GROUP BY b.thought_id
  )
  SELECT count(*)::int
    FROM me
    JOIN shared s ON true
    JOIN thoughts o ON o.id = s.thought_id
   WHERE o.embedding IS NOT NULL
     AND (o.created_at AT TIME ZONE 'UTC')::date < (me.created_at AT TIME ZONE 'UTC')::date
     AND o.supersedes IS DISTINCT FROM me.id
     AND me.supersedes IS DISTINCT FROM o.id
     AND NOT EXISTS (SELECT 1 FROM thoughts s WHERE s.supersedes = o.id)
     AND NOT EXISTS (SELECT 1 FROM supersession_proposals p WHERE p.older_id = o.id AND p.newer_id = me.id AND p.status <> 'stale')
     AND NOT COALESCE(me.derived_from @> jsonb_build_array(o.id::text), false)
     AND NOT COALESCE(o.derived_from @> jsonb_build_array(me.id::text), false)
     -- ob1:distinct-tickets-not-paired, turned round: the pairs it removes.
     AND COALESCE(me.issue <> o.metadata->>'issue', false)
     AND 1 - (o.embedding <=> me.embedding) >= COALESCE(p_min_similarity, 0)
$$;

COMMENT ON FUNCTION consolidation_ticket_pairs_left_out(uuid, float) IS
  'How many older thoughts consolidation_candidates leaves out of one thought''s list because the two carry different ticket identities (metadata->>''issue''), every other term of the candidate rule met at or above p_min_similarity, with no p_k cut — what db/consolidate.ts reports a run left out and --dry-run / --status say the next run would. Read-only. Migration 078 (SMD-2448).';
