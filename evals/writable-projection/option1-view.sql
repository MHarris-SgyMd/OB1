-- =============================================================================
-- SMD-1999 prototype, option 1 — `thoughts` becomes a view over the row store,
-- with INSTEAD OF triggers that append the event and project it. NOT a
-- migration (see common.sql). Applied AFTER common.sql with {{ROWS}} =
-- thought_rows: the table is renamed first (its indexes, constraints, the
-- nine foreign keys onto it and its six triggers follow the rename), then the
-- view takes the name every caller uses.
--
-- The INSTEAD OF triggers are the raw writers' door: an INSERT / UPDATE /
-- DELETE against the name `thoughts` becomes an event first and a row second,
-- through the same append and projector option 2's functions call. The write
-- functions themselves are measured twice by the runner — 053's bodies as
-- they stand (their INSERT … ON CONFLICT names `thoughts`, now the view), and
-- option 2's bodies — and the difference is the finding.
-- =============================================================================

ALTER TABLE thoughts RENAME TO thought_rows;

CREATE VIEW thoughts AS SELECT * FROM thought_rows;

-- The stamp the base table would apply runs here, before the event: the
-- row is written by the projector under 050's pass-through.
CREATE OR REPLACE FUNCTION ob1_thoughts_view_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_meta jsonb;
  v_fp   text;
  v_ev   uuid;
  v_row  thought_rows%ROWTYPE;
BEGIN
  NEW.id := COALESCE(NEW.id, gen_random_uuid());
  v_meta := ob1_actor_stamp(NEW.metadata);
  -- A raw writer may bring its own key (ingest-records does) or none (003's rule fills it).
  v_fp   := COALESCE(NEW.content_fingerprint, content_fingerprint_of(NEW.content));
  v_ev   := ob1_append_thought_event(NEW.id, 'capture', v_meta->>'source',
             ob1_thought_diff('capture', NULL, NEW.content, NULL, v_meta, false, NEW.embedding IS NOT NULL,
                              NULL, NEW.supersedes, NULL, NEW.derived_from, NULL, v_fp),
             NULL);
  PERFORM ob1_project_thought_event(v_ev, NEW.embedding, NEW.embedding_model);
  SELECT * INTO v_row FROM thought_rows WHERE id = NEW.id;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION ob1_thoughts_view_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_meta   jsonb;
  v_same   boolean;
  v_fp     text;
  v_diff   jsonb;
  v_ev     uuid;
  v_row    thought_rows%ROWTYPE;
BEGIN
  v_same := NEW.content IS NOT DISTINCT FROM OLD.content
            OR content_fingerprint_of(OLD.content) IS NOT DISTINCT FROM content_fingerprint_of(NEW.content);
  v_meta := CASE WHEN v_same THEN ob1_actor_stamp_kept(NEW.metadata, OLD.metadata) ELSE ob1_actor_stamp(NEW.metadata) END;
  -- The key the projector will write: the writer's when it moved it, else
  -- 003's rule on the new text — so a raw content UPDATE through the view no
  -- longer leaves 018's stale key (the first option-1 smoke had the event
  -- name no key and the projector move it, which the check refused).
  v_fp   := CASE WHEN NEW.content_fingerprint IS DISTINCT FROM OLD.content_fingerprint THEN NEW.content_fingerprint
                 WHEN NEW.content IS DISTINCT FROM OLD.content THEN content_fingerprint_of(NEW.content)
                 ELSE OLD.content_fingerprint END;
  v_diff := ob1_thought_diff('update',
    OLD.content, NEW.content,
    OLD.metadata, v_meta,
    OLD.embedding IS NOT NULL, NEW.embedding IS NOT NULL,
    OLD.supersedes, NEW.supersedes,
    OLD.derived_from, NEW.derived_from,
    OLD.content_fingerprint, v_fp);
  IF v_diff = '{}'::jsonb THEN
    -- No event — but a vector or its label may still have moved (053's
    -- update_thought re-embedding the same text through the view): a
    -- projection refresh, as option 2's functions make it. First review
    -- pass: the row-image probe found the refresh dropped here, the label
    -- left as it was.
    IF NEW.embedding IS DISTINCT FROM OLD.embedding OR NEW.embedding_model IS DISTINCT FROM OLD.embedding_model THEN
      PERFORM ob1_refresh_thought_vector(NEW.id, NEW.embedding, NEW.embedding_model);
    END IF;
    SELECT * INTO v_row FROM thought_rows WHERE id = NEW.id;
    RETURN v_row;
  END IF;
  v_ev := ob1_append_thought_event(NEW.id, 'update', v_meta->>'source', v_diff, NULL);
  IF v_ev IS NOT NULL THEN
    PERFORM ob1_project_thought_event(v_ev, CASE WHEN NEW.embedding IS DISTINCT FROM OLD.embedding THEN NEW.embedding END, NEW.embedding_model);
  END IF;
  SELECT * INTO v_row FROM thought_rows WHERE id = NEW.id;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION ob1_thoughts_view_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_ev uuid;
BEGIN
  v_ev := ob1_append_thought_event(OLD.id, 'delete', OLD.metadata->>'source',
            ob1_thought_diff('delete', OLD.content, NULL, OLD.metadata, NULL, OLD.embedding IS NOT NULL, false,
                             OLD.supersedes, NULL, OLD.derived_from, NULL, OLD.content_fingerprint, NULL),
            NULL);
  PERFORM ob1_project_thought_event(v_ev);
  RETURN OLD;
END;
$$;

CREATE TRIGGER thoughts_view_insert INSTEAD OF INSERT ON thoughts FOR EACH ROW EXECUTE FUNCTION ob1_thoughts_view_insert();
CREATE TRIGGER thoughts_view_update INSTEAD OF UPDATE ON thoughts FOR EACH ROW EXECUTE FUNCTION ob1_thoughts_view_update();
CREATE TRIGGER thoughts_view_delete INSTEAD OF DELETE ON thoughts FOR EACH ROW EXECUTE FUNCTION ob1_thoughts_view_delete();
