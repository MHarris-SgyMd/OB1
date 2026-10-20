-- =============================================================================
-- Migration 101: the lapse locks its own tree — the walk records the links it
--                went on through, the trigger locks them FOR SHARE from the
--                taken row up and reads each again before it clears above
--                it, and a pointer's lapse locks its target's chain first
--                (SMD-3046)
-- =============================================================================
--
-- WHY
--   The lapse (097) reads the tree above a taken row in one snapshot
--   (ob1_lapse_walk) and then locks and clears what it found. A link moved
--   between the two was missed: one moved out still had the capture-only
--   pointers above it cleared; one moved in onto the taken row missed its
--   own, its writer's lapse having read the row untaken. 099 (SMD-3045) had
--   every pointer write take the review lock, which an accept holds for its
--   whole lapse; any other taking — a write key's re-capture note, a text
--   move by another key, board-sync's adoption by update_thought or by a
--   capture's merge, a page render — holds none, and SMD-3045's Verify
--   measured both races still open. A first attempt had those writers take
--   the review lock before their row lock (SMD-3046, review pass 1, never
--   shipped): a page render already holds its row when it writes, so page
--   writes deadlocked against a delete or a pointer write of the page (154
--   of 400 races, none under 099), and a capture's merge was a taker it had
--   not listed. Writer by writer is the wrong place; every taking passes
--   through the lapse trigger, so the locks are taken there.
--
-- WHAT
--   1. ob1_lapse_tree(row, onto): 097's walk, its body and order unchanged,
--      also emitting {id, onto, "stays": true} for each link it went on
--      through — row `id`'s pointer names `onto` — after that row's clears,
--      before anything above it; never the event's own row.
--   2. ob1_lapse_walk(row, onto): the tree's clears, in their order — the
--      same [{id, onto}] as 097's, which ob1_accept_lapses, the listing and
--      the CLI read unchanged. One walk still: the trigger reads the tree,
--      the listing the walk derived from it.
--   3. ob1_lapse_capture_pointers(), 097's gates and pointer kept, then:
--      a. the event's row locked FOR NO KEY UPDATE — every write function
--         holds it already; the order below rests on it;
--      b. when the event writes a pointer onto a thought, that thought's
--         chain (it and 1,000 below, as 092 reads it) locked FOR SHARE from
--         its deepest row up, before the walk: a taking in flight below
--         holds its row FOR NO KEY UPDATE, so the pointer's lapse waits for
--         it, and its walk — a statement of its own — then reads the row
--         taken (moved in). Not read again and refused, as 092's capture
--         check does: every write function that moves a pointer holds the
--         review lock (099), so the chain only shortens under it;
--      c. the tree, its own statement;
--      d. before any clear, every clear's links — from its pointer's target
--         down to the event's row, to a row an earlier clear names (the walk
--         lists clears above a cleared row only when 082's log took it, and
--         went on from it whatever that row's pointer), or to a link already
--         held — locked FOR SHARE from the lowest up, each WHERE its pointer
--         still names the row below: a link moved since the walk (the lock
--         waited for its writer and read the row again) is broken, and the
--         clears above it are left (moved out). Then that clear's own row,
--         by its id, FOR NO KEY UPDATE. Every row the lapse waits on is
--         waited on here, bottom-up, before any clear: a clear projects its
--         pointer and takes 068's node-state bucket locks, held to the
--         commit, and a lapse waiting on a row while holding one deadlocked
--         against a re-point out of the tree, which needs the same bucket
--         when its own event projects (the race table's first live run);
--         and a lapse holding a link while waiting on the row above it
--         crossed a delete of that row (its cascade needs the link) and a
--         transaction that edited the row and then moved the link (review
--         pass 2).
--      e. then 097's clears, unchanged, those whose links held.
--
-- Lock order
--   A taker holds its row FOR NO KEY UPDATE and no review lock; inside its
--   lapse it locks only rows of its own tree, bottom-up — each clear's links
--   FOR SHARE, then its row FOR NO KEY UPDATE — before any clear, and takes
--   068's buckets only in its clears, waiting on nothing after. A pointer
--   writer holds the review lock and its row, and its lapse locks its
--   target's chain FOR SHARE, bottom-up, then its own tree as a taker would.
--   No cycle, measured (review pass 2: some 13,000 races, natural timing
--   and jittered, against six takers):
--     * an unlink locks no chain; a taker reaching the unlinked row waits for
--       it before holding anything above it;
--     * delete_thought's cascade locks only rows above the deleted one; the
--       taker waits at the deleted row, holding nothing above it (top-down
--       path locks, or a cleared row locked after the links above it,
--       deadlock here);
--     * an accept writes onto a NULL pointer — the accepted row is in no
--       tree; 092's capture check locks bottom-up and waits at the taken row;
--     * two takers on one tree: the lower waits at the higher's row, and the
--       higher locks only rows above its own;
--     * a page render is a taker; a page write racing a delete of the page
--       takes the review lock in the delete alone (test-live [32]);
--     * a pointer moved in: its writer waits on the taker's row, and the
--       taker never wants the writer's row — the target chain is locked
--       bottom-up, so a target the taker clears is reached only after the
--       taker's row (top-down would hold it and deadlock);
--     * a transaction that edits a row the lapse clears and then moves a
--       link under it: the lapse waits on that row holding nothing above it.
--   One cycle remains, named: a pointer write whose new target's chain (to
--   1,000 rows) reaches the taken row, while the row it moves is one the
--   taking will lock — a link of the tree or a row it clears, re-pointed
--   onto the taken row, onto a row above it, or onto a row outside the tree
--   whose chain runs through a cleared row the walk did not go on from. The
--   writer holds its row and its chain lock waits on the taker; the taker's
--   lock waits on that row. Postgres breaks it with 40P01, one side rolls
--   back whole. It is not narrow: whenever such a write overlaps a taking
--   it fires (review pass 2: 395 of 400 overlapping races), the pointer
--   writer the usual victim, and nothing in the server retries it — the
--   caller gets the error, and a retry of the call succeeds. An unlink and
--   an accept cannot meet it. 099's multi-call class stands outside the
--   order too (a transaction that holds a row and then asks for the review
--   lock): it meets an accept, whose lapse now waits on its links.
--
-- Cost
--   A lapse that clears: one FOR SHARE per distinct link on its clears'
--   paths and one FOR NO KEY UPDATE per clear, at most 1,001 each — each
--   FOR SHARE writes the row's header. Measured against 097 (review pass
--   2, before the membership sets): a lapse over 200 rows about +8%, over
--   1,000 about +22-60%; a pointer onto the end
--   of a 1,000-row chain about +17%, onto a short chain +0.3 ms. A pointer
--   onto a thought locks its chain even when nothing lapses — usually one
--   to three rows — and so waits for a plain edit of a chain row while it
--   holds the review lock, which every other pointer write, delete and
--   accept then waits behind.
--
-- NOT HERE
--   * A raw write, which locks nothing of anyone's.
--   * 097's and 099's NOT HERE name this residual; they stand as written
--     (migrations are append-only) and db/README says what holds.
--
-- SAFETY
--   One function created; two redefined under their own signatures; their
--   comments. MINOR: nothing changes shape, no data step. EXECUTE is PUBLIC
--   by default; no grant group names them. Re-applying 097 puts its own walk
--   and lockless trigger back; this file, applied after it, the tree and the
--   locks. test-schema [91], test-live [6k], test-upgrade [20at].
--
-- Prerequisites
--   097 (ob1_lapse_walk, ob1_lapse_capture_pointers), 094 (ob1_accept_takes),
--   092 (ob1_capture_taken_by_log). Applied by `bun db/migrate.ts`.
--
-- Idempotent: CREATE OR REPLACE.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regprocedure('ob1_lapse_walk(uuid, uuid)') IS NULL
     OR to_regprocedure('ob1_lapse_capture_pointers()') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 101 needs 097 (ob1_lapse_walk, ob1_lapse_capture_pointers); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_accept_takes(uuid, uuid)') IS NULL
     OR to_regprocedure('ob1_capture_taken_by_log(uuid)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 101 needs 094 and 092 (ob1_accept_takes, ob1_capture_taken_by_log); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. The tree: 097's walk, its links recorded.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_lapse_tree(p_row uuid, p_onto uuid)
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
  v_stay uuid[];
BEGIN
  -- ob1:lapse-tree — a CONTRACT SENTINEL, not prose (the 014 convention).
  -- 097's walk (ob1:lapse-walk), unchanged, with each link it goes on
  -- through recorded for the trigger's path locks (101, SMD-3046).
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
    v_stay := ARRAY(SELECT t.id FROM thoughts t WHERE t.supersedes = v_x AND NOT (t.id = ANY(v_hit)) ORDER BY t.id);
    -- 101 (SMD-3046): each such link, after this row's clears and before
    -- anything above it — never the event's own row, which a raw cycle
    -- could bring back.
    FOREACH v_h IN ARRAY v_stay LOOP
      CONTINUE WHEN v_h = p_row;
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_h, 'onto', v_x, 'stays', true));
    END LOOP;
    v_work := v_work || v_stay;
  END LOOP;
  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION ob1_lapse_tree(uuid, uuid) IS
  'ob1_lapse_walk''s walk with the links it goes on through: the clears as [{id, onto}] in the order they are cleared, and for each row reached through a pointer that stays {id, onto, "stays": true} after that row''s clears and before anything above it (never p_row''s own). What ob1_lapse_capture_pointers reads and locks; ob1_lapse_walk returns its clears. Migration 101 / SMD-3046, on 097 / SMD-3035.';

