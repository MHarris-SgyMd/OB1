-- =============================================================================
-- SMD-1999 prototype — the pieces both options share. NOT a migration: applied
-- by evals/eval-writable-projection.ts onto a throwaway database at the shipped
-- schema (053 when it was measured; 054 since SMD-2115 shipped the diff rule,
-- the append and the stamp arms — sections 1, 2 and 5a below are now the
-- migration's, and this file calls them), for the measurement, and thrown away
-- with it. Placeholders: {{EMBEDDING_DIM}}
-- (test-support's substitute) and {{ROWS}} — the relation the rows live in,
-- `thoughts` under option 2 and `thought_rows` under option 1 (the runner's).
--
-- What this file states, in the order a write runs:
--
--   1. ONE DIFF RULE (shipped by 054). ob1_thought_diff is what 046's audit
--      trigger computed from OLD and NEW, lifted out so the write functions
--      can compute the event BEFORE the row exists and the trigger can
--      compute it AFTER and compare. Three additions over 046, and nothing
--      else: a capture carries
--      the content (SMD-1998: the log is otherwise not the payload store) and,
--      when the writer set one, the row's created_at (a backdating ingester's
--      own time — the event's clock is the write's); an update records the
--      fingerprint's before/after when it moves — 018 sets the column NULL
--      when another row holds the key, a decision a replay cannot re-derive.
--   2. THE APPEND (shipped by 054). ob1_append_thought_event is 046's trigger tail — who, the
--      kind from the registry, the trust ceiling, the door, the claim — as a
--      function that INSERTs the thought_audit row and returns its id. The
--      trigger calls it for a raw write; the functions call it first.
--   3. THE PROJECTOR. ob1_project_thought_event applies one event to the row
--      store: capture → INSERT (created_at from the event when it carries one,
--      else the write's clock), update → UPDATE by the diff's afters, delete →
--      DELETE. The live write passes its vector; a replay takes the vector
--      from ob1_embedding_snapshot by (content_fingerprint, embedding_model) —
--      SMD-1998's key, made a table — or leaves what stands: the log is
--      FAITHFUL, not corrective — a key the event does not move stays (018's
--      stale key after a raw content edit stays stale), a vector the event
--      does not flip stays unless the snapshot holds one for the new text. A
--      row without a vector is readable while the re-embed pool (015) fills
--      it. A capture event without content (008's shape) is refused, not
--      projected as an empty thought. A replayed tombstone never refuses
--      (ob1.cited_delete = 'detach' for the statement, restored after). The
--      projector announces itself to the row's triggers through three
--      settings, cleared after: ob1.projecting (the event id),
--      ob1.projecting_thought (the event's row), ob1.projecting_replay.
--      ob1_refresh_thought_vector is the fourth write: a vector arriving on a
--      row that has one is a projection refresh with no event and no
--      updated_at bump, announced as ob1.projecting = 'vector'.
--   4. THE CHECK. thoughts_write_audit, under ob1.projecting = <event id>,
--      recomputes the diff from the row it sees and RAISES (SQLSTATE OB002)
--      when the row is not the event's AFTER image or moved a column the
--      event does not name — every projected write, live or replayed, is
--      verified against its event by the trigger that used to write it. On a
--      live write it also holds the vector's PRESENCE to the event (a flip
--      named, or none); on a replay the snapshot may miss, so presence is not
--      held there. THE FOREIGN-ROW RULE: a row OTHER than the event's that
--      moves under its projection is a consequence the schema draws — a
--      tombstone's ON DELETE SET NULL on a successor's pointer (025), 042's
--      guard bumping a citing thought's stamp — accepted when it is exactly
--      that: a bump (an empty diff) is nothing; the successor's nulled pointer
--      is appended as its own update event live (as 046 does) and skipped on
--      a replay (the log already holds it); anything else RAISES. Under
--      ob1.projecting = 'vector' it verifies that only the vector moved.
--      Without any setting (a raw write) it appends, as 046 does, reading and
--      clearing ob1.event as 046 did.
--   5. THE STAMP, CALLABLE (the two arms shipped by 054). 050 stamps metadata.actor_kind / actor_name in a
--      BEFORE trigger from the envelope; an event written before the row must
--      carry the stamped metadata, so the two arms are functions the writers
--      call, and the projector runs under 050's own pass-through
--      (ob1.actor_amend = 'backfill') so the row takes the event's metadata
--      as given. 001's updated_at trigger yields to the projector's stamp for
--      the event's own row (ob1.projecting_thought) — the event's created_at,
--      now() on the live path, the original time on a replay — and bumps a
--      cascaded row as 001 bumps it.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1, 2 and 5a — the diff rule, the append and 050's two stamp arms — SHIPPED:
-- migration 054 (SMD-2115, step 1 of the decision) defines ob1_thought_diff,
-- ob1_append_thought_event, ob1_actor_stamp and ob1_actor_stamp_kept with the
-- bodies this file carried, and the shipped audit trigger calls the first two.
-- This file calls them and defines only what step 2 (SMD-2116) will ship: the
-- snapshot, the projector, the refresh, the check, 001's yielding stamp.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 5b. 001's updated_at trigger yields to the projector's stamp.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger AS $$
BEGIN
  -- The event's own row takes the event's time; a row a cascade moves under
  -- the projection (a successor's nulled pointer) is bumped as 001 bumps it —
  -- the first replay smoke had the cascaded row keep its old stamp live and
  -- take the event's on replay, the one column that then differed.
  IF new.id::text = COALESCE(current_setting('ob1.projecting_thought', true), '') THEN
    RETURN new;
  END IF;
  new.updated_at = now();
  RETURN new;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 3a. The snapshot: the vector by its key (SMD-1998), fed by the row store.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ob1_embedding_snapshot (
  content_fingerprint text NOT NULL,
  embedding_model     text NOT NULL,
  embedding           vector({{EMBEDDING_DIM}}) NOT NULL,
  taken_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_fingerprint, embedding_model)
);

CREATE OR REPLACE FUNCTION ob1_snapshot_embedding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.embedding IS NOT NULL AND NEW.embedding_model IS NOT NULL AND NEW.content_fingerprint IS NOT NULL THEN
    INSERT INTO ob1_embedding_snapshot (content_fingerprint, embedding_model, embedding)
    VALUES (NEW.content_fingerprint, NEW.embedding_model, NEW.embedding)
    ON CONFLICT (content_fingerprint, embedding_model) DO UPDATE
      SET embedding = EXCLUDED.embedding, taken_at = now();
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS thoughts_snapshot_embedding ON {{ROWS}};
CREATE TRIGGER thoughts_snapshot_embedding
  AFTER INSERT OR UPDATE OF embedding, embedding_model, content_fingerprint ON {{ROWS}}
  FOR EACH ROW EXECUTE FUNCTION ob1_snapshot_embedding();

-- ---------------------------------------------------------------------------
-- 3b. The projector.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_project_thought_event(
  p_event           uuid,
  p_embedding       vector({{EMBEDDING_DIM}}) DEFAULT NULL,
  p_embedding_model text    DEFAULT NULL,
  p_replay          boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  e            thought_audit%ROWTYPE;
  v_content    text;
  v_fp         text;
  v_vec        vector({{EMBEDDING_DIM}});
  v_model      text;
  v_target     text;
  v_found      boolean := false;
  v_prev_amend text := current_setting('ob1.actor_amend', true);
  v_prev_cited text := current_setting('ob1.cited_delete', true);
BEGIN
  SELECT * INTO e FROM thought_audit WHERE id = p_event;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ob1_project_thought_event: no event % in thought_audit', p_event;
  END IF;
  SELECT value INTO v_target FROM ob1_config WHERE key = 'embedding_model';

  -- The row's triggers see the event id (the audit trigger checks instead of
  -- writing; 001's stamp yields) and 050's pass-through (the metadata is
  -- already stamped in the event).
  PERFORM set_config('ob1.projecting', p_event::text, true);
  PERFORM set_config('ob1.projecting_thought', e.thought_id::text, true);
  PERFORM set_config('ob1.projecting_replay', CASE WHEN p_replay THEN 'on' ELSE '' END, true);
  PERFORM set_config('ob1.actor_amend', 'backfill', true);
  -- 046's anti-inheritance rule, kept: the setting a raw write would read is
  -- cleared before any row moves, so a cascaded row cannot inherit a stance,
  -- cites or a window declared for another write (first review pass: the
  -- functions had stopped setting it, since the event now rides the append).
  PERFORM set_config('ob1.event', '', true);

  IF e.action = 'capture' THEN
    IF NOT (e.diff ? 'content') THEN
      RAISE EXCEPTION USING
        ERRCODE = 'OB003',
        MESSAGE = 'ob1_project_thought_event: the capture event carries no content (008''s shape) — the log is not the payload store for this thought, and the row cannot be projected from it',
        DETAIL  = e.thought_id::text;
    END IF;
    v_content := e.diff->>'content';
    v_fp      := content_fingerprint_of(v_content);
    IF p_replay THEN
      SELECT s.embedding, s.embedding_model INTO v_vec, v_model
        FROM ob1_embedding_snapshot s
       WHERE s.content_fingerprint = v_fp AND s.embedding_model = v_target;
    ELSE
      v_vec   := p_embedding;
      v_model := CASE WHEN p_embedding IS NULL THEN NULL ELSE p_embedding_model END;
    END IF;
    -- metadata as the event holds it: a payload's `"metadata": null` is
    -- jsonb null on the row under 046 (COALESCE does not replace it, 050's
    -- guard leaves it), and stays so here — a NULLIF would turn it into SQL
    -- NULL and the check, applying the same NULLIF, would not see the
    -- difference (first review pass). An update's after keeps the NULLIF:
    -- a raw `SET metadata = NULL` is SQL NULL, and JSON encodes both the same.
    INSERT INTO {{ROWS}} (id, content, content_fingerprint, metadata, embedding, embedding_model, derived_from, supersedes, created_at, updated_at)
    VALUES (
      e.thought_id, v_content, v_fp,
      e.diff->'metadata',
      v_vec, v_model,
      NULLIF(e.diff->'derived_from', 'null'::jsonb),
      (e.diff->>'supersedes')::uuid,
      -- The row's own created_at when the event carries one (a backdating
      -- writer), else the write's clock; updated_at is the write's clock as
      -- 001's default makes it.
      COALESCE((e.diff->>'created_at')::timestamptz, e.created_at), e.created_at);

  ELSIF e.action = 'update' THEN
    IF e.diff ? 'content' THEN
      v_content := e.diff->'content'->>'after';
      IF p_replay THEN
        -- The vector by the new text's key, if the live write ever snapshotted one.
        SELECT s.embedding, s.embedding_model INTO v_vec, v_model
          FROM ob1_embedding_snapshot s
         WHERE s.content_fingerprint = content_fingerprint_of(v_content) AND s.embedding_model = v_target;
        v_found := FOUND;
      ELSE
        -- The live edit's vector, or none: update_thought writes p_embedding beside a new text (018/021).
        v_vec   := p_embedding;
        v_model := CASE WHEN p_embedding IS NULL THEN NULL ELSE p_embedding_model END;
      END IF;
    END IF;
    -- The log is faithful, not corrective (second review pass): a key the
    -- event does not move stays as it was — a raw content UPDATE around the
    -- functions leaves 018's stale key live, and the replay leaves it too —
    -- and a vector the event does not flip stays unless the snapshot holds
    -- one for the new text (a function's edit snapshotted it live; a raw
    -- edit did not, and the stale vector stays, as live).
    UPDATE {{ROWS}} t SET
      content             = CASE WHEN e.diff ? 'content' THEN v_content ELSE t.content END,
      content_fingerprint = CASE WHEN e.diff ? 'content_fingerprint' THEN e.diff->'content_fingerprint'->>'after'
                                 ELSE t.content_fingerprint END,
      metadata            = CASE WHEN e.diff ? 'metadata' THEN NULLIF(e.diff->'metadata'->'after', 'null'::jsonb) ELSE t.metadata END,
      supersedes          = CASE WHEN e.diff ? 'supersedes' THEN (e.diff->'supersedes'->>'after')::uuid ELSE t.supersedes END,
      derived_from        = CASE WHEN e.diff ? 'derived_from' THEN NULLIF(e.diff->'derived_from'->'after', 'null'::jsonb) ELSE t.derived_from END,
      embedding           = CASE WHEN e.diff ? 'content' AND NOT p_replay THEN v_vec
                                 WHEN e.diff ? 'content' AND (e.diff->>'embedding_present') = 'false' THEN NULL
                                 WHEN e.diff ? 'content' AND v_found THEN v_vec
                                 WHEN e.diff ? 'content' THEN t.embedding
                                 WHEN p_embedding IS NOT NULL THEN p_embedding
                                 WHEN (e.diff->>'embedding_present') = 'false' THEN NULL
                                 ELSE t.embedding END,
      embedding_model     = CASE WHEN e.diff ? 'content' AND NOT p_replay THEN v_model
                                 WHEN e.diff ? 'content' AND (e.diff->>'embedding_present') = 'false' THEN NULL
                                 WHEN e.diff ? 'content' AND v_found THEN v_model
                                 WHEN e.diff ? 'content' THEN t.embedding_model
                                 WHEN p_embedding IS NOT NULL THEN p_embedding_model
                                 WHEN (e.diff->>'embedding_present') = 'false' THEN NULL
                                 ELSE t.embedding_model END,
      updated_at          = e.created_at
    WHERE t.id = e.thought_id;

  ELSIF e.action = 'delete' THEN
    -- On a replay a tombstone never refuses: the delete happened, and 042's
    -- guard (which reads ob1.cited_delete, default refuse) would otherwise
    -- abort the whole replay on a thought that was cited when it went. The
    -- facets it detaches are a projection rebuilt apart (first review pass).
    IF p_replay THEN
      PERFORM set_config('ob1.cited_delete', 'detach', true);
    END IF;
    DELETE FROM {{ROWS}} WHERE id = e.thought_id;
  ELSE
    RAISE EXCEPTION 'ob1_project_thought_event: unknown action %', e.action;
  END IF;

  PERFORM set_config('ob1.projecting', '', true);
  PERFORM set_config('ob1.projecting_thought', '', true);
  PERFORM set_config('ob1.projecting_replay', '', true);
  PERFORM set_config('ob1.actor_amend', COALESCE(v_prev_amend, ''), true);
  PERFORM set_config('ob1.cited_delete', COALESCE(v_prev_cited, ''), true);  -- restored as delete_thought restores its own (second review pass)
  RETURN e.thought_id;
END;
$$;

-- A vector arriving on a row that already stands: a projection refresh, no
-- event (the log records embedding_present, never a label change — 046). The
-- audit trigger verifies that nothing but the vector moved. updated_at is
-- NOT bumped: the first full run had the one row whose last live write was
-- a refresh differ from its replay on that column alone — a stamp no event
-- carries cannot be rebuilt. The vector's own time is the snapshot's
-- taken_at; updated_at follows the events. DELTA against 053, where a
-- re-embed's update_thought bumps it (and so reads as a change to a caller's
-- if_unchanged_since) — named in the plan for SMD-1997 to accept or reverse.
CREATE OR REPLACE FUNCTION ob1_refresh_thought_vector(
  p_id              uuid,
  p_embedding       vector({{EMBEDDING_DIM}}),
  p_embedding_model text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('ob1.projecting', 'vector', true);
  PERFORM set_config('ob1.projecting_thought', p_id::text, true);
  UPDATE {{ROWS}} SET embedding = p_embedding, embedding_model = p_embedding_model
   WHERE id = p_id;
  PERFORM set_config('ob1.projecting', '', true);
  PERFORM set_config('ob1.projecting_thought', '', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. The audit trigger: the check under a projection, the writer for a raw write.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thoughts_write_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_proj   text := COALESCE(current_setting('ob1.projecting', true), '');
  v_raw    text;
  event    jsonb;
  v_action text;
  v_id     uuid;
  v_source text;
  v_diff   jsonb;
  e        thought_audit%ROWTYPE;
BEGIN
  v_action := CASE TG_OP WHEN 'INSERT' THEN 'capture' WHEN 'UPDATE' THEN 'update' ELSE 'delete' END;
  v_id     := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  v_source := CASE WHEN TG_OP = 'DELETE' THEN OLD.metadata->>'source' ELSE NEW.metadata->>'source' END;
  v_diff   := ob1_thought_diff(
    v_action,
    OLD.content, NEW.content,
    OLD.metadata, NEW.metadata,
    OLD.embedding IS NOT NULL, NEW.embedding IS NOT NULL,
    OLD.supersedes, NEW.supersedes,
    OLD.derived_from, NEW.derived_from,
    OLD.content_fingerprint, NEW.content_fingerprint,
    CASE WHEN TG_OP = 'INSERT' THEN NEW.created_at END);

  IF v_proj = 'vector' THEN
    -- ob1:projection-checked-against-its-event (1999): a refresh moves the
    -- vector and nothing else.
    IF TG_OP <> 'UPDATE' OR (v_diff - 'embedding_present') <> '{}'::jsonb THEN
      RAISE EXCEPTION USING
        ERRCODE = 'OB002',
        MESSAGE = 'thoughts_write_audit: a vector refresh changed more than the vector',
        DETAIL  = v_diff::text;
    END IF;
    RETURN NULL;
  ELSIF v_proj <> '' THEN
    SELECT * INTO e FROM thought_audit WHERE id = v_proj::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'OB002',
        MESSAGE = 'thoughts_write_audit: ob1.projecting names an event that is not in the log', DETAIL = v_proj;
    END IF;
    IF e.thought_id <> v_id THEN
      -- ANOTHER row moved under this event's projection: a consequence the
      -- schema itself draws, judged on the WHOLE diff (a cascade that also
      -- moved a vector is not a bump). Found by the first smoke run — a tombstone's
      -- ON DELETE SET NULL (025) writes every successor's pointer, and 042's
      -- citation guard bumps a citing thought's updated_at on a detach.
      IF v_diff = '{}'::jsonb THEN
        RETURN NULL;  -- a bump (updated_at is not in the diff): nothing to record
      END IF;
      IF e.action = 'delete' AND TG_OP = 'UPDATE'
         AND v_diff = jsonb_build_object('supersedes', jsonb_build_object('before', e.thought_id, 'after', NULL)) THEN
        -- The FK's consequence. Live: audited as its own update, as 046 does
        -- today (the successor's row says when its pointer went). Replay: the
        -- log already holds that event and will replay it — appending again
        -- would double the log.
        IF COALESCE(current_setting('ob1.projecting_replay', true), '') <> 'on' THEN
          PERFORM ob1_append_thought_event(v_id, 'update', NEW.metadata->>'source', v_diff, NULL);
        END IF;
        RETURN NULL;
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'OB002',
        MESSAGE = 'thoughts_write_audit: a row other than the event''s moved under its projection',
        DETAIL  = jsonb_build_object('event', jsonb_build_object('thought_id', e.thought_id, 'action', e.action),
                                     'row', jsonb_build_object('thought_id', v_id, 'action', v_action, 'diff', v_diff))::text;
    END IF;

    -- The vector's PRESENCE: live, the projector writes what the event says
    -- (a flip named, or none), so a vector dropped or conjured under an event
    -- that names no flip is a divergence (second review pass — a view's raw
    -- content UPDATE had dropped the vector with the strip hiding it). On a
    -- replay the snapshot may miss, so presence is not held there.
    IF COALESCE(current_setting('ob1.projecting_replay', true), '') <> 'on'
       AND (e.diff->'embedding_present') IS DISTINCT FROM (v_diff->'embedding_present') THEN
      RAISE EXCEPTION USING ERRCODE = 'OB002',
        MESSAGE = 'thoughts_write_audit: the projection moved the vector''s presence in a way its event does not name',
        DETAIL  = jsonb_build_object('event', e.diff->'embedding_present', 'row', v_diff->'embedding_present')::text;
    END IF;
    v_diff := v_diff - 'embedding_present';  -- the vector itself is a projection (SMD-1998), not the event's claim
    IF e.action <> v_action THEN
      RAISE EXCEPTION USING ERRCODE = 'OB002',
        MESSAGE = 'thoughts_write_audit: the projected row''s action is not the event''s',
        DETAIL  = jsonb_build_object('event', e.action, 'row', v_action)::text;
    END IF;
    -- The event's AFTER image against the row, and nothing moved that the
    -- event does not name. Afters rather than before/after pairs: on a replay
    -- a cascade may have applied part of a later event already (the successor
    -- whose pointer a tombstone nulled), so its before differs and its diff
    -- is a subset — the state the event asserts is what must hold.
    IF TG_OP = 'INSERT' THEN
      IF (e.diff->>'content') IS DISTINCT FROM NEW.content
         OR (e.diff->'metadata') IS DISTINCT FROM NEW.metadata
         OR (e.diff ? 'created_at' AND (e.diff->>'created_at')::timestamptz IS DISTINCT FROM NEW.created_at)
         OR NULLIF(e.diff->'derived_from', 'null'::jsonb) IS DISTINCT FROM NEW.derived_from
         OR (e.diff->>'supersedes')::uuid IS DISTINCT FROM NEW.supersedes THEN
        RAISE EXCEPTION USING ERRCODE = 'OB002',
          MESSAGE = 'thoughts_write_audit: the projected row diverges from its capture event',
          DETAIL  = jsonb_build_object('event', e.diff - 'content', 'row', v_diff - 'content')::text;
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NOT (SELECT COALESCE(bool_and(k IN (SELECT jsonb_object_keys(e.diff))), true) FROM jsonb_object_keys(v_diff) k) THEN
        RAISE EXCEPTION USING ERRCODE = 'OB002',
          MESSAGE = 'thoughts_write_audit: the projection moved a column its event does not name',
          DETAIL  = jsonb_build_object('event', e.diff - 'embedding_present', 'row', v_diff)::text;
      END IF;
      IF (e.diff ? 'content' AND (e.diff->'content'->>'after') IS DISTINCT FROM NEW.content)
         OR (e.diff ? 'metadata' AND NULLIF(e.diff->'metadata'->'after', 'null'::jsonb) IS DISTINCT FROM NEW.metadata)
         OR (e.diff ? 'supersedes' AND (e.diff->'supersedes'->>'after')::uuid IS DISTINCT FROM NEW.supersedes)
         OR (e.diff ? 'derived_from' AND NULLIF(e.diff->'derived_from'->'after', 'null'::jsonb) IS DISTINCT FROM NEW.derived_from)
         OR (e.diff ? 'content_fingerprint' AND (e.diff->'content_fingerprint'->>'after') IS DISTINCT FROM NEW.content_fingerprint) THEN
        RAISE EXCEPTION USING ERRCODE = 'OB002',
          MESSAGE = 'thoughts_write_audit: the projected row diverges from its update event',
          DETAIL  = jsonb_build_object('event', e.diff - 'embedding_present', 'row', v_diff)::text;
      END IF;
    END IF;
    RETURN NULL;
  END IF;

  -- A raw write: 046's path — the event handoff read once and cleared, the
  -- empty-diff gate, the append.
  v_raw := current_setting('ob1.event', true);
  IF v_raw IS NOT NULL AND v_raw <> '' THEN
    PERFORM set_config('ob1.event', '', true);
    IF TG_OP <> 'DELETE' AND v_raw ~ '^\s*\{' THEN
      event := v_raw::jsonb;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND v_diff = '{}'::jsonb
     AND NOT COALESCE(event ?| ARRAY['stance', 'cites', 'valid_from', 'valid_until', 'trust', 'actor_kind'], false) THEN
    RETURN NULL;
  END IF;
  PERFORM ob1_append_thought_event(v_id, v_action, v_source, v_diff, event);
  RETURN NULL;
END;
$$;
