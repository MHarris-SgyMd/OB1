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
--     its text, or metadata.ticket or metadata.issue (the metadata rule's
--     fields, the ticket it is filed under), so a ticket filed after the
--     thought was asked is read; any other metadata edit pools nothing,
--     and reads nothing as the caller, as 016's trigger reads nothing on one.
--   * close_thought_subject(thought, facet, fingerprint) — closes the
--     thought's standing subject only when it is still that facet and the
--     thought's text is still the one read; otherwise it answers what it found
--     and writes nothing. Under the door's advisory lock, the thought locked
--     FOR KEY SHARE first, as record_thought_subject. The sweep calls it when
--     the model names nothing for a thought whose subject is out of date.
--   * ob1_filed_ticket(metadata) — the ticket a thought is filed under,
--     subject.ts's metadataTicket in SQL, trimming ob1_js_space(), the set
--     JavaScript's trim takes — and record_thought_subject, 111's
--     door, redefined to read it under its lock: the metadata rule's subject
--     under another ticket than the thought is filed under now, or none, or
--     a session header's or a model's on a thought filed since, is refused
--     as stale, as one found in a text that moved. The edit that moved the
--     ticket put the thought back in the pool, or, with none named, the next
--     naming pools it, so a write landing after another pass recorded the
--     ticket's subject and finished its claim replaces nothing
--     (SMD-3306 PR 5's review pass 5: a sweep's answer, or the extraction
--     pass's rule, read before the move, replaced it, and no run took the
--     thought again).
--   * Grants: none issued, and one read is new. The trigger runs as the
--     writer of the thought, so an edit that moves metadata.ticket or
--     metadata.issue reads ob1_config as the caller from 113 on, pool or no:
--     the SELECT a role that captures has needed since 016's trigger, which
--     a role that only edits metadata did not. Its pool writes are 016's:
--     SELECT, INSERT and UPDATE on
--     thought_work_claims (the worker group's; requeue_thought_work's upsert
--     reads the conflict), which a capturing role needs once a pool is
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
--   * A fold's replay (SMD-2117, ob1.projecting_replay): this trigger, as
--     016's, does not tell one from a live write, so a fold with a pool
--     named pools each thought it replays. The fold decides for both.
--
-- SAFETY
--   A new trigger function, a trigger, three new functions and 111's door
--   redefined with one check more: a database whose encoding is not UTF8 is
--   refused by name, before anything changes (the file holds no Unicode
--   escape, which a SQL_ASCII server cannot convert); no existing row changes, and the trigger
--   writes nothing until the sweep has named its pool. Before then it reads
--   ob1_config, as the caller, on a capture, a text edit, or an edit that
--   changes metadata.ticket or metadata.issue: that last read is one a role
--   that only edits metadata did not make before 113 (Grants, above).
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
  -- ob1_filed_ticket trims what JavaScript trims, a no-break space and a BOM
  -- among it, which only UTF8 holds: another encoding is refused here, by
  -- name (review pass 6: it failed on the escapes, SQL_ASCII's conversion
  -- error; SMD-3349 tracks non-UTF8 brains).
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION USING
      MESSAGE = format('migration 113 needs a UTF8 database; this one''s encoding is %s', current_setting('server_encoding')),
      HINT = 'ob1_filed_ticket trims what JavaScript trims (a no-break space, a BOM), which only UTF8 holds. SMD-3349 tracks non-UTF8 brains.',
      ERRCODE = 'feature_not_supported';
  END IF;
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
-- model having named nothing for it, is asked again once its text, or its
-- metadata.ticket or metadata.issue, changes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thoughts_enqueue_subject()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_key text;
BEGIN
  -- What the subject is read from: the text, and metadata.ticket and
  -- metadata.issue (the metadata rule's fields), any change of either. Asked
  -- first, so an update that moves neither reads nothing as the caller: a role
  -- that only enriches metadata needs no SELECT on ob1_config.
  IF TG_OP = 'UPDATE'
     AND NEW.content IS NOT DISTINCT FROM OLD.content
     AND (NEW.metadata->>'ticket') IS NOT DISTINCT FROM (OLD.metadata->>'ticket')
     AND (NEW.metadata->>'issue') IS NOT DISTINCT FROM (OLD.metadata->>'issue') THEN
    RETURN NULL;
  END IF;
  SELECT value INTO v_key FROM ob1_config WHERE key = 'subject_pool_key';
  IF v_key IS NULL OR v_key = '' THEN
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

-- ---------------------------------------------------------------------------
-- 3. The ticket a thought is filed under, and a door that reads it
--
-- ob1_filed_ticket(metadata) is server-portable/subject.ts's metadataTicket
-- in SQL: metadata.ticket, else metadata.issue, the first a string that is a
-- ticket id once trimmed as JavaScript trims (its white space and line
-- terminators, which [[:space:]] does not all take, by the database's
-- locale: a no-break space, a BOM), short enough for a subject key; NULL for
-- none. The sweep's "no current subject" reads it, and so does the door
-- below. One expression, no sub-SELECT, so Postgres inlines it into the
-- statements that read it per thought (review pass 6: written with
-- sub-SELECTs it was a call a thought). test-live [10h] holds it to
-- metadataTicket value by value.
-- ---------------------------------------------------------------------------
-- ob1_js_space() is the set JavaScript's trim takes from either end of a
-- string (its white space and line terminators, 25 characters), which
-- metadataTicket's trim takes, as btrim's set: built by chr() from their code
-- points, so this file holds no Unicode escape, and a database that cannot
-- hold them is refused by the guard above, not by the parser. One
-- constant expression: the planner folds it where ob1_filed_ticket is inlined.
CREATE OR REPLACE FUNCTION ob1_js_space()
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $$
  SELECT chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760) ||
         chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) ||
         chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) ||
         chr(65279)