-- ---------------------------------------------------------------------------
-- 2. The walk: the tree's clears.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_lapse_walk(p_row uuid, p_onto uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  -- ob1:lapse-walk — a CONTRACT SENTINEL, not prose (the 014 convention).
  -- 082's lapse for an event that leaves p_row's pointer at p_onto: the
  -- tree's clears (ob1_lapse_tree — 097's walk, its links recorded), in
  -- their order; the one walk the trigger clears and the listing's read
  -- returns (SMD-3035, SMD-3046).
  SELECT COALESCE(jsonb_agg(a.x ORDER BY a.i) FILTER (WHERE NOT a.x ? 'stays'), '[]'::jsonb)
    FROM jsonb_array_elements(ob1_lapse_tree(p_row, p_onto)) WITH ORDINALITY AS a(x, i)
$$;

COMMENT ON FUNCTION ob1_lapse_walk(uuid, uuid) IS
  'The pointers 082''s lapse clears for an update event that leaves p_row''s pointer at p_onto, as [{id, onto}] in the order they are cleared: ob1_lapse_tree''s clears, its links left out — none unless the row is taken now (ob1_accept_takes); else, up from the row, each row''s capturer''s capture-scoped pointers onto it that no update has re-pointed (never p_row''s own), on through the pointers that stay and from a cleared row 082''s log had already taken, to 1,000 rows above it. The one walk ob1_lapse_capture_pointers clears and ob1_accept_lapses returns. Migration 097 / SMD-3035; the tree 101 / SMD-3046.';

