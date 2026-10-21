-- =============================================================================
-- Migration 106: the listing caps the walks it runs — list_proposal_writers
--                reads a side's takes and lapses only when the chain below
--                the other side and the tree above it each hold 25 rows or
--                fewer, and leaves both NULL past that, which the replies
--                name (SMD-3036)
-- =============================================================================
--
-- WHY
--   094's list_proposal_writers runs, for every listed proposal and each
--   side, ob1_accept_takes (a walk down the chain below the other side) and
--   ob1_accept_lapses (a loop check down that chain, then 097's lapse walk
--   up the tree above the side) — each to 1,000 rows, with audit probes at
--   every row. db/consolidate.ts --list, the stores' listing and the MCP
--   tool pay it on every call. Measured (SMD-3036, 2026-10-21), every
--   column read as the stores read them, a page of 200 at 104:
--     * the stable and canary brains: 78-135 ms; their longest chain is 7
--       rows, and no proposal side has more than one row above it;
--     * on a throwaway brain, ANALYZEd: 200 proposals each over a 1,000-row
--       chain below the other side, 3.3-4.0 s (a page of 10, 0.18 s); one
--       side with 1,000 re-captured capture-only pointers above it,
--       proposed over 200 others, 17-19 s (10: 0.8-0.9 s); the same shapes
--       at 100 rows, 0.35-0.43 s and 1.2-1.4 s.
--   A side's cost grows with its walks, and the walks are a reviewer's
--   detail: what an accept would take and lapse. The accept reads them in
--   full where it matters (db/consolidate.ts's guard, and the lapse when it
--   runs); the listing can say it did not.
--
-- WHAT
--   1. ob1_listing_walk_fits(side, other): whether the walks a listing would
--      run for an accept making `side` stand over `other` stay within 25
--      rows — `other` and the rows below it, followed down its supersedes a
--      row at a time (a cycle runs the count out), and the rows whose chain
--      reaches `side`, followed up a row at a time, each counted once — to
--      26 at most each way. One equality read of `supersedes` or the key a
--      row, as the walks read, and no audit probes: a recursive query's plan
--      without statistics scanned thoughts at every step, and a level's rows
--      read at once (= ANY) took a scan under its generic plan. Each count
--      holds what the walks can visit: the takes walk and the loop check go
--      down from `other`; the lapse walk's clears, the links it goes on
--      through and the cleared rows it walks on from are all rows above
--      `side`. 25 is about three and a half times the longest real chain.
--      Measured on the same brain: at 25 rows a page of 200 costs 0.14 s
--      below and 0.30-0.36 s above (104: 0.11 s and 0.28-0.30 s), a page
--      of 10 16 ms at most; past the cap, at 100 or 1,000 rows, 40-75 ms
--      for 200 and 3-5 ms for 10. The sentinel `ob1:listing-walk-cap`
--      marks the body.
--   2. list_proposal_writers(ids): 094's, with each side's takes and lapses
--      read only where ob1_listing_walk_fits answers true for that side;
--      past it both are NULL and neither walk runs. An accepted row's
--      lapses are still `[]` (029 answers its accept); its takes are capped
--      like any other's. Names, kinds, trust, capture_only, superseded_by
--      and same_capturer are read for every row. RETURNS TABLE unchanged,
--      so 094 re-applied replaces it in place; the sentinel
--      `ob1:listing-names-the-writers` stays and `ob1:listing-walk-cap`
--      joins it.
--   3. The readers, in the same change. The tool's reply and --list print,
--      under a side left unread, that its takes and lapses were not read and
--      why; the reply's value carries `walkCapped`. db/consolidate.ts's
--      accept guard reads its one row's takes and lapses through
--      ob1_accept_takes and ob1_accept_lapses itself, so its WRITER refusal
--      and the pointers it names are never capped. A listing's WRITER flag
--      reads an unread takes as false (the store's rule for an unread
--      column); the guard decides on the full read.
--
--   Why a count before the walks and not a cap inside them: 097 made the
--   lapse one definition, the walk the trigger clears by and the listing
--   reads, and a cap passed into it (an argument changes the signature
--   every re-apply of 097 and 104 would then stand beside; a setting would
--   reach the trigger in the same transaction and have it clear fewer
--   pointers than it must) puts a second answer into the trigger's path.
--   The count reads nothing the trigger reads.
--
-- NOT HERE
--   * The trigger, the accept and db/consolidate.ts --accept: uncapped.
--   * ob1_accept_takes and ob1_accept_lapses: unchanged, and uncapped when
--     called alone.
--   * The 200-id cap on the ids read (094) stands.
--
-- SAFETY
--   One function created; one redefined under its own signature; their
--   comments. MINOR: nothing changes shape, no data step. EXECUTE is PUBLIC
--   by default; no grant group names them. Re-applying 094 puts its
--   uncapped listing back; this file, applied after it, the cap.
--   test-schema [95], test-upgrade [20ax].
--
-- Prerequisites
--   094 (list_proposal_writers, ob1_accept_takes, ob1_accept_lapses).
--   Applied by `bun db/migrate.ts`.
--
-- Idempotent: CREATE OR REPLACE.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regprocedure('list_proposal_writers(uuid[])') IS NULL
     OR to_regprocedure('ob1_accept_takes(uuid, uuid)') IS NULL
     OR to_regprocedure('ob1_accept_lapses(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 106 needs 094 (list_proposal_writers, ob1_accept_takes, ob1_accept_lapses); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. Whether a side's walks fit the listing's cap.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_listing_walk_fits(p_side uuid, p_other uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_cur  uuid := p_other;
  v_n    int := 0;
  v_seen uuid[] := ARRAY[p_side];
  v_work uuid[] := ARRAY[p_side];
  v_x    uuid;
  v_hit  uuid[];
BEGIN
  -- ob1:listing-walk-cap — a CONTRACT SENTINEL, not prose (the 014
  -- convention). 25 rows each way: p_other and the rows below it (the takes
  -- walk and the loop check), and the rows above p_side (the lapse walk).
  -- Loops of one equality read a row, as the walks read: a recursive
  -- query's plan without statistics hash-joined a scan of thoughts into
  -- every step, and a read of a level's rows at once (= ANY) took a scan
  -- under its generic plan.
  -- Down, a row at a time; a cycle runs the count out.
  WHILE v_cur IS NOT NULL LOOP
    v_n := v_n + 1;
    IF v_n > 25 THEN
      RETURN false;
    END IF;
    SELECT t.supersedes INTO v_cur FROM thoughts t WHERE t.id = v_cur;
  END LOOP;
  -- Up, a row at a time, each row counted once; never more than the count
  -- has left read.
  v_n := 0;
  WHILE cardinality(v_work) > 0 LOOP
    v_x := v_work[1];
    v_work := v_work[2:];
    v_hit := ARRAY(SELECT t.id FROM thoughts t
                    WHERE t.supersedes = v_x AND NOT (t.id = ANY(v_seen))
                    LIMIT 26 - v_n);
    v_n := v_n + cardinality(v_hit);
    IF v_n > 25 THEN
      RETURN false;
    END IF;
    v_seen := v_seen || v_hit;
    v_work := v_work || v_hit;
  END LOOP;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION ob1_listing_walk_fits(uuid, uuid) IS
  'Whether the walks list_proposal_writers would run for an accept making p_side stand over p_other stay within 25 rows each way: p_other and the rows below it, down its supersedes chain (ob1_accept_takes'' walk and ob1_accept_lapses'' loop check), and the rows whose chain reaches p_side (the lapse walk''s clears and the links it goes on through). Index reads of supersedes alone; cycle-safe. The listing reads a side''s takes and lapses only when it answers true. Migration 106 / SMD-3036.';

-- ---------------------------------------------------------------------------
-- 2. The listing, its walks capped.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_proposal_writers(p_ids uuid[])
RETURNS TABLE (
  id                    uuid,
  older_actor_name      text,
  older_actor_kind      text,
  older_trust           text,
  older_capture_only    boolean,
  older_superseded_by   uuid,
  older_lapses          jsonb,
  older_takes           boolean,
  newer_actor_name      text,
  newer_actor_kind      text,
  newer_trust           text,
  newer_capture_only    boolean,
  newer_superseded_by   uuid,
  newer_lapses          jsonb,
  newer_takes           boolean,
  same_capturer         boolean
)
LANGUAGE sql
STABLE
AS $$
  -- ob1:listing-names-the-writers — the proposals named (the listing's cap
  -- of them), each side's writer, whose text it is, its first superseder,
  -- and what an accept making it stand over the other side would lapse and
  -- whether it would take the side.
  -- ob1:listing-walk-cap — those two read only where the side's walks fit
  -- 25 rows (ob1_listing_walk_fits); NULL past it (106, SMD-3036).
  WITH page AS (
    SELECT p.id, p.status, p.older_id, p.newer_id, o.metadata AS older_metadata, n.metadata AS newer_metadata
      FROM supersession_proposals p
      JOIN thoughts o ON o.id = p.older_id
      JOIN thoughts n ON n.id = p.newer_id
     WHERE p.id = ANY(p_ids[1:200])
  ),
  side AS (
    SELECT x.tid, ob1_capturer_of(x.tid) AS agent, ob1_capture_only_text(x.tid) AS only_text,
           (SELECT t.id FROM thoughts t WHERE t.supersedes = x.tid ORDER BY t.created_at, t.id LIMIT 1) AS superseded_by
      FROM (SELECT older_id AS tid FROM page UNION SELECT newer_id FROM page) x
  ),
  fit AS (
    SELECT g.id, ob1_listing_walk_fits(g.older_id, g.newer_id) AS older_fits, ob1_listing_walk_fits(g.newer_id, g.older_id) AS newer_fits
      FROM page g
  )
  SELECT g.id,
         g.older_metadata->>'actor_name', g.older_metadata->>'actor_kind', g.older_metadata->>'trust',
         so.only_text, so.superseded_by,
         -- An accepted row takes no accept (029: ALREADY_ACCEPTED).
         CASE WHEN g.status = 'accepted' THEN '[]'::jsonb WHEN f.older_fits THEN ob1_accept_lapses(g.older_id, g.newer_id) END,
         CASE WHEN f.older_fits THEN ob1_accept_takes(g.older_id, g.newer_id) END,
         g.newer_metadata->>'actor_name', g.newer_metadata->>'actor_kind', g.newer_metadata->>'trust',
         sn.only_text, sn.superseded_by,
         CASE WHEN g.status = 'accepted' THEN '[]'::jsonb WHEN f.newer_fits THEN ob1_accept_lapses(g.newer_id, g.older_id) END,
         CASE WHEN f.newer_fits THEN ob1_accept_takes(g.newer_id, g.older_id) END,
         COALESCE(so.agent = sn.agent, false)
    FROM page g
    JOIN fit f ON f.id = g.id
    JOIN side so ON so.tid = g.older_id
    JOIN side sn ON sn.tid = g.newer_id
   ORDER BY g.id
$$;

COMMENT ON FUNCTION list_proposal_writers(uuid[]) IS
  'Who wrote each side of the supersession proposals named (any status; the first 200 ids read): its actor_name, actor_kind and trust (050, 073), whether its text is still a capture-only key''s alone (ob1_capture_only_text), the first thought superseding it, the pointers an accept making it stand over the other side would lapse, as [{id, onto}] (ob1_accept_lapses; none on an accepted row), whether that accept would take it (ob1_accept_takes), and whether one agent captured both sides (same_capturer). Since 106 a side''s lapses and takes are read only when its walks fit 25 rows (ob1_listing_walk_fits), and are NULL past it — an accepted row''s lapses stay []; db/consolidate.ts''s accept guard reads them in full. The companion of list_supersession_proposals (070); an id naming no proposal returns nothing. Migration 094 / SMD-2707; the cap 106 / SMD-3036.';
