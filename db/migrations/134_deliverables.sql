-- =============================================================================
-- Migration 134: deliverables — a unit of agent output tied to the spec it
--                was meant to meet, with a checkpoint and a status that moves
--                only through the allowed transitions; the events are the
--                record and a `deliverable` facet on the thought is their
--                projection (SMD-1715 PR 1)
-- =============================================================================
--
-- WHY
--   A deliverable is what gets verified: one output an agent handed back,
--   the spec it was asked to meet, the commit or content fingerprint it was
--   handed back at, and whether anyone has checked it. Nothing in the brain
--   held one. Whether a run did what it was asked lived in the PR and the
--   session, so plan_context's specs section has said "not available here"
--   (SMD-2684), and SMD-2683's spec reads "met" from a verified deliverable
--   that cites it.
--
-- WHAT
--   The maintainer chose (2026-11-11) three things before this file was
--   written: the events have a table of their own, as 116's priorities and
--   117's open items do, not an op on thought_audit; the ticket's Work 5
--   (a thought_work_claims work type for "who is working it") is dropped,
--   since 015 is a worker's batch pool and no caller claims one named thought
--   there, and each event stamps its maker instead; and a deliverable is not
--   verified by the key that captured it (and, since review pass 2, not by a
--   key that wrote its thought). And two definitions (review pass 3):
--   * WHAT A VERIFICATION VOUCHES FOR is the output at the deliverable's
--     checkpoint, not the thought's text. The thought stays editable, and the
--     events don't follow an edit: a reader comparing a content-fingerprint
--     checkpoint with the thought's own fingerprint says when they differ
--     (PR 2, plan_context).
--   * `corrected` IS A FINDING ON THE SAME OUTPUT: a verification found the
--     output at its checkpoint wanting. corrected -> verified is a later
--     verification overturning that finding, at the same checkpoint. Reworked
--     output is a new deliverable, a new thought at its new checkpoint, so a
--     deliverable's checkpoint never changes (PR 2 makes the checkpoint part
--     of what it captures, so a new checkpoint is a new thought).
--   1. AN EVENT is one row of deliverable_events: captured or verification.
--      Each carries the deliverable's whole state after it (spec_ref,
--      checkpoint, status), a verification its method and outcome, and its
--      maker, which the writers stamp from the call's actor envelope (117's
--      ob1_actor_maker: the key's name, agent id, the registry's kind and
--      trust, the envelope's scope). A role holding INSERT on the table writes
--      any maker it names, as on 117's events: the maker, and the rule below
--      that it does not verify its own, hold through the writers. Its seq and
--      its time (`at`) are the trigger's, drawn under the deliverable's lock,
--      whatever the insert brought. seq orders one deliverable's events; it is
--      one sequence for every deliverable and not a cursor across them (an
--      event drawn earlier can commit later, and an event takes two values).
--      Events never change: a trigger refuses every UPDATE, DELETE and
--      TRUNCATE, for the owner too (046's rule).
--   2. THE TRANSITIONS are the event's, checked by a trigger on every insert,
--      the writers' and a raw one alike, under the deliverable's lock:
--      * the first event of a thought is its capture, status unverified, of a
--        thought that exists, citing a spec that exists and is not itself;
--      * every later event is a verification, keeping the capture's spec_ref
--        and checkpoint, moving the status by one allowed transition:
--        unverified -> verified, unverified -> corrected,
--        verified -> corrected, corrected -> verified
--        (ob1_deliverable_transition_ok, the one statement of the rule).
--      ob1:deliverable-transitions-on-the-event
--   3. THE FACET is the projection: one `deliverable` facet on the thought,
--      standing, its payload what ob1_deliverable_payload builds from the
--      events — {spec_ref, checkpoint, status, captured_by, captured_at,
--      verification: null | {method, outcome, by, at}, seq}. The validator
--      admits a deliverable facet only when its payload is that projection of
--      the newest event, so a direct UPDATE of its status, forbidden or not,
--      is refused below any tool, and so is one inserted with no event. Every
--      event is projected as it lands, by a trigger after the insert, a raw
--      one's too, so the facet is never left behind its events. It is
--      deleted only with its thought (the cascade): a trigger refuses any
--      other DELETE. 120's validator is carried whole, but the kind check and
--      this branch. ob1:deliverable-facet-is-the-projection
--   4. THE FUNCTIONS (SECURITY INVOKER, PUBLIC's EXECUTE as every core
--      function), each jsonb {outcome, code?, message?, ...}; a refusal is a
--      value, a malformed argument and an envelope naming nobody raise:
--      * record_deliverable(thought, spec, checkpoint, actor) — makes a
--        thought a deliverable: {outcome: captured | unchanged | refused,
--        deliverable, event}. The thought is written first, by the capture
--        path (upsert_thought, its derived_from carrying the spec), in the
--        same transaction (SMD-1715 PR 2). Refused WRITE_SCOPE_REQUIRED (an
--        envelope stating no write scope), THOUGHT_NOT_FOUND, SPEC_NOT_FOUND,
--        SPEC_IS_SELF, ALREADY_A_DELIVERABLE (another spec or checkpoint, or
--        another key: it names the key that recorded it); the same spec and
--        checkpoint again by the key that recorded it is unchanged.
--      * verify_deliverable(thought, status, method, outcome, actor) — one
--        verification: {outcome: changed | refused, deliverable, event, from,
--        to}. Refused WRITE_SCOPE_REQUIRED, NOT_A_DELIVERABLE (no capture, or
--        its thought deleted), ILLEGAL_TRANSITION (naming from and to), and
--        VERIFY_NOT_YOURS: a move to verified by the key that recorded the
--        deliverable or a key the brain records as writing its thought's text
--        (its capture, an update changing its content, or a capture-only
--        key's row re-captured, 082/092's `recaptured`, in thought_audit), by
--        its name or its agent id, as 117's PROPOSAL_YOURS. A key with no
--        agent id is known by its name alone, so such a key renamed since is
--        not matched. Another write key whose byte-identical submission the
--        capture deduplicated onto the thought leaves no record, and is not
--        matched either (SMD-4242; the maintainer, 2026-11-12). A move to
--        corrected is any write key's, its maker's included.
--      * deliverable_history(thought) — {deliverable, events}, the events in
--        the order written; deliverable NULL for a thought with none, or one
--        deleted. STABLE, no actor.
--      * ob1_deliverable_projection_drift() and
--        ob1_rebuild_deliverable_projection(): 068's pattern.
--   5. CONCURRENCY. The writers, the event trigger and the facet's branch of
--      the validator take a transaction advisory lock on the thought
--      (ob1:deliverable:<id>) before they read its events, and raise above
--      READ COMMITTED (116's ob1_priority_isolation), so two verifications of
--      one deliverable queue and the second reads the first's status. The
--      trigger draws each event's seq under the lock, whatever the insert
--      brought, so a deliverable's events are numbered in the order written,
--      a raw insert's too. The projector locks the thought FOR KEY SHARE, so
--      a delete in flight is waited out. The rebuild takes the deliverables
--      in id order, so two rebuilds queue rather than deadlock.
--
-- NOT HERE
--   * The operations over REST and MCP, capture_deliverable and
--     verify_deliverable, write-scoped (SMD-1715 PR 2).
--   * A spec record (SMD-2683): spec_ref is any thought's id.
--   * The spec is not held: deleting it is not refused, as a cited source's
--     is (042), and the facet keeps the id it named.
--   * Forgetting (SMD-1723): the events may hold a verification's words; the
--     refusing trigger is what that ticket relaxes, as for 117's.
--   * Coverage, the share of a deliverable's citations with a live source,
--     is a read for a later ticket.
--
-- PRIVILEGES
--   The `deliverables` group (db/config.mjs ROLE_GRANTS): SELECT and INSERT
--   on deliverable_events (the trigger refuses the rest), and USAGE on its
--   seq's sequence (the trigger draws each event's seq itself); SELECT,
--   INSERT and UPDATE on thought_facets (the projection is written and
--   replaced). The thoughts' existence, their KEY SHARE locks and their
--   authors (thought_audit) are the capture group's SELECT and UPDATE.
--   Soft: a role without the group is refused the deliverable calls, naming
--   the table, and nothing else; the server first calls them in PR 2, whose
--   preflight checks the group.
--
-- SAFETY
--   One new table, its indexes, five triggers (four on it, one on
--   thought_facets), a unique index on thought_facets, twenty-two new functions,
--   and 120's validator replaced with one kind more; no row is changed, and
--   the validator's other branches are as 120 wrote them. MINOR under
--   FORK.md's version rules.
--
-- Prerequisites
--   042 (thought_facets), 117 (ob1_actor_maker), 116
--   (ob1_priority_isolation), 120 (the validator this file carries).
--   Applied by `bun db/migrate.ts`. Re-applied: the table and its rows are
--   kept, and the functions and the triggers are replaced as they were.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
DECLARE
  v_missing text;
BEGIN
  v_missing := CASE
    WHEN to_regclass('thought_facets') IS NULL THEN '042 (thought_facets)'
    WHEN to_regprocedure('ob1_priority_isolation(text)') IS NULL THEN '116 (ob1_priority_isolation)'
    WHEN to_regprocedure('ob1_actor_maker(jsonb, text)') IS NULL THEN '117 (ob1_actor_maker)'
    WHEN to_regprocedure('thread_relink(text, boolean)') IS NULL THEN '120 (thread_relink)'
  END;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('migration 134 needs %s; this schema lacks it', v_missing),
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url ... --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. The events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deliverable_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  -- The deliverable's thought. No foreign key: a thought deleted leaves its
  -- deliverable's history as it was (117's rule for an item's origin), and a
  -- cascade would be refused by the append-only trigger.
  thought_id      uuid        NOT NULL,
  event           text        NOT NULL,
  status          text        NOT NULL,
  spec_ref        uuid        NOT NULL,
  checkpoint      text        NOT NULL,
  method          text,
  outcome         text,
  actor_name      text        NOT NULL,
  actor_agent_id  uuid,
  actor_proved    boolean     NOT NULL,
  actor_kind      text,
  actor_trust     text,
  actor_scope     text,
  at              timestamptz NOT NULL,
  CONSTRAINT deliverable_events_event      CHECK (event IN ('captured', 'verification')),
  CONSTRAINT deliverable_events_status     CHECK (status IN ('unverified', 'verified', 'corrected')),
  -- A capture starts unverified and says nothing of a check; a verification
  -- says how it was checked and what was found.
  CONSTRAINT deliverable_events_capture    CHECK (event <> 'captured' OR (status = 'unverified' AND method IS NULL AND outcome IS NULL)),
  CONSTRAINT deliverable_events_check      CHECK (event <> 'verification' OR (method IS NOT NULL AND outcome IS NOT NULL)),
  CONSTRAINT deliverable_events_self       CHECK (spec_ref <> thought_id),
  CONSTRAINT deliverable_events_checkpoint CHECK (checkpoint <> '' AND length(checkpoint) <= 200 AND checkpoint !~ '[[:cntrl:]]'),
  CONSTRAINT deliverable_events_method     CHECK (method IS NULL OR (method <> '' AND length(method) <= 200 AND method !~ '[[:cntrl:]]')),
  CONSTRAINT deliverable_events_outcome    CHECK (outcome IS NULL OR (btrim(outcome) <> '' AND length(outcome) <= 4000)),
  CONSTRAINT deliverable_events_actor      CHECK (actor_name <> '' AND length(actor_name) <= 200),
  CONSTRAINT deliverable_events_kind       CHECK (actor_kind IS NULL OR actor_kind IN ('operator', 'agent', 'ingested')),
  CONSTRAINT deliverable_events_trust      CHECK (actor_trust IS NULL OR actor_trust IN ('operator', 'agent', 'ingested')),
  CONSTRAINT deliverable_events_scope      CHECK (actor_scope IS NULL OR (actor_scope <> '' AND length(actor_scope) <= 40))
);
COMMENT ON TABLE deliverable_events IS
  'Every event of a deliverable (SMD-1715), in the order written (seq): its capture, then each verification, each carrying the deliverable''s whole state after it (spec_ref, checkpoint, status) and its maker, which the writers stamp from the call''s actor envelope (never an argument; a role with INSERT on the table writes any maker it names, as on 117''s events); a verification its method and outcome. The status moves only unverified -> verified, unverified -> corrected, verified -> corrected or corrected -> verified (ob1_deliverable_transition_ok), checked on every insert by deliverable_events_transitions. Never changed: a trigger refuses UPDATE, DELETE and TRUNCATE. Written through record_deliverable and verify_deliverable; the thought''s `deliverable` facet is its projection. Migration 134 / SMD-1715.';
