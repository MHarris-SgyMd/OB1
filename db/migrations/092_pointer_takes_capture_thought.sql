-- =============================================================================
-- Migration 092: a capture-only key's thought is taken while its supersedes
--                chain reaches a thought the key did not capture — a
--                reviewer's accept or another key's pointer that makes the
--                key's text current over another's — so the key cannot pass
--                that standing on to text no one else saw (SMD-2708)
-- =============================================================================
--
-- WHY
--   082 (SMD-2638) stops a capture-only key's thought being its own once
--   another key takes it — a re-capture by a key that can read, a text
--   move, board-sync's adoption — and from then on the key cannot point at
--   it. A reviewer accepting a supersession proposal was not on that list:
--   review_supersession_proposal (036) writes the pointer on the thought it
--   makes current through update_thought. SMD-1873's review pass 3 proved
--   the chain on a scratch server: a capture key's copy was accepted over a
--   write key's thought; ob1_thought_taken(copy) stayed false; the key then
--   captured new text with `supersedes: <copy>`, the pointer was kept, and
--   search showed the key's unreviewed text current with both the copy and
--   the write key's original superseded.
--
--   The harm is a capture-only key's text ending up current over another
--   key's. A capture-only key can point only at its own untaken thoughts
--   (SMD-2473, 082), so its own pointers never reach another's text; only
--   another key's pointer can put one of its thoughts over another's. Two
--   rules on the pointer event were tried first, and each review pass found
--   a seam: "any other key's pointer takes the row" broke the session-capture
--   recipe's repair (a write key linking two of the hook's summaries took the
--   newer and lapsed the hook's next pointer); "a pointer onto a thought the
--   capturer did not capture" let the standing through one link more (a
--   second accept between two of the hook's thoughts, a write key's link
--   onto an accepted one, an accept arriving after the hook's pointer).
--   Consecutive seams in one mechanism: the rule reads the harm itself now.
--
-- WHAT
--   * ob1_capture_taken_by_log(id) — 082's ob1_thought_taken, by name: any
--     update event the 082 rule (ob1_takes_thought, unchanged) counts.
--   * ob1_chain_reaches_outside(id, capturer, at, to) — walks the thought's
--     current supersedes chain down, and answers whether it reaches a
--     thought the capturer did not capture (its first capture row's agent,
--     none included) or one 082's log took. `at`/`to` read one row's pointer
--     as `to` — the event the lapse trigger fires on, not yet projected.
--     Cycle-safe (the rows seen) and bounded (1,000 steps): past the bound
--     it answers NULL, which the callers read each in its safe direction.
--   * ob1_thought_taken(id) — 082's read, and the chain: a thought its
--     capturer holds is taken when 082's log took it, or its chain reaches
--     outside (NULL — the bound — counts as taken: a refused pointer is safe).
--     Read from the current pointers, so a reject that clears an accept's
--     pointer gives the thought back, and an accept made before this file
--     counts from now on. A pointer between two of the capturer's own
--     thoughts takes neither, so the recipe's repair keeps the hook's chain.
--   * The lapse (082's trigger function, redefined): on an update event that
--     takes its row by 082's rule or writes its `supersedes`, when that row
--     is taken now (the bound reads as untaken here: a lapse is not
--     fail-safe, 082), it and every row above it through the pointers that
--     stay — each of which reaches outside through it, so is taken too — has
--     the capture-scoped pointers its capturer wrote onto it cleared (082's
--     predicate, each an event of its own under the actor in force; a row
--     captured by no one has none). One walk down for the event's row, none
--     for the rows above: linear in the rows above (review pass 3: re-walking
--     each was quadratic, 20.8 s for a thousand linked rows), up to 1,000 of
--     them. Never the event's own row, which a raw write's cycle could bring
--     the walk back to (review pass 4). So an accept below a write key's link
--     onto the hook's thought lapses the hook's pointer above the link.
--   * The check at the write (082's trigger function, redefined): the
--     target's chain is read, locked FOR SHARE from its deepest row up to the
--     target, and read again; a chain that moved onto a row the first read
--     did not lock is refused (OB004 — the server drops the pointer and
--     writes again), one only shortened (a taker's lapse) is all locked. A
--     taker re-pointing a row of the chain holds that row FOR NO KEY UPDATE
--     and then locks the rows its lapse clears above it, and a delete's
--     cascade does the same, so locking bottom-up waits behind them rather
--     than crossing them (review pass 3: top-down locking deadlocked, 40P01,
--     in 2 of 210 races); whichever comes second sees the other. Refused,
--     not retried: a retry would lock the moved chain's new rows while
--     holding the first pass's (review pass 4).
--   * ob1_note_recapture (082's, redefined): its once-only guard reads 082's
--     log (ob1_capture_taken_by_log), not the chain — a write key re-capturing
--     a thought taken only through its chain is recorded, so the thought stays
--     taken when the chain is cleared (review pass 3: a reject gave back a
--     thought a write key held).
--   * The lapse trigger's WHEN gains `supersedes`.
--   ob1_takes_thought and the server's pre-check (core/writes.ts, through
--   ob1_thought_taken) are unchanged.
--
-- NOT HERE
--   * A capture-scoped pointer written onto a thought before this file, onto
--     a thought an accept before this file put over another's, stays until an
--     event below it fires the lapse — no sweep (the maintainer's choice: a
--     migration here writes no thought events with no actor); SMD-2934
--     counts them.
--   * A pointer the lapse cleared is not put back when the taking is undone
--     (a reject of the accept); nor does thought_changes say why it lapsed:
--     SMD-2933.
--   * A taking lapses what the capturer had pointed at the row: when the row
--     was already superseded by the capturer's own later text (a hook
--     summary a later summary replaced, accepted or ranked over another's
--     after the hook moved on), the older text reads current again beside
--     the newer — 082's lapse, by design. The listing side is SMD-2707's.
--   * A thought the capturer wrote while the registry could not attribute
--     it (no agent id) counts as outside, as 082 counts it not the key's: a
--     write key linking a summary to one written during such an outage takes
--     the newer (082 refuses ownership by name). So does a link onto one of
--     its own thoughts that is, or later becomes, taken: the newer is taken
--     through it, and the key's pointer onto the newer lapses.
--   * The bound: a chain of more than 1,000 of the capturer's own links
--     reads as taken, and its next pointer is refused — far past a session
--     hook's episode (a compaction starts a new one). The bound's two
--     branches are held by review, not by a suite.
--   * Board-sync's chain re-pointing a capture key's pasted-header row onto
--     another's row takes it and lapses the key's pointer onto it until the
--     next pass re-chains; the key's own pointer that board-sync carries is
--     SMD-2670's.
--   * Re-applying 082 restores its three functions and the three-key WHEN;
--     this file, applied after it, puts them back — the re-apply order.
--
-- Idempotent: CREATE OR REPLACE, and the trigger dropped by name first.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regprocedure('ob1_takes_thought(jsonb, uuid, uuid)') IS NULL
     OR to_regprocedure('ob1_capturer_of(uuid)') IS NULL
     OR to_regprocedure('ob1_lapse_capture_pointers()') IS NULL
     OR to_regprocedure('ob1_check_capture_pointer()') IS NULL
     OR to_regprocedure('ob1_note_recapture(uuid, jsonb)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 092 needs 082 (ob1_takes_thought, ob1_capturer_of, ob1_lapse_capture_pointers, ob1_check_capture_pointer, ob1_note_recapture); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. 082's log read, by name; and the chain.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_capture_taken_by_log(p_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  WITH c AS (SELECT ob1_capturer_of(p_id) AS agent)
  SELECT EXISTS (
    SELECT 1 FROM thought_audit u, c
     WHERE u.thought_id = p_id AND u.action = 'update'
       AND ob1_takes_thought(u.diff, u.canonical_agent_id, c.agent))
$$;

COMMENT ON FUNCTION ob1_capture_taken_by_log(uuid) IS
  'Whether any update event on the thought takes it from the agent that captured it by 082''s rule (ob1_takes_thought: a re-capture by a key that can read, a text move, board-sync''s `issue`) — 082''s ob1_thought_taken, by name, which ob1_thought_taken and ob1_chain_reaches_outside read. Migration 092 / SMD-2708, on 082 / SMD-2638.';

CREATE OR REPLACE FUNCTION ob1_chain_reaches_outside(p_id uuid, p_capturer uuid, p_at uuid DEFAULT NULL, p_to uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_cur  uuid;
  v_seen uuid[] := ARRAY[p_id];
  v_n    int := 0;
BEGIN
  -- ob1:capture-chain-reaches-outside — a CONTRACT SENTINEL, not prose (the
  -- 014 convention). The thought's current pointer, and each one below it:
  -- a thought its capturer did not capture (none included), or one 082's
  -- log took, puts the capturer's text over another's (SMD-2708). `p_at`'s
  -- pointer reads as `p_to` — the event the lapse fires on, not projected.
  v_cur := CASE WHEN p_id = p_at THEN p_to ELSE (SELECT supersedes FROM thoughts WHERE id = p_id) END;
  WHILE v_cur IS NOT NULL LOOP
    IF v_cur = ANY(v_seen) THEN
      RETURN false;  -- a cycle (a raw write; update_thought refuses one): nothing further below
    END IF;
    v_n := v_n + 1;
    IF v_n > 1000 THEN
      RETURN NULL;   -- past the bound: each caller reads it in its safe direction
    END IF;
    IF ob1_capturer_of(v_cur) IS DISTINCT FROM p_capturer OR ob1_capture_taken_by_log(v_cur) THEN
      RETURN true;
    END IF;
    v_seen := v_seen || v_cur;
    v_cur := CASE WHEN v_cur = p_at THEN p_to ELSE (SELECT supersedes FROM thoughts WHERE id = v_cur) END;
  END LOOP;
  RETURN false;
END;
$$;

COMMENT ON FUNCTION ob1_chain_reaches_outside(uuid, uuid, uuid, uuid) IS
  'Whether the thought''s current supersedes chain, walked down, reaches a thought p_capturer did not capture (ob1_capturer_of, none included) or one 082''s log took (ob1_capture_taken_by_log) — the capturer''s text then current over another''s. p_at''s pointer reads as p_to (an event not yet projected). Cycle-safe; past 1,000 steps it answers NULL, which ob1_thought_taken reads as taken and the lapse as not. Migration 092 / SMD-2708.';

-- ---------------------------------------------------------------------------
-- 2. Taken: 082's log, or the chain.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_thought_taken(p_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  -- 092: the chain too (SMD-2708). NULL — past the walk's bound — is taken:
  -- a refused pointer is the safe side.
  WITH c AS (SELECT ob1_capturer_of(p_id) AS agent)
  SELECT c.agent IS NOT NULL
     AND (ob1_capture_taken_by_log(p_id) OR COALESCE(ob1_chain_reaches_outside(p_id, c.agent), true))
    FROM c
$$;

COMMENT ON FUNCTION ob1_thought_taken(uuid) IS
  'Whether the thought is no longer its capturer''s alone: an update event took it by 082''s rule (ob1_capture_taken_by_log), or — since 092 — its current supersedes chain reaches a thought the capturer did not capture or one 082 took (ob1_chain_reaches_outside; past the walk''s bound, taken): a reviewer''s accept or another key''s pointer that puts the capturer''s text over another''s. False for a thought nobody attributable captured. The server reads it for every target of a capture-only key''s `supersedes`, and the write-time check reads it again under a lock: a taken thought is not the key''s, and the pointer is dropped. Read from the current pointers: a reject clearing an accept''s pointer gives the thought back. Migration 082 / SMD-2638; the chain 092 / SMD-2708.';

-- ---------------------------------------------------------------------------
-- 3. The lapse, up the chain.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_lapse_capture_pointers()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_at       uuid;
  v_to       uuid;
  v_work     uuid[] := ARRAY[NEW.thought_id];
  v_seen     uuid[] := '{}';
  v_x        uuid;
  v_capturer uuid;
  v_n        int := 0;
  s          record;
  v_ev       uuid;
BEGIN
  -- ob1:capture-pointer-lapses — a CONTRACT SENTINEL, not prose (the 014
  -- convention). An update event that takes thought T from its capturer
  -- clears every capture-scoped pointer the capturer wrote onto T and no
  -- update has re-pointed since. 092 (SMD-2708): taken by 082's rule or by
  -- T's chain reaching outside — weighed once, for T — and then T and every
  -- row above it through the pointers that stay, each taken through T, have
  -- their capturers' capture-scoped pointers cleared.
  v_capturer := ob1_capturer_of(NEW.thought_id);
  IF v_capturer IS NULL THEN
    RETURN NULL;  -- nobody attributable captured T, and a row above it already reached it
  END IF;
  -- Only an event that can change what is taken: 082's taking, or a pointer.
  IF NOT (ob1_takes_thought(NEW.diff, NEW.canonical_agent_id, v_capturer) OR NEW.diff ? 'supersedes') THEN
    RETURN NULL;
  END IF;
  -- T's pointer as this event leaves it — not yet projected.
  IF NEW.diff ? 'supersedes' THEN
    v_at := NEW.thought_id;
    v_to := CASE WHEN NEW.diff->'supersedes'->>'after' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 THEN (NEW.diff->'supersedes'->>'after')::uuid END;
  END IF;
  -- Taken now: 082's log (this event among it), or the chain read with T's
  -- new pointer. The bound reads as untaken: a lapse is not fail-safe.
  IF NOT (ob1_capture_taken_by_log(NEW.thought_id)
          OR COALESCE(ob1_chain_reaches_outside(NEW.thought_id, v_capturer, v_at, v_to), false)) THEN
    RETURN NULL;
  END IF;
  -- T is taken, and so is every row above it through the pointers that
  -- stay: each reaches outside through T (a row above of another capturer
  -- reaches T, which is not its own). No walk down for them (review pass 3).
  WHILE array_length(v_work, 1) > 0 LOOP
    v_x := v_work[1];
    v_work := v_work[2:];
    v_n := v_n + 1;
    EXIT WHEN v_n > 1001;  -- the event's row and 1,000 above it, the walk's own bound
    CONTINUE WHEN v_x = ANY(v_seen);
    v_seen := v_seen || v_x;
    v_capturer := ob1_capturer_of(v_x);
    FOR s IN
      SELECT t.id, t.metadata
        FROM thoughts t
       WHERE t.supersedes = v_x
         AND EXISTS (SELECT 1 FROM thought_audit c
                      WHERE c.thought_id = t.id AND c.action = 'capture'
                        AND c.canonical_agent_id = v_capturer
                        AND c.actor_context->>'scope' = 'capture'
                        AND c.diff->>'supersedes' = v_x::text)
         -- The pointer the capture wrote, not one a key set since: a write
         -- key's update_thought, an accepted proposal, board-sync's chain.
         AND NOT EXISTS (SELECT 1 FROM thought_audit u
                          WHERE u.thought_id = t.id AND u.action = 'update'
                            AND u.diff ? 'supersedes')
         AND v_capturer IS NOT NULL
         -- Never the event's own row: its event projects after this, and a
         -- newer one written first would refuse it (060) — a cycle a raw
         -- write closed would bring the walk back to it (review pass 4).
         AND t.id <> NEW.thought_id
       ORDER BY t.id
         FOR NO KEY UPDATE OF t
    LOOP
      -- Each pointer an event of its own, under the actor of the write that
      -- took the row (ob1.actor, as it stands), projected before the next:
      -- 060's check holds each row to its own latest event. Its own firing
      -- of this trigger finds the row's chain cleared and stops there.
      v_ev := ob1_append_thought_event(s.id, 'update', s.metadata->>'source',
                jsonb_build_object('supersedes', jsonb_build_object('before', v_x, 'after', NULL)), NULL);
      IF v_ev IS NOT NULL THEN
        PERFORM ob1_project_thought_event(v_ev);
      END IF;
    END LOOP;
    -- The rows still pointing at it — a write key's link, an accepted
    -- pointer — reach outside through it too.
    v_work := v_work || ARRAY(SELECT t.id FROM thoughts t WHERE t.supersedes = v_x ORDER BY t.id);
  END LOOP;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION ob1_lapse_capture_pointers() IS
  'The lapse (AFTER INSERT on thought_audit, update events): on one that takes its row by 082''s rule or writes its `supersedes`, when that row is taken now (ob1_capture_taken_by_log, or ob1_chain_reaches_outside read with the event''s new pointer; past the bound, not taken), it and every row above it through the pointers that stay — each taken through it — has every thought that names it as `supersedes`, was captured by its capturer with that pointer under a capture-only key and has not been re-pointed by any update since, cleared — an update event of its own under the current actor, appended and projected. A pointer a write key set is never lapsed. Migration 082 / SMD-2638; up the chain 092 / SMD-2708.';

-- ---------------------------------------------------------------------------
-- 4. The check at the write, the chain locked.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_check_capture_pointer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_target uuid;
  v_cur    uuid;
  v_chain  uuid[];
  v_again  uuid[];
BEGIN
  -- ob1:capture-pointer-checked-at-write — a CONTRACT SENTINEL, not prose
  -- (the 014 convention). The server asked before its model calls; a taking
  -- that landed since found no pointer to lapse, for this one was not yet
  -- written. Asked again here, inside the capture's transaction, under a
  -- lock every taker conflicts with: FOR SHARE waits for a taker holding
  -- the row FOR NO KEY UPDATE, and a taker that comes after waits for this
  -- capture, then lapses the pointer it now sees.
  v_target := (NEW.diff->>'supersedes')::uuid;
  -- FOR SHARE locks do not conflict with each other, and a concurrent
  -- capture's pointer is not visible until it commits: without this, N
  -- captures sent at once all passed the one-superseder rule below (review
  -- pass 3). Held to the commit, so the second reads the first's row.
  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:capture-pointer:' || v_target::text, 0));
  -- 092 (SMD-2708): the chain below the target is what can take it now, so
  -- it is locked with the target — read, locked FOR SHARE from its deepest
  -- row up to the target, and read again. A taker re-pointing a row of the
  -- chain holds that row FOR NO KEY UPDATE and then locks the rows its
  -- lapse clears above it (a delete's cascade likewise): bottom-up waits
  -- behind it rather than crossing it (review pass 3: top-down locking
  -- deadlocked). A chain that moved onto a row the first read did not lock
  -- is refused, not read again: a second pass would lock its new rows while
  -- holding the first pass's, crossing a taker again (review pass 4); one
  -- that only shortened — a taker's lapse cut it — is all locked, and holds.
  -- The bound is the walk's: the target and 1,000 rows below it.
  v_chain := ARRAY[v_target];
  v_cur := (SELECT supersedes FROM thoughts WHERE id = v_target);
  WHILE v_cur IS NOT NULL AND NOT (v_cur = ANY(v_chain)) AND array_length(v_chain, 1) <= 1000 LOOP
    v_chain := v_chain || v_cur;
    v_cur := (SELECT supersedes FROM thoughts WHERE id = v_cur);
  END LOOP;
  FOR i IN REVERSE array_length(v_chain, 1)..1 LOOP
    PERFORM 1 FROM thoughts WHERE id = v_chain[i] FOR SHARE;
  END LOOP;
  v_again := ARRAY[v_target];
  v_cur := (SELECT supersedes FROM thoughts WHERE id = v_target);
  WHILE v_cur IS NOT NULL AND NOT (v_cur = ANY(v_again)) AND array_length(v_again, 1) <= 1000 LOOP
    v_again := v_again || v_cur;
    v_cur := (SELECT supersedes FROM thoughts WHERE id = v_cur);
  END LOOP;
  -- Every row the second read reached is locked, so it holds still: go on.
  -- A row it reached that the first did not lock is refused.
  IF NOT (v_again <@ v_chain) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'OB004',
      MESSAGE = 'ob1_check_capture_pointer: a capture-only key''s supersedes names a thought whose chain moved under the check',
      DETAIL  = v_target::text;
  END IF;
  PERFORM 1 FROM thoughts WHERE id = v_target;
  IF NOT FOUND THEN
    RETURN NULL;  -- no such thought: the self-FK refuses it at the projection, as before
  END IF;
  IF NEW.canonical_agent_id IS NULL
     OR ob1_capturer_of(v_target) IS DISTINCT FROM NEW.canonical_agent_id
     OR ob1_thought_taken(v_target)
     OR EXISTS (SELECT 1 FROM thoughts s WHERE s.supersedes = v_target) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'OB004',
      MESSAGE = 'ob1_check_capture_pointer: a capture-only key''s supersedes names a thought that is not its own alone — another key took it, or it is already superseded',
      DETAIL  = v_target::text;
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION ob1_check_capture_pointer() IS
  'The check at the write (AFTER INSERT on thought_audit, capture events carrying `supersedes` and "scope": "capture"): takes an advisory lock on the target (two such captures naming one target are serialised), locks it and — since 092 — every row of its supersedes chain FOR SHARE, from the deepest up, then reads the chain again and refuses (OB004) one that moved onto a row it did not lock, which waits for any taker, and refuses the capture (SQLSTATE OB004) when the capture names no agent or the target is not that agent''s alone — captured by another, taken (ob1_thought_taken: 082''s log or, since 092, its chain reaching another''s thought), or already superseded by any thought. The server drops the pointer and writes again. One superseder per target bounds the lapse to one event. Migration 082 / SMD-2638; the chain 092 / SMD-2708.';

-- ---------------------------------------------------------------------------
-- 5. A re-capture by a key that can read, recorded — taken by the log alone.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_note_recapture(p_id uuid, p_actor jsonb DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_meta     jsonb;
  v_capturer uuid;
  v_ev       uuid;
BEGIN
  -- 005's guard, for the actor as upsert_thought reads it from its envelope.
  IF p_actor IS NOT NULL AND jsonb_typeof(p_actor) <> 'object' THEN
    RAISE EXCEPTION
      'ob1_note_recapture: p_actor must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_actor);
  END IF;
  -- Transaction-local, as the write functions set it (008).
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;
  -- The row locked as update_thought locks it, so an edit, a capture-scoped
  -- write naming this row and this note are serialised, and the rule below
  -- reads the log as it stands.
  SELECT metadata INTO v_meta FROM thoughts WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  v_capturer := ob1_capturer_of(p_id);
  -- Only a capture-only key's row (its capture row's mark), once: a row
  -- already taken BY THE LOG, the capturer's own re-capture, or any other row
  -- records nothing — 060's rule, a re-capture that changes nothing moves
  -- nothing. 092 (SMD-2708): the log, not ob1_thought_taken — a thought taken
  -- only through its chain is given back when the chain is cleared, and a
  -- write key holding its text must stay on record (review pass 3).
  IF v_capturer IS NULL
     OR ob1_actor_agent_id() IS NOT DISTINCT FROM v_capturer
     OR NOT EXISTS (SELECT 1 FROM thought_audit c
                     WHERE c.thought_id = p_id AND c.action = 'capture'
                       AND c.actor_context->>'scope' = 'capture')
     OR ob1_capture_taken_by_log(p_id) THEN
    RETURN false;
  END IF;
  v_ev := ob1_append_thought_event(p_id, 'update', v_meta->>'source', '{"recaptured": true}'::jsonb, NULL);
  IF v_ev IS NULL THEN
    RETURN false;
  END IF;
  -- Nothing the row holds moves; updated_at takes the event's clock, live and
  -- on a replay alike.
  PERFORM ob1_project_thought_event(v_ev);
  RETURN true;
END;
$$;

COMMENT ON FUNCTION ob1_note_recapture(uuid, jsonb) IS
  'Records that a key that can read captured text a capture-only key''s thought holds: called by the stores after a capture without p_payload.recapture = ''keep'' lands on an existing row. Sets ob1.actor from p_actor (008''s envelope), locks the row, and — when its capture row carries "scope": "capture", 082''s log has not yet taken it (ob1_capture_taken_by_log; since 092 not the chain, which a reject or an unlink clears) and the caller is another agent — appends one update event with diff {"recaptured": true} and projects it (updated_at moves, nothing else). Returns whether it recorded one. The event takes the thought from its capturer (ob1_takes_thought), and its append fires the lapse. Migration 082 / SMD-2638; the log guard 092 / SMD-2708.';

-- ---------------------------------------------------------------------------
-- 6. The lapse fires on a pointer's event too.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS thought_audit_lapse_capture_pointers ON thought_audit;
CREATE TRIGGER thought_audit_lapse_capture_pointers
  AFTER INSERT ON thought_audit
  FOR EACH ROW
  WHEN (NEW.action = 'update' AND NEW.diff ?| ARRAY['recaptured', 'content', 'metadata', 'supersedes'])
  EXECUTE FUNCTION ob1_lapse_capture_pointers();
