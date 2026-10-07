-- =============================================================================
-- Migration 081: a capture-only key's thought stops being its own once
--                another key or board-sync takes it — one rule says what
--                takes it, a write key's re-capture that changes nothing is
--                recorded, a pointer the key had already written onto the
--                thought lapses, and the key's pointer is re-checked at its
--                own write (SMD-2638)
-- =============================================================================
--
-- WHY
--   A capture-only key (scope `capture`, SMD-1298) may set `supersedes` only
--   on a thought it captured itself (SMD-2473): the target's capture audit
--   row names its agent id. Capturing a text FIRST was enough to own the row
--   for good. A write key that later captured the same text landed on that
--   row (035), and board-sync adopted a row holding a ticket's text in place;
--   the capture key could still mark the row superseded, so the writer's
--   thought, or the ticket's head, read "Superseded" and ranked x0.25.
--   Checking ownership when the pointer is asked for (the server) leaves
--   three ways round it, all shown on the real server in SMD-2638's reviews:
--   * the reverse order: the key supersedes its own row first, while it is
--     still only its own, and the writer or board-sync lands on it after;
--   * a write key's re-capture that changes nothing writes no audit row
--     (046's no-op gate) — with a deterministic extractor and both sides on
--     the default source, the ordinary case;
--   * the race: the server checks before its model calls and writes seconds
--     later, and a taking in between found no pointer to lapse.
--
-- WHAT
--   * ob1_takes_thought(diff, agent, capturer) — the one rule: an update
--     event takes a thought from the agent that captured it when its own
--     agent is another (none included) and it
--       - records a re-capture by a key that can read (`recaptured`, below),
--       - moves the text, or
--       - gives the metadata a ticket identity (`issue`) it lacked, under no
--         agent id — how board-sync adopts a row (db/sync-linear.ts, which
--         writes without one); a key that cannot read may not set `issue`
--         (SMD-2617).
--     Someone else then holds the text. A key's metadata edit does not take
--     the thought, whatever it adds: a writer tagging the hook's summary or
--     filing it under a ticket, a kanban move, backfill_thought_actors, a
--     recipe's tags. A lapse is not
--     fail-safe — it puts a summary the hook superseded back to current — so
--     only a write that puts another's text on the row may cause one. Nor
--     does a vector (db/reembed.ts), a pointer, or a fingerprint.
--   * ob1_capturer_of(id), ob1_thought_taken(id) — the agent of the first
--     capture row, and whether any update event takes the thought from it.
--     The server reads the second beside the capture row for every target of
--     a capture-only key's `supersedes` (core/writes.ts).
--   * ob1_note_recapture(id, actor) — the stores call it when a capture
--     WITHOUT p_payload.recapture = 'keep' (a key that can read) landed on an
--     existing row. When the row's capture row says it was a capture-only
--     key's ("scope": "capture" in actor_context, which the server writes
--     from SMD-2638 on), the row is not yet taken and the caller is another
--     agent, it appends one update event, diff {"recaptured": true}, and
--     projects it: updated_at moves, nothing else. Any other row is left as
--     060 leaves it — a re-capture that changes nothing moves nothing — and a
--     capture-only key's re-capture ('keep') records nothing, so one capture
--     key cannot take another's thought by sending its text.
--   * The lapse: an AFTER INSERT trigger on thought_audit. When an update
--     event takes thought T, the pointer onto T of each thought that T's
--     capturer captured with that pointer under the capture scope, and that
--     no update has re-pointed since, is cleared: an update event of its
--     own, under the actor of the write that took T, appended and projected.
--     A pointer a write key set is never lapsed.
--   * The check at the write: an AFTER INSERT trigger on thought_audit for a
--     capture-scoped capture event that names `supersedes`. It takes an
--     advisory lock on the target, so two such captures naming one target
--     are serialised and the second sees the first; locks the target FOR
--     SHARE, which waits for any taker, every one of which holds the row FOR
--     NO KEY UPDATE before its append; and refuses the capture (SQLSTATE
--     OB004) when the target is no longer the capturing key's alone: another
--     agent captured it, it is taken, or something already supersedes it. The server drops the pointer and writes again, as it
--     does for a target deleted mid-write. One superseder per target bounds
--     the lapse to one event, where a key pointing thousands of its own
--     captures at one thought made the taker's write pay for each.
--
--   ob1:capture-pointer-lapses and ob1:capture-pointer-checked-at-write —
--   CONTRACT SENTINELS, not prose (the 014 convention), in the two trigger
--   functions.
--
-- NOT HERE
--   * A pointer written before the server sent the scope mark, and a
--     capture-only key's row from before then: neither is marked, so the
--     pointer is not lapsed, the re-capture not noted, and the write-time
--     check not run. The server's check still holds a new pointer.
--   * A caller of upsert_thought outside the stores (a vendored integration)
--     records no re-capture.
--   * A row a capture key forged with `issue` before SMD-2617: board-sync's
--     patches find `issue` there already, so they do not take it.
--   * Timing: a kept pointer costs a projection a dropped one does not, a
--     pointer refused at the write costs a second write, and the check waits
--     behind a write in progress on the target. SMD-2473 left timing out of
--     the oracle rule, and so does this file.
--   * A taker under REPEATABLE READ (018's and 068's caveat): its lapse reads
--     its transaction's snapshot, so a capture-scoped pointer it waited on is
--     not seen. Every writer here runs READ COMMITTED.
--   * Board-sync re-chaining a ticket group that holds a capture key's pasted
--     header carries the key's pointer onto a board-sync row, which the lapse
--     does not clear: SMD-2670.
--   * A data-only reload of thought_audit (COPY into the table) fires both
--     triggers; a pg_dump/pg_restore creates triggers after the data.
--
-- The triggers write OTHER rows, each under its own event, between the event
-- that fired them and that event's projection: 060's check holds each row to
-- its own latest event, and a trigger on the log that writes the SAME row is
-- still refused (test-schema).
--
-- Idempotent: CREATE OR REPLACE, and each trigger dropped by name first.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regprocedure('ob1_append_thought_event(uuid, text, text, jsonb, jsonb)') IS NULL
     OR to_regprocedure('ob1_project_thought_event(uuid, vector, text, boolean)') IS NULL
     OR to_regprocedure('ob1_actor_agent_id()') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 081 needs 060 and 061 (ob1_append_thought_event, ob1_project_thought_event, ob1_actor_agent_id); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. The rule, and the two reads.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_takes_thought(p_diff jsonb, p_agent uuid, p_capturer uuid)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  -- `->>` reads a JSON null as SQL NULL: a row whose metadata held
  -- "issue": null lacked a ticket identity (board-sync's ticketIdentifier
  -- reads it so), and gaining one takes it. Only under no agent id, as
  -- board-sync writes: a write key filing the hook's summary under a ticket
  -- is a metadata edit, and lapsing for it would put the summary back to
  -- current (SMD-2638 review pass 3).
  SELECT COALESCE(
    jsonb_typeof(p_diff) = 'object'
    AND p_capturer IS NOT NULL
    AND p_agent IS DISTINCT FROM p_capturer
    AND (p_diff ? 'recaptured'
         OR p_diff ? 'content'
         OR (p_agent IS NULL
             AND p_diff->'metadata'->'after'->>'issue' IS NOT NULL
             AND p_diff->'metadata'->'before'->>'issue' IS NULL)),
    false)
