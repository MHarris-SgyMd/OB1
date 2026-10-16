-- =============================================================================
-- Migration 096: one definition for 082's lapse — ob1_lapse_walk is the walk
--                the trigger clears and the review listing's read returns,
--                so the listing's preview of an accept's lapses is no longer
--                a hand-kept copy of 092's trigger (SMD-3035)
-- =============================================================================
--
-- WHY
--   094 (SMD-2707) added ob1_accept_lapses: 092's lapse
--   (ob1_lapse_capture_pointers) read and not written, so the listing can
--   say which capture-only pointers an accept would clear. The two were kept
--   in step by hand, and SMD-2707's review passes 2-4 found the copy
--   drifting four times, each caught only by a one-off fuzz: lapses
--   promised for accepts 029 refuses, the loop bound, the walk on from a row
--   082's log already took, and the takes gate. A later change to the
--   trigger that missed the copy would have the listing promise lapses that
--   do not happen, or hide ones that do.
--
-- WHAT
--   1. ob1_lapse_walk(row, onto): the pointers 082's lapse clears for an
--      event that leaves the row's pointer at `onto`, as [{id, onto}] in the
--      order they are cleared. The gate is ob1_accept_takes (094), which is
--      092's taken-now read: 082's log took the row, or its chain read with
--      the new pointer reaches a thought its capturer did not capture or
--      one 082's log took (past the bound, not taken: a lapse is not
--      fail-safe). Then 092's walk, up
--      from the row: each row's capturer's capture-scoped pointers onto it
--      that no update has re-pointed (never the row's own), on through the
--      pointers that stay, and on from a cleared row 082's log had already
--      taken; the row and 1,000 above it.
--   2. The trigger (ob1_lapse_capture_pointers, redefined) clears what the
--      walk returns, in its order, each pointer an event of its own as 092
--      wrote it, the row locked and read again first: one re-pointed since
--      the walk read it — moved, or any update writing its pointer, as the
--      walk's own predicate reads it, that read taken once the lock is held
--      — is left (review passes 1, 2): what it clears is the walk's list
--      less any the re-read leaves, and the walk on from a row it left
--      stands (that row's log took it, pointer or none). Its gates stay
--      its own (no capturer; an event that neither takes the row by 082's
--      rule nor writes its pointer). An event that writes no pointer
--      leaves the row's pointer where it is, so the walk reads it as it
--      stands — 092's read.
--      Its own clearing events do not fire it again: before each one it
--      names that pointer in ob1.lapse_clearing (transaction-local), and a
--      firing from inside a trigger on an event that is that clear and
--      nothing else returns — the walk already went on from each cleared
--      row 082's log had taken, which is what 092's re-firing did. Per
--      pointer, not a switch: a write function's event fires at depth 1, so
--      a flag set by hand turns none of its lapses off; a raw write's or a
--      cascade's pure clear of exactly the pair named it can, which a raw
--      writer can do worse than (review passes 1, 2).
--      Three changes from 092, all the walk's:
--        * the walk on — its continuation from a cleared row 082's log
--          had taken — shares the event's one bound, 1,001 rows walked in
--          all, where each of 092's re-firings counted afresh from its row;
--        * the clears land breadth-first, in the walk's order, where 092's
--          re-firing cleared the pointers onto a cleared taken row before
--          that row's siblings';
--        * never the event's own row, through the walk on too: a raw
--          write's cycle back through it let 092's re-firing clear the
--          event row's own pointer, whose clear then projected ahead of the
--          event and 060 refused the write (review pass 1, reproduced).
--      Outside raw cycles, none changes what is cleared below the bound.
--   3. The read (ob1_accept_lapses, redefined): its own no-event gates —
--      the side already points somewhere, the pointer would close a loop or
--      the chain below the other side runs past update_thought's 1,001-row
--      walk (WOULD_CYCLE) — then the walk.
--   4. ob1_accept_takes' comment names it the lapse's gate; its body is 094's.
--
-- NOT HERE
--   * Why a pointer lapsed, on the lapse's own event: SMD-2933.
--   * The fuzz that held the copy to the trigger, as a check (SMD-3038):
--     the read and the trigger now share one function.
--   * The listing's cost (SMD-3036): each side's walk is the trigger's, as before.
--   * The walk past its bound is held by review, not by a suite (092).
--   * The walk reads one snapshot and each cleared row is read again under
--     its lock, not the path below it: a write key moving a link out from
--     under the event's row between the two still has the pointers above
--     the link cleared, and a link moved in misses its own. An accept holds
--     the review lock a re-point onto a thought waits on, so under an
--     accept only an unlink (which takes none, 088) moves one out. 092 had
--     the same window, one level wide (review pass 2, raced live): SMD-3046,
--     and the unlink SMD-3045.
--
-- SAFETY
--   One function created; two redefined under their own signatures; one
--   comment. MINOR: nothing changes shape, no data step. EXECUTE is PUBLIC by
--   default; no grant group in db/config.mjs names any of them. Re-applying
--   092 or 094 restores its own body; this file, applied after it, puts the
--   walk back — the re-apply order.
--   test-schema [86], test-upgrade [20aq]; the behaviour cells of the
--   trigger's [72] and [82] and the read's [84] unchanged (only their
--   last-definer asserts name 096).
--
-- Prerequisites
--   092 (ob1_lapse_capture_pointers, ob1_capture_taken_by_log), 094
--   (ob1_accept_takes, ob1_accept_lapses). Applied by `bun db/migrate.ts`.
--
-- Idempotent: CREATE OR REPLACE.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regprocedure('ob1_lapse_capture_pointers()') IS NULL
     OR to_regprocedure('ob1_capture_taken_by_log(uuid)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 096 needs 092 (ob1_lapse_capture_pointers, ob1_capture_taken_by_log); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_accept_takes(uuid, uuid)') IS NULL
     OR to_regprocedure('ob1_accept_lapses(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 096 needs 094 (ob1_accept_takes, ob1_accept_lapses); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. The walk.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_lapse_walk(p_row uuid, p_onto uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_work uuid[] := ARRAY[p_row];
  v_seen uuid[] := '{}';
  v_out  jsonb := '[]';
  v_x    uuid;
  v_cap  uuid;
  v_hit  uuid[];
  v_h    uuid;
  v_n    int := 0;
BEGIN
  -- ob1:lapse-walk — a CONTRACT SENTINEL, not prose (the 014 convention).
  -- 082's lapse for an event that leaves p_row's pointer at p_onto: taken
  -- now (092's read, the bound untaken), then up from p_row — the one walk
  -- the trigger clears and the listing's read returns (SMD-3035).
  IF NOT ob1_accept_takes(p_row, p_onto) THEN
    RETURN v_out;
  END IF;
  WHILE array_length(v_work, 1) > 0 LOOP
    v_x := v_work[1];
    v_work := v_work[2:];
    v_n := v_n + 1;
    EXIT WHEN v_n > 1001;  -- the event's row and 1,000 above it
    CONTINUE WHEN v_x = ANY(v_seen);
    v_seen := v_seen || v_x;
    v_cap := ob1_capturer_of(v_x);
    v_hit := ARRAY(
      SELECT t.id FROM thoughts t
       WHERE t.supersedes = v_x
         AND v_cap IS NOT NULL
         AND EXISTS (SELECT 1 FROM thought_audit c
                      WHERE c.thought_id = t.id AND c.action = 'capture'
                        AND c.canonical_agent_id = v_cap
                        AND c.actor_context->>'scope' = 'capture'
                        AND c.diff->>'supersedes' = v_x::text)
         -- The pointer the capture wrote, not one a key set since: a write
         -- key's update_thought, an accepted proposal, board-sync's chain.
         AND NOT EXISTS (SELECT 1 FROM thought_audit u
                          WHERE u.thought_id = t.id AND u.action = 'update'
                            AND u.diff ? 'supersedes')
         -- Never the event's own row: its event projects after the lapse,
         -- and a cycle a raw write closed would bring the walk back to it
         -- (092's review pass 4).
         AND t.id <> p_row
       ORDER BY t.id);
    FOREACH v_h IN ARRAY v_hit LOOP
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_h, 'onto', v_x));
      -- A cleared row 082's log already took is taken still, pointer or
      -- none: the walk goes on from it (092's lapse event fired there).
      IF ob1_capture_taken_by_log(v_h) THEN
        v_work := v_work || v_h;
      END IF;
    END LOOP;
    -- The rows still pointing at it once those are cleared — a write key's
    -- link, an accepted pointer — reach outside through it too.
    v_work := v_work || ARRAY(SELECT t.id FROM thoughts t WHERE t.supersedes = v_x AND NOT (t.id = ANY(v_hit)) ORDER BY t.id);
  END LOOP;
  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION ob1_lapse_walk(uuid, uuid) IS
  'The pointers 082''s lapse clears for an update event that leaves p_row''s pointer at p_onto, as [{id, onto}] in the order they are cleared — none unless the row is taken now (ob1_accept_takes: 082''s log, or its chain read with the new pointer reaching outside its capturer''s own; past the bound, not taken); else, up from the row, each row''s capturer''s capture-scoped pointers onto it that no update has re-pointed (never p_row''s own), on through the pointers that stay and from a cleared row 082''s log had already taken, to 1,000 rows above it. The one walk ob1_lapse_capture_pointers clears and ob1_accept_lapses returns. Migration 096 / SMD-3035.';

-- ---------------------------------------------------------------------------
-- 2. The trigger clears what the walk returns.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_lapse_capture_pointers()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_capturer uuid;
  v_to       uuid;
  v_lapses   jsonb;
  e          record;
  v_meta     jsonb;
  v_ev       uuid;
BEGIN
  -- ob1:capture-pointer-lapses — a CONTRACT SENTINEL, not prose (the 014
  -- convention). An update event that takes thought T from its capturer
  -- clears every capture-scoped pointer the capturer wrote onto T and no
  -- update has re-pointed since. 092 (SMD-2708): taken by 082's rule or by
  -- T's chain reaching outside, and then T and every row above it through
  -- the pointers that stay. 096 (SMD-3035): what ob1_lapse_walk returns.
  -- The lapse's own clearing event, named before it was appended, its diff
  -- the clear and nothing else, from inside a trigger: the walk already
  -- went on from it. A write function's event fires at depth 1, so a flag
  -- set by hand turns none of its lapses off; a raw write's or a cascade's
  -- pure clear of exactly the pair named it can (review pass 2).
  IF pg_trigger_depth() > 1
     AND NEW.diff = jsonb_build_object('supersedes', jsonb_build_object('before', NEW.diff->'supersedes'->'before', 'after', NULL))
     AND current_setting('ob1.lapse_clearing', true) = NEW.thought_id::text || '>' || (NEW.diff->'supersedes'->>'before') THEN
    RETURN NULL;
  END IF;
  v_capturer := ob1_capturer_of(NEW.thought_id);
  IF v_capturer IS NULL THEN
    RETURN NULL;  -- nobody attributable captured T, and a row above it already reached it
  END IF;
  -- Only an event that can change what is taken: 082's taking, or a pointer.
  IF NOT (ob1_takes_thought(NEW.diff, NEW.canonical_agent_id, v_capturer) OR NEW.diff ? 'supersedes') THEN
    RETURN NULL;
  END IF;
  -- T's pointer as this event leaves it — not yet projected; one that writes
  -- no pointer leaves it where it stands.
  IF NEW.diff ? 'supersedes' THEN
    v_to := CASE WHEN NEW.diff->'supersedes'->>'after' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 THEN (NEW.diff->'supersedes'->>'after')::uuid END;
  ELSE
    v_to := (SELECT supersedes FROM thoughts WHERE id = NEW.thought_id);
  END IF;
  v_lapses := ob1_lapse_walk(NEW.thought_id, v_to);
  IF jsonb_array_length(v_lapses) = 0 THEN
    RETURN NULL;
  END IF;
  FOR e IN SELECT (x->>'id')::uuid AS id, (x->>'onto')::uuid AS onto
             FROM jsonb_array_elements(v_lapses) WITH ORDINALITY AS a(x, i) ORDER BY i
  LOOP
    -- Locked, upward along each path as the walk read it, and read again:
    -- a pointer moved since the walk read it is left (review pass 1)...
    SELECT t.metadata INTO v_meta FROM thoughts t
     WHERE t.id = e.id AND t.supersedes = e.onto
       FOR NO KEY UPDATE OF t;
    CONTINUE WHEN NOT FOUND;
    -- ...and one an update has written since (the walk's own predicate),
    -- read in a statement of its own once the lock is held: a writer the
    -- lock waited for committed its events after the locking statement's
    -- snapshot (review pass 2).
    CONTINUE WHEN EXISTS (SELECT 1 FROM thought_audit u
                           WHERE u.thought_id = e.id AND u.action = 'update'
                             AND u.diff ? 'supersedes');
    PERFORM set_config('ob1.lapse_clearing', e.id::text || '>' || e.onto::text, true);
    -- Each pointer an event of its own, under the actor of the write that
    -- took the row (ob1.actor, as it stands), projected before the next:
    -- 060's check holds each row to its own latest event.
    v_ev := ob1_append_thought_event(e.id, 'update', v_meta->>'source',
              jsonb_build_object('supersedes', jsonb_build_object('before', e.onto, 'after', NULL)), NULL);
    IF v_ev IS NOT NULL THEN
      PERFORM ob1_project_thought_event(v_ev);
    END IF;
  END LOOP;
  PERFORM set_config('ob1.lapse_clearing', '', true);
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION ob1_lapse_capture_pointers() IS
  'The lapse (AFTER INSERT on thought_audit, update events): on one that takes its row by 082''s rule or writes its `supersedes`, clears what ob1_lapse_walk returns for the row''s pointer as the event leaves it — each pointer, re-read under a row lock and left when it moved or an update has written it since, an update event of its own under the current actor, appended and projected, in the walk''s order. Its own clearing events do not fire it again: each is named in ob1.lapse_clearing before it is appended, and only a firing from inside a trigger on an event that is that clear and nothing else reads it (a flag set by hand turns no write function''s lapse off); the walk went on from them. A pointer a write key set is never lapsed. Migration 082 / SMD-2638; up the chain 092 / SMD-2708; the one walk 096 / SMD-3035.';

-- ---------------------------------------------------------------------------
-- 3. The read returns what the walk returns.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_accept_lapses(p_side uuid, p_other uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_n    int := 0;
  v_down uuid := p_other;
BEGIN
  -- ob1:accept-lapses-read — 082's lapse for the event an accept making
  -- p_side stand over p_other appends (p_side.supersedes = p_other): the
  -- walk the trigger clears (ob1_lapse_walk, 096), once the accept writes
  -- an event at all. No event, no lapse (094's review pass 2): 029's accept
  -- writes only onto a NULL pointer (one already p_other writes nothing, a
  -- third thought is ALREADY_SUPERSEDES), and update_thought refuses a loop
  -- (WOULD_CYCLE).
  IF (SELECT t.supersedes FROM thoughts t WHERE t.id = p_side) IS NOT NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  -- update_thought's loop walk (088): past 1,001 rows below p_other it
  -- refuses as a loop too, a raw cycle not through p_side among them.
  WHILE v_down IS NOT NULL AND v_n < 1001 LOOP
    IF v_down = p_side THEN
      RETURN '[]'::jsonb;
    END IF;
    v_n := v_n + 1;
    v_down := (SELECT t.supersedes FROM thoughts t WHERE t.id = v_down);
  END LOOP;
  IF v_down IS NOT NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  RETURN ob1_lapse_walk(p_side, p_other);
END;
$$;

COMMENT ON FUNCTION ob1_accept_lapses(uuid, uuid) IS
  'The pointers 082''s lapse would clear if an accept made p_side supersede p_other, as [{id, onto}] — the thought whose pointer is cleared and the thought it pointed at: none when the accept writes no event (p_side already points somewhere: 029 writes nothing or refuses ALREADY_SUPERSEDES; the pointer would close a loop, or the chain below p_other runs past update_thought''s 1,001-row walk: WOULD_CYCLE); else ob1_lapse_walk(p_side, p_other), the walk the trigger clears. Migration 094 / SMD-2707; the one walk 096 / SMD-3035.';

-- ---------------------------------------------------------------------------
-- 4. The gate's comment.
-- ---------------------------------------------------------------------------
COMMENT ON FUNCTION ob1_accept_takes(uuid, uuid) IS
  'Whether an accept making p_side supersede p_other would take p_side from its capturer: 092''s taken read (ob1_capture_taken_by_log, or ob1_chain_reaches_outside with p_side''s pointer read as p_other; past the bound, not taken, as the lapse reads it). False for a thought no attributable agent captured. The gate of ob1_lapse_walk, so of the lapse and of ob1_accept_lapses alike (096), and the listing''s WRITER flag reads it between one capturer''s two thoughts. Migration 094 / SMD-2707; the lapse''s gate 096 / SMD-3035.';
