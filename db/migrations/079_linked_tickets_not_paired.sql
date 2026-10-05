-- =============================================================================
-- Migration 079: two tickets Linear links are never paired for judgement —
--                consolidation_candidates leaves out a pair whose two thoughts
--                are filed under two different tickets that Linear relates
--                (parent and child, blocks, relates) (SMD-2448)
-- =============================================================================
--
-- WHY
--   The first full consolidation pass under consolidate:qwen2.5:7b@p3
--   (2026-10-01, the stable dogfood brain) judged 1,001 thoughts and recorded
--   98 proposals; on review 2 were accepted and 96 rejected. 68 of the 98
--   paired two thoughts carrying different issues (84 reading a thought's
--   ticket as node_state does, below): a parent and its child, tickets
--   Linear already relates or blocks, a ticket and its follow-up. Counted
--   over every proposal the brain holds (2026-10-04) on node_state's key:
--   109 of 128 pair two different tickets, all rejected, and 107 of those
--   109 are tickets Linear relates as of that day (94 relates_to alone, 12
--   through child_of, 1 blocks; about 72 of the 10-01 pass's 84 were
--   already linked when they were judged, a dozen linked during that
--   review). Two tickets Linear relates are two records whose relationship
--   is already stated, each with its own status, which board-sync keeps
--   current and node_state (058, 068, 071) reads; one
--   "superseding" the other would archive a record that still holds, and
--   the judge calls tickets that build on each other a conflict (SMD-1873).
--
--   Why not every pair of two tickets (the first cut of this file, review
--   pass 3): the repo's own labels say a ticket can supersede another. In
--   evals/consolidate-labels.json, a product tracker's tickets, 6 of the 13
--   proposals graded by hand are real and all 6 pair two different tickets
--   (a later ticket replacing an earlier ticket's decision), as do all 6
--   labelled conflicts; under the broad rule eval-consolidate.ts measures
--   nothing (its corpus gives every row its own issue). That corpus carries
--   no links at all, so it cannot say what the narrower rule costs: in a live
--   workspace a later ticket replacing an earlier one's decision is often
--   filed as relates_to, which this file leaves out — the residual risk, to
--   be measured on a labelled set that keeps Linear's relations.
--
-- THE RULE
--   A pair is not a candidate when both thoughts carry a ticket identity,
--   the identities differ, and an active Linear link joins the two tickets
--   in either direction — a thought_facets row of kind 'link' (053), system
--   'linear', valid_until NULL (active as 058 and 071 read a link;
--   record_source_links closes one with now()), relation child_of, blocks,
--   blocked_by or relates_to, held by a thought filed under one ticket and
--   targeting the other. A text cross-reference (relation 'references', an
--   autolink in a description) does not count: naming a ticket is not
--   relating to it. Nor does duplicate_of: Linear's verdict that one ticket
--   no longer holds is the nearest thing to a supersession the board
--   records — six such pairs on the dogfood meet every other candidate term
--   (review pass 4) — so they stay for the judge. A thought's identity is
--   the ticket node_state reads it under (058, 068, 071):
--   coalesce(metadata->>'ticket', metadata->>'issue')
--   — a ticket's own row by its issue, a dated section, a reference or a
--   fork change record filed under a ticket by its ticket — the text
--   exactly, as 068 keys a head and as the links' targets are written. So a
--   dated section of ticket A is kept apart from ticket B's row when A's
--   row links to B. Two rows of ONE ticket stay candidates (two writers of
--   one identity can be genuine duplicates), as do two tickets Linear does
--   not relate, and a thought with no identity is judged against a ticket
--   row as before. This is the sixth restriction beside 029's four and
--   066's; it is stated here and in db/README.md because 029 is frozen by
--   release 1.0.0 (check-fork-consistency, SMD-1804).
--   Not taken: the text rule (a thought that names ticket X in its text,
--   paired with a thought filed under X, is lineage, not a conflict) — on
--   the 128 it would leave out 11 more pairs, one of them an ACCEPTED
--   proposal; not clean (SMD-2448's third Work item).
--
-- WHAT
--   consolidation_tickets_linked(a, b) is the predicate, on the two
--   thoughts' metadata: one definition, read by the candidate body, by the
--   count, and by db/consolidate.ts when it names the reason a stale
--   proposal is settled. It is reached through 053's
--   thought_facets_link_target_idx (system, target), both directions, the
--   holder's identity checked on its row by primary key.
--   consolidation_candidates is redefined on 066's body, verbatim, plus the
--   thought's metadata in the `me` row and one condition on the pair. The
--   sentinel `ob1:linked-tickets-not-paired` marks the body for preflight,
--   which warns naming this file when 063 or 066 is re-applied by hand over
--   it, and for db/consolidate.ts, which reports the rule only where the
--   body carries it. consolidation_linked_ticket_pairs_left_out(thought, floor)
--   counts the pairs this rule removes for one thought — every other term of
--   the candidate rule met, at or above the floor, with no p_k cut;
--   db/consolidate.ts turns it into judge calls fewer (the k cut over 066's
--   list less the cut over this one — a lower bound: a stale pair past the
--   cut, which 067 has the pass judge anyway, is not counted) for a run's
--   summary and for --status / --dry-run. Its body is the candidate body
--   copied with the condition turned round, so the kept list and the count
--   partition 066's: test-schema [70] holds the sum for every thought of a
--   corpus that exercises each shared term. (One body behind both was
--   weighed: it would move 063's and 066's sentinels, which preflight and
--   the suites read in consolidation_candidates' own text.)
--   Measured at the shipped defaults (k 3, cosine 0.6) over the dogfood's
--   pool (1,241 thoughts, 2026-10-05): 3,435 judge calls before this file,
--   3,293 after (-4.1%; the broad rule measured -36.1% the day before, 3,427
--   -> 2,190 — its extra came from unlinked ticket pairs the judge rarely
--   proposes, whose precision is SMD-1873's). On a copy of that brain the
--   worker's per-thought candidate read went from 2.3 s to about 3.2 s over
--   the pool (+0.7 ms a thought, the predicate 0.1-0.2 ms a call through the
--   link index); --status and --dry-run now spend about 6 ms a thought still
--   to judge (7.7 s over the whole pool; 0.6 s over the 68 thoughts then
--   waiting, in review pass 3's walkthrough).
--
-- SAFETY
--   One body redefined on its own text with no arity change (CREATE OR
--   REPLACE keeps the ACL), and two functions added, read-only. Nothing runs
--   at apply time but the DDL; no row moves. A proposal already standing on
--   two linked tickets is left as it is: a reviewer's to decide (`bun
--   db/consolidate.ts --list pending` shows it with both texts). A pending
--   one holds its pair, as any does; a stale one the pass settles as no
--   longer a candidate, naming this rule (067's leftover path).
--   record_supersession_proposal has no ticket guard: the rule lives in the
--   candidate filter, the worker's one source of pairs. A link written or
--   closed later moves the rule with it at the next pass (nothing is
--   stored). MINOR under FORK.md's version rules.
--
-- Prerequisites
--   025 (thoughts.derived_from, which 066's terms read), 029
--   (consolidation_candidates, supersession_proposals), 053 (link rows on
--   thought_facets and their target index), 063 (the stale status the body
--   reads). Applied by `bun db/migrate.ts`.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape) — 066's probes, since this body carries 066's terms,
-- and 053's link index, which the predicate reads.
DO $qc$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'thoughts' AND column_name = 'derived_from') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 079 needs 025 (thoughts.derived_from); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regclass('supersession_proposals') IS NULL OR to_regprocedure('consolidation_candidates(uuid, int, float)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 079 needs 029 (supersession_proposals, consolidation_candidates); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regclass('thought_facets_link_target_idx') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 079 needs 053 (link rows on thought_facets, thought_facets_link_target_idx); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'supersession_proposals_status_check' AND pg_get_constraintdef(oid) LIKE '%''stale''%') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 079 needs 063 (the stale proposal status this body reads); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- The predicate, on two thoughts' metadata: both filed under a ticket, two
-- different tickets, and an active structured Linear link between them in
-- either direction.
CREATE OR REPLACE FUNCTION consolidation_tickets_linked(p_a jsonb, p_b jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT CASE WHEN k.a IS NULL OR k.b IS NULL OR k.a = k.b THEN false ELSE EXISTS (
    SELECT 1
      FROM thought_facets f
      JOIN thoughts h ON h.id = f.thought_id
     WHERE f.kind = 'link'
       AND f.payload->>'system' = 'linear'
       AND f.valid_until IS NULL
       AND f.payload->>'relation' IN ('child_of', 'blocks', 'blocked_by', 'relates_to')
       AND ((f.payload->>'target' = k.b AND coalesce(h.metadata->>'ticket', h.metadata->>'issue') = k.a)
         OR (f.payload->>'target' = k.a AND coalesce(h.metadata->>'ticket', h.metadata->>'issue') = k.b))
  ) END
    FROM (SELECT coalesce(p_a->>'ticket', p_a->>'issue') AS a, coalesce(p_b->>'ticket', p_b->>'issue') AS b) k
$$;

COMMENT ON FUNCTION consolidation_tickets_linked(jsonb, jsonb) IS
  'Whether two thoughts (their metadata) are filed under two different tickets — metadata->>''ticket'', else metadata->>''issue'', as node_state reads them — that an active Linear link relates in either direction (thought_facets kind link, system linear, relation child_of | blocks | blocked_by | relates_to; neither a text reference nor duplicate_of counts). The pair rule consolidation_candidates applies since 079, and the reason db/consolidate.ts names when it settles a stale proposal. Read-only. Migration 079 (SMD-2448).';

-- 066's body, verbatim, plus the linked-tickets rule. The sentinel sits
-- inside the body — preflight and the suites read pg_proc.prosrc.
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
    SELECT t.id, t.embedding, t.created_at, t.supersedes, t.derived_from, t.metadata
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
     -- 079 (ob1:linked-tickets-not-paired): two tickets Linear relates are
     -- two records whose relationship is stated, each with its own lifecycle
     -- — never one superseding the other. The predicate is false, never
     -- NULL, for a side with no ticket.
     AND NOT consolidation_tickets_linked(me.metadata, o.metadata)
     AND 1 - (o.embedding <=> me.embedding) >= COALESCE(p_min_similarity, 0)
   ORDER BY o.embedding <=> me.embedding, o.id
   LIMIT GREATEST(COALESCE(p_k, 5), 1)
$$;

COMMENT ON FUNCTION consolidation_candidates(uuid, int, float) IS
  'The older thoughts a thought is judged against for a supersession: sharing at least one entity (016), captured at least a calendar day (UTC) earlier, nearest by exact cosine, at or above p_min_similarity, at most p_k; pairs already proposed and thoughts already superseded are left out — since 063 a pair whose proposal is stale (rebuild_derived found a text moved) is judged again; since 066 a pair one side of which names the other in derived_from (a page and its evidence, a digest and its sources) is never judged: re-deriving is rebuild_derived''s door, not supersession''s; since 079 a pair filed under two different tickets that an active Linear link relates (consolidation_tickets_linked) is never judged: two records whose relationship is stated, each with its own lifecycle. Migrations 029, 063, 066, 079.';

-- The candidate body with 079's condition turned round and no p_k cut: the
-- pairs the rule removes for one thought, every other term met.
CREATE OR REPLACE FUNCTION consolidation_linked_ticket_pairs_left_out(
  p_thought_id     uuid,
  p_min_similarity float DEFAULT 0
)
RETURNS int
LANGUAGE sql
STABLE
AS $$
  WITH me AS (
    SELECT t.id, t.embedding, t.created_at, t.supersedes, t.derived_from, t.metadata
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
     -- ob1:linked-tickets-not-paired, turned round: the pairs it removes.
     AND consolidation_tickets_linked(me.metadata, o.metadata)
     AND 1 - (o.embedding <=> me.embedding) >= COALESCE(p_min_similarity, 0)
$$;

COMMENT ON FUNCTION consolidation_linked_ticket_pairs_left_out(uuid, float) IS
  'How many older thoughts consolidation_candidates leaves out of one thought''s list because the two are filed under two different tickets an active Linear link relates (consolidation_tickets_linked), every other term of the candidate rule met at or above p_min_similarity, with no p_k cut — db/consolidate.ts turns it into the judge calls a run did not spend. Read-only. Migration 079 (SMD-2448).';
