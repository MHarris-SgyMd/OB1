-- =============================================================================
-- SMD-1999 prototype, option 2 — the three write functions append the event
-- first and call the projector; the table stays a table. NOT a migration
-- (see common.sql). Requires common.sql. Placeholders as there; every body
-- reads `thoughts` by name for its locks and lookups (under option 1 that is
-- the simple view, through which a row lock reaches the base table — probed)
-- and lets the projector write {{ROWS}}.
--
-- What moves and what stays, function by function:
--
--   upsert_thought (2-, 3-argument): 005's payload guard, 025's provenance
--   validation, 046's event validation, the actor setting, 003's fingerprint,
--   033's advisory lock and (3-argument) 035's row read FOR NO KEY UPDATE all
--   stay in the body, in the same order. DELTA, said in the record: the
--   2-argument form takes that row read too — 046's was a pure INSERT … ON
--   CONFLICT with no row lock — under the same advisory lock, so no caller
--   can observe the difference. What moves: the INSERT … ON CONFLICT becomes a
--   branch on the locked read — a fresh text appends a `capture` event (the
--   stamped metadata, the content, the provenance) and projects it with the
--   caller's vector; a re-capture appends an `update` event only when 046's
--   trigger would have recorded one (the metadata merge changed something, or
--   the vector's presence flipped, or the envelope declared stance / cites /
--   a window), projects it, and refreshes the vector without an event when a
--   vector arrives on a row that has one. 022's chunk rule and 035's
--   `existed` return are unchanged. DELTA, said in the plan: a re-capture
--   that changes nothing no longer bumps updated_at — no event, no write.
--
--   update_thought: the whole choreography before the UPDATE stays — the
--   provenance shape, the actor, the event validation, the supersession lock,
--   the fingerprint lock, the row lock FOR NO KEY UPDATE, the STALE_READ
--   pre-check, the cycle walk, 018's unchanged-content rule. What moves: the
--   UPDATE becomes the computed after-image (the stamp by 050's two arms),
--   the diff, the append, the projection with the caller's vector. A vector
--   arriving on the same text is a refresh, no event. DELTAS, said in the
--   record: an edit whose patch changes nothing writes nothing (053 bumps
--   updated_at and records no audit row); and 046's if_unchanged_since
--   predicate in the UPDATE's own WHERE, with its STALE_READ lost-race arm,
--   is gone — unreachable under the row lock taken first, by 046's own
--   argument, but a documented refusal path the body no longer has.
--
--   delete_thought: 042's body with one change — inside the sub-block, the
--   `delete` event is appended and projected, so 042's citation guard (which
--   RAISES OB001 from the base table's DELETE) rolls back the event with the
--   row when the delete is refused. The supersession lock (036) is taken
--   first, as before.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- upsert_thought(text, jsonb) — the 2-argument form (PostgREST callers by name,
-- the recipes that carry the vector in the payload, the server's fallback).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_thought(p_content text, p_payload jsonb DEFAULT '{}')
RETURNS jsonb AS $$
DECLARE
  v_fingerprint text;
  v_id          uuid;
  v_event       jsonb;
  v_old_meta    jsonb;
  v_new_meta    jsonb;
  v_diff        jsonb;
  v_ev          uuid;
BEGIN
  -- 005's guard, carried.
  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_payload);
  END IF;
  IF p_payload ? 'actor' THEN
    PERFORM set_config('ob1.actor', p_payload->>'actor', true);
  END IF;
  v_event := validate_write_event(p_payload->'event');
  -- 046's anti-inheritance rule, kept: the event rides the append now, and
  -- the setting a raw write later in this transaction would read is cleared
  -- here as 046 cleared it before its write (first review pass).
  PERFORM set_config('ob1.event', '', true);
  v_fingerprint := content_fingerprint_of(p_content);
  -- ob1:capture-takes-fingerprint-lock (033): before the read, so a concurrent
  -- writer of this text has committed before the read runs.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));
  -- New to the 2-argument form (046's was a pure INSERT … ON CONFLICT): the
  -- row read the 3-argument form has had since 035, under the same advisory
  -- lock — a named delta, unobservable to a caller.
  SELECT id, metadata INTO v_id, v_old_meta FROM thoughts WHERE content_fingerprint = v_fingerprint FOR NO KEY UPDATE;
  -- ob1:capture-sets-write-event (046): the declared event reaches the audit
  -- row — here by the append itself, not by a setting the trigger reads.
  IF NOT FOUND THEN
    v_id       := gen_random_uuid();
    v_new_meta := ob1_actor_stamp(COALESCE(p_payload->'metadata', '{}'::jsonb));
    v_diff     := ob1_thought_diff('capture', NULL, p_content, NULL, v_new_meta, false, false, NULL, NULL, NULL, NULL, NULL, v_fingerprint);
    v_ev       := ob1_append_thought_event(v_id, 'capture', v_new_meta->>'source', v_diff, v_event);
    PERFORM ob1_project_thought_event(v_ev);
  ELSE
    -- A re-capture: metadata merged (the stamp follows the content — kept), 046's gate.
    v_new_meta := ob1_actor_stamp_kept(v_old_meta || COALESCE(p_payload->'metadata', '{}'::jsonb), v_old_meta);
    v_diff     := ob1_thought_diff('update', p_content, p_content, v_old_meta, v_new_meta, false, false, NULL, NULL, NULL, NULL, v_fingerprint, v_fingerprint);
    IF v_diff <> '{}'::jsonb OR COALESCE(v_event ?| ARRAY['stance', 'cites', 'valid_from', 'valid_until', 'trust', 'actor_kind'], false) THEN
      v_ev := ob1_append_thought_event(v_id, 'update', v_new_meta->>'source', v_diff, v_event);
      IF v_ev IS NOT NULL THEN
        PERFORM ob1_project_thought_event(v_ev);
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- upsert_thought(text, jsonb, vector) — the atomic capture.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_thought(
  p_content   text,
  p_payload   jsonb,
  p_embedding vector({{EMBEDDING_DIM}})
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_fingerprint    text;
  v_id             uuid;
  v_existed        boolean := false;
  v_old_label      text;
  v_old_meta       jsonb;
  v_old_has_vec    boolean;
  v_old_sup        uuid;
  v_old_derived    jsonb;
  v_supersedes_now uuid;
  v_derived        jsonb;
  v_supersedes     text  := p_payload->>'supersedes';
  v_event          jsonb;
  v_new_meta       jsonb;
  v_diff           jsonb;
  v_ev             uuid;
  v_label          text := p_payload->>'embedding_model';
BEGIN
  -- 005's guard, carried.
  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_payload);
  END IF;
  -- 025: the provenance envelope, validated before any lock.
  v_derived := validate_derived_from(p_payload->'derived_from');
  IF v_supersedes IS NOT NULL AND v_supersedes !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'upsert_thought: supersedes must be a thought UUID string, got %.', p_payload->'supersedes';
  END IF;
  IF p_payload ? 'actor' THEN
    PERFORM set_config('ob1.actor', p_payload->>'actor', true);
  END IF;
  v_event := validate_write_event(p_payload->'event');
  -- 046's anti-inheritance rule, kept: the event rides the append now, and
  -- the setting a raw write later in this transaction would read is cleared
  -- here as 046 cleared it before its write (first review pass).
  PERFORM set_config('ob1.event', '', true);
  v_fingerprint := content_fingerprint_of(p_content);

  -- ob1:capture-takes-fingerprint-lock — a CONTRACT SENTINEL (033).
  PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));

  -- 022/035: the row this capture lands on, if any, locked FOR NO KEY UPDATE.
  SELECT id, embedding_model, metadata, embedding IS NOT NULL, supersedes, derived_from
    INTO v_id, v_old_label, v_old_meta, v_old_has_vec, v_old_sup, v_old_derived
    FROM thoughts WHERE content_fingerprint = v_fingerprint FOR NO KEY UPDATE;
  v_existed := FOUND;

  -- ob1:capture-sets-write-event — a CONTRACT SENTINEL (046): the declared
  -- event reaches the audit row, by the append.
  IF NOT v_existed THEN
    v_id       := gen_random_uuid();
    v_new_meta := ob1_actor_stamp(COALESCE(p_payload->'metadata', '{}'::jsonb));
    v_diff     := ob1_thought_diff('capture', NULL, p_content, NULL, v_new_meta, false, p_embedding IS NOT NULL,
                                   NULL, v_supersedes::uuid, NULL, v_derived, NULL, v_fingerprint);
    v_ev       := ob1_append_thought_event(v_id, 'capture', v_new_meta->>'source', v_diff, v_event);
    PERFORM ob1_project_thought_event(v_ev, p_embedding, v_label);
    v_supersedes_now := v_supersedes::uuid;
  ELSE
    -- ob1:re-capture-writes-no-provenance — a CONTRACT SENTINEL (035): the
    -- envelope's derived_from and supersedes are not written on an existing
    -- row; the diff below carries the old values on both sides.
    v_new_meta := ob1_actor_stamp_kept(v_old_meta || COALESCE(p_payload->'metadata', '{}'::jsonb), v_old_meta);
    v_diff     := ob1_thought_diff('update', p_content, p_content, v_old_meta, v_new_meta,
                                   v_old_has_vec, v_old_has_vec OR p_embedding IS NOT NULL,
                                   v_old_sup, v_old_sup, v_old_derived, v_old_derived, v_fingerprint, v_fingerprint);
    IF v_diff <> '{}'::jsonb OR COALESCE(v_event ?| ARRAY['stance', 'cites', 'valid_from', 'valid_until', 'trust', 'actor_kind'], false) THEN
      v_ev := ob1_append_thought_event(v_id, 'update', v_new_meta->>'source', v_diff, v_event);
    END IF;
    IF v_ev IS NOT NULL THEN
      -- The vector rides the projection: kept when none arrives (021), the caller's when one does.
      PERFORM ob1_project_thought_event(v_ev, p_embedding, v_label);
    ELSIF p_embedding IS NOT NULL THEN
      -- No event to project, a vector to place: a projection refresh.
      PERFORM ob1_refresh_thought_vector(v_id, p_embedding, v_label);
    END IF;
    v_supersedes_now := v_old_sup;
  END IF;

  -- ob1:vector-replaces-chunks — a CONTRACT SENTINEL (022): the windows stay
  -- while the label vouches for them, and go in every other case.
  IF p_embedding IS NOT NULL AND v_existed
     AND (v_old_label = v_label) IS NOT TRUE THEN
    DELETE FROM thought_chunks WHERE thought_id = v_id;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint, 'existed', v_existed, 'supersedes', v_supersedes_now);