$$;

COMMENT ON FUNCTION ob1_js_space() IS
  'The 25 characters JavaScript''s trim takes from either end of a string (its white space and line terminators), as btrim''s set, built by chr() from their code points: what server-portable/subject.ts''s metadataTicket trims, which ob1_filed_ticket reads (113, SMD-3306). Migration 113 / SMD-3306.';

CREATE OR REPLACE FUNCTION ob1_filed_ticket(p_metadata jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $$
  SELECT COALESCE(
    CASE WHEN jsonb_typeof(p_metadata->'ticket') = 'string'
          AND btrim(p_metadata->>'ticket', ob1_js_space()) ~ '^[A-Z][A-Z0-9]+-[0-9]+$'
          AND length(btrim(p_metadata->>'ticket', ob1_js_space())) <= 200
         THEN btrim(p_metadata->>'ticket', ob1_js_space()) END,
    CASE WHEN jsonb_typeof(p_metadata->'issue') = 'string'
          AND btrim(p_metadata->>'issue', ob1_js_space()) ~ '^[A-Z][A-Z0-9]+-[0-9]+$'
          AND length(btrim(p_metadata->>'issue', ob1_js_space())) <= 200
         THEN btrim(p_metadata->>'issue', ob1_js_space()) END)
$$;

COMMENT ON FUNCTION ob1_filed_ticket(jsonb) IS
  'The ticket a thought is filed under (113, SMD-3306): metadata.ticket, else metadata.issue, the first a string that is a ticket id once trimmed as JavaScript trims, at most 200 characters; NULL for none. server-portable/subject.ts''s metadataTicket in SQL, which the subject sweep''s "no current subject" and record_thought_subject read. Migration 113 / SMD-3306.';

-- 111's door, redefined with one check more: the ticket the thought is filed
-- under, read under its lock.
CREATE OR REPLACE FUNCTION record_thought_subject(
  p_thought   uuid,
  p_key       text,
  p_by        text,
  p_judge_key text,
  p_agent     uuid,
  p_fp        text,
  p_recipe    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_active uuid;
  v_key    text;
  v_by     text;
  v_judge  text;
  v_fp     text;
  v_filed  text;
  v_id     uuid;
BEGIN
  IF p_thought IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subject: a thought is required', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_judge_key IS NULL OR btrim(p_judge_key) = '' OR length(p_judge_key) > 200 THEN
    -- The validator's bounds, refused here as parameter errors: a check
    -- violation would read to the pass as the thought deleted mid-write (084's way).
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subject: judge_key must name the pass, in at most 200 characters', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_key IS NOT NULL AND NOT subject_key_valid(p_key) THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_thought_subject: the key is ticket:<ID>, pr:<number>, version:<v1.2.3> or phrase:<lower-case words>, or NULL (close), got %L', left(p_key, 80)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_key IS NOT NULL AND (p_by IS NULL OR p_by NOT IN ('metadata', 'first_line', 'model')) THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_thought_subject: by is metadata, first_line or model, got %L', p_by),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_key IS NOT NULL AND (p_fp IS NULL OR btrim(p_fp) = '') THEN
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subject: the fingerprint of the text the subject was found in is required', ERRCODE = 'invalid_parameter_value';
  END IF;

  -- One writer per thought at a time: two passes at once would otherwise both
  -- find nothing standing and the second insert hit the index.
  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:subject:' || p_thought::text, 0));
  -- The thought locked FOR KEY SHARE before its facet row, as 084 locks a
  -- relation's two: a delete then waits here rather than deadlocking with the
  -- facet this call locks. A thought already gone answers none.
  SELECT COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)), ob1_filed_ticket(t.metadata) INTO v_fp, v_filed
    FROM thoughts t WHERE t.id = p_thought FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'gone', true);
  END IF;
  -- The text moved since the pass read it: the subject was found in a text
  -- that is gone, so nothing is written; the edit leaves the thought for the
  -- pass to read again (its pool finds a subject off its text).
  IF p_key IS NOT NULL AND p_fp IS DISTINCT FROM v_fp THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'stale', true);
  END IF;
  -- The ticket the thought is filed under moved since the pass read it (113):
  -- a rule's subject under another ticket than it is filed under now, or a
  -- session header's or a model's on a thought filed since, is not its subject
  -- now; nothing is written, and the edit that moved the ticket has put the
  -- thought back in the subject pool, which reads it again. Read under the
  -- lock, so a write that lands after another pass recorded the ticket's
  -- subject and finished its claim does not replace it (SMD-3306 PR 5,
  -- review pass 5).
  IF p_key IS NOT NULL AND (CASE WHEN p_by = 'metadata' THEN p_key IS DISTINCT FROM 'ticket:' || v_filed
                                 ELSE v_filed IS NOT NULL END) THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'stale', true);
  END IF;

  SELECT f.id, f.payload->>'key', f.payload->>'by', f.payload->>'judge_key' INTO v_active, v_key, v_by, v_judge
    FROM thought_facets f
   WHERE f.thought_id = p_thought AND f.kind = 'subject' AND f.valid_until IS NULL
   FOR UPDATE;

  IF p_key IS NULL THEN
    IF v_active IS NULL THEN
      RETURN jsonb_build_object('ok', true, 'action', 'none');
    END IF;
    UPDATE thought_facets SET valid_until = now() WHERE id = v_active;
    RETURN jsonb_build_object('ok', true, 'action', 'closed', 'id', v_active);
  END IF;

  IF v_active IS NOT NULL AND v_key = p_key AND v_by = p_by AND v_judge = p_judge_key THEN
    -- Kept: the same subject, found the same way by the same pass — the facet
    -- stands, its lineage moved to the text read now.
    PERFORM ob1_record_derivation('subject', v_active, ARRAY[p_thought], ARRAY[p_fp], p_judge_key,
                                  COALESCE(p_recipe, jsonb_build_object('deterministic', p_by <> 'model', 'declared', false)), p_agent);
    RETURN jsonb_build_object('ok', true, 'action', 'kept', 'id', v_active);
  END IF;
  IF v_active IS NOT NULL THEN
    UPDATE thought_facets SET valid_until = now() WHERE id = v_active;
  END IF;

  INSERT INTO thought_facets (thought_id, kind, payload)
  VALUES (p_thought, 'subject', jsonb_build_object('key', p_key, 'by', p_by, 'judge_key', p_judge_key))
  RETURNING id INTO v_id;
  -- ob1:subject-lineage-with-its-artifact — a CONTRACT SENTINEL, not prose:
  -- the facet and its lineage are one transaction (061's rule).
  PERFORM ob1_record_derivation('subject', v_id, ARRAY[p_thought], ARRAY[p_fp], p_judge_key,
                                COALESCE(p_recipe, jsonb_build_object('deterministic', p_by <> 'model', 'declared', false)), p_agent);
  RETURN jsonb_build_object('ok', true, 'action', CASE WHEN v_active IS NULL THEN 'added' ELSE 'replaced' END, 'id', v_id);
END;
$$;

COMMENT ON FUNCTION record_thought_subject(uuid, text, text, text, uuid, text, jsonb) IS
  'The subject pass''s write of one thought''s own subject (SMD-3306): a `subject` facet on the thought, one standing, under an advisory lock on the thought, the thought locked FOR KEY SHARE first. Refused (action none, stale) when the thought''s fingerprint is not the one the pass read — the subject was found in a text that is gone — and, since 113, when the ticket the thought is filed under (ob1_filed_ticket) disagrees with it: the metadata rule''s subject under another ticket than it is filed under now, or none, or a session header''s or a model''s on a thought filed since. The same key, found the same way by the same pass, is kept (its lineage row moved to the fingerprint read now); anything else replaces it (the old facet closed with valid_until, a new one inserted — a subject is never edited); a NULL key closes the standing subject, or answers none; a thought gone answers none. Each new facet''s lineage row (artifact_kind subject, its thought at the fingerprint read, produced_by the pass''s key; the recipe the caller''s, else deterministic unless the model found it) is written in the same transaction (ob1:subject-lineage-with-its-artifact). Returns {ok, action: added | kept | replaced | closed | none, id, stale?, gone?}. SECURITY INVOKER: the caller needs INSERT on thought_facets (the structure group), UPDATE on it and on thoughts (the row locks) and the writes on derivations (the capture group). Migrations 111, 113 / SMD-3306.';
