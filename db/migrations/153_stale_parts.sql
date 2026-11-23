-- =============================================================================
-- Migration 153: a settled part that is no longer a judgement of its texts —
--                the pass's removal of one it names no more, and the validity
--                read's arm for a part's lineage row (SMD-4446 PR 2b-1)
-- =============================================================================
--
-- WHY
--   Since decide version 6 the consolidation pass records settled parts (151):
--   a statement in one thought that the other thought of a pair settles, as a
--   proposal a reviewer decides. A part is a judgement of two texts, and it
--   keeps the fingerprint of each. Two things were missing for a part whose
--   text has moved since.
--
--   * Nothing removes one the pass no longer names. Judged again at the texts
--     as they stand, a statement the writer names again takes its earlier
--     row's place (record_settled_part's `replaced`). One it names no more,
--     because the statement left the text or the other thought no longer
--     shows it, stays: stale, or pending at fingerprints that are no longer
--     its texts', which an accept refuses (EDITED_SINCE) unless forced.
--   * thought_validity (149) had no arm for a part's lineage row. It read one
--     as standing whatever the part's status: both thoughts of a part a
--     reviewer decided would read stale for good once either text moved, and a
--     stale part read stale where a stale proposal reads requested.
--
-- WHAT
--   * settle_stale_part(p_id, p_older_fingerprint, p_newer_fingerprint) → jsonb.
--     The pass's removal of an undecided part that is not a judgement of the
--     texts as they stand. It is called with the fingerprint of each text as
--     the pass judged it, when that judgement did not name the part. Under the
--     supersession advisory lock and the row's own, it answers, as values:
--       {ok: false, error: NOT_FOUND, id}: no such part (a later judgement
--         replaced it, a reviewer's client or another worker removed it, a
--         thought of its pair is gone and took it);
--       {ok: false, error: DECIDED, id, status}: accepted or rejected. A
--         reviewer's decision stands whatever its texts have done since;
--       {ok: false, error: EDITED_SINCE, id, older_edited, newer_edited}: a
--         fingerprint given is not its text's as it stands. The caller judged
--         other texts than these, so its judgement says nothing of the part;
--       {ok: false, error: NOT_STALE, id, status}: pending at the fingerprints
--         given, a judgement of these very texts. Not this function's to
--         remove, whoever no longer names it;
--       {ok: true, action: removed, id, was}: the row is deleted, and its
--         lineage row with it (151's settled_parts_drop_derivation). `was` is
--         the status it had, pending or stale.
--     It removes and does not reject: nobody decided the part, and a rejection
--     would keep its statement from being proposed on the pair again.
--   * thought_validity, 149's function carried whole, with one arm added to
--     its freshness read. A part's lineage row reads its part: pending or
--     stale, the row stands; stale, it reads requested, as a stale proposal's
--     does; accepted or rejected, it is history and not read; with no part it
--     is listed as orphaned. A role that may not read settled_parts has `part`
--     in unread, and freshness unknown for a thought such a row names. Nothing
--     else of the read changes: its validity and review axes read no part
--     (the mark for an accepted part is SMD-4446's PR 3).
--
-- WHO READS
--   No grant changes. The settle deletes one row of settled_parts: the worker
--   group holds DELETE there since 151, and the server group, which holds
--   SELECT and UPDATE alone, is refused by the table (42501). The validity
--   read is SECURITY INVOKER as before, and the server group's SELECT on
--   settled_parts (151) reads the part.
--
-- SAFETY
--   One new function, and one redefined with its signature unchanged. No
--   table, column, trigger or index; nothing runs at apply time but the DDL,
--   and no row is written. Nothing calls settle_stale_part yet: the pass does
--   from SMD-4446's PR 2b-2. MINOR under MAINTAINING.md's versioning.
--   test-schema [138], test-upgrade [20cp].
--
-- Prerequisites
--   149 (thought_validity and everything it reads) and 151 (settled_parts).
--   Applied by `bun db/migrate.ts`. Re-applied, both functions are replaced as
--   they were.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not hold
-- (052's shape): 149's own probes, and 151's table and its columns read here.
DO $qc$
DECLARE
  v_missing text;
BEGIN
  -- Every function, table and column the body reads: plpgsql resolves them
  -- only at the first call, so a missing one would otherwise make a function
  -- that fails when called rather than a file refused here.
  SELECT string_agg(name, ', ' ORDER BY ord) INTO v_missing FROM (
    SELECT p.name, p.ord FROM (VALUES
        (1, 'content_fingerprint_of(text)', to_regprocedure('content_fingerprint_of(text)') IS NULL),
        (2, 'thought_facet_active(thought_facets)', to_regprocedure('thought_facet_active(thought_facets)') IS NULL),
        (3, 'ob1_superseded_by', to_regclass('ob1_superseded_by') IS NULL),
        (4, 'thought_chunks', to_regclass('thought_chunks') IS NULL),
        (5, 'thought_entities', to_regclass('thought_entities') IS NULL),
        (6, 'ob1_entity_edges', to_regclass('ob1_entity_edges') IS NULL),
        (7, 'settled_parts', to_regclass('settled_parts') IS NULL)
      ) AS p(ord, name, missing)
     WHERE p.missing
    UNION ALL
    SELECT c.tbl || '.' || c.col, 10 + c.ord
      FROM (VALUES
        (1, 'thoughts', 'content_fingerprint'), (2, 'thought_audit', 'seq'), (3, 'thought_audit', 'redacted_at'),
        (4, 'thought_audit', 'canonical_agent_id'), (5, 'thought_audit', 'actor_kind'),
        (6, 'supersession_proposals', 'older_fingerprint'), (7, 'supersession_proposals', 'pointer_written'),
        (8, 'supersession_proposals', 'superseding_id'), (9, 'supersession_proposals', 'reviewed_by_kind'),
        (10, 'derivations', 'recipe'), (11, 'derivations', 'stale_since'),
        (12, 'deliverable_events', 'checkpoint'), (13, 'thought_forgotten', 'forgotten_at'),
        (14, 'settled_parts', 'older_fingerprint'), (15, 'settled_parts', 'newer_fingerprint'), (16, 'settled_parts', 'status')
      ) AS c(ord, tbl, col)
     WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns i
                        WHERE i.table_schema = current_schema() AND i.table_name = c.tbl AND i.column_name = c.col)
  ) m;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 153 needs 016, 029, 042, 046, 050, 061, 063, 068, 114, 134, 139, 149 and 151; this schema lacks ' || v_missing,
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. settle_stale_part — the pass removes a part it no longer names
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION settle_stale_part(
  p_id                uuid,
  -- The fingerprint of each text as the caller judged it.
  p_older_fingerprint text,
  p_newer_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  r     settled_parts%ROWTYPE;
  v_old text;
  v_new text;
BEGIN
  -- No argument is echoed: see record_settled_part (151).
  IF p_id IS NULL OR p_older_fingerprint IS NULL OR p_older_fingerprint = ''
     OR p_newer_fingerprint IS NULL OR p_newer_fingerprint = '' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'settle_stale_part: the part''s id and the fingerprint of each text as judged are required',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  -- READ COMMITTED alone, checked before anything is read (068's rule, as
  -- 151's write and decision): above it the two texts would be read as the
  -- transaction first saw them, before the lock below was had, and a part
  -- recorded meanwhile at the texts as they stand could be removed.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('settle_stale_part must run under READ COMMITTED; this transaction is %s', upper(current_setting('transaction_isolation'))),
      HINT = 'Under REPEATABLE READ or SERIALIZABLE its read of the two texts would predate its lock. BEGIN ISOLATION LEVEL READ COMMITTED; then call it.',
      ERRCODE = 'feature_not_supported';
  END IF;

  -- The locks in review_settled_part's order (151): the supersession advisory
  -- lock first, then the row. record_settled_part takes the same lock before
  -- it reads the two texts, a rebuild before it moves a part, delete_thought
  -- and forget_thought before the cascade that takes one. No thought's row
  -- is locked: the texts are read after the locks, as the decision reads them.
  PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));

  SELECT * INTO r FROM settled_parts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND', 'id', p_id);
  END IF;
  -- A reviewer's decision stands whatever its texts have done since (151).
  IF r.status NOT IN ('pending', 'stale') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DECIDED', 'id', p_id, 'status', r.status);
  END IF;

  -- ob1:a-settle-is-of-the-texts-as-they-stand — a CONTRACT SENTINEL (the
  -- 014 convention), read by db/test-schema.ts. The caller says which texts
  -- it judged, and both are compared with the texts as they stand, under the
  -- lock: a settle that trusted the judge's read removed a part the next
  -- judgement would have kept (SMD-4446's PR 1, review pass 4: 20 of 20).
  SELECT content_fingerprint_of(content) INTO v_old FROM thoughts WHERE id = r.older_id;
  SELECT content_fingerprint_of(content) INTO v_new FROM thoughts WHERE id = r.newer_id;
  IF p_older_fingerprint IS DISTINCT FROM v_old OR p_newer_fingerprint IS DISTINCT FROM v_new THEN
    RETURN jsonb_build_object('ok', false, 'error', 'EDITED_SINCE', 'id', p_id,
                              'older_edited', p_older_fingerprint IS DISTINCT FROM v_old,
                              'newer_edited', p_newer_fingerprint IS DISTINCT FROM v_new);
  END IF;
  -- ob1:a-settle-leaves-a-judgement-of-these-texts — a CONTRACT SENTINEL
  -- (the 014 convention), read by db/test-schema.ts. A pending row at the
  -- fingerprints given is a judgement of the texts as they stand. Another
  -- judgement of the same texts that does not name it is no reason to
  -- remove it: what a later decide version does with an earlier one's
  -- parts is not decided here. A stale row goes whatever its fingerprints:
  -- a re-run was asked for it, and the re-run did not name it.
  IF r.status = 'pending' AND r.older_fingerprint = v_old AND r.newer_fingerprint = v_new THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_STALE', 'id', p_id, 'status', r.status);
  END IF;

  -- The row, and by 151's settled_parts_drop_derivation its lineage row.
  DELETE FROM settled_parts WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'action', 'removed', 'id', p_id, 'was', r.status);
END;
$$;

COMMENT ON FUNCTION settle_stale_part(uuid, text, text) IS
  'The consolidation pass''s removal of a settled part it no longer names (153, SMD-4446): the part''s id, and the fingerprint of each text as the pass judged it when that judgement did not name the part. Removes an undecided part that is not a judgement of the texts as they stand: a stale one, or a pending one at fingerprints that are no longer its texts''. Four answers remove nothing and are values, each {ok: false, error, id}: NOT_FOUND (no such part: a later judgement replaced it, another caller removed it, or a thought of its pair is gone and took it); DECIDED, with status (accepted or rejected: a reviewer''s decision stands whatever its texts have done since); EDITED_SINCE, with older_edited and newer_edited (a fingerprint given is not its text''s as it stands: the caller judged other texts, and its judgement says nothing of this part); NOT_STALE, with status (pending at the fingerprints given, a judgement of these very texts, which another judgement of them that names it no more does not remove). Otherwise {ok: true, action: removed, id, was}: the row is deleted, its lineage row with it (151''s settled_parts_drop_derivation), was being the status it had. It removes and does not reject: nobody decided the part, and a rejection would keep its statement from being proposed on the pair again. Raises (invalid_parameter_value) on a missing id or fingerprint, echoing none, and (feature_not_supported) above READ COMMITTED, where its read of the two texts would predate its lock. Takes the supersession advisory lock, then the row, as review_settled_part does, and locks no thought''s row; the lock is held to the end of the caller''s transaction, so call it as a statement of its own. Writes no thought. Migration 153 / SMD-4446.';

-- ---------------------------------------------------------------------------
-- 2. thought_validity — 149's read, with an arm for a settled part's row
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thought_validity(p_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  c_cap constant int := 100;
  -- What the caller's role may read. A record kind it may not is named in
  -- `unread` and moves the axes that rest on it to unknown (rows 1 and 2).
  -- Each read below sits behind its own plpgsql IF or ELSIF, so a table the
  -- role may not SELECT is never planned. A guard inside one statement (a
  -- CASE, an AND) is not enough: its table is still privilege-checked under a
  -- generic plan, as a SQL function's CASE branch is.
  r_pointer   boolean := has_table_privilege('ob1_superseded_by', 'SELECT');
  r_proposal  boolean := has_table_privilege('supersession_proposals', 'SELECT');
  r_verify    boolean := has_table_privilege('deliverable_events', 'SELECT');
  r_facet     boolean := has_table_privilege('thought_facets', 'SELECT');
  -- Lineage: the rows, and the tables 067's orphan test reads for the artifacts they name.
  r_lineage   boolean := has_table_privilege('derivations', 'SELECT') AND has_table_privilege('thought_chunks', 'SELECT')
                     AND has_table_privilege('thought_entities', 'SELECT') AND has_table_privilege('ob1_entity_edges', 'SELECT');
  r_audit     boolean := has_table_privilege('thought_audit', 'SELECT');
  r_forgotten boolean := has_table_privilege('thought_forgotten', 'SELECT');
  -- A settled part's own row (151). A part's lineage row is read by the part's
  -- status (153), behind an IF of its own, as the rule above asks.
  r_part      boolean := has_table_privilege('settled_parts', 'SELECT');
  v_ids       uuid[];
  v_id        uuid;
  v_out       jsonb := '[]'::jsonb;
  v_unread    text[];
  v_t         record;
  v_fp        text;
  v_fp_text   text;
  v_seq       bigint;
  v_ckpt_unknown boolean;
  v_has_check boolean;
  v_gone      jsonb;
  v_earlier   text[];
  -- validity
  v_level     int;          -- 5 superseded, 4 contested, 3 unresolved, 2 supported, 1 unchallenged
  v_state     text;
  v_vrecs     jsonb;
  v_new       uuid;
  v_writer    jsonb;
  v_by_review uuid;
  v_p         record;
  v_edited    boolean;
  v_v         record;
  v_reads     text;
  v_c         record;
  v_src_state text;
  v_ceiling   int;
  -- review
  v_rstate    text;
  v_rrecs     jsonb;
  v_pending   boolean;
  v_decided   boolean;
  v_captured  boolean;
  v_checked   boolean;
  -- freshness
  v_frecs     jsonb;
  v_fstate    text;
  v_d         record;
  v_row_state text;
  v_standing  text;
  v_rank      int;
  v_worst     int;
  v_kinds     jsonb;
  v_part_status text;
  v_part_unread boolean;
BEGIN
  IF p_ids IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NO_IDS', 'cap', c_cap);
  END IF;
  -- The cap bounds the work: a list over ten times the cap is refused before it
  -- is de-duplicated.
  IF cardinality(p_ids) > 10 * c_cap THEN
    RETURN jsonb_build_object('ok', false, 'error', 'TOO_MANY', 'cap', c_cap, 'given', cardinality(p_ids));
  END IF;
  -- The thoughts themselves are the one table the read cannot do without.
  IF NOT has_table_privilege('thoughts', 'SELECT') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_READABLE', 'cap', c_cap, 'unread', jsonb_build_array('thought'));
  END IF;
  -- Distinct, in the order first given.
  SELECT COALESCE(array_agg(x.id ORDER BY x.first), '{}') INTO v_ids
    FROM (SELECT u.id, min(u.ord) AS first FROM unnest(p_ids) WITH ORDINALITY AS u(id, ord)
           WHERE u.id IS NOT NULL GROUP BY u.id) x;
  IF cardinality(v_ids) > c_cap THEN
    RETURN jsonb_build_object('ok', false, 'error', 'TOO_MANY', 'cap', c_cap, 'given', cardinality(v_ids));
  END IF;

  v_unread := array_remove(ARRAY[
    CASE WHEN NOT r_pointer   THEN 'pointer'      END,
    CASE WHEN NOT r_proposal  THEN 'proposal'     END,
    CASE WHEN NOT r_verify    THEN 'verification' END,
    CASE WHEN NOT r_facet     THEN 'facet'        END,
    CASE WHEN NOT r_lineage   THEN 'lineage'      END,
    CASE WHEN NOT r_audit     THEN 'audit'        END,
    CASE WHEN NOT r_forgotten THEN 'forgotten'    END,
    CASE WHEN NOT r_part      THEN 'part'         END], NULL);

  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT t.id, t.content, t.content_fingerprint INTO v_t FROM thoughts t WHERE t.id = v_id;
    IF NOT FOUND THEN
      -- Not a thought: forgotten true (139's ledger holds it), false, or null
      -- when the ledger could not be read. Every answer carries unread.
      -- The ledger read sits behind its own IF: a guard inside one expression
      -- (a CASE, an AND) still has its table privilege-checked under a
      -- generic plan.
      IF r_forgotten THEN
        SELECT jsonb_build_object('id', v_id, 'found', false, 'forgotten', count(*) > 0, 'forgotten_at', max(f.forgotten_at), 'unread', to_jsonb(v_unread))
          INTO v_gone FROM thought_forgotten f WHERE f.thought_id = v_id;
      ELSE
        v_gone := jsonb_build_object('id', v_id, 'found', false, 'forgotten', NULL, 'forgotten_at', NULL, 'unread', to_jsonb(v_unread));
      END IF;
      v_out := v_out || jsonb_build_array(v_gone);
      CONTINUE;
    END IF;

    -- ---------------------------------------------------------------- version
    -- The fingerprint now as rebuild_derived and the lineage writers read it
    -- (061, 067): the stored key, else the text's. The text's own (016) is
    -- also kept, for a checkpoint written from it.
    v_fp := COALESCE(v_t.content_fingerprint, content_fingerprint_of(v_t.content));
    v_fp_text := content_fingerprint_of(v_t.content);
    v_seq := NULL;
    IF r_audit THEN
      SELECT max(a.seq) INTO v_seq FROM thought_audit a WHERE a.thought_id = v_id;
    END IF;
    -- The earlier keys place a verification's checkpoint, so they are read
    -- only for a thought that has one. A stored key that is not the text's
    -- own is earlier whatever the log says: a raw update of the text leaves
    -- the stored key stale (018).
    v_earlier := CASE WHEN v_fp IS DISTINCT FROM v_fp_text THEN ARRAY[v_fp] ELSE '{}' END;
    v_has_check := false;
    IF r_verify THEN
      v_has_check := EXISTS (SELECT 1 FROM deliverable_events e WHERE e.thought_id = v_id AND e.event = 'verification');
    END IF;
    IF r_audit AND v_has_check THEN
      -- Every earlier key the log holds for it, unredacted: a capture's
      -- content, an update's content before and after, and an update's stored
      -- key before and after (055).
      SELECT v_earlier || COALESCE(array_agg(DISTINCT x.fp), '{}') INTO v_earlier
        FROM thought_audit a
        CROSS JOIN LATERAL (VALUES
            (CASE WHEN a.action = 'capture' THEN content_fingerprint_of(a.diff->>'content') END),
            (CASE WHEN a.action = 'update' AND jsonb_typeof(a.diff->'content') = 'object' THEN content_fingerprint_of(a.diff->'content'->>'before') END),
            (CASE WHEN a.action = 'update' AND jsonb_typeof(a.diff->'content') = 'object' THEN content_fingerprint_of(a.diff->'content'->>'after') END),
            (CASE WHEN a.action = 'update' AND jsonb_typeof(a.diff->'content_fingerprint') = 'object' THEN a.diff->'content_fingerprint'->>'before' END),
            (CASE WHEN a.action = 'update' AND jsonb_typeof(a.diff->'content_fingerprint') = 'object' THEN a.diff->'content_fingerprint'->>'after' END)) AS x(fp)
       WHERE a.thought_id = v_id AND a.redacted_at IS NULL AND jsonb_typeof(a.diff) = 'object' AND x.fp IS NOT NULL;
    END IF;
    -- Only the text's own key is current for a checkpoint.
    v_earlier := array_remove(v_earlier, v_fp_text);

    -- --------------------------------------------------------------- validity
    v_level := 1;
    v_vrecs := '[]'::jsonb;

    -- Superseded: 068's projection, the newest superseder; the key that wrote
    -- its pointer from the superseder's log, and the accepted proposal that
    -- wrote it, if one did.
    IF r_pointer THEN
      SELECT s.new_id INTO v_new FROM ob1_superseded_by s WHERE s.old_id = v_id;
      IF FOUND THEN
        v_level := 5;
        v_writer := NULL;
        IF r_audit THEN
          SELECT jsonb_build_object('name', a.actor_name, 'kind', a.actor_kind, 'agent_id', a.canonical_agent_id, 'seq', a.seq)
            INTO v_writer
            FROM thought_audit a
           WHERE a.thought_id = v_new
             AND ((a.action = 'capture' AND a.diff->>'supersedes' = v_id::text)
               OR (a.action = 'update' AND jsonb_typeof(a.diff->'supersedes') = 'object' AND a.diff->'supersedes'->>'after' = v_id::text))
           ORDER BY a.seq DESC LIMIT 1;
        END IF;
        v_by_review := NULL;
        IF r_proposal THEN
          SELECT p.id INTO v_by_review FROM supersession_proposals p
           WHERE p.status = 'accepted' AND p.pointer_written AND p.superseding_id = v_new
             AND v_id IN (p.older_id, p.newer_id)
           ORDER BY p.reviewed_at DESC NULLS LAST LIMIT 1;
        END IF;
        v_vrecs := v_vrecs || jsonb_build_array(jsonb_build_object(
          'kind', 'pointer', 'superseded_by', v_new, 'written_by', v_writer, 'proposal', v_by_review));
      END IF;
    END IF;

    -- Contested or unresolved: a pending or stale proposal naming it as the
    -- side that falls; edited when a side's fingerprint is not the one judged
    -- (an unknown fingerprint counts as unchanged, as 036's EDITED_SINCE).
    IF r_proposal THEN
      FOR v_p IN
        SELECT p.id, p.status, p.verdict, p.confidence, p.judge_key,
               p.older_fingerprint IS NOT NULL AND p.older_fingerprint IS DISTINCT FROM content_fingerprint_of(o.content) AS older_edited,
               p.newer_fingerprint IS NOT NULL AND p.newer_fingerprint IS DISTINCT FROM content_fingerprint_of(n.content) AS newer_edited
          FROM supersession_proposals p
          JOIN thoughts o ON o.id = p.older_id
          JOIN thoughts n ON n.id = p.newer_id
         WHERE p.status IN ('pending', 'stale')
           AND ((p.older_id = v_id AND p.verdict IN ('newer_supersedes_older', 'conflict_undirected'))
             OR (p.newer_id = v_id AND p.verdict IN ('older_supersedes_newer', 'conflict_undirected')))
         ORDER BY p.judged_at, p.id
      LOOP
        v_edited := COALESCE(v_p.older_edited, false) OR COALESCE(v_p.newer_edited, false);
        v_level := GREATEST(v_level, CASE WHEN v_p.status = 'pending' AND NOT v_edited THEN 4 ELSE 3 END);
        v_vrecs := v_vrecs || jsonb_build_array(jsonb_build_object(
          'kind', 'proposal', 'id', v_p.id, 'status', v_p.status, 'verdict', v_p.verdict, 'falls', 'this',
          'edited', jsonb_build_object('older', COALESCE(v_p.older_edited, false), 'newer', COALESCE(v_p.newer_edited, false)),
          'reads', CASE WHEN v_p.status = 'pending' AND NOT v_edited THEN 'contested' ELSE 'unresolved' END,
          'judge', jsonb_build_object('key', v_p.judge_key, 'confidence', v_p.confidence, 'calibrated', false)));
      END LOOP;
    END IF;

    -- A deliverable whose newest verification is corrected: contested at a
    -- checkpoint that reads current or unmatched, unresolved at one that reads
    -- earlier (the checkpoint rule). Without the log, a checkpoint that is neither
    -- the text's key nor a stale stored key reads unknown: earlier and unmatched cannot be told apart,
    -- so the corrected verification sets unresolved at least and the state
    -- unknown, since contested could stand above it (row 2).
    v_ckpt_unknown := false;
    IF r_verify THEN
      SELECT e.seq, e.status, e.checkpoint, e.actor_name, e.actor_kind, e.at INTO v_v
        FROM deliverable_events e WHERE e.thought_id = v_id AND e.event = 'verification'
       ORDER BY e.seq DESC LIMIT 1;
      IF FOUND AND v_v.status = 'corrected' THEN
        v_reads := CASE WHEN lower(v_v.checkpoint) = v_fp_text THEN 'current'
                        WHEN lower(v_v.checkpoint) = ANY(v_earlier) THEN 'earlier'
                        WHEN NOT r_audit THEN 'unknown'
                        ELSE 'unmatched' END;
        v_ckpt_unknown := v_reads = 'unknown';
        v_level := GREATEST(v_level, CASE WHEN v_reads IN ('earlier', 'unknown') THEN 3 ELSE 4 END);
        v_vrecs := v_vrecs || jsonb_build_array(jsonb_build_object(
          'kind', 'verification', 'seq', v_v.seq, 'status', v_v.status, 'checkpoint', v_v.checkpoint, 'checkpoint_reads', v_reads,
          'by', jsonb_build_object('name', v_v.actor_name, 'kind', v_v.actor_kind), 'at', v_v.at,
          'reads', CASE v_reads WHEN 'earlier' THEN 'unresolved' WHEN 'unknown' THEN 'unknown' ELSE 'contested' END));
      END IF;
    END IF;

    -- Supported: an active citation whose source stands and, one level deep
    -- (its own pointer and proposals, never its citations), is neither
    -- superseded, contested nor unresolved. A source state not readable is
    -- unknown, and supports nothing.
    IF r_facet THEN
      FOR v_c IN
        SELECT f.id, (f.payload->>'source_id')::uuid AS source
          FROM thought_facets f
         WHERE f.thought_id = v_id AND f.kind = 'citation' AND thought_facet_active(f)
           AND f.payload->>'source_id' IS NOT NULL
         ORDER BY f.created_at, f.id
      LOOP
        IF NOT EXISTS (SELECT 1 FROM thoughts s WHERE s.id = v_c.source) THEN
          v_src_state := 'gone';
        ELSIF NOT r_pointer OR NOT r_proposal THEN
          v_src_state := 'unknown';
        ELSIF EXISTS (SELECT 1 FROM ob1_superseded_by s WHERE s.old_id = v_c.source) THEN
          v_src_state := 'superseded';
        ELSIF EXISTS (SELECT 1 FROM supersession_proposals p
                        WHERE p.status IN ('pending', 'stale')
                          AND ((p.older_id = v_c.source AND p.verdict IN ('newer_supersedes_older', 'conflict_undirected'))
                            OR (p.newer_id = v_c.source AND p.verdict IN ('older_supersedes_newer', 'conflict_undirected')))) THEN
          v_src_state := 'challenged';
        ELSE
          v_src_state := 'standing';
        END IF;
        IF v_src_state = 'standing' THEN
          v_level := GREATEST(v_level, 2);
        END IF;
        v_vrecs := v_vrecs || jsonb_build_array(jsonb_build_object(
          'kind', 'citation', 'id', v_c.id, 'source', v_c.source, 'source_reads', v_src_state, 'supports', v_src_state = 'standing'));
      END LOOP;
    END IF;

    -- Unknown: a kind left unread that could have set a state above the one
    -- found (row 2). The pointer could set any; a proposal or a verification
    -- contested; a citation supported.
    v_ceiling := GREATEST(
      CASE WHEN NOT r_pointer  THEN 5 ELSE 0 END,
      CASE WHEN NOT r_proposal THEN 4 ELSE 0 END,
      CASE WHEN NOT r_verify   THEN 4 ELSE 0 END,
      CASE WHEN NOT r_facet    THEN 2 ELSE 0 END,
      CASE WHEN v_ckpt_unknown THEN 4 ELSE 0 END);
    v_state := CASE WHEN v_ceiling > v_level THEN 'unknown'
                    ELSE (ARRAY['unchallenged', 'supported', 'unresolved', 'contested', 'superseded'])[v_level] END;

    -- ----------------------------------------------------------------- review
    v_rrecs := '[]'::jsonb;
    IF NOT r_proposal OR NOT r_verify THEN
      v_rstate := 'unknown';
    ELSE
      v_pending := false;
      FOR v_p IN
        SELECT p.id, p.status, p.reviewed_at, p.reviewed_by, p.reviewed_by_kind,
               COALESCE(p.review_note LIKE 'settled by the pass:%', false) AS by_pass
          FROM supersession_proposals p WHERE v_id IN (p.older_id, p.newer_id)
         ORDER BY p.reviewed_at DESC NULLS FIRST, p.judged_at DESC, p.id
      LOOP
        IF v_p.status IN ('pending', 'stale') THEN v_pending := true; END IF;
        v_rrecs := v_rrecs || jsonb_build_array(jsonb_build_object(
          'kind', 'proposal', 'id', v_p.id, 'status', v_p.status, 'at', v_p.reviewed_at,
          'by', CASE WHEN v_p.reviewed_at IS NULL THEN NULL
                     ELSE jsonb_build_object('name', v_p.reviewed_by, 'kind', v_p.reviewed_by_kind, 'pass', v_p.by_pass) END));
      END LOOP;
      v_decided := EXISTS (SELECT 1 FROM supersession_proposals p
                            WHERE v_id IN (p.older_id, p.newer_id) AND p.status IN ('accepted', 'rejected'));
      v_captured := EXISTS (SELECT 1 FROM deliverable_events e WHERE e.thought_id = v_id AND e.event = 'captured');
      -- Every verification, newest first (row 5: every check is listed).
      v_checked := false;
      FOR v_v IN
        SELECT e.seq, e.status, e.checkpoint, e.actor_name, e.actor_kind, e.at
          FROM deliverable_events e WHERE e.thought_id = v_id AND e.event = 'verification'
         ORDER BY e.seq DESC
      LOOP
        v_checked := true;
        v_rrecs := v_rrecs || jsonb_build_array(jsonb_build_object(
          'kind', 'verification', 'seq', v_v.seq, 'status', v_v.status, 'checkpoint', v_v.checkpoint,
          'checkpoint_reads', CASE WHEN lower(v_v.checkpoint) = v_fp_text THEN 'current'
                                   WHEN lower(v_v.checkpoint) = ANY(v_earlier) THEN 'earlier'
                                   WHEN NOT r_audit THEN 'unknown' ELSE 'unmatched' END,
          'by', jsonb_build_object('name', v_v.actor_name, 'kind', v_v.actor_kind), 'at', v_v.at));
      END LOOP;
      v_rstate := CASE WHEN v_pending THEN 'pending'
                       WHEN v_decided THEN 'decided'
                       WHEN v_checked THEN 'checked'
                       WHEN v_captured THEN 'unchecked'
                       ELSE 'none' END;
    END IF;

    -- -------------------------------------------------------------- freshness
    v_frecs := '[]'::jsonb;
    IF NOT r_lineage OR NOT r_proposal OR NOT r_facet THEN
      v_fstate := 'unknown';
    ELSE
      v_worst := 0;   -- 0 none, 1 current, 2 legacy, 3 requested, 4 stale
      v_part_unread := false;
      FOR v_d IN
        SELECT d.id, d.artifact_kind, d.artifact_id, d.produced_by, d.stale_since, d.stale_reason,
               COALESCE(d.recipe->>'legacy' = 'true', false) AS legacy,
               (SELECT COALESCE(array_agg(u.id ORDER BY u.ord), '{}')
                  FROM unnest(d.input_ids, d.input_fingerprints) WITH ORDINALITY AS u(id, fp, ord)
                  LEFT JOIN thoughts x ON x.id = u.id
                 WHERE x.id IS NULL OR u.fp IS DISTINCT FROM COALESCE(x.content_fingerprint, content_fingerprint_of(x.content))) AS moved,
               (SELECT p.status FROM supersession_proposals p WHERE d.artifact_kind = 'proposal' AND p.id = d.artifact_id) AS proposal_status,
               (SELECT COALESCE(p.review_note LIKE 'settled by the pass:%', false) FROM supersession_proposals p
                 WHERE d.artifact_kind = 'proposal' AND p.id = d.artifact_id) AS by_pass,
               (SELECT jsonb_build_object('key', f.payload->>'judge_key', 'confidence', (f.payload->>'confidence')::numeric, 'calibrated', false)
                  FROM thought_facets f WHERE d.artifact_kind = 'relation' AND f.id = d.artifact_id AND f.payload ? 'confidence') AS judge
          FROM derivations d
         WHERE d.input_ids @> ARRAY[v_id]
         ORDER BY d.artifact_kind, d.produced_by, d.artifact_id
      LOOP
        -- Whether the artifact still stands. History — a closed relation or
        -- subject facet, a key's decision on a proposal — is not read (no
        -- re-run rewrites it; a rejection the pass itself settled is standing,
        -- since 067 reopens it when a text moves). An orphan by 067's test (its artifact gone: a deleted proposal,
        -- no windows, no mentions or edges under the key, no embedding, no
        -- tags) is listed as orphaned and not read. A section's row is dropped
        -- with its section, so it stands while it is here.
        -- ob1:a-part-row-reads-its-part — a CONTRACT SENTINEL (the 014
        -- convention), read by db/test-schema.ts. A settled part's row (151)
        -- reads its part's status: pending or stale it stands; a reviewer's
        -- decision is history, which no re-run rewrites (nothing reopens one:
        -- a part the pass no longer names is removed with its lineage row,
        -- settle_stale_part, where a proposal is rejected); with no part it is
        -- orphaned, as 151's rebuild_derived reads it. The part is read
        -- behind its own IF: a role that may not read settled_parts leaves
        -- the row unread, and the axis unknown below.
        IF v_d.artifact_kind = 'part' THEN
          IF NOT r_part THEN
            v_part_unread := true;
            CONTINUE;
          END IF;
          SELECT s.status INTO v_part_status FROM settled_parts s WHERE s.id = v_d.artifact_id;
        END IF;
        v_standing := CASE v_d.artifact_kind
          WHEN 'relation' THEN CASE WHEN EXISTS (SELECT 1 FROM thought_facets f WHERE f.id = v_d.artifact_id AND f.valid_until IS NULL) THEN 'standing' ELSE 'history' END
          WHEN 'subject'  THEN CASE WHEN EXISTS (SELECT 1 FROM thought_facets f WHERE f.id = v_d.artifact_id AND f.valid_until IS NULL) THEN 'standing' ELSE 'history' END
          WHEN 'proposal' THEN CASE WHEN v_d.proposal_status IS NULL THEN 'orphaned'
                                    WHEN v_d.proposal_status IN ('pending', 'stale') THEN 'standing'
                                    WHEN v_d.proposal_status = 'rejected' AND v_d.by_pass THEN 'standing' ELSE 'history' END
          WHEN 'part'     THEN CASE WHEN v_part_status IS NULL THEN 'orphaned'
                                    WHEN v_part_status IN ('pending', 'stale') THEN 'standing' ELSE 'history' END
          WHEN 'chunks'   THEN CASE WHEN EXISTS (SELECT 1 FROM thought_chunks c WHERE c.thought_id = v_d.artifact_id) THEN 'standing' ELSE 'orphaned' END
          WHEN 'entities' THEN CASE WHEN EXISTS (SELECT 1 FROM thought_entities m WHERE m.thought_id = v_d.artifact_id AND m.extraction_key = v_d.produced_by)
                                      OR EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.thought_id = v_d.artifact_id AND g.extraction_key = v_d.produced_by)
                                    THEN 'standing' ELSE 'orphaned' END
          WHEN 'vector'   THEN CASE WHEN EXISTS (SELECT 1 FROM thoughts t WHERE t.id = v_d.artifact_id AND t.embedding IS NOT NULL) THEN 'standing' ELSE 'orphaned' END
          WHEN 'metadata' THEN CASE WHEN EXISTS (SELECT 1 FROM thoughts t WHERE t.id = v_d.artifact_id AND (t.metadata ? 'type' OR t.metadata ? 'topics')) THEN 'standing' ELSE 'orphaned' END
          ELSE 'standing' END;
        CONTINUE WHEN v_standing = 'history';
        IF v_standing = 'orphaned' THEN
          v_frecs := v_frecs || jsonb_build_array(jsonb_build_object(
            'kind', v_d.artifact_kind, 'artifact', v_d.artifact_id, 'produced_by', v_d.produced_by, 'state', 'orphaned'));
          CONTINUE;
        END IF;
        -- A structured source pass's extraction (entities produced by
        -- source:<system>) reads its source's own record, not the text: 067's
        -- entities arm keeps it on a moved text, and so does this read.
        v_row_state := CASE
          WHEN v_d.stale_since IS NOT NULL OR (v_d.artifact_kind = 'proposal' AND v_d.proposal_status = 'stale')
               OR (v_d.artifact_kind = 'part' AND v_part_status = 'stale') THEN 'requested'
          WHEN cardinality(v_d.moved) > 0 AND NOT (v_d.artifact_kind = 'entities' AND v_d.produced_by LIKE 'source:%') THEN 'stale'
          WHEN v_d.legacy THEN 'legacy'
          ELSE 'current' END;
        v_rank := CASE v_row_state WHEN 'stale' THEN 4 WHEN 'requested' THEN 3 WHEN 'legacy' THEN 2 ELSE 1 END;
        v_worst := GREATEST(v_worst, v_rank);
        -- The tags and a generated section have no pool: stale or requested
        -- (063 and 067 leave them unqueued), only an operator's rebuild clears
        -- them. (A vector or windows row on a brain with no embedding settings
        -- is unqueued too; this read does not name that case.) A relation
        -- carries its judge's number, uncalibrated (row 9).
        v_frecs := v_frecs || jsonb_build_array(jsonb_build_object(
          'kind', v_d.artifact_kind, 'artifact', v_d.artifact_id, 'produced_by', v_d.produced_by, 'state', v_row_state,
          'moved', to_jsonb(v_d.moved), 'requested_for', CASE WHEN v_d.stale_since IS NOT NULL THEN v_d.stale_reason END,
          'no_pool', v_row_state IN ('stale', 'requested') AND v_d.artifact_kind IN ('metadata', 'section'))
          || CASE WHEN v_d.judge IS NOT NULL THEN jsonb_build_object('judge', v_d.judge) ELSE '{}'::jsonb END);
      END LOOP;
      v_fstate := (ARRAY['none', 'current', 'legacy', 'requested', 'stale'])[v_worst + 1];
      -- A part's row left unread may stand at a moved text: the axis is not known.
      IF v_part_unread THEN
        v_fstate := 'unknown';
      END IF;
    END IF;
    -- A kind's state is its worst row read (orphans aside), with its
    -- producers, what moved under its stale rows, and no_pool when any row
    -- has it (the record's shape).
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', k.kind, 'state', k.state, 'produced_by', k.produced_by,
             'moved', COALESCE((SELECT to_jsonb(array_agg(DISTINCT m)) FROM jsonb_array_elements(v_frecs) r2, jsonb_array_elements_text(r2->'moved') m
                                 WHERE r2->>'kind' = k.kind AND r2->>'state' = 'stale'), '[]'::jsonb),
             'no_pool', k.no_pool) ORDER BY k.kind), '[]'::jsonb) INTO v_kinds
      FROM (SELECT r->>'kind' AS kind,
                   (ARRAY['current', 'legacy', 'requested', 'stale'])[max(CASE r->>'state' WHEN 'stale' THEN 4 WHEN 'requested' THEN 3 WHEN 'legacy' THEN 2 ELSE 1 END)] AS state,
                   to_jsonb(array_agg(DISTINCT r->>'produced_by')) AS produced_by,
                   bool_or(COALESCE((r->>'no_pool')::boolean, false)) AS no_pool
              FROM jsonb_array_elements(v_frecs) r WHERE r->>'state' <> 'orphaned' GROUP BY r->>'kind') k;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_id, 'found', true,
      'version', jsonb_build_object('fingerprint', v_fp, 'seq', v_seq),
      'validity', jsonb_build_object('state', v_state, 'found', (ARRAY['unchallenged', 'supported', 'unresolved', 'contested', 'superseded'])[v_level], 'records', v_vrecs),
      'review', jsonb_build_object('state', v_rstate, 'records', v_rrecs),
      'freshness', jsonb_build_object('state', v_fstate, 'kinds', v_kinds, 'records', v_frecs),
      'unread', to_jsonb(v_unread)));
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'cap', c_cap, 'thoughts', v_out);
END;
$$;