COMMENT ON COLUMN deliverable_events.spec_ref IS
  'The thought the deliverable was meant to meet: the spec, any thought''s id (SMD-2683''s spec record is a thought too). Fixed at the capture. Migration 134 / SMD-1715.';
COMMENT ON COLUMN deliverable_events.checkpoint IS
  'What the output was handed back at: a commit hash or a content fingerprint, at most 200 characters, no control characters. Fixed at the capture. Migration 134 / SMD-1715.';
COMMENT ON COLUMN deliverable_events.outcome IS
  'A verification''s finding, at most 4000 characters. May hold personal data, so forget_thought (SMD-1723) must reach a forgotten thought''s deliverable events. Migration 134 / SMD-1715.';
COMMENT ON COLUMN deliverable_events.actor_proved IS
  'Whether the maker''s agent id came from the envelope itself (061''s ob1_actor_agent_id), not the registry''s for its name (117''s column). Migration 134 / SMD-1715.';

CREATE INDEX IF NOT EXISTS deliverable_events_thought ON deliverable_events (thought_id, seq);
COMMENT ON INDEX deliverable_events_thought IS
  'A deliverable''s events in the order written: its history, its projection and the newest event a transition is checked from. Migration 134 / SMD-1715.';
CREATE UNIQUE INDEX IF NOT EXISTS deliverable_events_one_capture ON deliverable_events (thought_id) WHERE event = 'captured';
COMMENT ON INDEX deliverable_events_one_capture IS
  'One capture per deliverable. Migration 134 / SMD-1715.';
CREATE INDEX IF NOT EXISTS deliverable_events_spec ON deliverable_events (spec_ref) WHERE event = 'captured';
COMMENT ON INDEX deliverable_events_spec IS
  'The deliverables meant to meet one spec: what SMD-2683''s "met" reads. Migration 134 / SMD-1715.';

-- ---------------------------------------------------------------------------
-- 2. Never changed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_deliverable_events_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    MESSAGE = format('deliverable_events is append-only: %s refused (a deliverable changes by a new event: verify_deliverable)', TG_OP),
    ERRCODE = 'restrict_violation';
END;
$$;
COMMENT ON FUNCTION ob1_deliverable_events_guard() IS
  'Refuses every UPDATE and DELETE of deliverable_events, and every TRUNCATE — for the owner too. SMD-1723 relaxes it for forgetting. Migration 134 / SMD-1715.';

DROP TRIGGER IF EXISTS deliverable_events_append_only ON deliverable_events;
CREATE TRIGGER deliverable_events_append_only
  BEFORE UPDATE OR DELETE ON deliverable_events
  FOR EACH ROW EXECUTE FUNCTION ob1_deliverable_events_guard();
DROP TRIGGER IF EXISTS deliverable_events_no_truncate ON deliverable_events;
CREATE TRIGGER deliverable_events_no_truncate
  BEFORE TRUNCATE ON deliverable_events
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_deliverable_events_guard();

-- ---------------------------------------------------------------------------
-- 3. The transitions, the lock and the projection's payload
-- ---------------------------------------------------------------------------

-- The one statement of the rule: the event trigger and verify_deliverable's
-- refusal both read it.
CREATE OR REPLACE FUNCTION ob1_deliverable_transition_ok(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE((p_from, p_to) IN (('unverified', 'verified'), ('unverified', 'corrected'),
                                     ('verified', 'corrected'), ('corrected', 'verified')), false)
$$;
COMMENT ON FUNCTION ob1_deliverable_transition_ok(text, text) IS
  'Whether a deliverable''s status may move from p_from to p_to: unverified -> verified, unverified -> corrected, verified -> corrected and corrected -> verified, and nothing else (nothing returns to unverified, and no status moves to itself); false, never NULL. Migration 134 / SMD-1715.';

CREATE OR REPLACE FUNCTION ob1_deliverable_lock(p_thought uuid)
RETURNS void
LANGUAGE sql
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('ob1:deliverable:' || p_thought::text, 0))
$$;
COMMENT ON FUNCTION ob1_deliverable_lock(uuid) IS
  'Takes the transaction advisory lock on one deliverable (its thought''s id): the writers, the event trigger, the facet''s validator and the rebuild take it before they read its events. Migration 134 / SMD-1715.';