$$;

COMMENT ON FUNCTION ob1_takes_thought(jsonb, uuid, uuid) IS
  'Whether an update event (its diff and its canonical agent id) takes a thought from the agent that captured it: another agent, or none, that records a re-capture (`recaptured`) or moves the text, or no agent giving the metadata an `issue` it lacked (board-sync''s adoption) — someone else then holds the text. A key''s metadata edit, a vector, a pointer and a fingerprint do not. False for a thought nobody attributable captured, and for a diff that is not an object. Read by ob1_thought_taken and the lapse trigger. Migration 081 / SMD-2638.';

CREATE OR REPLACE FUNCTION ob1_capturer_of(p_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  -- The FIRST capture row, as the server's captureActorOf reads it: one per
  -- thought by construction (035); the id breaks a tie on created_at.
  SELECT canonical_agent_id FROM thought_audit
   WHERE thought_id = p_id AND action = 'capture'
   ORDER BY created_at ASC, id ASC
   LIMIT 1
$$;

COMMENT ON FUNCTION ob1_capturer_of(uuid) IS
  'The canonical agent id (010) on a thought''s first capture audit row, or NULL — none, or captured without one. Migration 081 / SMD-2638.';

CREATE OR REPLACE FUNCTION ob1_thought_taken(p_id uuid)
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

COMMENT ON FUNCTION ob1_thought_taken(uuid) IS
  'Whether any update event on the thought takes it from the agent that captured it (ob1_takes_thought). The server reads it for every target of a capture-only key''s `supersedes`, and the write-time check reads it again under a lock: a taken thought is not the key''s, and the pointer is dropped. Migration 081 / SMD-2638.';

-- ---------------------------------------------------------------------------
-- 2. A re-capture by a key that can read, recorded.
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
  -- already taken, the capturer's own re-capture, or any other row records
  -- nothing — 060's rule, a re-capture that changes nothing moves nothing.
  IF v_capturer IS NULL
     OR ob1_actor_agent_id() IS NOT DISTINCT FROM v_capturer
     OR NOT EXISTS (SELECT 1 FROM thought_audit c
                     WHERE c.thought_id = p_id AND c.action = 'capture'
                       AND c.actor_context->>'scope' = 'capture')
     OR ob1_thought_taken(p_id) THEN
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
  'Records that a key that can read captured text a capture-only key''s thought holds: called by the stores after a capture without p_payload.recapture = ''keep'' lands on an existing row. Sets ob1.actor from p_actor (008''s envelope), locks the row, and — when its capture row carries "scope": "capture", it is not yet taken and the caller is another agent — appends one update event with diff {"recaptured": true} and projects it (updated_at moves, nothing else). Returns whether it recorded one. The event takes the thought from its capturer (ob1_takes_thought), and its append fires the lapse. Migration 081 / SMD-2638.';

-- ---------------------------------------------------------------------------
-- 3. The lapse.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_lapse_capture_pointers()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_capturer uuid;
  s          record;
  v_ev       uuid;
BEGIN
  -- ob1:capture-pointer-lapses — a CONTRACT SENTINEL, not prose (the 014
  -- convention). An update event that takes thought T from its capturer
  -- clears every capture-scoped pointer the capturer wrote onto T and no
  -- update has re-pointed since.
  v_capturer := ob1_capturer_of(NEW.thought_id);
  IF NOT ob1_takes_thought(NEW.diff, NEW.canonical_agent_id, v_capturer) THEN
    RETURN NULL;
  END IF;
  FOR s IN
    SELECT t.id, t.metadata
      FROM thoughts t
     WHERE t.supersedes = NEW.thought_id
       AND EXISTS (SELECT 1 FROM thought_audit c
                    WHERE c.thought_id = t.id AND c.action = 'capture'
                      AND c.canonical_agent_id = v_capturer
                      AND c.actor_context->>'scope' = 'capture'
                      AND c.diff->>'supersedes' = NEW.thought_id::text)
       -- The pointer the capture wrote, not one a key set since: a write
       -- key's update_thought, an accepted proposal, board-sync's chain.
       AND NOT EXISTS (SELECT 1 FROM thought_audit u
                        WHERE u.thought_id = t.id AND u.action = 'update'
                          AND u.diff ? 'supersedes')
     ORDER BY t.id
       FOR NO KEY UPDATE OF t
  LOOP
    -- Each pointer an event of its own, under the actor of the write that
    -- took T (ob1.actor, as it stands), projected before the next: 060's
    -- check holds each row to its own latest event. The projector clears
    -- its settings on the way out; the write that fired this projects its
    -- own event after, and sets them again. The write-time check below keeps
    -- this to one row for a pointer written since 081.
    v_ev := ob1_append_thought_event(s.id, 'update', s.metadata->>'source',
              jsonb_build_object('supersedes', jsonb_build_object('before', NEW.thought_id, 'after', NULL)), NULL);
    IF v_ev IS NOT NULL THEN
      PERFORM ob1_project_thought_event(v_ev);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION ob1_lapse_capture_pointers() IS
  'The lapse (AFTER INSERT on thought_audit, update events): when one takes a thought from the agent that captured it (ob1_takes_thought), every thought that names it as `supersedes`, was captured by that agent with that pointer under a capture-only key (its capture row''s actor_context has "scope": "capture") and has not been re-pointed by any update since, has the pointer cleared — an update event of its own under the current actor, appended and projected. A pointer a write key set is never lapsed. Migration 081 / SMD-2638.';

DROP TRIGGER IF EXISTS thought_audit_lapse_capture_pointers ON thought_audit;
CREATE TRIGGER thought_audit_lapse_capture_pointers
  AFTER INSERT ON thought_audit
  FOR EACH ROW
  WHEN (NEW.action = 'update' AND NEW.diff ?| ARRAY['recaptured', 'content', 'metadata'])
  EXECUTE FUNCTION ob1_lapse_capture_pointers();

-- ---------------------------------------------------------------------------
-- 4. The check at the write.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_check_capture_pointer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_target uuid;
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
  PERFORM 1 FROM thoughts WHERE id = v_target FOR SHARE;
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
  'The check at the write (AFTER INSERT on thought_audit, capture events carrying `supersedes` and "scope": "capture"): takes an advisory lock on the target (two such captures naming one target are serialised), locks it FOR SHARE, which waits for any taker, and refuses the capture (SQLSTATE OB004) when the capture names no agent or the target is not that agent''s alone — captured by another, taken (ob1_thought_taken), or already superseded by any thought. The server drops the pointer and writes again. One superseder per target bounds the lapse to one event. Migration 081 / SMD-2638.';

DROP TRIGGER IF EXISTS thought_audit_check_capture_pointer ON thought_audit;
CREATE TRIGGER thought_audit_check_capture_pointer
  AFTER INSERT ON thought_audit
  FOR EACH ROW
  WHEN (NEW.action = 'capture' AND NEW.diff ? 'supersedes' AND NEW.actor_context->>'scope' = 'capture')
  EXECUTE FUNCTION ob1_check_capture_pointer();