COMMENT ON FUNCTION thought_validity(uuid[]) IS
  'A thought''s state on three axes, read from the records that already exist (docs/claim-validity.md, rows 1 to 7 and 9 to 11; migration 149 / SMD-3887). Up to 100 distinct ids (a repeat answered once; over the cap refused whole, TOO_MANY; NULL NO_IDS), answered in the order first given (a list over ten times the cap refused before de-duplication; a role that cannot read thoughts NOT_READABLE): {ok, cap, thoughts:[{id, found:false, forgotten (true, false, or null when the ledger could not be read), forgotten_at, unread} | {id, found:true, version:{fingerprint (the stored key, else the text''s, as 061 and 067 read it), seq}, validity:{state, found, records}, review:{state, records}, freshness:{state, kinds, records}, unread}]}. Validity: superseded (068''s ob1_superseded_by), contested (a pending proposal on it as the falling side, both texts as judged; a corrected verification whose checkpoint reads current or unmatched), unresolved (a pending proposal on it as the falling side with a text moved since judged, or a stale one; a corrected verification at an earlier checkpoint, a stale stored key among them; a checkpoint is current only at the text''s own key), supported (an active citation whose source stands and, one level deep, is not superseded or challenged), else unchallenged; unknown when a record kind the role could not read could have set a state above the one found, or a corrected checkpoint could not be placed without the log. Review: pending, decided, checked, unchecked, none; unknown when proposals or verifications were not read. Freshness: over the lineage rows naming it whose artifact still stands, the worst of stale, requested, legacy, current, or none; an orphaned row (067''s test) listed as orphaned and not read; a pass-settled rejection read, a key''s decision not; a source: pass''s extraction kept on a moved text, as 067''s entities arm keeps it; a kind''s moved from its stale rows; a relation''s judge number carried; no_pool on a stale or requested kind no pool re-runs; unknown when lineage, proposals or facets were not read. Judges'' numbers carry calibrated:false. STABLE, SECURITY INVOKER: it reads what the caller may, and names in unread what it may not. Labels only; ranks nothing. Migration 149 / SMD-3887. Since migration 153 (SMD-4446) a settled part''s lineage row (151) is read by its part''s status: pending or stale it stands, stale it reads requested, a reviewer''s decision is history and not read, and with no part it is listed as orphaned; a role that may not read settled_parts has part in unread, and freshness unknown for a thought such a row names.';
