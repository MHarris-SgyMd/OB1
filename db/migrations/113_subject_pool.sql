-- =============================================================================
-- Migration 113: a thought's own subject is found from a pool — new and
--                edited thoughts join it, the sweep claims from it, and an
--                out-of-date subject the model names nothing for is closed
--                only if it is still the one read (SMD-3306)
-- =============================================================================
--
-- WHY
--   The `--subjects` sweep (db/subject-sweep.ts, SMD-3306 PR 2) took every
--   thought with no current subject by reading every thought, its count and
--   its pages, on every run, whatever was left to do: a PGlite run timed the
--   count alone at 5.9 s over a million synthetic thoughts, so at a billion
--   it would outrun sleep's 300 s statement timeout before asking anything
--   (PR 3's review pass 5). And a thought the model named nothing for was
--   asked again at every run, its out-of-date subject left standing: the
--   door's close (record_thought_subject with a NULL key) closes whatever
--   subject stands, so a close there could close one a pass wrote since the
--   sweep read the thought.
--   The extraction pass already finds its work from a pool (015): new and
--   edited thoughts join it by 016's trigger, a run claims only what is
--   there, and a claim it finishes is the record of the pass. The maintainer
--   chose the same for subjects (2026-10-28).
--
-- WHAT
--   * thoughts_enqueue_subject() and its trigger, thoughts_subject_pool:
--     AFTER INSERT OR UPDATE OF content, metadata ON thoughts, it puts the
--     thought (back) in the pool ob1_config.subject_pool_key names, through
--     016's requeue_thought_work, as 016's thoughts_entity_extraction does for
--     the extraction pass. The sweep writes that key on its first run (the
--     pool's key names the rules' versions and, when the model is asked, the
--     question's and its reasoning: server-portable/subject.ts's
--     subjectPoolKey); absent or blank, the trigger does nothing. An update
--     pools the thought again only when what its subject is read from moved:
--     its text, or the ticket it is filed under (metadata.ticket, else
--     metadata.issue, the metadata rule's fields), so a ticket filed after
--     the thought was asked is read; any other metadata edit pools nothing.
--   * close_thought_subject(thought, facet, fingerprint) — closes the
--     thought's standing subject only when it is still that facet and the
--     thought's text is still the one read; otherwise it answers what it found
--     and writes nothing. Under the door's advisory lock, the thought locked
--     FOR KEY SHARE first, as record_thought_subject. The sweep calls it when
--     the model names nothing for a thought whose subject is out of date.
--   * Grants: none new. The trigger runs as the writer of the thought, and
--     its pool writes are 016's: INSERT and UPDATE on thought_work_claims
--     (the worker group's), which a capturing role needs once a pool is
--     named, as once extraction is enabled, and which preflight's write
--     privileges check enforces then. The close needs what the door's close
--     needs.
--
--   ob1:subject-pool — a CONTRACT SENTINEL, not prose (the 014 convention).
--
-- NOT HERE
--   * The sweep in sleep (SMD-3306 PR 6), after SMD-3379's scheduler.
--   * rebuild_derived's subject arm: this trigger requeues an edited thought,
--     so the arm would count stale subjects and find no work; a subject whose
--     text moved stands at its old fingerprint until the sweep takes it, as
--     111 says.
--   * The share alarm for a judge model that answers garbage (PR 5b).
--
-- SAFETY
--   A new trigger function, a trigger and a new function: no existing row
--   changes, and the trigger writes nothing until the sweep has named its
--   pool.
--
-- Idempotent: CREATE OR REPLACE, the trigger dropped by name first.
-- =============================================================================

DO $qc$
DECLARE
  v_missing text;
BEGIN
  -- The first prerequisite missing, in file order, named.
  v_missing := CASE
    WHEN to_regprocedure('claim_thoughts(text, text, integer, integer, integer)') IS NULL THEN '015 (claim_thoughts)'
    WHEN to_regprocedure('requeue_thought_work(text, uuid)') IS NULL THEN '016 (requeue_thought_work)'
    WHEN to_regprocedure('record_thought_subject(uuid, text, text, text, uuid, text, jsonb)') IS NULL THEN '111 (record_thought_subject)'
  END;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('migration 113 needs %s; this schema lacks it', v_missing),
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url ... --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. New and edited thoughts join the subject pool
--
-- ob1:subject-pool — the sweep names the pool in ob1_config.subject_pool_key;
-- this trigger puts each new or edited thought (back) in it, as 016's does
-- for the extraction pass's key. requeue_thought_work sets an existing claim
-- back to pending whatever its state: a thought finished under the key, the
-- model having named nothing for it, is asked again once its text, or the
-- ticket it is filed under, changes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thoughts_enqueue_subject()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_key text;
BEGIN
  SELECT value INTO v_key FROM ob1_config WHERE key = 'subject_pool_key';
  IF v_key IS NULL OR v_key = '' THEN
    RETURN NULL;
  END IF;
  -- What the subject is read from: the text, and the ticket it is filed under
  -- (metadata.ticket, else metadata.issue: the metadata rule's fields).
  IF TG_OP = 'UPDATE'
     AND NEW.content IS NOT DISTINCT FROM OLD.content
     AND (NEW.metadata->>'ticket') IS NOT DISTINCT FROM (OLD.metadata->>'ticket')
     AND (NEW.metadata->>'issue') IS NOT DISTINCT FROM (OLD.metadata->>'issue') THEN
    RETURN NULL;
  END IF;
  PERFORM requeue_thought_work(v_key, NEW.id);
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION thoughts_enqueue_subject() IS
  'AFTER INSERT OR UPDATE OF content, metadata on thoughts (thoughts_subject_pool, 113): puts the thought (back) in the subject pool ob1_config.subject_pool_key names, through requeue_thought_work, as 016''s trigger does for the extraction pass''s key; nothing when no pool is named, or when an update left the text and the ticket it is filed under (metadata.ticket, metadata.issue) as they were (ob1:subject-pool). Migration 113 / SMD-3306.';

DROP TRIGGER IF EXISTS thoughts_subject_pool ON thoughts;
CREATE TRIGGER thoughts_subject_pool
  AFTER INSERT OR UPDATE OF content, metadata ON thoughts
  FOR EACH ROW EXECUTE FUNCTION thoughts_enqueue_subject();

-- ---------------------------------------------------------------------------
-- 2. close_thought_subject — close the subject read, and no other
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION close_thought_subject(
  p_thought uuid,
  p_facet   uuid,
  p_fp      text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_fp     text;
  v_active uuid;
BEGIN
  IF p_thought IS NULL OR p_facet IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'close_thought_subject: a thought and the subject facet read are required', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_fp IS NULL OR btrim(p_fp) = '' THEN
    RAISE EXCEPTION USING MESSAGE = 'close_thought_subject: the fingerprint of the text read is required', ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The door's lock and order (record_thought_subject): one writer per thought
  -- at a time, the thought locked FOR KEY SHARE before its facet row.
  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:subject:' || p_thought::text, 0));
  SELECT COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)) INTO v_fp
    FROM thoughts t WHERE t.id = p_thought FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'gone', true);
  END IF;
  -- The text moved since it was read: what was asked of it says nothing of
  -- the text now, which the pool's trigger has put back in the pool.
  IF p_fp IS DISTINCT FROM v_fp THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'stale', true);
  END IF;

  SELECT f.id INTO v_active
    FROM thought_facets f
   WHERE f.thought_id = p_thought AND f.kind = 'subject' AND f.valid_until IS NULL
   FOR UPDATE;
  IF v_active IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none');
  END IF;
  -- Another subject stands now, written since the read (a pass's rule): it is
  -- not the one the caller means to close.
  IF v_active <> p_facet THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'moved', true, 'id', v_active);
  END IF;
  UPDATE thought_facets SET valid_until = now() WHERE id = v_active;
  RETURN jsonb_build_object('ok', true, 'action', 'closed', 'id', v_active);
END;
$$;

COMMENT ON FUNCTION close_thought_subject(uuid, uuid, text) IS
  'Closes a thought''s standing subject only when it is still the facet the caller read and the thought''s text still has the fingerprint read (113, SMD-3306): the subject sweep''s close of an out-of-date subject the model now names nothing for. Under record_thought_subject''s advisory lock, the thought locked FOR KEY SHARE first. Returns {ok, action: closed | none, id?, gone?, stale?, moved?}: none with gone for a thought deleted, with stale for a text that moved, with moved (and the standing id) when another subject stands, and alone when none does. SECURITY INVOKER: the caller needs UPDATE on thought_facets and on thoughts (the row locks), as the door''s close does. Migration 113 / SMD-3306.';
