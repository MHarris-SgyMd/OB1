-- =============================================================================
-- Migration 047: the actor on the row — who wrote a thought's current text,
--                from the key, where a read can filter on it (SMD-1726)
-- =============================================================================
--
-- WHY
--   046 records who holds the key on every audit row (thought_audit.actor_kind,
--   from ob1_agents.kind, never from the payload) beside 008's actor_name. But
--   a read does not return audit rows: a search hit, a listed item and a fetch
--   carry the thoughts row and its metadata, and nothing on that row says who
--   wrote it. A hit an agent's summary pass wrote and a hit the operator typed
--   look identical, and "only what I said" cannot be asked. Mem0's 2026 report
--   calls actor-aware memory table stakes; SMD-1716 defers isolation BETWEEN
--   operators, and this is the smaller thing — one operator, several keys.
--
-- WHAT
--   1. TWO RESERVED KEYS IN thoughts.metadata, actor_kind and actor_name,
--      stamped by a BEFORE trigger (thoughts_stamp_actor, ob1_stamp_actor)
--      from the envelope 008's writers set (ob1.actor), through 046's one
--      registry lookup (ob1_registry_kind: the id's kind, else the name's).
--      NEVER from the payload: whatever a payload's metadata carried under
--      either key is overwritten — or removed, when the write names no key —
--      before the row is written. The kind is written only when the registry
--      knows it; the name whenever the envelope carries one. NULL (absent) is
--      the honest value for an unclassified key or a mutation made outside
--      the server, as it is on the audit row.
--
--      Why metadata and not two columns: 014's route. match_thoughts filters
--      INSIDE the scan on `metadata @> filter`, over 001's GIN index, on both
--      the walk and the exact branch, and SMD-1490's `filter` argument on the
--      search tools already reaches it — so `said_by: operator` is
--      `{"actor_kind": "operator"}` on a path that exists and is measured
--      (014, 037, 038). Two columns would need their own index and a sixth
--      redefinition of match_thoughts (037–041 each carry the whole body) for
--      a branch the filter already has. metadata already carries the row's
--      system-written keys (`source`, `type`, `topics`, from the extractor);
--      these two are the first the DATABASE writes, so the column's COMMENT
--      says so.
--
--   2. THE ACTOR FOLLOWS THE CONTENT — 021's rule for the label, applied to
--      the writer. An INSERT stamps. An UPDATE that changes the content
--      re-stamps from the envelope present, or removes the mark when none is:
--      the text is now the editor's. An UPDATE that leaves the content keeps
--      the mark as it was, whatever the patch said: a metadata-only edit, a
--      re-capture's merge (upsert_thought's ON CONFLICT never touches
--      content), a re-embed, 018's unchanged edit — none of them changes who
--      said it. The audit row records the stamp with the rest of the metadata
--      diff, so "an agent rewrote the operator's note" is in the log.
--
--   3. THE BACKFILL, backfill_thought_actors(p_limit): for every thought, the
--      latest audit row that WROTE ITS CONTENT — a capture, or an update whose
--      diff carries `content` — gives the writer: its actor_kind (046's
--      backfill may have filled it) else the registry's kind for its id or
--      name now, and its actor_name. The two keys are set to exactly that
--      wherever they differ, so a pre-047 row that happened to carry a
--      caller's `actor_kind` is corrected (the log knows the writer) or
--      stripped (it does not), a stamped row is left alone, and a re-apply
--      writes nothing. Called once by the file with {{BACKFILL_LIMIT}} (023's
--      knob, OB1_BACKFILL_LIMIT); run again after set_agent_kind and 046's
--      backfill have classified a key. Each row it writes is an UPDATE of
--      metadata, which 008's trigger records — an audit row per thought
--      filled, its door `backfill_thought_actors`, its actor nobody. That IS
--      the record the ticket asks for; a brain with a million rows batches it.
--
--   4. NOT HERE, SAID SO. No index beyond 001's GIN: the filter's route is the
--      GIN's (a `said_by` matching most of the corpus is the walk with a
--      predicate, as any broad filter is — 037's route estimate decides). No
--      preflight census of the rows still without a kind — the backfill's
--      return carries `awaiting`, and whether a start-up census over
--      thoughts needs a bound is SMD-1947's question. The trust label on the
--      hit is SMD-1724's; the tool arguments `said_by` and `actor` and the
--      `By:` line are the server's half of this ticket.
--
-- PRIVILEGES
--   The trigger runs as the writer and reads ob1_agents — the SELECT
--   ROLE_GRANTS.capture holds since 046; nothing new. The backfill holds the
--   updated_at trigger for its pass (a stamp is not an edit: 018's stale-read
--   guard and 021's evidence rule read updated_at), which needs the table's
--   owner, as 023's does.
--
-- Idempotent. CREATE OR REPLACE throughout; the trigger drop-then-create (001's
-- form); the backfill writes only where the log and the row disagree.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The stamp: who wrote this text, from the key.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_stamp_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor   jsonb;
  v_agent uuid;
  v_name  text;
  v_kind  text;
  v_meta  jsonb;
BEGIN
  /**
   * ob1:actor-on-the-row-from-the-key — a CONTRACT SENTINEL, not prose (the
   * 014 convention): the two keys below are written from the envelope and the
   * registry, never copied from the payload.
   *
   * The backfill's own write: it has derived the keys from the log and sets
   * them as given, under its setting — the same shape as 046's
   * ob1.audit_amend. A direct SQL caller who sets it is a caller with UPDATE
   * on thoughts, who can already write any metadata (046's boundary).
   */
  IF current_setting('ob1.actor_amend', true) = 'backfill' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.content IS NOT DISTINCT FROM OLD.content THEN
    -- The actor follows the content: the mark stays as it was, whatever the
    -- patch said. The common case — a re-embed, a metadata touch — carries the
    -- same two keys in and out and pays two comparisons, no rebuild.
    IF NEW.metadata->'actor_kind' IS NOT DISTINCT FROM OLD.metadata->'actor_kind'
       AND NEW.metadata->'actor_name' IS NOT DISTINCT FROM OLD.metadata->'actor_name' THEN
      RETURN NEW;
    END IF;
    v_meta := COALESCE(NEW.metadata, '{}'::jsonb) - 'actor_kind' - 'actor_name';
    IF OLD.metadata ? 'actor_kind' THEN
      v_meta := v_meta || jsonb_build_object('actor_kind', OLD.metadata->'actor_kind');
    END IF;
    IF OLD.metadata ? 'actor_name' THEN
      v_meta := v_meta || jsonb_build_object('actor_name', OLD.metadata->'actor_name');
    END IF;
    NEW.metadata := v_meta;
    RETURN NEW;
  END IF;

  -- An INSERT, or an UPDATE that changes the content: the writer is whoever
  -- set the envelope. 008's reader (NULL when unset or malformed), 010's id
  -- reading (the exact form the server emits; anything else is no id) and
  -- 046's lookup — only when the envelope names an id or a name, so a raw
  -- write with no actor set probes nothing (046, third review pass).
  actor := ob1_current_actor();
  IF actor IS NOT NULL AND jsonb_typeof(actor) = 'object' THEN
    v_name  := NULLIF(btrim(actor->>'name'), '');
    v_agent := CASE
      WHEN actor->>'agent_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (actor->>'agent_id')::uuid
    END;
    IF v_agent IS NOT NULL OR v_name IS NOT NULL THEN
      v_kind := ob1_registry_kind(v_agent, v_name);
    END IF;
  END IF;

  v_meta := COALESCE(NEW.metadata, '{}'::jsonb) - 'actor_kind' - 'actor_name';
  IF v_kind IS NOT NULL THEN
    v_meta := v_meta || jsonb_build_object('actor_kind', v_kind);
  END IF;
  IF v_name IS NOT NULL THEN
    v_meta := v_meta || jsonb_build_object('actor_name', v_name);
  END IF;
  -- A NULL metadata with nothing to add stays NULL: the stamp adds keys, it
  -- does not decide the column's emptiness for a raw writer.
  IF NEW.metadata IS NULL AND v_meta = '{}'::jsonb THEN
    RETURN NEW;
  END IF;
  NEW.metadata := v_meta;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION ob1_stamp_actor() IS
  'BEFORE INSERT OR UPDATE on thoughts (thoughts_stamp_actor, 047): writes metadata.actor_kind (ob1_agents.kind for the envelope''s agent_id, else its name — ob1_registry_kind, 046) and metadata.actor_name (the envelope''s name) from the ob1.actor setting 008''s writers set, never from the payload — a payload''s own values under either key are overwritten or removed. The actor follows the content: an INSERT and a content-changing UPDATE stamp from the envelope present (no envelope, no mark); an UPDATE that leaves the content keeps the mark as it was. Under ob1.actor_amend = ''backfill'' the keys are taken as given (backfill_thought_actors). Migration 047 / SMD-1726.';

DROP TRIGGER IF EXISTS thoughts_stamp_actor ON thoughts;
CREATE TRIGGER thoughts_stamp_actor
  BEFORE INSERT OR UPDATE ON thoughts
  FOR EACH ROW
  EXECUTE FUNCTION ob1_stamp_actor();

COMMENT ON COLUMN thoughts.metadata IS
  'The thought''s metadata: the caller''s keys and the extractor''s (source, type, topics, people, action_items). Two keys are the DATABASE''s since 047 and a write cannot set them: actor_kind (operator | agent | ingested — who holds the key that wrote the current content, from ob1_agents.kind, 046) and actor_name (that key''s name); absent when the key is unclassified or the write came from outside the server. Reads filter on them through 014''s metadata route (`said_by`, `actor` on the search and list tools) and print them as `By: name (kind)`. Migration 047 / SMD-1726.';

-- ---------------------------------------------------------------------------
-- The backfill: the log says who wrote the content; the row is made to agree.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION backfill_thought_actors(p_limit integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET lock_timeout = '10s'
AS $$
DECLARE
  v_prev_actor text := current_setting('ob1.actor', true);
  v_prev_amend text := current_setting('ob1.actor_amend', true);
  v_rows     integer := 0;
  v_differ   integer;
  v_awaiting integer;
BEGIN
  IF p_limit IS NOT NULL AND p_limit < 1 THEN
    RAISE EXCEPTION 'backfill_thought_actors: p_limit must be at least 1, or NULL for every row (got %)', p_limit;
  END IF;

  /**
   * Every thought's writer, from the log: the latest row that wrote the
   * content (a capture, or an update whose diff carries `content`), read by
   * 008's thought_id index. Its kind is what 046 filled, else what the
   * registry says NOW for its id or name — the trigger's rule applied late,
   * as 046's backfill applies it. A thought with no such row (loaded with the
   * audit trigger off, or its log pruned by a migration) derives to nothing,
   * and a mark it carries is stripped: nobody vouches for it.
   *
   * `differs` is where the row and the log disagree — the rows this pass
   * writes; `awaiting` is where the log names a key nobody has classified —
   * the rows the next pass fills once set_agent_kind has. updated_at rides
   * along so the write below can tell a row edited meanwhile (018's guard).
   */
  DROP TABLE IF EXISTS ob1_actor_backfill;
  CREATE TEMP TABLE ob1_actor_backfill ON COMMIT DROP AS
    SELECT d.id, d.updated_at, d.kind, d.name,
           (d.kind IS DISTINCT FROM d.present_kind OR d.name IS DISTINCT FROM d.present_name) AS differs,
           (d.kind IS NULL AND (d.w_name IS NOT NULL OR d.w_agent IS NOT NULL)) AS awaiting
    FROM (
      SELECT t.id, t.updated_at,
             COALESCE(w.actor_kind, ob1_registry_kind(w.canonical_agent_id, w.actor_name)) AS kind,
             w.actor_name AS name,
             w.actor_name AS w_name, w.canonical_agent_id AS w_agent,
             t.metadata->>'actor_kind' AS present_kind,
             t.metadata->>'actor_name' AS present_name
      FROM thoughts t
      LEFT JOIN LATERAL (
        SELECT a.actor_kind, a.actor_name, a.canonical_agent_id
        FROM thought_audit a
        WHERE a.thought_id = t.id
          AND (a.action = 'capture' OR (a.action = 'update' AND a.diff ? 'content'))
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT 1
      ) w ON true
    ) d;

  SELECT count(*) FILTER (WHERE differs), count(*) FILTER (WHERE awaiting)
    INTO v_differ, v_awaiting
    FROM ob1_actor_backfill;

  IF v_differ > 0 THEN
    -- The stamp trigger takes the keys as given under this setting; the audit
    -- row each write leaves names the door and nobody. Both restored below —
    -- a hand call must not leave the transaction's actor changed.
    PERFORM set_config('ob1.actor_amend', 'backfill', true);
    PERFORM set_config('ob1.actor', '{"via": "backfill_thought_actors"}', true);
    -- A stamp is not an edit: 001's trigger would bump updated_at on every
    -- row written, and 018's stale-read guard and 021's evidence rule both
    -- read it. Held off for the one statement (SHARE ROW EXCLUSIVE: writers
    -- wait, readers do not), as 023 holds it.
    ALTER TABLE thoughts DISABLE TRIGGER thoughts_updated_at;

    UPDATE thoughts t
       SET metadata = (COALESCE(t.metadata, '{}'::jsonb) - 'actor_kind' - 'actor_name')
                      || CASE WHEN d.kind IS NOT NULL THEN jsonb_build_object('actor_kind', d.kind) ELSE '{}'::jsonb END
                      || CASE WHEN d.name IS NOT NULL THEN jsonb_build_object('actor_name', d.name) ELSE '{}'::jsonb END
      FROM (SELECT id, updated_at, kind, name FROM ob1_actor_backfill WHERE differs
            LIMIT COALESCE(p_limit, 2147483647)) d
     WHERE t.id = d.id
       -- Re-checked on the locked row: a thought edited since the scan has a
       -- newer writer, stamped by the trigger; it is left for the next pass.
       AND t.updated_at IS NOT DISTINCT FROM d.updated_at;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    ALTER TABLE thoughts ENABLE TRIGGER thoughts_updated_at;
    PERFORM set_config('ob1.actor', COALESCE(v_prev_actor, ''), true);
    PERFORM set_config('ob1.actor_amend', COALESCE(v_prev_amend, ''), true);
  END IF;

  DROP TABLE ob1_actor_backfill;
  RETURN jsonb_build_object('ok', true, 'rows', v_rows, 'differing', v_differ, 'awaiting', v_awaiting);
END;
$$;

COMMENT ON FUNCTION backfill_thought_actors(integer) IS
  'Sets metadata.actor_kind and metadata.actor_name on every thought to what thought_audit derives for the writer of its current content — the latest capture or content-changing update row: its actor_kind (046''s backfill) else ob1_registry_kind for its id or name now, and its actor_name — wherever the row and the log disagree, stripping a mark no audit row vouches for. Returns {ok, rows (written this call), differing (found disagreeing), awaiting (writer named but unclassified — set_agent_kind, then backfill_thought_audit_events, then this)}. p_limit (at least 1) bounds the rows written per call; each call its own transaction. Holds the updated_at trigger for the write (a stamp is not an edit), which needs the table''s owner; each row written leaves an audit row whose origin is backfill_thought_actors. Idempotent: a second pass finds nothing. Migration 047 / SMD-1726.';

-- Every thought already written takes its writer's mark now — or the batch
-- OB1_BACKFILL_LIMIT names, the rest by hand.
SELECT backfill_thought_actors({{BACKFILL_LIMIT}});