END;
$$;

-- ---------------------------------------------------------------------------
-- update_thought — the 10-argument form (046).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_thought(
  p_id                 uuid,
  p_content            text        DEFAULT NULL,
  p_metadata_patch     jsonb       DEFAULT NULL,
  p_embedding          vector({{EMBEDDING_DIM}}) DEFAULT NULL,
  p_chunks             jsonb       DEFAULT NULL,
  p_if_unchanged_since timestamptz DEFAULT NULL,
  p_actor              jsonb       DEFAULT NULL,
  p_embedding_model    text        DEFAULT NULL,
  p_provenance         jsonb       DEFAULT NULL,
  p_event              jsonb       DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing     thoughts%ROWTYPE;
  v_fingerprint  text;
  v_unchanged    boolean;
  v_other        uuid;
  v_other_same   boolean;
  v_updated      timestamptz;
  v_set_supersedes boolean := COALESCE(p_provenance ? 'supersedes', false);
  v_set_derived    boolean := COALESCE(p_provenance ? 'derived_from', false);
  v_supersedes     uuid;
  v_derived        jsonb;
  v_walk           uuid;
  v_steps          int := 0;
  v_event          jsonb;
  -- The after-image (1999).
  v_new_content    text;
  v_new_fp         text;
  v_new_meta       jsonb;
  v_new_sup        uuid;
  v_new_derived    jsonb;
  v_new_has_vec    boolean;
  v_same_text      boolean;
  v_diff           jsonb;
  v_ev             uuid;
BEGIN
  IF p_provenance IS NOT NULL AND jsonb_typeof(p_provenance) <> 'object' THEN
    RAISE EXCEPTION
      'update_thought: p_provenance must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_provenance);
  END IF;
  IF v_set_supersedes AND jsonb_typeof(p_provenance->'supersedes') <> 'null' THEN
    IF jsonb_typeof(p_provenance->'supersedes') <> 'string'
       OR (p_provenance->>'supersedes') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION
        'update_thought: supersedes must be a thought UUID string or null, got %.', p_provenance->'supersedes';
    END IF;
    v_supersedes := (p_provenance->>'supersedes')::uuid;
  END IF;
  IF v_set_derived THEN
    v_derived := validate_derived_from(p_provenance->'derived_from');
  END IF;
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;
  v_event := validate_write_event(p_event);
  PERFORM set_config('ob1.event', '', true);  -- 046's anti-inheritance rule, kept (first review pass)
  -- ob1:supersession-review (032/036): the writers' lock order.
  IF v_supersedes IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));
  END IF;
  IF p_content IS NOT NULL THEN
    v_fingerprint := content_fingerprint_of(p_content);
    PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));
  END IF;
  -- SMD-1323: FOR NO KEY UPDATE, ordered against the FK's KEY SHARE.
  SELECT * INTO v_existing FROM thoughts WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;
  IF p_if_unchanged_since IS NOT NULL
     AND date_trunc('milliseconds', COALESCE(v_existing.updated_at, v_existing.created_at))
         > date_trunc('milliseconds', p_if_unchanged_since) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'STALE_READ',
      'current_updated_at', COALESCE(v_existing.updated_at, v_existing.created_at));
  END IF;
  IF v_supersedes IS NOT NULL THEN
    IF v_supersedes = p_id THEN
      RETURN jsonb_build_object('ok', false, 'error', 'WOULD_CYCLE', 'supersedes', v_supersedes);
    END IF;
    SELECT supersedes INTO v_walk FROM thoughts WHERE id = v_supersedes;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'SUPERSEDES_NOT_FOUND', 'supersedes', v_supersedes);
    END IF;
    WHILE v_walk IS NOT NULL LOOP
      IF v_walk = p_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'WOULD_CYCLE', 'supersedes', v_supersedes);
      END IF;
      v_steps := v_steps + 1;
      IF v_steps > 1000 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'WOULD_CYCLE', 'supersedes', v_supersedes, 'detail', 'chain longer than 1000');
      END IF;
      SELECT supersedes INTO v_walk FROM thoughts WHERE id = v_walk;
    END LOOP;
  END IF;
  -- ob1:unchanged-edit-not-duplicate — a CONTRACT SENTINEL (018).
  IF p_content IS NOT NULL THEN
    IF v_existing.content_fingerprint = v_fingerprint THEN
      v_unchanged := true;
    ELSE
      v_unchanged := v_fingerprint = content_fingerprint_of(v_existing.content);
      SELECT id, content_fingerprint_of(content) = v_fingerprint
        INTO v_other, v_other_same
      FROM thoughts
      WHERE content_fingerprint = v_fingerprint AND id <> p_id
      LIMIT 1;
      IF v_other IS NOT NULL THEN
        IF NOT v_unchanged THEN
          RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE_CONTENT');
        END IF;
      END IF;
    END IF;
  END IF;

  -- The after-image, as 046's UPDATE would have left the row.
  v_new_content := COALESCE(p_content, v_existing.content);
  v_new_fp      := CASE WHEN p_content IS NULL THEN v_existing.content_fingerprint
                        WHEN v_other IS NOT NULL THEN NULL
                        ELSE v_fingerprint END;
  v_same_text   := p_content IS NULL OR p_content IS NOT DISTINCT FROM v_existing.content
                   OR content_fingerprint_of(v_existing.content) IS NOT DISTINCT FROM v_fingerprint;
  v_new_meta    := CASE WHEN p_metadata_patch IS NOT NULL THEN v_existing.metadata || p_metadata_patch ELSE v_existing.metadata END;
  -- 050's stamp: the actor follows the content.
  v_new_meta    := CASE WHEN v_same_text THEN ob1_actor_stamp_kept(v_new_meta, v_existing.metadata) ELSE ob1_actor_stamp(v_new_meta) END;
  v_new_sup     := CASE WHEN v_set_supersedes THEN v_supersedes ELSE v_existing.supersedes END;
  v_new_derived := CASE WHEN v_set_derived THEN v_derived ELSE v_existing.derived_from END;
  v_new_has_vec := CASE WHEN p_content IS NOT NULL THEN p_embedding IS NOT NULL ELSE v_existing.embedding IS NOT NULL END;
  v_diff := ob1_thought_diff('update',
    v_existing.content, v_new_content,
    v_existing.metadata, v_new_meta,
    v_existing.embedding IS NOT NULL, v_new_has_vec,
    v_existing.supersedes, v_new_sup,
    v_existing.derived_from, v_new_derived,
    v_existing.content_fingerprint, v_new_fp);

  IF v_diff <> '{}'::jsonb OR COALESCE(v_event ?| ARRAY['stance', 'cites', 'valid_from', 'valid_until', 'trust', 'actor_kind'], false) THEN
    v_ev := ob1_append_thought_event(p_id, 'update', v_new_meta->>'source', v_diff, v_event);
  END IF;
  IF v_ev IS NOT NULL THEN
    PERFORM ob1_project_thought_event(v_ev, CASE WHEN p_content IS NOT NULL THEN p_embedding END, p_embedding_model);
    SELECT updated_at INTO v_updated FROM thoughts WHERE id = p_id;
  ELSIF p_content IS NOT NULL AND p_embedding IS NOT NULL THEN
    -- The same text with a new vector (the re-embed's shape): a projection refresh.
    PERFORM ob1_refresh_thought_vector(p_id, p_embedding, p_embedding_model);
    SELECT updated_at INTO v_updated FROM thoughts WHERE id = p_id;
  ELSE
    -- Nothing changed: no event, no write (the plan's named delta).
    v_updated := COALESCE(v_existing.updated_at, v_existing.created_at);
  END IF;

  IF p_content IS NOT NULL THEN
    DELETE FROM thought_chunks WHERE thought_id = p_id;
    IF p_chunks IS NOT NULL AND jsonb_array_length(p_chunks) > 0 THEN
      INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding, context)
      SELECT p_id, (ord - 1)::int, elem->>'content',
             (elem->>'embedding')::vector({{EMBEDDING_DIM}}),
             elem->>'context'
      FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS a(elem, ord);
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'updated_at', v_updated)
         || CASE WHEN v_other IS NULL   THEN '{}'::jsonb
                 WHEN v_other_same       THEN jsonb_build_object('duplicate_of', v_other)
                 ELSE jsonb_build_object('fingerprint_held_by', v_other) END;