-- A time as the payload holds it: UTC, to the microsecond, whatever the
-- session's time zone, so the projection a session writes is the one any
-- other session's check computes.
CREATE OR REPLACE FUNCTION ob1_deliverable_time(p_at timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;
COMMENT ON FUNCTION ob1_deliverable_time(timestamptz) IS
  'A time in a deliverable''s payload: ISO 8601 in UTC to the microsecond, the same text whatever the session''s time zone. Migration 134 / SMD-1715.';

-- The projection: the facet's payload as the thought's events make it, or
-- NULL for a thought with none. The validator, the projector, the rebuild and
-- the drift check all read this one rule.
CREATE OR REPLACE FUNCTION ob1_deliverable_payload(p_thought uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  c deliverable_events;
  l deliverable_events;
BEGIN
  SELECT * INTO c FROM deliverable_events WHERE thought_id = p_thought AND event = 'captured';
  IF c.id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO l FROM deliverable_events WHERE thought_id = p_thought ORDER BY seq DESC LIMIT 1;
  RETURN jsonb_build_object(
    'spec_ref', l.spec_ref, 'checkpoint', l.checkpoint, 'status', l.status,
    'captured_by', c.actor_name, 'captured_at', ob1_deliverable_time(c.at),
    'verification', CASE WHEN l.event = 'verification' THEN jsonb_build_object(
      'method', l.method, 'outcome', l.outcome, 'by', l.actor_name, 'at', ob1_deliverable_time(l.at)) END,
    'seq', l.seq);
END;
$$;
COMMENT ON FUNCTION ob1_deliverable_payload(uuid) IS
  'The `deliverable` facet''s payload as a thought''s events make it: the newest event''s spec_ref, checkpoint and status, who captured it and when, the newest verification''s method, outcome, maker and time when the newest event is one (else null), and the newest event''s seq; NULL for a thought with no capture. The projection''s one rule: thought_facets_validate admits a deliverable facet only when its payload is this. Migration 134 / SMD-1715.';

-- The transitions, on every insert: the writers' and a raw one alike.
CREATE OR REPLACE FUNCTION ob1_deliverable_event_check()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  p deliverable_events;
BEGIN
  -- ob1:deliverable-transitions-on-the-event (134)
  -- READ COMMITTED alone: above it the newest event read after the lock is the
  -- transaction's old snapshot's, and a move from a status since replaced
  -- would be admitted for good (review pass 1).
  PERFORM ob1_priority_isolation('a deliverable event');
  PERFORM ob1_deliverable_lock(NEW.thought_id);
  SELECT * INTO p FROM deliverable_events WHERE thought_id = NEW.thought_id ORDER BY seq DESC LIMIT 1;
  -- The seq is drawn here, under the lock, whatever the insert brought: the
  -- identity's own is drawn before a BEFORE trigger runs, so an insert that
  -- waited on the lock held one below an event written meanwhile and sorted
  -- under it (review pass 1), and OVERRIDING SYSTEM VALUE let a raw insert
  -- name any seq at all, one above every later event's (review pass 2). Drawn
  -- under the deliverable's lock, a deliverable's events are numbered in the
  -- order they were written. The identity's sequence needs USAGE for this
  -- (the deliverables group). ob1:deliverable-seq-under-the-lock
  NEW.seq := nextval(pg_get_serial_sequence('deliverable_events', 'seq'));
  -- And its time, as its seq: a raw insert named any `at`, a verification
  -- dated before its capture among them (review pass 3).
  NEW.at := clock_timestamp();
  IF p.seq >= NEW.seq THEN
    -- Cannot happen while every event's seq is drawn here: said, not trusted.
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('deliverable %s''s newest event is %s, at or past the seq %s drawn under its lock', NEW.thought_id, p.seq, NEW.seq);
  END IF;
  IF NEW.event = 'captured' THEN
    IF p.id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('thought %s is a deliverable already (its newest event is %s): a deliverable is captured once, and changes by a verification', NEW.thought_id, p.seq);
    END IF;
    -- Both locked FOR KEY SHARE, so a delete in flight is waited out.
    PERFORM 1 FROM thoughts WHERE id = NEW.thought_id FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a deliverable''s thought %s is not a thought', NEW.thought_id);
    END IF;
    PERFORM 1 FROM thoughts WHERE id = NEW.spec_ref FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a deliverable''s spec_ref %s is not a thought', NEW.spec_ref);
    END IF;
    RETURN NEW;
  END IF;
  IF p.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('thought %s is not a deliverable: a verification follows a capture', NEW.thought_id);
  END IF;
  IF NEW.spec_ref IS DISTINCT FROM p.spec_ref OR NEW.checkpoint IS DISTINCT FROM p.checkpoint THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('a deliverable keeps the spec_ref and checkpoint it was captured with (%s at %L); a verification may not change them', p.spec_ref, p.checkpoint);
  END IF;
  IF NOT ob1_deliverable_transition_ok(p.status, NEW.status) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('a deliverable''s status does not move %s -> %s: the allowed moves are unverified -> verified, unverified -> corrected, verified -> corrected and corrected -> verified', p.status, NEW.status);
  END IF;
  PERFORM 1 FROM thoughts WHERE id = NEW.thought_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('deliverable %s''s thought was deleted: it takes no more verifications', NEW.thought_id);
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION ob1_deliverable_event_check() IS
  'BEFORE INSERT on deliverable_events, under READ COMMITTED alone (0A000 above it) and the deliverable''s lock: its seq and its time (at) drawn here, after the lock, whatever the insert brought (the identity''s seq, or OVERRIDING SYSTEM VALUE''s, and any at), so a deliverable''s events are numbered in the order written; a capture is a thought''s first event, of a thought that exists, citing a spec_ref that exists (both locked FOR KEY SHARE); every later event is a verification of a thought still there, keeping the capture''s spec_ref and checkpoint, its status one allowed move from the newest event''s (ob1_deliverable_transition_ok). check_violation naming what was refused, for the writers'' inserts and a raw one alike. Migration 134 / SMD-1715.';

DROP TRIGGER IF EXISTS deliverable_events_transitions ON deliverable_events;
CREATE TRIGGER deliverable_events_transitions
  BEFORE INSERT ON deliverable_events
  FOR EACH ROW EXECUTE FUNCTION ob1_deliverable_event_check();

-- ---------------------------------------------------------------------------
-- 4. The `deliverable` facet kind — thought_facets_validate extended
--
-- 120's body verbatim but the kind check, which names five kinds now, and the
-- new branch above the subject's.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thought_facets_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source   text;
  v_deleted  text;
  v_text     text;
  v_stance   text;
  v_relation text;
  v_system   text;
  v_target   text;
  v_conf     jsonb;
  v_key      text;
  v_by       text;
  v_want     jsonb;
BEGIN
  IF jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('thought_facets.payload must be a JSON object, got %s', COALESCE(jsonb_typeof(NEW.payload), 'null'));
  END IF;
  -- 084: a facet keeps its kind. An UPDATE turning a link into a citation
  -- was admitted by the citation branch, so a role holding the capture
  -- group's UPDATE could forge a citation of any thought and have its delete
  -- refused (CITED); the same for a link or a relation made from another
  -- kind. No writer changes a kind (SMD-1873 PR 2 review pass 2).
  IF TG_OP = 'UPDATE' AND NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('a facet keeps its kind: a %s is not turned into a %s; write a new facet', OLD.kind, NEW.kind);
  END IF;
  IF NEW.kind IS DISTINCT FROM 'citation' AND NEW.kind IS DISTINCT FROM 'link' AND NEW.kind IS DISTINCT FROM 'relation'
     AND NEW.kind IS DISTINCT FROM 'subject' AND NEW.kind IS DISTINCT FROM 'deliverable' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('thought_facets.kind %L is not a registered facet kind', NEW.kind),
      HINT = 'The registered kinds are: citation (migration 042), link (migration 053), relation (migration 084), subject (migration 111), deliverable (migration 134). A new kind is registered by a migration that extends thought_facets_validate.';
  END IF;

  IF NEW.kind = 'deliverable' THEN
    -- ob1:deliverable-facet-is-the-projection (134)
    -- A deliverable (SMD-1715) is its events: the facet is admitted only as
    -- their projection of the newest one, so a status moves by an event
    -- (verify_deliverable), whose trigger checks the move, and never by an
    -- UPDATE of the facet, forbidden or allowed. Under the deliverable's lock,
    -- so the newest event read is the one a writer in flight leaves, and READ
    -- COMMITTED alone, so that read is not an older snapshot's (review pass 1).
    PERFORM ob1_priority_isolation('a deliverable facet');
    PERFORM ob1_deliverable_lock(NEW.thought_id);
    IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.thought_id IS DISTINCT FROM OLD.thought_id
                             OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a deliverable facet stays on its thought: its id, thought and created_at are as written';
    END IF;
    IF NEW.valid_until IS NOT NULL OR NEW.superseded_by IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a deliverable facet stands while its thought does: valid_until and superseded_by stay unset';
    END IF;
    v_want := ob1_deliverable_payload(NEW.thought_id);
    IF v_want IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('thought %s has no deliverable events: a deliverable is recorded by record_deliverable, and its facet is their projection', NEW.thought_id);
    END IF;
    IF NEW.payload IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a deliverable facet is the projection of its events: thought %s stands %s as of event %s, and this row says %s. A status moves by a new event (verify_deliverable), whose trigger allows only unverified -> verified, unverified -> corrected, verified -> corrected and corrected -> verified',
                         NEW.thought_id, v_want->>'status', v_want->>'seq', COALESCE(left(NEW.payload->>'status', 40), 'no status')),
        HINT = 'ob1_rebuild_deliverable_projection() makes every deliverable facet current from its events.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.kind = 'subject' THEN
    -- ob1:subject-facet (111)
    -- A thought's own subject (SMD-3306), written once and only ever closed,
    -- as a relation is: the one UPDATE is the close — record_thought_subject
    -- setting valid_until with every other column as it was. A rewrite would
    -- leave its lineage naming what it no longer says.
    IF TG_OP = 'UPDATE' THEN
      IF NEW.id = OLD.id AND NEW.thought_id = OLD.thought_id AND NEW.payload = OLD.payload
         AND NEW.superseded_by IS NOT DISTINCT FROM OLD.superseded_by AND NEW.created_at = OLD.created_at
         AND OLD.valid_until IS NULL AND NEW.valid_until IS NOT NULL AND NEW.valid_until <= now() THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a subject is written once and only closed: the one update it takes sets valid_until, not in the future, on a standing subject, every other column as it was',
        HINT = 'record_thought_subject replaces a subject (the old one closed, a new one written); write a new row rather than edit one.';
    END IF;
    IF NEW.valid_until IS NOT NULL OR NEW.superseded_by IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a subject is written standing: valid_until and superseded_by are set only by its close';
    END IF;
    v_key := NEW.payload->>'key';
    v_by  := NEW.payload->>'by';
    IF jsonb_typeof(NEW.payload->'key') IS DISTINCT FROM 'string' OR NOT subject_key_valid(v_key) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a subject''s key is ticket:<ID>, pr:<number>, version:<v1.2.3> or phrase:<lower-case words>, got %L', left(v_key, 80));
    END IF;
    IF v_by IS NULL OR v_by NOT IN ('metadata', 'first_line', 'model') THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a subject says how it was found: by is metadata, first_line or model, got %L', v_by);
    END IF;
    IF jsonb_typeof(NEW.payload->'judge_key') IS DISTINCT FROM 'string' OR btrim(NEW.payload->>'judge_key') = '' OR length(NEW.payload->>'judge_key') > 200 THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a subject names the pass that found it: judge_key, a non-empty string of at most 200 characters';
    END IF;
    -- Origin is the validator's word, not the writer's: a pass derived it.
    NEW.payload := NEW.payload || jsonb_build_object('origin', 'derived');
    RETURN NEW;
  END IF;

  IF NEW.kind = 'relation' THEN
    -- ob1:relation-facet (084; distinct since 102)
    -- A relation is written once and only ever closed. The one UPDATE is the
    -- close — record_thought_relation, or the target's delete, setting
    -- valid_until with every other column as it was — and it is not re-judged:
    -- the target may be gone by then. Any other UPDATE of a relation, or one
    -- turning another kind into a relation, is refused: a rewrite would leave
    -- its lineage naming what it no longer says, and a re-open could stand an
    -- edge on a deleted thought (SMD-1873 PR 2 review pass 1).
    IF TG_OP = 'UPDATE' THEN
      -- The close sets valid_until to a time not in the future: a future one
      -- would leave the row off the one-standing index while
      -- thought_facet_active still counted it active (review pass 2).
      IF NEW.id = OLD.id AND NEW.thought_id = OLD.thought_id AND NEW.payload = OLD.payload
         AND NEW.superseded_by IS NOT DISTINCT FROM OLD.superseded_by AND NEW.created_at = OLD.created_at
         AND OLD.valid_until IS NULL AND NEW.valid_until IS NOT NULL AND NEW.valid_until <= now() THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a relation is written once and only closed: the one update it takes sets valid_until, not in the future, on a standing relation, every other column as it was',
        HINT = 'record_thought_relation replaces a relation (the old one closed, a new one written); write a new row rather than edit one.';
    END IF;
    IF NEW.valid_until IS NOT NULL OR NEW.superseded_by IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a relation is written standing: valid_until and superseded_by are set only by its close';
    END IF;
    v_relation := NEW.payload->>'relation';
    v_target   := NEW.payload->>'target';
    v_conf     := NEW.payload->'confidence';
    IF v_relation IS NULL OR v_relation NOT IN ('related', 'evolves', 'duplicate', 'distinct') THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a relation''s relation must be related, evolves, duplicate or distinct, got %L', v_relation);
    END IF;
    IF jsonb_typeof(NEW.payload->'target') IS DISTINCT FROM 'string'
       OR v_target !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a relation''s target must be a thought id, got %L', left(v_target, 60));
    END IF;
    IF v_target::uuid = NEW.thought_id THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a thought is not related to itself';
    END IF;
    IF jsonb_typeof(NEW.payload->'judge_key') IS DISTINCT FROM 'string' OR btrim(NEW.payload->>'judge_key') = '' OR length(NEW.payload->>'judge_key') > 200 THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a relation names the pass that judged it: judge_key, a non-empty string of at most 200 characters';
    END IF;
    -- ob1:thread-edge (120)
    -- A relation naming a subject key is a thread's edge (SMD-3306 PR 7a-1), written by
    -- thread_relink: the next thought on the key's thread goes on from the one before it, so
    -- evolves, under the threads' judge key, thread:<version>, with no confidence — its order is
    -- the subjects' order, not a judgement. Any other relation is the judge's: no key, and no
    -- thread's judge key. The validator, not the writer, says which (its origin below).
    IF NEW.payload ? 'key' THEN
      v_key := NEW.payload->>'key';
      IF jsonb_typeof(NEW.payload->'key') IS DISTINCT FROM 'string' OR NOT subject_key_valid(v_key) THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = format('a thread''s edge names its thread by a subject key, ticket:<ID>, pr:<number>, version:<v1.2.3> or phrase:<lower-case words>, got %L', left(v_key, 80));
      END IF;
      IF v_relation IS DISTINCT FROM 'evolves' THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = format('a thread''s edge is evolves, the next thought on the thread going on from the one before it, got %L', v_relation);
      END IF;
      IF NEW.payload->>'judge_key' NOT LIKE 'thread:%' THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = format('a thread''s edge names the threads'' version as its judge key, thread:<version>, got %L', left(NEW.payload->>'judge_key', 80));
      END IF;
      IF v_conf IS NOT NULL AND jsonb_typeof(v_conf) <> 'null' THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = 'a thread''s edge carries no confidence: its order is the subjects'' order, not a judgement';
      END IF;
    ELSIF NEW.payload->>'judge_key' LIKE 'thread:%' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a judge key thread:<version> is a thread''s edge''s, which names the subject key of its thread';
    END IF;
    IF v_conf IS NOT NULL AND jsonb_typeof(v_conf) <> 'null'
       AND (jsonb_typeof(v_conf) <> 'number' OR (v_conf)::numeric < 0 OR (v_conf)::numeric > 1) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a relation''s confidence is a number from 0 to 1, got %s', left(v_conf::text, 40));
    END IF;
    IF v_target IS DISTINCT FROM (v_target::uuid)::text THEN
      NEW.payload := NEW.payload || jsonb_build_object('target', v_target::uuid);
      v_target := (v_target::uuid)::text;
    END IF;
    -- The target must exist when the edge is written; locked FOR KEY SHARE so
    -- a delete of it waits, and then closes the edge (084's trigger on thoughts).
    PERFORM 1 FROM thoughts WHERE id = v_target::uuid FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a relation''s target %s is not a thought', v_target);
    END IF;
    -- Origin is the validator's word, not the writer's: a pass judged it, or, since 120, a
    -- thread's order made it.
    NEW.payload := NEW.payload || jsonb_build_object('origin', CASE WHEN NEW.payload ? 'key' THEN 'thread' ELSE 'judged' END);
    RETURN NEW;
  END IF;

  IF NEW.kind = 'link' THEN
    -- ob1:link-facet (053)
    -- A close — record_source_links setting valid_until with the payload as
    -- it was — is not a new link and is not re-judged: an identity re-pointed
    -- onto the target since (record_thought_source on the same thought) would
    -- otherwise make the row impossible to close, and every later structure
    -- write on the thought would fail (fourth review pass).
    -- Exactly a close and nothing else: the same link row, on the same
    -- thought, going from open to closed — a raw UPDATE that moves the row to
    -- another thought, re-opens it or turns a citation into a link is judged
    -- like any write (fifth review pass, independent read).
    IF TG_OP = 'UPDATE' AND OLD.kind = 'link' AND NEW.thought_id = OLD.thought_id
       AND NEW.payload = OLD.payload AND OLD.valid_until IS NULL AND NEW.valid_until IS NOT NULL THEN
      RETURN NEW;
    END IF;
    v_relation := NEW.payload->>'relation';
    v_system   := NEW.payload->>'system';
    v_target   := NEW.payload->>'target';
    IF v_relation IS NULL OR v_relation NOT IN ('references', 'child_of', 'blocks', 'blocked_by', 'relates_to', 'duplicate_of') THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a link''s relation must be references, child_of, blocks, blocked_by, relates_to or duplicate_of, got %L', v_relation);
    END IF;
    IF v_system IS NULL OR v_system !~ '^[a-z][a-z0-9_-]*$' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a link names its source system as one lower-case word, got %L', v_system);
    END IF;
    IF jsonb_typeof(NEW.payload->'target') IS DISTINCT FROM 'string' OR btrim(v_target) = '' OR length(v_target) > 512 THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a link names its target by identity within the system: a non-empty string of at most 512 characters';
    END IF;
    IF EXISTS (SELECT 1 FROM thought_sources s WHERE s.thought_id = NEW.thought_id AND s.system = v_system AND s.identity = v_target) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a thought does not link to itself (%s %s)', v_system, v_target);
    END IF;
    -- Origin is the validator's word, not the writer's: the source said it.
    NEW.payload := NEW.payload || jsonb_build_object('origin', 'structured');
    RETURN NEW;
  END IF;

  v_text    := NEW.payload->>'text';
  v_stance  := NEW.payload->>'stance';
  v_source  := NEW.payload->>'source_id';
  v_deleted := NEW.payload->>'source_deleted_id';

  IF jsonb_typeof(NEW.payload->'text') IS DISTINCT FROM 'string' OR btrim(v_text) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'a citation needs a non-empty text: the statement that rests on the source';
  END IF;
  IF v_stance IS NULL OR v_stance NOT IN ('stated', 'retrieved', 'inferred') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('a citation''s stance must be stated, retrieved or inferred, got %L', v_stance);
  END IF;

  IF v_source IS NULL THEN
    IF v_deleted IS NULL
       OR v_deleted !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NEW.payload->>'source_deleted_at' IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a citation names its source: payload.source_id must be a thought id (null only with source_deleted_id and source_deleted_at — the shape the guard writes when a source is deleted, or a detached row restored whole)';
    END IF;
    BEGIN
      PERFORM (NEW.payload->>'source_deleted_at')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a detached citation''s source_deleted_at must be a timestamp, got %L', left(NEW.payload->>'source_deleted_at', 40));
    END;
    IF v_deleted IS DISTINCT FROM (v_deleted::uuid)::text THEN
      NEW.payload := NEW.payload || jsonb_build_object('source_deleted_id', v_deleted::uuid);
      v_deleted := (v_deleted::uuid)::text;
    END IF;
    IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM thoughts WHERE id = v_deleted::uuid) THEN
      NEW.payload := (NEW.payload - 'source_deleted_id' - 'source_deleted_at') || jsonb_build_object('source_id', v_deleted::uuid);
      v_source := v_deleted;
    ELSE
      IF TG_OP = 'INSERT' OR OLD.payload->>'source_id' IS NOT NULL THEN
        IF TG_OP = 'UPDATE' AND v_deleted::uuid IS DISTINCT FROM (OLD.payload->>'source_id')::uuid THEN
          RAISE EXCEPTION USING ERRCODE = 'check_violation',
            MESSAGE = format('a citation is detached only from the source it had (%s), not %s', OLD.payload->>'source_id', v_deleted);
        END IF;
        IF EXISTS (SELECT 1 FROM thoughts WHERE id = v_deleted::uuid) THEN
          RAISE EXCEPTION USING ERRCODE = 'check_violation',
            MESSAGE = format('a citation is detached only when its source is gone; thought %s still exists', v_deleted);
        END IF;
      ELSIF v_deleted::uuid IS DISTINCT FROM (OLD.payload->>'source_deleted_id')::uuid THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = 'a detached citation keeps the source it lost';
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  IF v_source !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('a citation''s source_id must be a thought id, got %L', left(v_source, 60));
  END IF;
  IF v_source::uuid = NEW.thought_id THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'a thought cannot cite itself as a source';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.payload->>'source_id' IS NULL AND OLD.payload ? 'source_deleted_id' THEN
    IF v_source::uuid IS DISTINCT FROM (OLD.payload->>'source_deleted_id')::uuid THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a detached citation is not re-pointed at a new source (it rested on %s, deleted %s); record a new citation — it may only be re-attached to %s once that thought exists again', OLD.payload->>'source_deleted_id', OLD.payload->>'source_deleted_at', OLD.payload->>'source_deleted_id');
    END IF;
    NEW.payload := NEW.payload - 'source_deleted_id' - 'source_deleted_at';
  END IF;
  IF v_source IS DISTINCT FROM (v_source::uuid)::text THEN
    NEW.payload := NEW.payload || jsonb_build_object('source_id', v_source::uuid);
    v_source := (v_source::uuid)::text;
  END IF;
  IF NEW.payload ? 'source_deleted_id' OR NEW.payload ? 'source_deleted_at' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'a citation with a source carries no source_deleted_id or source_deleted_at — those are the detached shape''s, written when the source is deleted';
  END IF;
  IF TG_OP = 'INSERT' OR v_source IS DISTINCT FROM (OLD.payload->>'source_id') THEN
    PERFORM 1 FROM thoughts WHERE id = v_source::uuid FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a citation''s source_id %s is not a thought', v_source);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION thought_facets_validate() IS
  'BEFORE INSERT OR UPDATE on thought_facets: refuses an unregistered kind. For a citation (042): a missing text, a stance outside stated | retrieved | inferred, a source_id that is not an existing thought or is the citing thought itself — all as check_violation — stores source_id lower-case, locks the source row FOR KEY SHARE; source_id may be null only in the detached shape, which keeps what it lost and is not re-pointed. For a link (053): relation one of references | child_of | blocks | blocked_by | relates_to | duplicate_of, system one lower-case word, target a non-empty identity within it, never the thought''s own (thought_sources); writes origin = structured. For a relation (084): written standing (no valid_until, no superseded_by), relation one of related | evolves | duplicate | distinct (distinct since 102), target an existing thought (locked FOR KEY SHARE) that is not the thought itself, stored lower-case, judge_key a non-empty string of at most 200 characters, confidence a number in 0..1 or absent; writes origin = judged; afterwards only its close (valid_until set, not in the future, every other column as it was) is admitted — no rewrite, re-open or move. For a subject (111): written standing, key a subject key (subject_key_valid), by one of metadata | first_line | model, judge_key a non-empty string of at most 200 characters; writes origin = derived; afterwards only its close, as a relation''s. For a relation since 120: one naming a subject key is a thread''s edge — relation evolves, the key a subject key (subject_key_valid), judge_key thread:<version>, no confidence — and writes origin = thread; any other must name no thread''s judge key, and writes origin = judged. Since 084 no facet changes its kind on UPDATE. A pure close of a link passes unjudged. For a deliverable (134): standing, on the thought it was written on, its payload exactly the projection of the thought''s deliverable_events (ob1_deliverable_payload), read under the deliverable''s lock and READ COMMITTED alone; a thought with no events has none, and an UPDATE of its status, forbidden or allowed, is refused unless an event moved it first. Migrations 042, 053, 084, 102, 111, 120, 134.';


-- One standing deliverable per thought: the projection's row.
CREATE UNIQUE INDEX IF NOT EXISTS thought_facets_deliverable_uniq
  ON thought_facets (thought_id)
  WHERE kind = 'deliverable';
COMMENT ON INDEX thought_facets_deliverable_uniq IS
  'One deliverable facet per thought: the projection of its deliverable_events. Migration 134 / SMD-1715.';

-- The facet goes only with its thought: a DELETE of it alone would leave
-- events with no projection.
CREATE OR REPLACE FUNCTION ob1_deliverable_facet_kept()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- The cascade from the thought's delete runs after the thought's row is
  -- gone, so the thought not found is that cascade; anything else is a
  -- DELETE of the facet alone.
  IF EXISTS (SELECT 1 FROM thoughts WHERE id = OLD.thought_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'restrict_violation',
      MESSAGE = format('the deliverable facet on thought %s is the projection of its events and goes only with its thought', OLD.thought_id);
  END IF;
  RETURN OLD;
END;
$$;
COMMENT ON FUNCTION ob1_deliverable_facet_kept() IS
  'BEFORE DELETE on thought_facets, a deliverable facet alone: refused (restrict_violation) while its thought exists; the cascade from the thought''s own delete passes. Migration 134 / SMD-1715.';

DROP TRIGGER IF EXISTS thought_facets_deliverable_kept ON thought_facets;
CREATE TRIGGER thought_facets_deliverable_kept
  BEFORE DELETE ON thought_facets
  FOR EACH ROW WHEN (OLD.kind = 'deliverable') EXECUTE FUNCTION ob1_deliverable_facet_kept();

-- ---------------------------------------------------------------------------
-- 5. The writers' helpers
-- ---------------------------------------------------------------------------

-- A thought's id from text: a uuid, trimmed and lower-cased, or a raise
-- naming what it was meant to be.
CREATE OR REPLACE FUNCTION ob1_deliverable_id(p_id text, p_what text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v text := lower(btrim(COALESCE(p_id, '')));
BEGIN
  IF v !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION USING
      MESSAGE = format('%s is a thought''s id (a uuid), not %L', p_what, left(COALESCE(p_id, ''), 80)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v::uuid;
END;
$$;
COMMENT ON FUNCTION ob1_deliverable_id(text, text) IS
  'A thought''s id from text for the deliverable writers: a uuid, trimmed and lower-cased; raises 22023 naming p_what and the input on anything else. Migration 134 / SMD-1715.';

-- The writers' common start: READ COMMITTED, the maker from the envelope
-- (117's reader), and write scope alone: a deliverable is not a capture
-- key's (SMD-1715 Work 4), and a read key's or none at all is refused.
CREATE OR REPLACE FUNCTION ob1_deliverable_actor(p_actor jsonb, p_what text,
  OUT name text, OUT agent_id uuid, OUT env_agent_id uuid, OUT kind text, OUT trust text, OUT scope text, OUT refusal jsonb)
LANGUAGE plpgsql
AS $$
BEGIN
  -- ob1:deliverable-maker-from-the-envelope (134)
  PERFORM ob1_priority_isolation(p_what);
  SELECT m.name, m.agent_id, m.env_agent_id, m.kind, m.trust, m.scope
    INTO name, agent_id, env_agent_id, kind, trust, scope
    FROM ob1_actor_maker(p_actor, p_what) m;
  IF scope IS DISTINCT FROM 'write' THEN
    refusal := ob1_deliverable_refused('WRITE_SCOPE_REQUIRED',
      format('%s states no write scope, so it may not record or verify a deliverable', name));
  END IF;
END;
$$;
COMMENT ON FUNCTION ob1_deliverable_actor(jsonb, text) IS
  'The deliverable writers'' start: raises above READ COMMITTED (116''s ob1_priority_isolation), reads the maker (117''s ob1_actor_maker: name, agent id, the envelope''s own id, the registry''s kind and trust, the envelope''s scope), and refusal: a WRITE_SCOPE_REQUIRED outcome for an envelope stating any scope but write, else NULL. Migration 134 / SMD-1715.';

CREATE OR REPLACE FUNCTION ob1_deliverable_refused(p_code text, p_message text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object('outcome', 'refused', 'code', p_code, 'message', p_message)
$$;
COMMENT ON FUNCTION ob1_deliverable_refused(text, text) IS
  'A deliverable writer''s refusal: {outcome: refused, code, message}. Migration 134 / SMD-1715.';

-- One event as the functions return it.
CREATE OR REPLACE FUNCTION ob1_deliverable_event_json(e deliverable_events)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT CASE WHEN e.id IS NOT NULL THEN jsonb_build_object(
    'id', e.id, 'seq', e.seq, 'thought_id', e.thought_id, 'event', e.event, 'status', e.status,
    'spec_ref', e.spec_ref, 'checkpoint', e.checkpoint, 'method', e.method, 'outcome', e.outcome,
    'by', jsonb_build_object('name', e.actor_name, 'agent_id', e.actor_agent_id, 'kind', e.actor_kind, 'trust', e.actor_trust, 'scope', e.actor_scope),
    'at', ob1_deliverable_time(e.at)) END
$$;
COMMENT ON FUNCTION ob1_deliverable_event_json(deliverable_events) IS
  'One deliverable event as the functions return it: its ids and seq, event, status, spec_ref, checkpoint, method, outcome, maker {name, agent_id, kind, trust, scope} and time; NULL for none. Migration 134 / SMD-1715.';

-- A deliverable as the functions return it: its thought's id beside the
-- facet's payload, or NULL.
CREATE OR REPLACE FUNCTION ob1_deliverable_json(p_thought uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object('thought_id', f.thought_id) || f.payload
    FROM thought_facets f WHERE f.thought_id = p_thought AND f.kind = 'deliverable'
$$;
COMMENT ON FUNCTION ob1_deliverable_json(uuid) IS
  'A deliverable as the functions return it: {thought_id} and its facet''s payload (spec_ref, checkpoint, status, captured_by, captured_at, verification, seq); NULL for a thought with no deliverable facet. Migration 134 / SMD-1715.';

-- One event written, its maker stamped alike for every writer.
CREATE OR REPLACE FUNCTION ob1_deliverable_event(p_thought uuid, p_event text, p_status text, p_spec uuid, p_checkpoint text,
  p_method text, p_outcome text, p_who record)
RETURNS deliverable_events
LANGUAGE plpgsql
AS $$
DECLARE
  r deliverable_events;
BEGIN
  INSERT INTO deliverable_events (thought_id, event, status, spec_ref, checkpoint, method, outcome,
                                  actor_name, actor_agent_id, actor_proved, actor_kind, actor_trust, actor_scope, at)
  VALUES (p_thought, p_event, p_status, p_spec, p_checkpoint, p_method, p_outcome,
          p_who.name, p_who.agent_id, p_who.env_agent_id IS NOT NULL, p_who.kind, p_who.trust, p_who.scope, clock_timestamp())
  RETURNING * INTO r;
  RETURN r;
END;
$$;
COMMENT ON FUNCTION ob1_deliverable_event(uuid, text, text, uuid, text, text, text, record) IS
  'Writes one deliverable event — the state after it, a verification''s method and outcome, and its maker (p_who: ob1_deliverable_actor''s row) — and returns it. The transitions are its trigger''s. Migration 134 / SMD-1715.';

-- The facet made current from the events: written, or replaced, with the
-- payload ob1_deliverable_payload builds. Nothing for a thought deleted.
CREATE OR REPLACE FUNCTION ob1_deliverable_project(p_thought uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_want jsonb := ob1_deliverable_payload(p_thought);
BEGIN
  IF v_want IS NULL THEN
    RETURN NULL;
  END IF;
  -- Locked, not just read: a delete in flight is waited out and then seen, where
  -- a plain read saw the thought, the facet's cascade went under it and the
  -- INSERT below failed its foreign key, taking a whole rebuild with it (review
  -- pass 1).
  PERFORM 1 FROM thoughts WHERE id = p_thought FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  UPDATE thought_facets SET payload = v_want
   WHERE thought_id = p_thought AND kind = 'deliverable' AND payload IS DISTINCT FROM v_want;
  IF NOT EXISTS (SELECT 1 FROM thought_facets WHERE thought_id = p_thought AND kind = 'deliverable') THEN
    INSERT INTO thought_facets (thought_id, kind, payload) VALUES (p_thought, 'deliverable', v_want);
  END IF;
  RETURN ob1_deliverable_json(p_thought);
END;
$$;
COMMENT ON FUNCTION ob1_deliverable_project(uuid) IS
  'Makes one thought''s deliverable facet current from its events (ob1_deliverable_payload): replaced when it differs, written when there is none; returns the deliverable (ob1_deliverable_json), NULL for a thought with no capture or one deleted. The thought is locked FOR KEY SHARE, so a delete in flight is waited out. Called as each event lands (deliverable_events_projected, under the lock its BEFORE trigger took), and by the rebuild. Migration 134 / SMD-1715.';

-- Every event projected as it lands, a raw one too: the writers alone
-- projected, so a raw event left the facet stale until someone ran the
-- rebuild, which nothing runs (review pass 3). AFTER, so the event is there
-- to be read; under the lock its BEFORE trigger took.
CREATE OR REPLACE FUNCTION ob1_deliverable_event_projected()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM ob1_deliverable_project(NEW.thought_id);
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION ob1_deliverable_event_projected() IS
  'AFTER INSERT on deliverable_events: makes the thought''s deliverable facet current from its events (ob1_deliverable_project), for the writers'' events and a raw one alike, so the facet is the events'' projection however an event was written. Migration 134 / SMD-1715.';

DROP TRIGGER IF EXISTS deliverable_events_projected ON deliverable_events;
CREATE TRIGGER deliverable_events_projected
  AFTER INSERT ON deliverable_events
  FOR EACH ROW EXECUTE FUNCTION ob1_deliverable_event_projected();

-- Whether the call is the key that captured the deliverable: by its name, or
-- by its agent id. Either is enough, so a call made without its agent id
-- (the registry away) is still the maker it names, and the guard fails
-- closed (117's ob1_item_is_proposer). Never NULL.
CREATE OR REPLACE FUNCTION ob1_deliverable_is_maker(c deliverable_events, p_name text, p_agent uuid)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(c.actor_name = p_name, false)
         OR COALESCE(c.actor_agent_id IS NOT NULL AND c.actor_agent_id = p_agent, false)
$$;
COMMENT ON FUNCTION ob1_deliverable_is_maker(deliverable_events, text, uuid) IS
  'True when the call may be the key that captured the deliverable (c, its capture event): the same key name, or the same agent id; false otherwise, never NULL. What VERIFY_NOT_YOURS refuses, beside ob1_deliverable_is_author. Migration 134 / SMD-1715.';

-- Whether the call is a key that wrote the deliverable's thought's text: one
-- named, by name or agent id, on its capture in thought_audit, on an update
-- that changed its content, or on a re-capture by a key that can read (082's
-- `recaptured`: the rows ob1_takes_thought reads as taking a thought). The
-- first capture alone missed a key that rewrote the text after another
-- captured it (review pass 3). record_deliverable takes any thought, so the
-- key that recorded a deliverable need not be its author: both are refused
-- its verification (review pass 2, the maintainer's choice). A write key
-- whose identical submission the capture deduplicated onto a write key's
-- thought leaves no audit row (092 notes only a capture-only key's row
-- re-captured), so it is not matched here (SMD-4242). Never NULL; a row
-- naming no one matches no one.
CREATE OR REPLACE FUNCTION ob1_deliverable_is_author(p_thought uuid, p_name text, p_agent uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM thought_audit a
     WHERE a.thought_id = p_thought
       AND (a.action = 'capture'
            OR (a.action = 'update' AND jsonb_typeof(a.diff) = 'object' AND (a.diff ? 'content' OR a.diff ? 'recaptured')))
       AND (COALESCE(a.actor_name = p_name, false)
            OR COALESCE(a.canonical_agent_id IS NOT NULL AND a.canonical_agent_id = p_agent, false)))
$$;
COMMENT ON FUNCTION ob1_deliverable_is_author(uuid, text, uuid) IS
  'True when the call may be a key that wrote the text of the thought p_thought: a thought_audit row on it that captured it, changed its content, or re-captured it (082''s `recaptured`) names the same key name or the same agent id; false otherwise, never NULL. What VERIFY_NOT_YOURS refuses, beside ob1_deliverable_is_maker. Migration 134 / SMD-1715.';

-- ---------------------------------------------------------------------------
-- 6. The writers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION record_deliverable(
  p_thought    text,
  p_spec       text,
  p_checkpoint text,
  p_actor      jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_who        record;
  v_thought    uuid;
  v_spec       uuid;
  v_checkpoint text := btrim(COALESCE(p_checkpoint, ''));
  c            deliverable_events;
  e            deliverable_events;
BEGIN
  SELECT * INTO v_who FROM ob1_deliverable_actor(p_actor, 'record_deliverable');
  IF v_who.refusal IS NOT NULL THEN
    RETURN v_who.refusal;
  END IF;
  v_thought := ob1_deliverable_id(p_thought, 'record_deliverable''s thought');
  v_spec := ob1_deliverable_id(p_spec, 'record_deliverable''s spec');
  IF v_checkpoint = '' OR length(v_checkpoint) > 200 OR v_checkpoint ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_deliverable''s checkpoint is a commit hash or a content fingerprint: 1 to 200 characters, no control characters; got %s characters', length(v_checkpoint)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_spec = v_thought THEN
    RETURN ob1_deliverable_refused('SPEC_IS_SELF', format('thought %s cannot be its own spec', v_thought));
  END IF;
  PERFORM ob1_deliverable_lock(v_thought);
  PERFORM 1 FROM thoughts WHERE id = v_thought FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN ob1_deliverable_refused('THOUGHT_NOT_FOUND', format('thought %s is not in this brain', v_thought));
  END IF;
  SELECT * INTO c FROM deliverable_events WHERE thought_id = v_thought AND event = 'captured';
  IF c.id IS NOT NULL THEN
    -- The same again is unchanged for the key that recorded it alone: another
    -- key told `unchanged` read the deliverable as its own, and could then
    -- verify output it had submitted (review pass 3: a capture deduplicated
    -- onto an existing thought lands here).
    IF c.spec_ref = v_spec AND c.checkpoint = v_checkpoint AND ob1_deliverable_is_maker(c, v_who.name, v_who.agent_id) THEN
      RETURN jsonb_build_object('outcome', 'unchanged', 'deliverable', ob1_deliverable_json(v_thought), 'event', ob1_deliverable_event_json(c));
    END IF;
    RETURN ob1_deliverable_refused('ALREADY_A_DELIVERABLE',
      format('thought %s is a deliverable already, recorded by %s, meant to meet %s at checkpoint %s; a deliverable keeps the spec and checkpoint it was captured with, and the key that recorded it', v_thought, c.actor_name, c.spec_ref, c.checkpoint));
  END IF;
  PERFORM 1 FROM thoughts WHERE id = v_spec FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN ob1_deliverable_refused('SPEC_NOT_FOUND', format('the spec %s is not a thought in this brain', v_spec));
  END IF;
  e := ob1_deliverable_event(v_thought, 'captured', 'unverified', v_spec, v_checkpoint, NULL, NULL, v_who);
  RETURN jsonb_build_object('outcome', 'captured', 'deliverable', ob1_deliverable_json(v_thought), 'event', ob1_deliverable_event_json(e));
END;
$$;
COMMENT ON FUNCTION record_deliverable(text, text, text, jsonb) IS
  'Makes a thought a deliverable (SMD-1715): its capture event — status unverified, meant to meet the spec p_spec (a thought), handed back at p_checkpoint (a commit hash or content fingerprint, 1 to 200 characters) — and its facet. Returns {outcome: captured | unchanged | refused, deliverable, event}: unchanged, writing nothing, for the same spec and checkpoint again by the key that recorded it; refused WRITE_SCOPE_REQUIRED (an envelope stating no write scope), SPEC_IS_SELF, THOUGHT_NOT_FOUND, ALREADY_A_DELIVERABLE (another spec or checkpoint, or another key) or SPEC_NOT_FOUND. A malformed id or checkpoint raises 22023, an envelope naming nobody 42501, a transaction above READ COMMITTED 0A000. The thought is written first by the capture path, in the same transaction. Migration 134 / SMD-1715.';

CREATE OR REPLACE FUNCTION verify_deliverable(
  p_thought text,
  p_status  text,
  p_method  text,
  p_outcome text,
  p_actor   jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_who     record;
  v_thought uuid;
  v_status  text := lower(btrim(COALESCE(p_status, '')));
  v_method  text := btrim(COALESCE(p_method, ''));
  v_outcome text := COALESCE(p_outcome, '');
  c         deliverable_events;
  l         deliverable_events;
  e         deliverable_events;
BEGIN
  SELECT * INTO v_who FROM ob1_deliverable_actor(p_actor, 'verify_deliverable');
  IF v_who.refusal IS NOT NULL THEN
    RETURN v_who.refusal;
  END IF;
  v_thought := ob1_deliverable_id(p_thought, 'verify_deliverable''s deliverable');
  IF v_status NOT IN ('unverified', 'verified', 'corrected') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('verify_deliverable''s status is verified or corrected, not %L', left(COALESCE(p_status, ''), 40)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_method = '' OR length(v_method) > 200 OR v_method ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING
      MESSAGE = format('verify_deliverable''s method says how it was checked: 1 to 200 characters, no control characters; got %s characters', length(v_method)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF btrim(v_outcome) = '' OR length(v_outcome) > 4000 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('verify_deliverable''s outcome says what the check found: 1 to 4000 characters; got %s', length(v_outcome)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM ob1_deliverable_lock(v_thought);
  SELECT * INTO c FROM deliverable_events WHERE thought_id = v_thought AND event = 'captured';
  IF c.id IS NULL THEN
    RETURN ob1_deliverable_refused('NOT_A_DELIVERABLE', format('thought %s is not a deliverable: record_deliverable makes one', v_thought));
  END IF;
  PERFORM 1 FROM thoughts WHERE id = v_thought FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN ob1_deliverable_refused('NOT_A_DELIVERABLE', format('deliverable %s''s thought was deleted: it takes no more verifications', v_thought));
  END IF;
  SELECT * INTO l FROM deliverable_events WHERE thought_id = v_thought ORDER BY seq DESC LIMIT 1;
  IF NOT ob1_deliverable_transition_ok(l.status, v_status) THEN
    RETURN ob1_deliverable_refused('ILLEGAL_TRANSITION',
      format('deliverable %s does not move %s -> %s: the allowed moves are unverified -> verified, unverified -> corrected, verified -> corrected and corrected -> verified', v_thought, l.status, v_status))
      || jsonb_build_object('from', l.status, 'to', v_status);
  END IF;
  IF v_status = 'verified' AND ob1_deliverable_is_maker(c, v_who.name, v_who.agent_id) THEN
    RETURN ob1_deliverable_refused('VERIFY_NOT_YOURS',
      format('%s captured deliverable %s, so another key verifies it; its maker may mark it corrected', v_who.name, v_thought))
      || jsonb_build_object('from', l.status, 'to', v_status);
  END IF;
  IF v_status = 'verified' AND ob1_deliverable_is_author(v_thought, v_who.name, v_who.agent_id) THEN
    RETURN ob1_deliverable_refused('VERIFY_NOT_YOURS',
      format('%s wrote the thought deliverable %s is, so another key verifies it; its author may mark it corrected', v_who.name, v_thought))
      || jsonb_build_object('from', l.status, 'to', v_status);
  END IF;
  e := ob1_deliverable_event(v_thought, 'verification', v_status, l.spec_ref, l.checkpoint, v_method, v_outcome, v_who);
  RETURN jsonb_build_object('outcome', 'changed', 'deliverable', ob1_deliverable_json(v_thought), 'event', ob1_deliverable_event_json(e),
                            'from', l.status, 'to', v_status);
END;
$$;
COMMENT ON FUNCTION verify_deliverable(text, text, text, text, jsonb) IS
  'One verification of a deliverable (SMD-1715): how it was checked (p_method, 1 to 200 characters) and what was found (p_outcome, 1 to 4000), moving its status to p_status (verified or corrected) by an allowed move. Returns {outcome: changed | refused, deliverable, event, from, to}: refused WRITE_SCOPE_REQUIRED (an envelope stating no write scope), NOT_A_DELIVERABLE (no capture, or its thought deleted), ILLEGAL_TRANSITION (with from and to) or VERIFY_NOT_YOURS (a move to verified by the key that recorded the deliverable or wrote its thought, by name or agent id; with from and to). A malformed id, status, method or outcome raises 22023, an envelope naming nobody 42501, a transaction above READ COMMITTED 0A000. Migration 134 / SMD-1715.';

-- ---------------------------------------------------------------------------
-- 7. The read, the drift check and the rebuild
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION deliverable_history(p_thought text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'deliverable', ob1_deliverable_json(t.id),
    'events', COALESCE((SELECT jsonb_agg(ob1_deliverable_event_json(e) ORDER BY e.seq)
                          FROM deliverable_events e WHERE e.thought_id = t.id), '[]'::jsonb))
    FROM (SELECT ob1_deliverable_id(p_thought, 'deliverable_history''s thought') AS id) t
$$;
COMMENT ON FUNCTION deliverable_history(text) IS
  'A deliverable and its events in the order written: {deliverable, events}; deliverable NULL for a thought with no deliverable facet (none, or deleted, whose events stay as history). A malformed id raises 22023. No actor: which keys may read is the operations layer''s. Migration 134 / SMD-1715.';

CREATE OR REPLACE FUNCTION ob1_deliverable_projection_drift()
RETURNS TABLE (thought_id uuid, problem text)
LANGUAGE sql
STABLE
AS $$
  SELECT d.thought_id, CASE WHEN f.id IS NULL THEN 'missing' ELSE 'differs' END
    FROM (SELECT DISTINCT e.thought_id FROM deliverable_events e) d
    JOIN thoughts t ON t.id = d.thought_id
    LEFT JOIN thought_facets f ON f.thought_id = d.thought_id AND f.kind = 'deliverable'
   WHERE f.id IS NULL OR f.payload IS DISTINCT FROM ob1_deliverable_payload(d.thought_id)
  UNION ALL
  SELECT f.thought_id, 'no events'
    FROM thought_facets f
   WHERE f.kind = 'deliverable'
     AND NOT EXISTS (SELECT 1 FROM deliverable_events e WHERE e.thought_id = f.thought_id)
  ORDER BY 1
$$;
COMMENT ON FUNCTION ob1_deliverable_projection_drift() IS
  'Each thought whose deliverable facet is not the projection of its events: missing (events, a thought, no facet), differs (a facet whose payload is not ob1_deliverable_payload''s), or no events (a facet no event made). Empty when the projection is current. A deleted thought''s events are history and not drift. Migration 134 / SMD-1715.';

CREATE OR REPLACE FUNCTION ob1_rebuild_deliverable_projection()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_thought uuid;
  v_n       integer := 0;
BEGIN
  -- In id order, so two rebuilds take the deliverables' locks in one order and
  -- queue rather than deadlock (review pass 2). Read again under the lock and
  -- counted only where the facet still differed and the projector wrote: not
  -- for a thought deleted while it waited (review pass 2), nor for one a
  -- writer or another rebuild made current since the drift was read (review
  -- pass 3).
  FOR v_thought IN SELECT DISTINCT d.thought_id FROM ob1_deliverable_projection_drift() d WHERE d.problem <> 'no events' ORDER BY 1 LOOP
    PERFORM ob1_deliverable_lock(v_thought);
    CONTINUE WHEN EXISTS (SELECT 1 FROM thought_facets f
                           WHERE f.thought_id = v_thought AND f.kind = 'deliverable'
                             AND f.payload = ob1_deliverable_payload(v_thought));
    IF ob1_deliverable_project(v_thought) IS NOT NULL THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION ob1_rebuild_deliverable_projection() IS
  'Makes every drifted deliverable facet current from its events (ob1_deliverable_project, under each deliverable''s lock, taken in id order) and returns how many it wrote, not counting a thought deleted while it waited. A facet with no events is left for the operator: the validator admits none, so one is a raw write with the trigger off. Migration 134 / SMD-1715.';

-- ---------------------------------------------------------------------------
-- 8. The catalog's copy of the vocabulary
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN thought_facets.payload IS
  'Shaped by kind. citation: text (non-empty), stance (stated | retrieved | inferred), source_id (an existing thought, not thought_id itself, stored lower-case); after the source is deleted, source_id null with source_deleted_id and source_deleted_at set by the guard — a shape a restore may insert whole, and that is never re-pointed at a new source. link (053): relation, system, target (an identity in the system), origin structured. relation (084): relation (related | evolves | duplicate | distinct — distinct since 102), target (the older thought''s id), judge_key, confidence, origin judged; inserted standing only, so a restore re-inserts a closed relation as standing or not at all. subject (111): key (ticket:<ID> | pr:<number> | version:<v> | phrase:<words>), by (metadata | first_line | model), judge_key, origin derived; inserted standing only, as a relation. Since 120 a relation may be a thread''s edge (SMD-3306): payload {relation evolves, target (the thought before it on the thread), judge_key thread:<version>, key (the thread''s subject key), origin thread}, written by thread_relink. deliverable (134): spec_ref, checkpoint, status (unverified | verified | corrected), captured_by, captured_at, verification (null | {method, outcome, by, at}), seq — the projection of the thought''s deliverable_events, one per thought (SMD-1715).';
COMMENT ON TABLE thought_facets IS
  'Typed rows on a thought, five kinds registered: citation (042), payload {text, stance, source_id} — a statement in thought_id that rests on thought source_id; link (053), payload {relation, system, target, origin} — a source system''s structured link from the thought to another identity in it; relation (084), payload {relation, target, judge_key, confidence, origin} — the consolidation judge''s related, evolves or duplicate verdict on the thought (the newer) and the target thought (the older), or since 102 its distinct (the pair it called unrelated: two near neighbours about different subjects, kept apart), written once — by record_thought_relation, the consolidation pass''s door, though origin `judged` marks the kind and any role holding INSERT on the table (the structure group) can write one — and only ever closed; subject (111), payload {key, by, judge_key, origin} — the thought''s own subject, since 130 a set: one standing per thought and key (the index''s rule), at most three and one rule''s (record_thought_subjects''s), written by record_thought_subjects (record_thought_subject a set of one) and only ever closed. Since 120 a relation is also a work thread''s edge — origin thread, the key of the thread it links — kept by thread_relink as the subjects land and leave (SMD-3306), so a thought with a set stands in each key''s thread; deliverable (134), payload {spec_ref, checkpoint, status, captured_by, captured_at, verification, seq} — the thought as a deliverable meant to meet a spec (SMD-1715), the projection of its deliverable_events, one per thought, deleted only with it. Validated by kind in thought_facets_validate (check_violation for an unregistered kind or a malformed payload). Active while valid_until is NULL or future and no facet that still exists supersedes it (thought_facet_active); only active citations make thoughts_guard_citation_sources refuse a delete of their source. Migrations 042, 053, 084, 102, 111, 120, 130, 134 / SMD-1712, SMD-1867, SMD-1873, SMD-3117, SMD-3306, SMD-1715.';