-- ---------------------------------------------------------------------------
-- 3. The trigger locks its tree, then clears.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_lapse_capture_pointers()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_capturer uuid;
  v_to       uuid;
  v_tree     jsonb;
  e          record;
  -- 101: the chain under a pointer's target; the links read from the tree
  -- (row -> the row it points at), the rows that anchor a path, the links
  -- held and the ones found moved; one clear's path.
  v_chain    uuid[];
  v_cur      uuid;
  v_below    jsonb := '{}'::jsonb;
  v_anchor   jsonb := '{}'::jsonb;
  v_held     jsonb := '{}'::jsonb;
  v_broken   jsonb := '{}'::jsonb;
  v_skip     jsonb := '{}'::jsonb;
  v_path     uuid[];
  v_ok       boolean;
  v_steps    int;
  v_meta     jsonb;
  v_ev       uuid;
BEGIN
  -- ob1:capture-pointer-lapses — a CONTRACT SENTINEL, not prose (the 014
  -- convention). An update event that takes thought T from its capturer
  -- clears every capture-scoped pointer the capturer wrote onto T and no
  -- update has re-pointed since. 092 (SMD-2708): taken by 082's rule or by
  -- T's chain reaching outside, and then T and every row above it through
  -- the pointers that stay. 097 (SMD-3035): what ob1_lapse_walk returns.
  -- 101 (SMD-3046): its tree locked first, so no link moves under it.
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
  -- ob1:lapse-locks-its-tree — a CONTRACT SENTINEL, not prose (the 014
  -- convention). 101 (SMD-3046): the event's row, held by the write that
  -- appended this, held here too — the order below rests on it.
  PERFORM 1 FROM thoughts WHERE id = NEW.thought_id FOR NO KEY UPDATE;
  -- A pointer onto a thought: that thought's chain, it and 1,000 below,
  -- locked FOR SHARE from the deepest row up, before the walk. A taking in
  -- flight below holds its row FOR NO KEY UPDATE, so this waits for it; the
  -- walk, a statement of its own, then reads the row taken (moved in).
  -- Bottom-up, as 092's check locks a chain: a target the taker clears is
  -- reached only after the taker's row. Not refused when it moved: every
  -- write function that moves a pointer holds the review lock (099), so
  -- under it the chain only shortens.
  IF NEW.diff ? 'supersedes' AND v_to IS NOT NULL THEN
    v_chain := ARRAY[v_to];
    v_cur := (SELECT supersedes FROM thoughts WHERE id = v_to);
    WHILE v_cur IS NOT NULL AND NOT (v_cur = ANY(v_chain)) AND array_length(v_chain, 1) <= 1000 LOOP
      v_chain := v_chain || v_cur;
      v_cur := (SELECT supersedes FROM thoughts WHERE id = v_cur);
    END LOOP;
    FOR k IN REVERSE array_length(v_chain, 1)..1 LOOP
      PERFORM 1 FROM thoughts WHERE id = v_chain[k] FOR SHARE;
    END LOOP;
  END IF;
  v_tree := ob1_lapse_tree(NEW.thought_id, v_to);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_tree) AS a(x) WHERE NOT a.x ? 'stays') THEN
    RETURN NULL;
  END IF;
  -- Every clear's links, and its row, locked first, before any clear: a
  -- clear projects its pointer and takes 068's node-state bucket locks,
  -- held to the commit, and a lapse waiting on a row while holding one
  -- deadlocked against a re-point out of the tree, which needs the same
  -- bucket when its own event projects (the first live run of the race
  -- table); a bucket shared by hash with a writer of a later clear's row
  -- crossed the same way (097 had that one too).
  FOR e IN SELECT (x->>'id')::uuid AS id, (x->>'onto')::uuid AS onto, x ? 'stays' AS stays
             FROM jsonb_array_elements(v_tree) WITH ORDINALITY AS a(x, i) ORDER BY i
  LOOP
    IF e.stays THEN
      v_below := v_below || jsonb_build_object(e.id::text, e.onto);
      CONTINUE;
    END IF;
    -- The links from this pointer's target down to the event's row, to a
    -- row an earlier clear names (the walk lists clears above a cleared row
    -- only when 082's log took it, and went on from it whatever its own
    -- pointer; each row has one pointer, so it is listed once), or to a link
    -- already held.
    v_path := '{}';
    v_cur := e.onto;
    v_ok := true;
    v_steps := 0;
    WHILE NOT (v_cur = NEW.thought_id OR v_anchor ? v_cur::text OR v_held ? v_cur::text) LOOP
      IF v_broken ? v_cur::text OR NOT (v_below ? v_cur::text) OR v_steps > 1001 THEN
        v_ok := false;
        EXIT;
      END IF;
      v_path := v_path || v_cur;
      v_cur := (v_below->>v_cur::text)::uuid;
      v_steps := v_steps + 1;
    END LOOP;
    v_anchor := v_anchor || jsonb_build_object(e.id::text, true);
    IF NOT v_ok THEN
      v_skip := v_skip || jsonb_build_object(e.id::text, true);
      CONTINUE;
    END IF;
    -- Locked FOR SHARE from the lowest up, each where its pointer still
    -- names the row below: one moved since the walk read it — the lock
    -- waited for its writer and read the row again — is broken, and the
    -- clears above it are left (moved out).
    FOR k IN REVERSE coalesce(array_length(v_path, 1), 0)..1 LOOP
      PERFORM 1 FROM thoughts
       WHERE id = v_path[k] AND supersedes = (v_below->>v_path[k]::text)::uuid
         FOR SHARE;
      IF NOT FOUND THEN
        v_broken := v_broken || jsonb_build_object(v_path[k]::text, true);
        v_ok := false;
        EXIT;
      END IF;
      v_held := v_held || jsonb_build_object(v_path[k]::text, true);
    END LOOP;
    IF NOT v_ok THEN
      v_skip := v_skip || jsonb_build_object(e.id::text, true);
      CONTINUE;
    END IF;
    -- And the row this clear writes, by its id, right after the links under
    -- it — so every row the lapse waits on is waited on here, before any
    -- clear, holding nothing above it: a writer holding a clear row and then
    -- moving a link under it (a transaction of several calls), and a delete
    -- of a cleared row the walk went on from (its cascade needs the link
    -- above it), both crossed a lapse that held the link and waited on the
    -- row in its clear (review pass 2).
    PERFORM 1 FROM thoughts WHERE id = e.id FOR NO KEY UPDATE;
  END LOOP;
  -- Then the clears, in the walk's order, those whose links held.
  FOR e IN SELECT (x->>'id')::uuid AS id, (x->>'onto')::uuid AS onto
             FROM jsonb_array_elements(v_tree) WITH ORDINALITY AS a(x, i)
            WHERE NOT x ? 'stays' ORDER BY i
  LOOP
    CONTINUE WHEN v_skip ? e.id::text;
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
  'The lapse (AFTER INSERT on thought_audit, update events): on one that takes its row by 082''s rule or writes its `supersedes`, clears what ob1_lapse_walk returns for the row''s pointer as the event leaves it — each pointer, re-read under a row lock and left when it moved or an update has written it since, an update event of its own under the current actor, appended and projected, in the walk''s order. Its own clearing events do not fire it again: each is named in ob1.lapse_clearing before it is appended, and only a firing from inside a trigger on an event that is that clear and nothing else reads it (a flag set by hand turns no write function''s lapse off); the walk went on from them. A pointer a write key set is never lapsed. Since 101 it locks its tree first: the event''s row; a pointer''s target chain FOR SHARE from the deepest row up, before the walk (ob1_lapse_tree), so a taking in flight below is waited for and read taken; and before each clear the links under it FOR SHARE from the taken row up, each where it still names the row below — a link moved since the walk leaves the clears above it. Migration 082 / SMD-2638; up the chain 092 / SMD-2708; the one walk 097 / SMD-3035; the locks 101 / SMD-3046.';