END;
$$;

-- ---------------------------------------------------------------------------
-- delete_thought — 042's body; the event appended and projected inside the
-- sub-block, so a refused delete leaves no event.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION delete_thought(
  p_id     uuid,
  p_actor  jsonb   DEFAULT NULL,
  p_detach boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted   uuid;
  v_prev_mode text := current_setting('ob1.cited_delete', true);
  v_before_det int := COALESCE(NULLIF(current_setting('ob1.citations_detached', true), ''), '0')::int;
  v_before_ina int := COALESCE(NULLIF(current_setting('ob1.citations_inactive', true), ''), '0')::int;
  v_refused   boolean := false;
  v_detail    text;
  v_json      jsonb;
  v_detached  int;
  v_inactive  int;
  v_old       thoughts%ROWTYPE;
  v_ev        uuid;
BEGIN
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;
  PERFORM set_config('ob1.cited_delete', CASE WHEN COALESCE(p_detach, false) THEN 'detach' ELSE 'refuse' END, true);
  PERFORM set_config('ob1.event', '', true);  -- a tombstone declares nothing (046); the setting is cleared as 046's statement trigger cleared it
  -- ob1:supersession-review (036): the writers' lock order, first.
  PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));
  BEGIN
    SELECT * INTO v_old FROM thoughts WHERE id = p_id FOR NO KEY UPDATE;
    IF FOUND THEN
      v_ev := ob1_append_thought_event(p_id, 'delete', v_old.metadata->>'source',
                ob1_thought_diff('delete', v_old.content, NULL, v_old.metadata, NULL, v_old.embedding IS NOT NULL, false,
                                 v_old.supersedes, NULL, v_old.derived_from, NULL, v_old.content_fingerprint, NULL),
                NULL);
      v_deleted := ob1_project_thought_event(v_ev);
    END IF;
  EXCEPTION WHEN SQLSTATE 'OB001' THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_refused := true;
  END;
  PERFORM set_config('ob1.cited_delete', COALESCE(v_prev_mode, ''), true);
  IF v_refused OR v_deleted IS NULL THEN
    IF v_refused THEN
      BEGIN
        v_json := v_detail::jsonb;
      EXCEPTION WHEN OTHERS THEN
        v_json := '{}'::jsonb;
      END;
      RETURN jsonb_build_object('ok', false, 'error', 'CITED', 'id', p_id)
             || jsonb_build_object('cited_by', COALESCE((v_json->>'cited_by')::int, 0),
                                   'citations', COALESCE(v_json->'citations', '[]'::jsonb));
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;
  v_detached := COALESCE(NULLIF(current_setting('ob1.citations_detached', true), ''), '0')::int - v_before_det;
  v_inactive := COALESCE(NULLIF(current_setting('ob1.citations_inactive', true), ''), '0')::int - v_before_ina;
  RETURN jsonb_build_object('ok', true, 'id', v_deleted, 'detached', v_detached)
         || CASE WHEN v_inactive > 0 THEN jsonb_build_object('inactive', v_inactive) ELSE '{}'::jsonb END;
END;
$$;
