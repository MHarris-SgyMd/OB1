-- =============================================================================
-- Migration 148: a thought's state on three axes — validity, review, freshness —
--                read from the records that already exist (SMD-3887 PR 2a)
-- =============================================================================
--
-- WHY
--   Whether a thought still holds is said by several records, each in its own
--   words: the supersedes pointer (025, 068's projection), supersession
--   proposals (029, 063, 067, 114), citations (042), deliverable verifications
--   (134), and the lineage rows of what was derived from it (061, 063). No read
--   puts them together, so SMD-3900's eligible read and the revision tickets
--   beside it have nothing to stand on. docs/claim-validity.md, accepted by the
--   maintainer on 2026-11-19, decides the states, their order and the records
--   each is read from; this file is its read, the record's rows 1 to 7 and 9 to
--   11 (row 12's operation over REST and MCP is PR 2b).
--
-- WHAT
--   thought_validity(p_ids uuid[]) → jsonb. Read only (STABLE), SECURITY
--   INVOKER: it reads what the caller's role may read, and names what it could
--   not. No table, no column, no trigger, no grant; nothing runs at apply time
--   but the DDL. The default reads (search, fetch, node_state, prefer_current)
--   are untouched: it labels, and ranks nothing (row 11: it stands beside
--   node_state, reading superseded from the same projection, ob1_superseded_by).
--
--   THE CALL. Up to 100 distinct ids (a repeated id is answered once, the cap
--   counts distinct ids, a call over it is refused whole: {ok: false, error:
--   TOO_MANY, cap, given}); NULL is NO_IDS; an empty array answers no thoughts.
--   {ok: true, cap: 100, thoughts: [...]} in the order the ids were first given.
--
--   PER THOUGHT. An id that is no thought answers {id, found: false}, with
--   forgotten: true and forgotten_at when 139's ledger holds it (and no text).
--   A thought answers {id, found: true, version, validity, review, freshness,
--   unread}:
--     * version: {fingerprint: its text's fingerprint now (016's
--       content_fingerprint_of, as 036 reads it), seq: the newest audit event
--       of any kind (row 7)}.
--     * validity (rows 2 to 4, the states table): superseded (068's projection
--       names it), contested (a pending proposal names it as the side that
--       falls, both texts as judged; or a deliverable whose newest
--       verification is corrected at a checkpoint that reads current or
--       unmatched), unresolved (a pending or stale proposal on it as the
--       falling side whose text moved since judged, or a stale one; or a
--       corrected verification whose checkpoint reads earlier), supported (an
--       active citation whose source stands and, read one level deep from its
--       own pointer and proposals, is neither superseded, contested nor
--       unresolved), else unchallenged. Precedence in that order. Unknown when
--       a record kind left unread could have set a state above the one found
--       (row 2): the pointer projection any, proposals and verifications
--       contested, citations supported.
--     * review (row 5): pending (a pending or stale proposal names it, either
--       side), decided (a key's or the pass's decision, the newest named),
--       checked (a deliverable with a verification, its status named), unchecked
--       (a deliverable still unverified), none; unknown when proposals or
--       deliverable events were not read.
--     * freshness (row 6): over the lineage rows that name it among their
--       inputs and whose artifact still stands — a standing relation or subject
--       facet, a pending or stale proposal, and a row of another kind whose
--       artifact exists by 067's orphan test (chunks, entities, vector,
--       metadata, proposal; a section's row is dropped with it). Each row reads
--       stale (an input's fingerprint moved and no re-run asked), requested (a
--       re-run asked: stale_since, or for a proposal its own stale status),
--       legacy (061's backfill, fingerprints matching), current. A kind is its
--       worst row; the thought the worst kind (stale, requested, legacy,
--       current), none with no such row; unknown when lineage, proposals or
--       facets were not read. A stale kind no pool re-runs (metadata, section)
--       says so.
--     * judges' numbers (row 9) ride under judge with calibrated: false.
--     * unread: the record kinds the caller's role could not SELECT, by name.
--
--   THE CHECKPOINT RULE (the record's, below its states table). A
--   verification's checkpoint is free text. Equal to the fingerprint now:
--   current; equal to the fingerprint of an earlier text, from the log (a
--   capture's content, an update's content before and after, unredacted):
--   earlier; else unmatched, read as applying.
--
--   Not here: the valid window (SMD-2011), a settled part (SMD-4446), what is
--   fit to act on (SMD-3900). PATCH under the version rules: a new function,
--   nothing existing changed. test-schema [133], test-upgrade [20ck].
--
-- Prerequisites
--   016 (content_fingerprint_of), 029/063/114 (supersession_proposals with
--   stale and the reviewer), 042 (thought_facets, thought_facet_active), 061
--   and 063 (derivations with stale_since), 068 (ob1_superseded_by), 134
--   (deliverable_events), 139 (thought_forgotten). Applied by
--   `bun db/migrate.ts`.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not hold
-- (052's shape). Every probe names an object that stands on a brain at this file.
DO $qc$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(name, ', ') INTO v_missing FROM (VALUES
      ('content_fingerprint_of(text)', to_regprocedure('content_fingerprint_of(text)') IS NULL),
      ('thought_facet_active(thought_facets)', to_regprocedure('thought_facet_active(thought_facets)') IS NULL),
      ('ob1_superseded_by', to_regclass('ob1_superseded_by') IS NULL),
      ('deliverable_events', to_regclass('deliverable_events') IS NULL),
      ('thought_forgotten', to_regclass('thought_forgotten') IS NULL),
      ('derivations.stale_since', NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'derivations' AND column_name = 'stale_since')),
      ('supersession_proposals.reviewed_by_kind', NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'supersession_proposals' AND column_name = 'reviewed_by_kind'))
    ) AS p(name, missing)
   WHERE missing;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 148 needs 016, 042, 063, 068, 114, 134 and 139; this schema lacks ' || v_missing,
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

CREATE OR REPLACE FUNCTION thought_validity(p_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  c_cap constant int := 100;
  -- What the caller's role may read. A record kind it may not is named in
  -- `unread` and moves the axes that rest on it to unknown (rows 1 and 2).
  -- Each read below sits behind its IF, so a table the role may not SELECT is
  -- never planned (a SQL function's CASE branch would be).
  r_pointer   boolean := has_table_privilege('ob1_superseded_by', 'SELECT');
  r_proposal  boolean := has_table_privilege('supersession_proposals', 'SELECT');
  r_verify    boolean := has_table_privilege('deliverable_events', 'SELECT');
  r_facet     boolean := has_table_privilege('thought_facets', 'SELECT');
  -- Lineage: the rows, and the tables 067's orphan test reads for the artifacts they name.
  r_lineage   boolean := has_table_privilege('derivations', 'SELECT') AND has_table_privilege('thought_chunks', 'SELECT')
                     AND has_table_privilege('thought_entities', 'SELECT') AND has_table_privilege('ob1_entity_edges', 'SELECT');
  r_audit     boolean := has_table_privilege('thought_audit', 'SELECT');
  r_forgotten boolean := has_table_privilege('thought_forgotten', 'SELECT');
  v_ids       uuid[];
  v_id        uuid;
  v_out       jsonb := '[]'::jsonb;
  v_unread    text[];
  v_t         record;
  v_fp        text;
  v_seq       bigint;
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
  v_rank      int;
  v_worst     int;
  v_kinds     jsonb;
BEGIN
  IF p_ids IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NO_IDS', 'cap', c_cap);
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
    CASE WHEN NOT r_forgotten THEN 'forgotten'    END], NULL);

  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT t.id, t.content INTO v_t FROM thoughts t WHERE t.id = v_id;
    IF NOT FOUND THEN
      IF r_forgotten THEN
        v_out := v_out || jsonb_build_array(COALESCE(
          (SELECT jsonb_build_object('id', v_id, 'found', false, 'forgotten', true, 'forgotten_at', max(f.forgotten_at))
             FROM thought_forgotten f WHERE f.thought_id = v_id HAVING count(*) > 0),
          jsonb_build_object('id', v_id, 'found', false)));
      ELSE
        v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'found', false, 'unread', to_jsonb(v_unread)));
      END IF;
      CONTINUE;
    END IF;

    -- ---------------------------------------------------------------- version
    v_fp := content_fingerprint_of(v_t.content);
    v_seq := NULL;
    v_earlier := '{}';
    IF r_audit THEN
      SELECT max(a.seq) INTO v_seq FROM thought_audit a WHERE a.thought_id = v_id;
      -- Every text the log holds for it, unredacted: a capture's content, an
      -- update's content before and after (055).
      SELECT COALESCE(array_agg(DISTINCT content_fingerprint_of(x.txt)), '{}') INTO v_earlier
        FROM thought_audit a
        CROSS JOIN LATERAL (VALUES
            (CASE WHEN a.action = 'capture' THEN a.diff->>'content' END),
            (CASE WHEN a.action = 'update' AND jsonb_typeof(a.diff->'content') = 'object' THEN a.diff->'content'->>'before' END),
            (CASE WHEN a.action = 'update' AND jsonb_typeof(a.diff->'content') = 'object' THEN a.diff->'content'->>'after' END)) AS x(txt)
       WHERE a.thought_id = v_id AND a.redacted_at IS NULL AND jsonb_typeof(a.diff) = 'object' AND x.txt IS NOT NULL;
      v_earlier := array_remove(v_earlier, v_fp);
    END IF;

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
    -- earlier (the checkpoint rule).
    IF r_verify THEN
      SELECT e.seq, e.status, e.checkpoint, e.actor_name, e.actor_kind, e.at INTO v_v
        FROM deliverable_events e WHERE e.thought_id = v_id AND e.event = 'verification'
       ORDER BY e.seq DESC LIMIT 1;
      IF FOUND AND v_v.status = 'corrected' THEN
        v_reads := CASE WHEN v_v.checkpoint = v_fp THEN 'current'
                        WHEN v_v.checkpoint = ANY(v_earlier) THEN 'earlier'
                        ELSE 'unmatched' END;
        v_level := GREATEST(v_level, CASE WHEN v_reads = 'earlier' THEN 3 ELSE 4 END);
        v_vrecs := v_vrecs || jsonb_build_array(jsonb_build_object(
          'kind', 'verification', 'seq', v_v.seq, 'status', v_v.status, 'checkpoint', v_v.checkpoint, 'checkpoint_reads', v_reads,
          'by', jsonb_build_object('name', v_v.actor_name, 'kind', v_v.actor_kind), 'at', v_v.at,
          'reads', CASE WHEN v_reads = 'earlier' THEN 'unresolved' ELSE 'contested' END));
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
      CASE WHEN NOT r_facet    THEN 2 ELSE 0 END);
    v_state := CASE WHEN v_ceiling > v_level THEN 'unknown'
                    ELSE (ARRAY['unchallenged', 'supported', 'unresolved', 'contested', 'superseded'])[v_level] END;

    -- ----------------------------------------------------------------- review
    v_rrecs := '[]'::jsonb;
    v_rstate := 'none';
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
      SELECT e.seq, e.status, e.checkpoint, e.actor_name, e.actor_kind, e.at INTO v_v
        FROM deliverable_events e WHERE e.thought_id = v_id AND e.event = 'verification'
       ORDER BY e.seq DESC LIMIT 1;
      v_checked := FOUND;
      IF v_checked THEN
        v_rrecs := v_rrecs || jsonb_build_array(jsonb_build_object(
          'kind', 'verification', 'seq', v_v.seq, 'status', v_v.status, 'checkpoint', v_v.checkpoint,
          'checkpoint_reads', CASE WHEN v_v.checkpoint = v_fp THEN 'current'
                                   WHEN v_v.checkpoint = ANY(v_earlier) THEN 'earlier' ELSE 'unmatched' END,
          'by', jsonb_build_object('name', v_v.actor_name, 'kind', v_v.actor_kind), 'at', v_v.at));
      END IF;
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
      FOR v_d IN
        SELECT d.id, d.artifact_kind, d.artifact_id, d.produced_by, d.stale_since, d.stale_reason,
               COALESCE(d.recipe->>'legacy' = 'true', false) AS legacy,
               (SELECT COALESCE(array_agg(u.id ORDER BY u.ord), '{}')
                  FROM unnest(d.input_ids, d.input_fingerprints) WITH ORDINALITY AS u(id, fp, ord)
                  LEFT JOIN thoughts x ON x.id = u.id
                 WHERE x.id IS NULL OR content_fingerprint_of(x.content) IS DISTINCT FROM u.fp) AS moved,
               (SELECT p.status FROM supersession_proposals p WHERE d.artifact_kind = 'proposal' AND p.id = d.artifact_id) AS proposal_status
          FROM derivations d
         WHERE d.input_ids @> ARRAY[v_id]
         ORDER BY d.artifact_kind, d.produced_by, d.artifact_id
      LOOP
        -- The artifact still stands: a standing relation or subject facet, an
        -- undecided proposal, else 067's orphan test (a section's row is
        -- dropped with its section, so it stands while it is here).
        CONTINUE WHEN NOT (CASE v_d.artifact_kind
          WHEN 'relation' THEN EXISTS (SELECT 1 FROM thought_facets f WHERE f.id = v_d.artifact_id AND f.valid_until IS NULL)
          WHEN 'subject'  THEN EXISTS (SELECT 1 FROM thought_facets f WHERE f.id = v_d.artifact_id AND f.valid_until IS NULL)
          WHEN 'proposal' THEN COALESCE(v_d.proposal_status IN ('pending', 'stale'), false)
          WHEN 'chunks'   THEN EXISTS (SELECT 1 FROM thought_chunks c WHERE c.thought_id = v_d.artifact_id)
          WHEN 'entities' THEN EXISTS (SELECT 1 FROM thought_entities m WHERE m.thought_id = v_d.artifact_id AND m.extraction_key = v_d.produced_by)
                            OR EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.thought_id = v_d.artifact_id AND g.extraction_key = v_d.produced_by)
          WHEN 'vector'   THEN EXISTS (SELECT 1 FROM thoughts t WHERE t.id = v_d.artifact_id AND t.embedding IS NOT NULL)
          WHEN 'metadata' THEN EXISTS (SELECT 1 FROM thoughts t WHERE t.id = v_d.artifact_id AND (t.metadata ? 'type' OR t.metadata ? 'topics'))
          ELSE true END);
        v_row_state := CASE
          WHEN v_d.stale_since IS NOT NULL OR (v_d.artifact_kind = 'proposal' AND v_d.proposal_status = 'stale') THEN 'requested'
          WHEN cardinality(v_d.moved) > 0 THEN 'stale'
          WHEN v_d.legacy THEN 'legacy'
          ELSE 'current' END;
        v_rank := CASE v_row_state WHEN 'stale' THEN 4 WHEN 'requested' THEN 3 WHEN 'legacy' THEN 2 ELSE 1 END;
        v_worst := GREATEST(v_worst, v_rank);
        v_frecs := v_frecs || jsonb_build_array(jsonb_build_object(
          'kind', v_d.artifact_kind, 'artifact', v_d.artifact_id, 'produced_by', v_d.produced_by, 'state', v_row_state,
          'moved', to_jsonb(v_d.moved), 'requested_for', CASE WHEN v_d.stale_since IS NOT NULL THEN v_d.stale_reason END,
          'no_pool', v_row_state = 'stale' AND v_d.artifact_kind IN ('metadata', 'section')));
      END LOOP;
      v_fstate := (ARRAY['none', 'current', 'legacy', 'requested', 'stale'])[v_worst + 1];
    END IF;
    -- A kind's state is its worst row.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', k.kind, 'state', k.state) ORDER BY k.kind), '[]'::jsonb) INTO v_kinds
      FROM (SELECT r->>'kind' AS kind,
                   (ARRAY['current', 'legacy', 'requested', 'stale'])[max(CASE r->>'state' WHEN 'stale' THEN 4 WHEN 'requested' THEN 3 WHEN 'legacy' THEN 2 ELSE 1 END)] AS state
              FROM jsonb_array_elements(v_frecs) r GROUP BY r->>'kind') k;

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
  'A thought''s state on three axes, read from the records that already exist (docs/claim-validity.md, rows 1 to 7 and 9 to 11; migration 148 / SMD-3887). Up to 100 distinct ids (a repeat answered once; over the cap refused whole, TOO_MANY; NULL NO_IDS), answered in the order first given: {ok, cap, thoughts:[{id, found:false[, forgotten, forgotten_at]} | {id, found:true, version:{fingerprint, seq}, validity:{state, found, records}, review:{state, records}, freshness:{state, kinds, records}, unread}]}. Validity: superseded (068''s ob1_superseded_by), contested (a pending proposal on it as the falling side, both texts as judged; a corrected verification whose checkpoint reads current or unmatched), unresolved (a pending or stale proposal on it as the falling side with a text moved since judged, or stale; a corrected verification at an earlier checkpoint), supported (an active citation whose source stands and, one level deep, is not superseded or challenged), else unchallenged; unknown when a record kind the role could not read could have set a state above the one found. Review: pending, decided, checked, unchecked, none; unknown when proposals or verifications were not read. Freshness: over the lineage rows naming it whose artifact still stands, the worst of stale, requested, legacy, current, or none; unknown when lineage, proposals or facets were not read. Judges'' numbers carry calibrated:false. STABLE, SECURITY INVOKER: it reads what the caller may, and names in unread what it may not. Labels only; ranks nothing. Migration 148 / SMD-3887.';
