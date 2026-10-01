-- =============================================================================
-- Migration 073: the content's trust on the row — metadata.trust, stamped
--                from the key and the write event beside the writer's mark,
--                never from the payload (SMD-1724)
-- =============================================================================
--
-- WHY
--   046 made trust a fact of every write: thought_audit.trust, the ceiling on
--   the content (operator > agent > ingested), the key's kind when undeclared,
--   a lower declaration kept, a higher one clamped and the attempt filed under
--   actor_context.claimed. Nothing carried it to the thought. A read could not
--   tell a page an integration copied in from a note the operator typed — both
--   came back alike, and a captured instruction retrieved later reads as one
--   (SMD-1724: memory-poisoning through one ordinary interaction succeeded in
--   over 90% of trials in the surveys it rests on). 050 put the writer on the
--   row as two metadata keys; the content's trust is the third, and goes the
--   same way.
--
-- WHAT
--   * metadata.trust — the DATABASE's key, as 050's actor_kind and actor_name
--     are: the trust of the write that put the standing text there, which is
--     thought_audit.trust on that write's row (ob1_trust_ceiling of the key's
--     registry kind and the event's declaration). Absent when the key is
--     unclassified and nothing lower was declared — 046's rule: an
--     unclassified key supports no claim above the floor.
--   * ob1_actor_stamp(jsonb, text) — 055's stamp with the write's declared
--     trust: the payload's own trust is removed with the two marks and the
--     ceiling written in its place. The 1-argument form is this one with no
--     declaration, for any caller left holding it.
--   * ob1_actor_stamp_kept — keeps trust with the two marks: the same text
--     keeps the trust it had, whatever the patch or the key re-capturing it
--     said (050's "the actor follows the content").
--   * ob1_declared_trust(event, metadata) — a payload's metadata.trust is a
--     declaration, not a value: folded into the write event when the event
--     declares none, so the one ladder decides it — a lower word stands, a
--     higher one is clamped to the key's kind AND filed under claimed by the
--     append (the count SMD-1724 asks for). The event's own trust wins when
--     both are given.
--   * upsert_thought (2- and 3-argument forms) and update_thought — 060's and
--     061's bodies with the fold and the 2-argument stamp; nothing else moves.
--     Since 060 the stamp must be in the body, before the diff: the projector
--     writes the row from the event and the audit trigger refuses a row that
--     is not the event's after-image (OB002), so a BEFORE trigger adding a key
--     there would refuse every projected write.
--   * ob1_stamp_actor() — the raw path (a direct INSERT or UPDATE, 050's
--     trigger): the declaration is the ob1.event handoff's trust, which the
--     audit trigger reads after it for the same row, so row and log agree.
--     A raw writer's metadata.trust is removed, not folded: the handoff is the
--     raw path's one declaration, and the audit trigger never sees the payload.
--   * backfill_thought_actors — 050's pass, deriving trust from the same
--     audit row it already derives the writer from (the row that wrote the
--     standing text): ob1_trust_ceiling of the registry's kind NOW and that
--     write's declaration, read back from the row (its claimed trust, else a
--     trust that differs from its kind). Called once below.
--
-- NOT HERE
--   * Reading it: the tools' label, the notice on ingested rows, min_trust and
--     the capture tool's declaration are SMD-1724's later PRs. 001's GIN on
--     metadata already serves {"trust": "..."} containment; min_trust's own
--     parameter and index come with its first read.
--   * Trust through an edit or a derivation. A text-changing edit takes the
--     editor's trust, as it takes the editor's mark (050); that a summary, a
--     merge or an edit should carry its weakest input's trust is SMD-1734's.
--   * A raw multi-row statement under one ob1.event: every row's stamp reads
--     the handoff, the audit trigger reads and clears it for the first row
--     only (046's handoff, unchanged). No writer in the tree sets it.
--
-- Idempotent: CREATE OR REPLACE throughout; the backfill writes nothing on a
-- second pass.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regprocedure('ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid)') IS NULL
     OR to_regclass('public.derivations') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 073 needs 061 (derivations, ob1_record_derivation); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_project_thought_event(uuid, vector, text, boolean)') IS NULL
     OR to_regprocedure('ob1_actor_stamp(jsonb)') IS NULL
     OR to_regprocedure('ob1_trust_ceiling(text, text)') IS NULL
     OR to_regprocedure('backfill_thought_actors(integer)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 073 needs 046, 050, 055 and 060 (ob1_trust_ceiling, backfill_thought_actors, ob1_actor_stamp, ob1_project_thought_event); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. The stamp with the write's declaration: the two marks and the trust.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_actor_stamp(p_meta jsonb, p_declared text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  actor   jsonb;
  v_raw   text;
  v_agent uuid;
  v_name  text;
  v_kind  text;
  v_trust text;
  v_meta  jsonb;
BEGIN
  /**
   * ob1:actor-on-the-row-from-the-key — a CONTRACT SENTINEL, not prose (the
   * 014 convention): the three keys are written from the envelope, the
   * registry and the write's declaration, never copied from the payload (050,
   * 073).
   *
   * 055's body, and one more key. The setting is read inline first — a raw
   * load with no actor pays one current_setting and nothing more — and
   * through 008's reader when set, so a malformed envelope is no actor rather
   * than a failed write. Then 010's id reading and 046's one lookup, only
   * when the envelope names an id or a name.
   */
  IF p_meta IS NOT NULL AND jsonb_typeof(p_meta) <> 'object' THEN
    RETURN p_meta;  -- a raw writer's array or scalar is not this rule's to fix
  END IF;
  v_raw := current_setting('ob1.actor', true);
  IF v_raw IS NOT NULL AND v_raw <> '' THEN
    actor := ob1_current_actor();
  END IF;
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
  -- 073: the append's own rule for the audit row's trust, from the same kind
  -- and the same declaration — so the row's key and its event's column agree.
  v_trust := ob1_trust_ceiling(v_kind, p_declared);
  v_meta := COALESCE(p_meta, '{}'::jsonb) - 'actor_kind' - 'actor_name' - 'trust';
  IF v_kind IS NOT NULL THEN
    v_meta := v_meta || jsonb_build_object('actor_kind', v_kind);
  END IF;
  IF v_name IS NOT NULL THEN
    v_meta := v_meta || jsonb_build_object('actor_name', v_name);
  END IF;
  IF v_trust IS NOT NULL THEN
    v_meta := v_meta || jsonb_build_object('trust', v_trust);
  END IF;
  -- A NULL metadata with nothing to add stays NULL: the stamp adds keys, it
  -- does not decide the column's emptiness for a raw writer (050).
  IF p_meta IS NULL AND v_meta = '{}'::jsonb THEN
    RETURN NULL;
  END IF;
  RETURN v_meta;
END;
$$;

COMMENT ON FUNCTION ob1_actor_stamp(jsonb, text) IS
  'A new text''s metadata with the writer''s mark and the content''s trust: metadata.actor_kind (ob1_agents.kind for the ob1.actor envelope''s agent_id, else its name — ob1_registry_kind), metadata.actor_name (the envelope''s name) and metadata.trust (ob1_trust_ceiling of that kind and p_declared, the write event''s trust — what the append writes to thought_audit.trust for the same write), never from the payload — the payload''s own values under the three keys are removed first. No envelope and no declaration, no mark; a non-object metadata passes untouched; a NULL with nothing to add stays NULL. The write functions call it on a new text; ob1_stamp_actor on a raw INSERT and a raw UPDATE that changes the text. Migration 055 / SMD-2115; trust 073 / SMD-1724.';

CREATE OR REPLACE FUNCTION ob1_actor_stamp(p_meta jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT ob1_actor_stamp(p_meta, NULL::text);
$$;

COMMENT ON FUNCTION ob1_actor_stamp(jsonb) IS
  'ob1_actor_stamp(p_meta, NULL): the stamp with no declaration — the trust is the key''s kind. 055''s signature, kept for a caller that holds it; the write functions and ob1_stamp_actor call the 2-argument form since 073. Migration 055 / SMD-2115; 073 / SMD-1724.';

CREATE OR REPLACE FUNCTION ob1_actor_stamp_kept(p_new jsonb, p_old jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_meta jsonb;
BEGIN
  -- 050's same-text arm: the actor follows the content, so the mark stays as
  -- it was whatever the patch said — a re-embed, a metadata touch, a raw
  -- `SET metadata = NULL` on a marked row all keep the writer of the text.
  -- 073: and the trust the text was written at — a key re-capturing the same
  -- text, or a patch naming trust, moves neither.
  IF p_new IS NOT NULL AND jsonb_typeof(p_new) <> 'object' THEN
    RETURN p_new;
  END IF;
  IF p_new->'actor_kind' IS NOT DISTINCT FROM p_old->'actor_kind'
     AND p_new->'actor_name' IS NOT DISTINCT FROM p_old->'actor_name'
     AND p_new->'trust' IS NOT DISTINCT FROM p_old->'trust' THEN
    RETURN p_new;  -- the common case: the same three keys in and out
  END IF;
  v_meta := COALESCE(p_new, '{}'::jsonb) - 'actor_kind' - 'actor_name' - 'trust';
  IF jsonb_typeof(p_old) = 'object' THEN
    IF p_old ? 'actor_kind' THEN
      v_meta := v_meta || jsonb_build_object('actor_kind', p_old->'actor_kind');
    END IF;
    IF p_old ? 'actor_name' THEN
      v_meta := v_meta || jsonb_build_object('actor_name', p_old->'actor_name');
    END IF;
    IF p_old ? 'trust' THEN
      v_meta := v_meta || jsonb_build_object('trust', p_old->'trust');
    END IF;
  END IF;
  RETURN v_meta;
END;
$$;

COMMENT ON FUNCTION ob1_actor_stamp_kept(jsonb, jsonb) IS
  'An unchanged text''s metadata with the writer''s mark and the content''s trust kept as they were (050''s same-text arm, callable): p_new''s actor_kind, actor_name and trust replaced by p_old''s, whatever the patch said — the actor and the trust follow the content. A non-object p_new passes untouched. The write functions and ob1_stamp_actor call it on a write that leaves the text. Migration 055 / SMD-2115; trust 073 / SMD-1724.';

-- ---------------------------------------------------------------------------
-- 2. A payload's metadata.trust is a declaration, folded into the event.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_declared_trust(p_event jsonb, p_meta jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  -- The event as validated (validate_write_event: an object or NULL), with
  -- the payload's metadata.trust as its trust when it declares none — the
  -- word as given, so a word off the ladder is filed under claimed as sent
  -- (ob1_trust_ceiling clamps anything it cannot place to the key's kind).
  -- A JSON null, or no key, declares nothing.
  SELECT CASE
    WHEN jsonb_typeof(p_meta) = 'object'
         AND p_meta->>'trust' IS NOT NULL
         AND NOT COALESCE(p_event ? 'trust', false)
    THEN COALESCE(p_event, '{}'::jsonb) || jsonb_build_object('trust', p_meta->>'trust')
    ELSE p_event
  END;
$$;

COMMENT ON FUNCTION ob1_declared_trust(jsonb, jsonb) IS
  'The write event with the payload''s metadata.trust folded in as its declared trust when the event declares none (the event''s own trust wins): a caller writing metadata.trust is declaring, not setting — the stamp writes ob1_trust_ceiling of the key''s kind and the declaration, and the append files a declaration above the kind under actor_context.claimed. A non-object metadata, an absent key or a JSON null declares nothing. upsert_thought and update_thought call it on the validated event. Migration 073 / SMD-1724.';

-- ---------------------------------------------------------------------------
-- 3. The raw path: 050's trigger, the declaration from the event handoff.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_stamp_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_same     boolean := false;
  v_raw      text;
  v_declared text;
BEGIN
  -- The backfill's own write (050): it has derived the keys from the log and
  -- sets them as given, under its setting. SMD-1997 step 2's projector runs
  -- under the same pass-through, the metadata already stamped in the event.
  IF current_setting('ob1.actor_amend', true) = 'backfill' THEN
    RETURN NEW;
  END IF;
  -- metadata is an object on every row the writers make (005); a raw
  -- writer's array or scalar is not this trigger's to fix (050).
  IF NEW.metadata IS NOT NULL AND jsonb_typeof(NEW.metadata) <> 'object' THEN
    RETURN NEW;
  END IF;

  -- The same text, by 003's rule or the same bytes (050): OLD's text is
  -- always hashed, because OLD's column cannot be trusted after a raw content
  -- UPDATE; NEW's column is trusted when it moved to a value (update_thought
  -- writes fp(text) there), else NEW's text is hashed too. Two IFs, not one
  -- OR — an SQL expression is not short-circuit, and the hashes are wanted
  -- only when the bytes differ.
  IF TG_OP = 'UPDATE' THEN
    v_same := NEW.content IS NOT DISTINCT FROM OLD.content;
    IF NOT v_same THEN
      v_same := content_fingerprint_of(OLD.content) IS NOT DISTINCT FROM
                CASE WHEN NEW.content_fingerprint IS NOT NULL
                      AND NEW.content_fingerprint IS DISTINCT FROM OLD.content_fingerprint
                     THEN NEW.content_fingerprint
                     ELSE content_fingerprint_of(NEW.content) END;
    END IF;
  END IF;
  IF v_same THEN
    NEW.metadata := ob1_actor_stamp_kept(NEW.metadata, OLD.metadata);
    RETURN NEW;
  END IF;
  -- 073: the declaration the audit trigger will read for this row — the
  -- ob1.event handoff, read here and NOT cleared (the audit trigger clears
  -- it, after this row is written). A value that does not begin as an object
  -- is no event (046's rule); one that begins as one and is malformed fails
  -- the write loudly here as it would there.
  v_raw := current_setting('ob1.event', true);
  IF v_raw IS NOT NULL AND v_raw ~ '^\s*\{' THEN
    v_declared := v_raw::jsonb->>'trust';
  END IF;
  -- An INSERT, or an UPDATE that changes the content: the writer is whoever
  -- set the envelope — ob1:actor-on-the-row-from-the-key, in ob1_actor_stamp.
  NEW.metadata := ob1_actor_stamp(NEW.metadata, v_declared);
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION ob1_stamp_actor() IS
  'BEFORE INSERT OR UPDATE on thoughts (thoughts_stamp_actor, 050): writes metadata.actor_kind (ob1_agents.kind for the envelope''s agent_id, else its name — ob1_registry_kind, 046), metadata.actor_name (the envelope''s name) and since 073 metadata.trust (ob1_trust_ceiling of that kind and the ob1.event handoff''s trust, the declaration the audit trigger reads for the same row) from the settings 008''s and 046''s writers set, never from the payload — a payload''s own values under the three keys are overwritten or removed. The actor and the trust follow the content: an INSERT and an UPDATE that changes the text (by 003''s normalised fingerprint, so 018''s unchanged edit is unchanged here too) stamp through ob1_actor_stamp(jsonb, text); an UPDATE that leaves the text keeps the three as they were through ob1_actor_stamp_kept. A non-object metadata (a raw writer''s) passes untouched. Under ob1.actor_amend = ''backfill'' the keys are taken as given (backfill_thought_actors, and 060''s projector, whose event the write function stamped). Migration 050 / SMD-1726; the arms lifted out by 055 / SMD-2115; trust 073 / SMD-1724.';

-- ---------------------------------------------------------------------------
-- 4. upsert_thought(text, jsonb) — 060's body; the fold and the stamp's
--    declaration are the two lines that move.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_thought(p_content text, p_payload jsonb DEFAULT '{}')
RETURNS jsonb AS $$
DECLARE
  v_fingerprint text;
  v_id          uuid;
  v_existed     boolean := false;
  v_event       jsonb;
  v_old_meta    jsonb;
  v_new_meta    jsonb;
  v_diff        jsonb;
  v_ev          uuid;
BEGIN
  -- 005's guard, carried forward verbatim.
  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_payload);
  END IF;

  -- 060: 005's guard for the payload's metadata too — an array, a string or
  -- a number there made the row's metadata that shape, after which every
  -- later event had no source and no mark (run-it, second review pass;
  -- 046's COALESCE accepted it). A JSON null stays, as 046 and the
  -- projector keep it.
  IF p_payload ? 'metadata' AND jsonb_typeof(p_payload->'metadata') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload.metadata must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_payload->'metadata');
  END IF;

  -- 008's actor, as the 3-argument form has read it since then (033): the
  -- append attributes the capture through the two-step fallback instead of
  -- recording NULL. Transaction-local.
  IF p_payload ? 'actor' THEN
    PERFORM set_config('ob1.actor', p_payload->>'actor', true);
  END IF;

  -- 046: the write event's shape, refused here as a bad payload is. 060: the
  -- event rides the append, and the setting a raw write later in this
  -- transaction would read is cleared here, as 046 cleared it before its
  -- write.
  v_event := validate_write_event(p_payload->'event');
  PERFORM set_config('ob1.event', '', true);
  -- ob1:write-stamps-trust — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `atomic capture` and `edit signature` read it.
  -- 073: a payload's metadata.trust is a declaration — folded into the event,
  -- so the stamp and the append weigh one word (ob1_declared_trust), and the
  -- new text is stamped with the event's trust (ob1_actor_stamp(jsonb, text)).
  v_event := ob1_declared_trust(v_event, p_payload->'metadata');

  v_fingerprint := content_fingerprint_of(p_content);

  -- ob1:capture-takes-fingerprint-lock — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `atomic capture` reads it. 033: the lock 018
  -- takes for an edit that would take this key, spelled the same, taken
  -- before the row read so a concurrent writer of this text has committed
  -- before the read runs (READ COMMITTED).
  PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));

  -- 060: the row read the 3-argument form has had since 035, under the same
  -- advisory lock — 046's form was a pure INSERT ... ON CONFLICT with no row
  -- lock. A named delta, unobservable to a caller: the advisory lock already
  -- serialises every writer of this text.
  SELECT id, metadata INTO v_id, v_old_meta
    FROM thoughts WHERE content_fingerprint = v_fingerprint FOR NO KEY UPDATE;

  -- ob1:capture-sets-write-event — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `atomic capture` reads it. 046: the declared
  -- event reaches the audit row — since 060 by the append itself, not by a
  -- setting the trigger reads.
  -- ob1:capture-appends-then-projects — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `atomic capture` reads it. 060: the event
  -- is appended first and the row projected from it.
  v_existed := FOUND;
  IF NOT v_existed THEN
    BEGIN
      v_id       := gen_random_uuid();
      v_new_meta := ob1_actor_stamp(COALESCE(p_payload->'metadata', '{}'::jsonb), v_event->>'trust');
      v_diff     := ob1_thought_diff('capture', NULL, p_content, NULL, v_new_meta, false, false,
                                     NULL, NULL, NULL, NULL, NULL, v_fingerprint);
      v_ev       := ob1_append_thought_event(v_id, 'capture', v_new_meta->>'source', v_diff, v_event);
      IF v_ev IS NULL THEN
        RAISE EXCEPTION 'upsert_thought: the append recorded no capture event for %', v_id;
      END IF;
      PERFORM ob1_project_thought_event(v_ev);
    EXCEPTION WHEN unique_violation THEN
      -- A writer that takes no fingerprint lock — a raw import, a backfill,
      -- a community schema — committed this text between the row read and
      -- the projection. 046's INSERT ... ON CONFLICT merged into it; the
      -- projector's INSERT meets the unique index. The event rolls back with
      -- this block; the row that landed is read under the lock still held
      -- and merged as a re-capture (run-it, first review pass). A raw row
      -- written on THIS connection inside the append — a trigger on the log
      -- — rolls back with the block, so nothing is found and the violation
      -- is re-raised as itself (run-it, second review pass).
      SELECT id, metadata INTO v_id, v_old_meta
        FROM thoughts WHERE content_fingerprint = v_fingerprint FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE;
      END IF;
      v_existed := true;
      v_ev := NULL;
    END;
  END IF;
  IF v_existed THEN
    -- A re-capture: the metadata merged as 046's ON CONFLICT merged it, the
    -- stamp kept (050: the mark follows the content, and the content is the
    -- same), 046's no-op gate — an update event only when the merge changed
    -- something or the envelope declared stance, cites or a window; a write
    -- that changes nothing writes nothing and moves no updated_at (060's
    -- named delta).
    v_new_meta := ob1_actor_stamp_kept(v_old_meta || COALESCE(p_payload->'metadata', '{}'::jsonb), v_old_meta);
    v_diff     := ob1_thought_diff('update', p_content, p_content, v_old_meta, v_new_meta, false, false,
                                   NULL, NULL, NULL, NULL, v_fingerprint, v_fingerprint);
    IF v_diff <> '{}'::jsonb OR COALESCE(v_event ?| ARRAY['stance', 'cites', 'valid_from', 'valid_until', 'trust', 'actor_kind'], false) THEN
      v_ev := ob1_append_thought_event(v_id, 'update', v_new_meta->>'source', v_diff, v_event);
      IF v_ev IS NOT NULL THEN  -- 046's late gate may drop an unchanged write carrying only a trust or an actor_kind
        PERFORM ob1_project_thought_event(v_ev);
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION upsert_thought(text, jsonb) IS
  'Capture without a vector: content + metadata, merged into the row holding the same normalised text. Reads p_payload.actor (008, here since 033) for the audit row. Takes the fingerprint advisory lock before the row read (033), the one update_thought takes, so a capture and an edit of one text are serialised (READ COMMITTED), and since 060 locks the row it lands on FOR NO KEY UPDATE as the 3-argument form does. Refuses a non-object payload (005). Reads no provenance from the envelope. Reads p_payload.event (046) — {stance, cites, valid_from, valid_until, trust, actor_kind} — validated by validate_write_event and carried by the append. Since 060 the event is appended first (ob1_append_thought_event) and the row projected from it (ob1_project_thought_event); a re-capture that changes nothing writes nothing and moves no updated_at. Called by PostgREST clients by name and the two-step capture fallback; the servers capture through the 3- and 4-argument forms. Since 073 a payload''s metadata.trust is a declaration folded into the event (ob1_declared_trust) and a new text''s metadata carries the trust the append records (ob1_actor_stamp(jsonb, text)); a re-capture keeps the row''s. Migration 003 / 005 / 033 / 035 / 046 / 060 (SMD-2116) / 073 (SMD-1724).';

-- ---------------------------------------------------------------------------
-- 5. upsert_thought(text, jsonb, vector) — 061's body; the same two lines.
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
  -- 022: whether a row was there to lock, and the model its vector — and so
  -- its windows — was labelled with before this write (NULL: unknown). 035:
  -- read for every capture, so `existed` in the return is always right.
  v_existed        boolean := false;
  v_old_label      text;
  -- 060: the rest of the row the after-image is computed from.
  v_old_meta       jsonb;
  v_old_has_vec    boolean;
  v_old_sup        uuid;
  v_old_derived    jsonb;
  -- 035: the row's pointer after the write — the fresh row's, or the one the
  -- existing row keeps — returned so a caller told `existed` can say what
  -- stands instead of guessing.
  v_supersedes_now uuid;
  -- 025: the provenance the envelope carries, if any — written on a fresh
  -- row only (035).
  v_derived        jsonb;
  v_supersedes     text  := p_payload->>'supersedes';
  v_event          jsonb;  -- 046
  v_new_meta       jsonb;
  v_diff           jsonb;
  v_ev             uuid;
  v_label          text := p_payload->>'embedding_model';  -- 021
  -- 061: the lineage envelope — {"metadata": recipe, "chunks": recipe} —
  -- what the caller's producers declare about the tags (and, for the
  -- 4-argument form, the windows) this write carries. Absent: no row.
  v_lineage        jsonb := p_payload->'lineage';
BEGIN
  /**
   * Migration 005's guard, carried forward verbatim.
   *
   * This is the trap in redefining a function from a later migration: CREATE OR
   * REPLACE takes the whole body, so every change made to it in between is
   * silently reverted. Anything that redefines upsert_thought again must carry
   * this, the actor, the event and the locks forward too.
   */
  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_payload);
  END IF;

  -- 025: derived_from is validated HERE — the write is the choke point, or an
  -- untrusted-input hole (SMD-1253). 033: through 032's validate_derived_from,
  -- the one copy of the rule. 035: validated before the write is known to be
  -- a dedup, so a bad reference is refused whether or not the text is new.
  v_derived := validate_derived_from(p_payload->'derived_from');

  -- 025: supersedes existence is the self-FK's job; check only its SHAPE here,
  -- so a bad string fails with a message about supersedes rather than a raw
  -- uuid cast error, and the FK reports a missing target.
  IF v_supersedes IS NOT NULL
     AND v_supersedes !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION
      'upsert_thought: supersedes must be a thought UUID string, got %.', v_supersedes;
  END IF;

  -- 060: 005's guard for the payload's metadata too (the 2-argument form
  -- says why); a JSON null stays.
  IF p_payload ? 'metadata' AND jsonb_typeof(p_payload->'metadata') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload.metadata must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_payload->'metadata');
  END IF;

  -- 061: 005's guard for the lineage envelope; a JSON null is no envelope.
  IF v_lineage IS NOT NULL AND jsonb_typeof(v_lineage) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload.lineage must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(v_lineage);
  END IF;
  -- …and each recipe it names is an object carrying a boolean deterministic,
  -- refused HERE by the key's name — not three frames down in the writer
  -- (run-it, first review pass: a scalar was ignored and an object without
  -- the key failed the capture naming ob1_record_derivation).
  IF v_lineage ? 'metadata' AND (jsonb_typeof(v_lineage->'metadata') <> 'object' OR COALESCE(jsonb_typeof(v_lineage->'metadata'->'deterministic'), '') <> 'boolean') THEN
    RAISE EXCEPTION 'upsert_thought: p_payload.lineage.metadata must be a JSON object carrying a boolean "deterministic", got %.', v_lineage->'metadata';
  END IF;
  IF v_lineage ? 'chunks' AND (jsonb_typeof(v_lineage->'chunks') <> 'object' OR COALESCE(jsonb_typeof(v_lineage->'chunks'->'deterministic'), '') <> 'boolean') THEN
    RAISE EXCEPTION 'upsert_thought: p_payload.lineage.chunks must be a JSON object carrying a boolean "deterministic", got %.', v_lineage->'chunks';
  END IF;

  -- Transaction-local, so it cannot outlive this call on a pooled connection.
  IF p_payload ? 'actor' THEN
    PERFORM set_config('ob1.actor', p_payload->>'actor', true);
  END IF;

  -- 046: the write event's shape, refused here as a bad derived_from is. 060:
  -- the event rides the append; the setting a raw write later in this
  -- transaction would read is cleared here, as 046 cleared it before its write.
  v_event := validate_write_event(p_payload->'event');
  PERFORM set_config('ob1.event', '', true);
  -- ob1:write-stamps-trust — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `atomic capture` and `edit signature` read it.
  -- 073: a payload's metadata.trust is a declaration — folded into the event,
  -- so the stamp and the append weigh one word (ob1_declared_trust), and the
  -- new text is stamped with the event's trust (ob1_actor_stamp(jsonb, text)).
  v_event := ob1_declared_trust(v_event, p_payload->'metadata');

  v_fingerprint := content_fingerprint_of(p_content);

  -- 035: no supersession lock here. 033 took it first when the envelope named
  -- supersedes, to order the ON CONFLICT fill of a NULL pointer against
  -- update_thought's cycle walk; the fill is gone, and the pointer a fresh
  -- row writes is one no concurrent walk can reach.

  -- ob1:capture-takes-fingerprint-lock — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `atomic capture` reads it. 033: the lock 018
  -- takes for an edit that would take this key, spelled the same. Taken
  -- BEFORE the row read, so a concurrent writer of this text — an edit
  -- taking the key, a first capture racing this one, an edit moving another
  -- row onto it — has committed before the read runs and the read finds its
  -- row (READ COMMITTED: a fresh snapshot per statement).
  PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));

  -- 022/035: the row this capture lands on, if any, locked — so the write
  -- below lands on THIS row, not on one a concurrent writer commits meanwhile
  -- — and its label before the write, which says whether its windows still
  -- hold. FOR NO KEY UPDATE: ordered against update_thought's row lock, not
  -- against the FOR KEY SHARE every foreign key onto this row holds. 060: the
  -- rest of the row too, for the after-image.
  SELECT id, embedding_model, metadata, embedding IS NOT NULL, supersedes, derived_from
    INTO v_id, v_old_label, v_old_meta, v_old_has_vec, v_old_sup, v_old_derived
    FROM thoughts WHERE content_fingerprint = v_fingerprint FOR NO KEY UPDATE;
  v_existed := FOUND;

  -- ob1:capture-sets-write-event — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `atomic capture` check reads it. 046: the
  -- declared event reaches the audit row — since 060 by the append itself.
  -- ob1:capture-appends-then-projects — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `atomic capture` reads it. 060: the event
  -- is appended first and the row projected from it, the caller's vector
  -- and label (021) riding the projection.
  IF NOT v_existed THEN
    BEGIN
      v_id       := gen_random_uuid();
      -- 050: a new text — the writer from the envelope. 025: derived_from and
      -- supersedes written on a fresh row, validated above.
      v_new_meta := ob1_actor_stamp(COALESCE(p_payload->'metadata', '{}'::jsonb), v_event->>'trust');
      v_diff     := ob1_thought_diff('capture', NULL, p_content, NULL, v_new_meta, false, p_embedding IS NOT NULL,
                                     NULL, v_supersedes::uuid, NULL, v_derived, NULL, v_fingerprint);
      v_ev       := ob1_append_thought_event(v_id, 'capture', v_new_meta->>'source', v_diff, v_event);
      IF v_ev IS NULL THEN
        RAISE EXCEPTION 'upsert_thought: the append recorded no capture event for %', v_id;
      END IF;
      PERFORM ob1_project_thought_event(v_ev, p_embedding, v_label);
      v_supersedes_now := v_supersedes::uuid;
    EXCEPTION WHEN unique_violation THEN
      -- A writer that takes no fingerprint lock — a raw import, a backfill,
      -- a community schema — committed this text between the row read and
      -- the projection. 046's INSERT ... ON CONFLICT merged into it; the
      -- projector's INSERT meets the unique index. The event rolls back with
      -- this block; the row that landed is read under the lock still held
      -- and merged as a re-capture below (run-it, first review pass).
      SELECT id, embedding_model, metadata, embedding IS NOT NULL, supersedes, derived_from
        INTO v_id, v_old_label, v_old_meta, v_old_has_vec, v_old_sup, v_old_derived
        FROM thoughts WHERE content_fingerprint = v_fingerprint FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE;
      END IF;
      v_existed := true;
      v_ev := NULL;
    END;
  END IF;
  IF v_existed THEN
    -- ob1:re-capture-writes-no-provenance — a CONTRACT SENTINEL, not prose
    -- (the 014 convention); preflight's `atomic capture` reads it. 035: the
    -- envelope's derived_from and supersedes are NOT written on an existing
    -- row — the diff below carries the old values on both sides, so the
    -- event names no move and the projector leaves them. Setting, changing
    -- or clearing provenance on an existing thought is update_thought's,
    -- through its p_provenance envelope (032).
    -- 050: the same text — the mark as it was. 046's gate: an update event
    -- only when the merge changed something, the vector's presence flipped
    -- or the envelope declared stance, cites or a window.
    v_new_meta := ob1_actor_stamp_kept(v_old_meta || COALESCE(p_payload->'metadata', '{}'::jsonb), v_old_meta);
    v_diff     := ob1_thought_diff('update', p_content, p_content, v_old_meta, v_new_meta,
                                   v_old_has_vec, v_old_has_vec OR p_embedding IS NOT NULL,
                                   v_old_sup, v_old_sup, v_old_derived, v_old_derived, v_fingerprint, v_fingerprint);
    IF v_diff <> '{}'::jsonb OR COALESCE(v_event ?| ARRAY['stance', 'cites', 'valid_from', 'valid_until', 'trust', 'actor_kind'], false) THEN
      v_ev := ob1_append_thought_event(v_id, 'update', v_new_meta->>'source', v_diff, v_event);
    END IF;
    IF v_ev IS NOT NULL THEN
      -- The vector rides the projection: kept when none arrives (021), the
      -- caller's when one does.
      PERFORM ob1_project_thought_event(v_ev, p_embedding, v_label);
    ELSIF p_embedding IS NOT NULL THEN
      -- No event to project, a vector to place: a projection refresh — no
      -- event, no updated_at (060's named delta).
      PERFORM ob1_refresh_thought_vector(v_id, p_embedding, v_label);
    END IF;
    v_supersedes_now := v_old_sup;
  END IF;

  -- ob1:vector-replaces-chunks — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `atomic capture` check reads it. 022: the windows
  -- stay while the label vouches for them — the row's vector was labelled
  -- with a model and the vector arriving is labelled with the same one — and
  -- go in every other case: a label unknown on either side, or another model.
  -- No vector arriving keeps vector, label and windows alike; a fresh insert
  -- runs no DELETE (v_existed). The 4-argument form delegates here and then
  -- writes the caller's windows; update_thought does the same for an edit.
  IF p_embedding IS NOT NULL AND v_existed
     AND (v_old_label = v_label) IS NOT TRUE THEN
    DELETE FROM thought_chunks WHERE thought_id = v_id;
    -- 061: the windows' lineage goes with the windows — no artifact, no row.
    DELETE FROM derivations WHERE artifact_kind = 'chunks' AND artifact_id = v_id;
  END IF;

  -- ob1:derivation-recorded-with-its-artifact — a CONTRACT SENTINEL, not prose
  -- (the 014 convention); preflight's `atomic capture` reads it. 061: the
  -- tags' lineage row commits with the tags (SMD-1731) — on a fresh row, or
  -- on a re-capture whose event moved the metadata; a re-capture that wrote
  -- nothing, or refreshed the vector alone, records nothing and moves no
  -- produced_at. The vector's own row is thoughts_record_vector_lineage's.
  IF v_lineage ? 'metadata' AND jsonb_typeof(v_lineage->'metadata') = 'object'
     AND (NOT v_existed OR v_diff ? 'metadata') THEN
    PERFORM ob1_record_derivation('metadata', v_id, ARRAY[v_id], ARRAY[v_fingerprint], 'metadata',
                                  v_lineage->'metadata', ob1_actor_agent_id());
  END IF;

  -- 035: `existed` — the text was already captured; metadata merged, vector
  -- and windows by 021/022, provenance in the envelope not written — and
  -- `supersedes`, the row's pointer as it stands after this write.
  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint, 'existed', v_existed, 'supersedes', v_supersedes_now);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector) IS
  'Atomic capture: content + metadata + embedding in one call. Reads p_payload.actor (008), p_payload.embedding_model (021), p_payload.derived_from / p_payload.supersedes (025), p_payload.event (046: {stance, cites, valid_from, valid_until, trust, actor_kind}, validated by validate_write_event and carried by the append) and p_payload.lineage (061: {metadata: recipe} — the tags'' derivation, recorded in `derivations` with the write; absent, no row) from the envelope. derived_from is validated by validate_derived_from — an array of existing thought UUIDs, or the write is refused (SMD-1253); supersedes'' existence is the self-FK''s, checked where the column is written — a first capture (035). Takes the fingerprint advisory lock before the row read (033), the one update_thought takes, so a capture and an edit of one text are serialised (READ COMMITTED); no supersession lock (035). Since 060 the event is appended first (ob1_append_thought_event) and the row projected from it (ob1_project_thought_event) with the caller''s vector: a fresh text is a capture event; a re-capture is an update event only when the metadata merge, the vector''s presence or a declared event gives it one, a vector onto a row that has one is a refresh with no event and no updated_at, and a re-capture that changes nothing writes nothing. On a re-capture the label follows the vector, the chunk rows stay only while the label vouches for them (022) — and their lineage row with them (061) — and the envelope''s provenance is NOT written (035) — setting, changing or clearing it is update_thought''s p_provenance (032). Returns {id, fingerprint, existed, supersedes}. Since 073 a payload''s metadata.trust is a declaration folded into the event (ob1_declared_trust) and a new text''s metadata carries the trust the append records (ob1_actor_stamp(jsonb, text)); a re-capture keeps the row''s. Migration 004 / 021 / 022 / 025 / 033 / 035 / 046 / 060 / 061 (SMD-1731) / 073 (SMD-1724).';

-- ---------------------------------------------------------------------------
-- 6. update_thought — 061's body; the fold and the new text's stamp.
-- ---------------------------------------------------------------------------
-- 061's mechanism, carried (032/046/060's): on a schema an older file left
-- with an earlier form (a re-apply of 046 or 060), that form's ACL is
-- captured, the form dropped and the ACL replayed onto this one below; on
-- 061's form, CREATE OR REPLACE keeps its ACL and nothing is captured.
SELECT set_config('ob1.acl_update_thought',
                  CASE WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb, jsonb)') IS NOT NULL THEN ''
                       WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb)') IS NOT NULL THEN
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb)')), '')
                       WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb)') IS NOT NULL THEN
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb)')), '')
                       WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)') IS NOT NULL THEN
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)')), '')
                       ELSE
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb)')), '') END,
                  false);

DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb);
DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb);
DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text);
DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb);

CREATE OR REPLACE FUNCTION update_thought(
  p_id                 uuid,
  p_content            text        DEFAULT NULL,
  p_metadata_patch     jsonb       DEFAULT NULL,
  p_embedding          vector({{EMBEDDING_DIM}}) DEFAULT NULL,
  p_chunks             jsonb       DEFAULT NULL,
  p_if_unchanged_since timestamptz DEFAULT NULL,
  p_actor              jsonb       DEFAULT NULL,
  -- 021: the model that produced p_embedding, as OB1_EMBEDDING_MODEL names it.
  p_embedding_model    text        DEFAULT NULL,
  -- 032: the provenance envelope — {"supersedes": uuid|null, "derived_from":
  -- [uuid…]|null}. An absent key leaves the column, a JSON null clears it, a
  -- value sets it.
  p_provenance         jsonb       DEFAULT NULL,
  -- 046: the write event — {"stance": stated|retrieved|inferred, "cites":
  -- [uuid…], "valid_from", "valid_until", "trust", "actor_kind"} — validated by
  -- validate_write_event and carried by the append; trust and actor_kind are
  -- claims the append checks against the key, never copies.
  p_event              jsonb       DEFAULT NULL,
  -- 061: the lineage envelope — {"chunks": recipe, "metadata": recipe} — what
  -- the caller's producers declare about the windows and the tags this edit
  -- carries (SMD-1731). Absent: the windows' row from the label alone, no
  -- row for the tags.
  p_lineage            jsonb       DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing     thoughts%ROWTYPE;
  v_fingerprint  text;
  v_unchanged    boolean;
  -- The row holding v_fingerprint in the unique index, if any, and whether its
  -- text still hashes to it (a raw update around this function can leave a
  -- stale key): the twin, or the stale holder, reported as such below.
  v_other        uuid;
  v_other_same   boolean;
  v_updated      timestamptz;
  -- 032: whether the envelope names each key, and the value to write when it
  -- does (NULL clears). Two flags rather than two nullable values, because
  -- "clear" and "leave alone" are both NULL.
  v_set_supersedes boolean := COALESCE(p_provenance ? 'supersedes', false);
  v_set_derived    boolean := COALESCE(p_provenance ? 'derived_from', false);
  v_supersedes     uuid;
  v_derived        jsonb;
  v_walk           uuid;
  v_steps          int := 0;
  v_event          jsonb;  -- 046
  -- 060: the after-image, as 046's UPDATE would have left the row.
  v_new_content    text;
  v_new_fp         text;
  v_new_meta       jsonb;
  v_new_sup        uuid;
  v_new_derived    jsonb;
  v_new_has_vec    boolean;
  v_same_text      boolean;
  v_diff           jsonb;
  v_ev             uuid;
  -- 060: a window's vector, assigned through the column's type — the text of
  -- the JSON fed to the type's input function — rather than cast to `vector`
  -- by name, which a session with pgvector off its search_path cannot
  -- resolve inside a body (cold read, second review pass; 046's cast).
  elem             jsonb;
  v_chunk_i        integer := 0;
  v_chunk_vec      thought_chunks.embedding%TYPE;
BEGIN
  -- 032: the envelope's shape, before any lock is taken — 005's guard, for
  -- this parameter: a client that binds a JS string to a jsonb parameter
  -- double-encodes it. Then each key's value: supersedes a UUID string or
  -- null (shape here, existence under the row lock below), derived_from
  -- through the one rule.
  IF p_provenance IS NOT NULL AND jsonb_typeof(p_provenance) <> 'object' THEN
    RAISE EXCEPTION
      'update_thought: p_provenance must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_provenance);
  END IF;
  -- 060: the same guard for the patch — `{} || 'null'` and `{} || '[…]'`
  -- make an ARRAY of the row's metadata, after which every later event has
  -- no source and no mark (run-it, first review pass; 046 accepted it).
  IF p_metadata_patch IS NOT NULL AND jsonb_typeof(p_metadata_patch) <> 'object' THEN
    RAISE EXCEPTION
      'update_thought: p_metadata_patch must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_metadata_patch);
  END IF;
  -- 061: the same guard for the lineage envelope, and for each recipe it
  -- names — an object carrying a boolean deterministic, refused by the
  -- key's name (run-it, first review pass).
  -- A JSON null is no envelope, as p_payload.lineage's is (run-it, second
  -- review pass: the two forms disagreed).
  IF p_lineage IS NOT NULL AND jsonb_typeof(p_lineage) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION
      'update_thought: p_lineage must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_lineage);
  END IF;
  IF p_lineage ? 'metadata' AND (jsonb_typeof(p_lineage->'metadata') <> 'object' OR COALESCE(jsonb_typeof(p_lineage->'metadata'->'deterministic'), '') <> 'boolean') THEN
    RAISE EXCEPTION 'update_thought: p_lineage.metadata must be a JSON object carrying a boolean "deterministic", got %.', p_lineage->'metadata';
  END IF;
  IF p_lineage ? 'chunks' AND (jsonb_typeof(p_lineage->'chunks') <> 'object' OR COALESCE(jsonb_typeof(p_lineage->'chunks'->'deterministic'), '') <> 'boolean') THEN
    RAISE EXCEPTION 'update_thought: p_lineage.chunks must be a JSON object carrying a boolean "deterministic", got %.', p_lineage->'chunks';
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

  -- 008: transaction-local, so it cannot outlive this call on a pooled
  -- connection; set before the write so the append reads it.
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;
  -- 046: the event's shape, refused here before any lock. 060: the event
  -- rides the append, which runs after every refusal this function can
  -- return (NOT_FOUND, STALE_READ, DUPLICATE_CONTENT, SUPERSEDES_NOT_FOUND,
  -- WOULD_CYCLE) — so a refused call leaves no event, in the log or on the
  -- transaction; the setting a raw write later would read is cleared here.
  -- The ACTOR set above stays, as 008 scoped it.
  v_event := validate_write_event(p_event);
  PERFORM set_config('ob1.event', '', true);
  -- ob1:write-stamps-trust — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `edit signature` reads it. 073: the patch's
  -- metadata.trust is a declaration — folded into the event, so the stamp and
  -- the append weigh one word (ob1_declared_trust), and a new text is stamped
  -- with the event's trust (ob1_actor_stamp(jsonb, text)).
  v_event := ob1_declared_trust(v_event, p_metadata_patch);

  -- ob1:supersession-review (032/036): a supersedes write is serialised with
  -- every other on 029's lock, taken BEFORE the row lock — see "Lock order"
  -- in 033's header — so the walk below reads committed pointers.
  -- Re-entrant: review_supersession_proposal holds it already when it calls
  -- here.
  IF v_supersedes IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));
  END IF;

  -- 033: the fingerprint lock BEFORE the row, whenever content arrives — the
  -- order every capture takes, so no writer holds a row while waiting on a
  -- fingerprint lock another writer holds while waiting on a row. 003's
  -- rule, through 016's function: a fingerprint computed differently here
  -- would silently stop matching the ones capture writes.
  IF p_content IS NOT NULL THEN
    v_fingerprint := content_fingerprint_of(p_content);
    PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));
  END IF;

  -- The row lock: what "unchanged" is decided against below is the row as it
  -- is NOW, and stays so until this transaction ends. FOR NO KEY UPDATE, not
  -- 018's FOR UPDATE (032): the supersedes write takes FOR KEY SHARE on the
  -- target row, which FOR UPDATE on that row — another edit of it, waiting
  -- on a fingerprint lock this one holds — would deadlock with. Two edits of
  -- one row still serialise, and delete_thought still waits.
  SELECT * INTO v_existing FROM thoughts WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;

  -- 009: a stale read is told apart from a missing row before the write, so
  -- the caller gets the reason rather than a bare "0 rows". Truncated on both
  -- sides to milliseconds — JavaScript's Date carries no more, and a caller
  -- passing back exactly what it read must pass this. 060: this is THE
  -- guard. 046's second copy in the UPDATE's own WHERE is gone with the
  -- UPDATE: under READ COMMITTED with the row locked FOR NO KEY UPDATE
  -- above, the row this read saw is the row the projector writes.
  IF p_if_unchanged_since IS NOT NULL
     AND date_trunc('milliseconds', COALESCE(v_existing.updated_at, v_existing.created_at))
         > date_trunc('milliseconds', p_if_unchanged_since) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'STALE_READ',
      'current_updated_at', COALESCE(v_existing.updated_at, v_existing.created_at));
  END IF;

  -- 032: the target exists, and pointing at it closes no loop. The first read
  -- answers both: NOT FOUND is the ghost; its pointer starts the walk. 029's
  -- walk, moved here so a hand edit and an acceptance are refused alike;
  -- bounded, so a chain longer than the bound is refused rather than walked
  -- for ever. A thought cannot supersede itself.
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

  IF p_content IS NOT NULL THEN
    IF v_existing.content_fingerprint = v_fingerprint THEN
      -- The row already owns this key, and it is locked: the unique index
      -- says no other row can hold it, so there is nothing to look up. The
      -- common case — every fingerprinted row a re-embed pass visits, every
      -- same-text re-save through the tool.
      v_unchanged := true;
    ELSE
      v_unchanged := v_fingerprint = content_fingerprint_of(v_existing.content);

      -- ob1:unchanged-edit-not-duplicate — a CONTRACT SENTINEL, not prose (the
      -- 014 convention). The one definition of "another row holding this key":
      -- the refusal below and the duplicate_of report both read it. Under the
      -- fingerprint lock taken above, so it sees the other writer's committed
      -- row rather than racing it to the unique index — see "The rule", 2, in
      -- 018's header. The holder's text is hashed again, because a stale key
      -- — a raw update of content around this function — is not the same
      -- text, and must not be reported as a twin.
      SELECT id, content_fingerprint_of(content) = v_fingerprint
        INTO v_other, v_other_same
      FROM thoughts
      WHERE content_fingerprint = v_fingerprint AND id <> p_id
      LIMIT 1;

      IF v_other IS NOT NULL THEN
        -- Editing a thought INTO a key another row holds. The partial unique
        -- index would reject this anyway, but as a constraint violation that
        -- surfaces at the tool boundary as an opaque 23505. An edit whose text
        -- normalises to what the row already holds creates no duplicate that
        -- was not already there, so it is not refused; what was found is
        -- reported instead — the twin, or the row whose stale key blocks the
        -- fingerprint this row should have had.
        IF NOT v_unchanged THEN
          RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE_CONTENT');
        END IF;
      END IF;
    END IF;
  END IF;

  -- ob1:capture-appends-then-projects — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `edit signature` reads it. 060: the
  -- after-image, as 046's UPDATE would have left the row, computed here;
  -- the diff from it; the event appended; the row projected from the event.
  v_new_content := COALESCE(p_content, v_existing.content);
  -- v_other is set only when content arrived: another row holds this key, so
  -- this row must not claim it — NULL, whatever a raw update around this
  -- function may have left here (018).
  v_new_fp      := CASE WHEN p_content IS NULL   THEN v_existing.content_fingerprint
                        WHEN v_other IS NOT NULL THEN NULL
                        ELSE v_fingerprint END;
  -- 050: the actor follows the content — the same text (the same bytes, or
  -- 003's normalised fingerprint) keeps the mark, a new text takes the
  -- envelope's; the two arms 055 lifted out of ob1_stamp_actor.
  v_same_text   := p_content IS NULL OR p_content IS NOT DISTINCT FROM v_existing.content
                   OR content_fingerprint_of(v_existing.content) IS NOT DISTINCT FROM v_fingerprint;
  v_new_meta    := CASE WHEN p_metadata_patch IS NOT NULL THEN v_existing.metadata || p_metadata_patch ELSE v_existing.metadata END;
  v_new_meta    := CASE WHEN v_same_text THEN ob1_actor_stamp_kept(v_new_meta, v_existing.metadata) ELSE ob1_actor_stamp(v_new_meta, v_event->>'trust') END;
  -- 032: each provenance column moves only when the envelope names its key
  -- — to the value given, NULL included.
  v_new_sup     := CASE WHEN v_set_supersedes THEN v_supersedes ELSE v_existing.supersedes END;
  v_new_derived := CASE WHEN v_set_derived THEN v_derived ELSE v_existing.derived_from END;
  -- Only when content arrived does the vector move (021): a metadata-only
  -- edit must not blank the vector and quietly remove the row from every
  -- semantic search.
  v_new_has_vec := CASE WHEN p_content IS NOT NULL THEN p_embedding IS NOT NULL ELSE v_existing.embedding IS NOT NULL END;
  v_diff := ob1_thought_diff('update',
    v_existing.content, v_new_content,
    v_existing.metadata, v_new_meta,
    v_existing.embedding IS NOT NULL, v_new_has_vec,
    v_existing.supersedes, v_new_sup,
    v_existing.derived_from, v_new_derived,
    v_existing.content_fingerprint, v_new_fp);

  -- 046's gate, as the trigger applied it: an edit that changes nothing and
  -- declares nothing is not an event.
  IF v_diff <> '{}'::jsonb OR COALESCE(v_event ?| ARRAY['stance', 'cites', 'valid_from', 'valid_until', 'trust', 'actor_kind'], false) THEN
    v_ev := ob1_append_thought_event(p_id, 'update', v_new_meta->>'source', v_diff, v_event);
  END IF;
  IF v_ev IS NOT NULL THEN
    -- The label follows the vector (021): the caller's with a vector, NULL
    -- with content and no vector, untouched without content — the projector
    -- writes it so from the event and these two.
    PERFORM ob1_project_thought_event(v_ev, CASE WHEN p_content IS NOT NULL THEN p_embedding END, p_embedding_model);
    SELECT updated_at INTO v_updated FROM thoughts WHERE id = p_id;
  ELSIF p_content IS NOT NULL AND p_embedding IS NOT NULL THEN
    -- The same text with a new vector (the re-embed's shape): a projection
    -- refresh — no event, no updated_at (060's named delta).
    PERFORM ob1_refresh_thought_vector(p_id, p_embedding, p_embedding_model);
    v_updated := COALESCE(v_existing.updated_at, v_existing.created_at);
  ELSE
    -- Nothing changed: no event, no write, no updated_at (060's named delta;
    -- 046 bumped the stamp and recorded no audit row).
    v_updated := COALESCE(v_existing.updated_at, v_existing.created_at);
  END IF;

  -- Chunks describe the content, so they follow it: replaced wholesale, as
  -- migration 007's capture path does, carrying 013's context.
  IF p_content IS NOT NULL THEN
    DELETE FROM thought_chunks WHERE thought_id = p_id;
    -- 061: the set is replaced wholesale, so its lineage row goes with it.
    DELETE FROM derivations WHERE artifact_kind = 'chunks' AND artifact_id = p_id;
    IF p_chunks IS NOT NULL AND jsonb_array_length(p_chunks) > 0 THEN
      FOR elem IN SELECT x.e FROM jsonb_array_elements(p_chunks) AS x(e) LOOP
        v_chunk_vec := elem->>'embedding';
        INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding, context)
        VALUES (p_id, v_chunk_i, elem->>'content', v_chunk_vec, elem->>'context');
        v_chunk_i := v_chunk_i + 1;
      END LOOP;
    END IF;
    -- ob1:derivation-recorded-with-its-artifact — a CONTRACT SENTINEL, not prose
    -- (the 014 convention); preflight's `edit signature` reads it. 061: the
    -- windows' lineage row commits with the windows (SMD-1731) — the caller's
    -- recipe from p_lineage.chunks, the label alone when none is declared;
    -- no windows, no row. The row's key as this edit leaves it (018's NULL
    -- under a twin hashed again, so the row always names a fingerprint).
    IF v_chunk_i > 0 THEN
      PERFORM ob1_record_derivation('chunks', p_id, ARRAY[p_id], ARRAY[COALESCE(v_new_fp, v_fingerprint)], 'edit',
        COALESCE(CASE WHEN jsonb_typeof(p_lineage->'chunks') = 'object' THEN p_lineage->'chunks' END,
                 jsonb_build_object('deterministic', true, 'declared', false)
                   || jsonb_strip_nulls(jsonb_build_object('model', p_embedding_model)))
          || jsonb_build_object('count', v_chunk_i),
        ob1_actor_agent_id());
    END IF;
  END IF;
  -- 061: the tags' lineage row, when the caller's extractor wrote the patch
  -- and the event moved the metadata — or the TEXT moved under the
  -- extractor's recipe: the tags were computed again from the new text and
  -- came out the same, so the caller sent no patch, and the row moves to
  -- the text they were computed from (a false stale otherwise; cold read,
  -- third review pass). A patch that changed nothing on standing text, or
  -- one no extractor produced, records nothing (SMD-1731).
  IF p_lineage ? 'metadata' AND jsonb_typeof(p_lineage->'metadata') = 'object' AND (v_diff ? 'metadata' OR NOT v_same_text) THEN
    PERFORM ob1_record_derivation('metadata', p_id, ARRAY[p_id],
                                  ARRAY[COALESCE(v_new_fp, v_fingerprint, content_fingerprint_of(v_new_content))], 'metadata',
                                  p_lineage->'metadata', ob1_actor_agent_id());
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', p_id, 'updated_at', v_updated)
         || CASE WHEN v_other IS NULL   THEN '{}'::jsonb
                 WHEN v_other_same       THEN jsonb_build_object('duplicate_of', v_other)
                 ELSE jsonb_build_object('fingerprint_held_by', v_other) END;
END;
$$;

DO $acl$
DECLARE
  v_acl  text := current_setting('ob1.acl_update_thought', true);
  v_item record;
BEGIN
  IF v_acl IS NULL OR v_acl = '' THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb, jsonb) FROM PUBLIC';
  FOR v_item IN
    SELECT DISTINCT a.grantee FROM pg_proc p, aclexplode(p.proacl) AS a
    WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb, jsonb)') AND a.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb, jsonb) FROM %s', quote_ident(pg_get_userbyid(v_item.grantee)));
  END LOOP;
  FOR v_item IN SELECT grantee, privilege_type, is_grantable FROM aclexplode(v_acl::aclitem[]) LOOP
    IF v_item.privilege_type = 'EXECUTE' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb, jsonb) TO %s%s',
                     CASE WHEN v_item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_item.grantee)) END,
                     CASE WHEN v_item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END IF;
  END LOOP;
END
$acl$;

COMMENT ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb, jsonb) IS
  'Edit a thought by id. Recomputes content_fingerprint and replaces chunks — with their context — when content changes; an edit whose text normalises to what the row holds is never DUPLICATE_CONTENT, and reports duplicate_of when another row holds that text (a pair from before migration 003), or fingerprint_held_by when a row holds the key under other text, leaving this row''s fingerprint NULL. Every edit with content takes the fingerprint advisory lock (READ COMMITTED) — the one every capture through upsert_thought takes since 033 — and then locks the row FOR NO KEY UPDATE (032); both locks are held until the caller''s transaction ends, refusals included. Checks if_unchanged_since against the locked row before the write — since 060 the one check, the row it read being the row it writes. Since 060 the edit is an event first: the after-image is computed in the body (050''s stamp arms, 046''s diff rule), appended (ob1_append_thought_event) and projected (ob1_project_thought_event); a same-text edit carrying a vector is a refresh with no event and no updated_at (ob1_refresh_thought_vector); an edit that changes nothing writes nothing. p_embedding_model (021) is written beside the vector — the label follows the vector: untouched without content, NULL with content and no vector. p_provenance (032) is the envelope {"supersedes": uuid|null, "derived_from": [uuid…]|null}: an absent key leaves the column, a JSON null clears it, a value sets it — derived_from validated by validate_derived_from, supersedes an existing thought that closes no loop, the write serialised with review_supersession_proposal''s. p_event (046) is the write event {"stance", "cites", "valid_from", "valid_until", "trust", "actor_kind"}: validated by validate_write_event (a bad shape is refused) and carried by the append, which stamps stance, cites and the window on the row and checks trust and actor_kind against the key rather than copying them. p_lineage (061) is the lineage envelope {"chunks": recipe, "metadata": recipe}: with content, the windows written are recorded in `derivations` (artifact_kind chunks) under the caller''s recipe, or the label alone when none is declared — no windows, no row; the tags are recorded (artifact_kind metadata) when the envelope names their recipe and the event moved the metadata. Returns {ok:true, id, updated_at} — the row''s stamp after the call, unmoved by a refresh or a no-op — or {ok:false, error} for NOT_FOUND | STALE_READ | DUPLICATE_CONTENT | SUPERSEDES_NOT_FOUND | WOULD_CYCLE. Since 073 the patch''s metadata.trust is a declaration folded into the event (ob1_declared_trust), a new text takes the trust the append records (ob1_actor_stamp(jsonb, text)) and an unchanged one keeps the row''s. Migration 009 / 013 / 018 / 021 / 032 / 033 / 046 / 060 / 061 (SMD-1731) / 073 (SMD-1724).';

-- ---------------------------------------------------------------------------
-- 7. The column's contract, and the backfill: the log says who wrote the
--    content and at what trust; the row is made to agree. 050's pass with the
--    third key — the same writing row, the same scan, the same lock.
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN thoughts.metadata IS
  'The thought''s metadata: the caller''s keys and the extractor''s (source, type, topics, people, action_items). Three keys are the DATABASE''s and a write cannot set them: actor_kind (operator | agent | ingested — who holds the key that wrote the current content, from ob1_agents.kind, 046) and actor_name (that key''s name), since 050; and trust (operator > agent > ingested — the ceiling on the current content: the thought_audit.trust of the write that put it there, the key''s kind unless that write declared lower, never higher), since 073. A payload''s metadata.trust is read as the write''s declaration (ob1_declared_trust), not stored. Absent when the key is unclassified (trust: unless the write declared ingested) or the write came from outside the server. Reads filter on actor_kind and actor_name through 014''s metadata route (`said_by`, `actor` on the search and list tools) and print them as `By: name (kind)`. Migration 050 / SMD-1726; trust 073 / SMD-1724.';

CREATE OR REPLACE FUNCTION backfill_thought_actors(p_limit integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET lock_timeout = '10s'
AS $$
DECLARE
  v_prev_actor text := current_setting('ob1.actor', true);
  v_prev_amend text := current_setting('ob1.actor_amend', true);
  -- 023's shape: a temp table named per call and dropped at commit, so two
  -- calls in one transaction never meet each other's, and nothing is dropped
  -- by hand (CLAUDE.md's rail; the first draft dropped a fixed name, which
  -- resolved to a permanent table of that name when no temp one existed —
  -- first review pass, reproduced).
  v_tbl      text := format('ob1_actor_backfill_%s',
                            to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'));
  v_rows     integer := 0;
  v_differ   integer;
  v_awaiting integer;
BEGIN
  IF p_limit IS NOT NULL AND p_limit < 1 THEN
    RAISE EXCEPTION 'backfill_thought_actors: p_limit must be at least 1, or NULL for every row (got %)',
      p_limit;
  END IF;

  /**
   * Every thought's writer, from the log: the update row whose after-text is
   * the row's text, else the capture when no update ever changed the text —
   * the newest by created_at then seq among candidates — read through 008's
   * thought_id index; nobody when update rows exist but none wrote the text
   * that stands (a capture-only thought rewritten unaudited cannot be told
   * apart, and its capturer stands). Its kind is what the registry says
   * NOW for its id or name — the trigger's rule applied late, and a
   * reclassification carried to the rows — else the kind 046 stamped on the
   * row (a key since removed from the registry). A thought with no such row
   * (loaded with the audit trigger off, or its log pruned by a migration)
   * derives to nothing, and a mark it carries is stripped: nobody vouches
   * for it. A metadata that is not an object has no mark to read or write.
   *
   * 073: its trust is the append's rule on that same row — ob1_trust_ceiling
   * of that kind and the write's declaration, read back from the row: the
   * claim filed under actor_context.claimed when the key could not support
   * it (046's own backfill reads it so), else a trust that differs from the
   * kind the row was written under (a lowering, or an unclassified key's
   * declared ingested), else none — the kind. Live, the stamp and the append
   * compute the same word from the same two inputs, so a pass after live
   * writes finds nothing to change unless the registry moved.
   *
   * `differs` is where the row and the log disagree — the rows this pass
   * writes; `awaiting` is where the log names a key nobody has classified —
   * the rows the next pass fills once set_agent_kind has. updated_at rides
   * along so the write below can tell a row edited meanwhile (018's guard).
   */
  EXECUTE format($scan$
    CREATE TEMP TABLE %I ON COMMIT DROP AS
    SELECT d.id, d.updated_at, d.kind, d.name, ob1_trust_ceiling(d.kind, d.declared) AS trust,
           -- Differs when the value differs, or when the key is present with
           -- a value that reads as NULL (a JSON null a caller planted — `->>`
           -- says NULL for it as for an absent key; run-it, first review pass).
           (d.kind IS DISTINCT FROM d.present_kind OR (d.kind IS NULL AND d.has_kind)
            OR d.name IS DISTINCT FROM d.present_name OR (d.name IS NULL AND d.has_name)
            OR ob1_trust_ceiling(d.kind, d.declared) IS DISTINCT FROM d.present_trust
            OR (ob1_trust_ceiling(d.kind, d.declared) IS NULL AND d.has_trust)) AS differs,
           (d.kind IS NULL AND (d.w_name IS NOT NULL OR d.w_agent IS NOT NULL)) AS awaiting
    FROM (
      SELECT t.id, t.updated_at,
             -- (w is the LATERAL below; f.fp is the thought's own text hashed
             -- once per thought — the OFFSET 0 fences the subquery, or the
             -- planner pulls the hash up into w's sort key and runs it once
             -- per update row (third review pass, counted: 5 edits, 5 hashes
             -- of the same text) — NOT the content_fingerprint column: a raw
             -- content UPDATE leaves that column stale, and the stale hash
             -- anchored the previous writer's edit — second review pass.)
             -- A writer stands only for text the log vouches for: an update
             -- row whose after-text is the row's, or the capture when no
             -- update ever changed the text (a capture row carries no text to
             -- check). Update rows present and none matching means the text
             -- that stands was written unaudited — nobody's, as a no-row
             -- thought is (third review pass).
             CASE WHEN w.vouched
                  THEN COALESCE(ob1_registry_kind(w.canonical_agent_id, w.name), w.actor_kind) END AS kind,
             CASE WHEN w.vouched THEN w.name END               AS name,
             CASE WHEN w.vouched THEN w.declared END           AS declared,
             CASE WHEN w.vouched THEN w.name END               AS w_name,
             CASE WHEN w.vouched THEN w.canonical_agent_id END AS w_agent,
             t.metadata->>'actor_kind' AS present_kind,
             t.metadata->>'actor_name' AS present_name,
             t.metadata->>'trust'      AS present_trust,
             COALESCE(t.metadata ? 'actor_kind', false) AS has_kind,
             COALESCE(t.metadata ? 'actor_name', false) AS has_name,
             COALESCE(t.metadata ? 'trust', false)      AS has_trust
      FROM thoughts t
      CROSS JOIN LATERAL (
        -- Read only against update rows, so hashed only when one carries text
        -- (fourth review pass: a quarter of the hashes went to capture-only
        -- thoughts and were never compared). OFFSET 0 as above.
        SELECT CASE WHEN EXISTS (SELECT 1 FROM thought_audit u
                                  WHERE u.thought_id = t.id AND u.action = 'update' AND u.diff ? 'content')
                    THEN content_fingerprint_of(t.content) END AS fp
        OFFSET 0) f
      LEFT JOIN LATERAL (
        -- The name as the trigger reads it — trimmed, empty is none — so the
        -- two derive one value and a pass after a pass writes nothing
        -- (run-it, first review pass: a padded name flip-flopped every pass).
        SELECT a.actor_kind, NULLIF(btrim(a.actor_name), '') AS name, a.canonical_agent_id,
               -- 073: the write's declaration, as 046 filed it (above).
               COALESCE(a.actor_context->'claimed'->>'trust',
                        CASE WHEN a.trust IS DISTINCT FROM a.actor_kind THEN a.trust END) AS declared,
               -- Decided from the SET, not from which row sorts first: a
               -- capture stands only when no update ever changed the text
               -- (fourth review pass, planted: a pre-050 seq inverted under a
               -- created_at tie put the capture on top of an unmatched update,
               -- and it was vouched by its place in the order).
               ((a.action = 'update' AND a.fa IS NOT DISTINCT FROM f.fp)
                OR (a.action = 'capture' AND NOT bool_or(a.action = 'update') OVER ())) AS vouched
        FROM (
          -- Each candidate row's two texts hashed ONCE, behind an OFFSET 0:
          -- read inline, the planner hashed them in every place the value is
          -- used — four sha256 of a 100 KB text per update row, the whole cost
          -- of a pass on a brain of long thoughts (third review pass, measured:
          -- 17.6 s at 100,000 thoughts with a tenth at 100 KB, of which the
          -- hashing of the update rows' texts was 15.9).
          SELECT a.actor_kind, a.actor_name, a.canonical_agent_id, a.action, a.created_at, a.seq,
                 a.trust, a.actor_context,
                 content_fingerprint_of(a.diff->'content'->>'before') AS fb,
                 content_fingerprint_of(a.diff->'content'->>'after')  AS fa
          FROM thought_audit a
          WHERE a.thought_id = t.id
            AND (a.action = 'capture' OR (a.action = 'update' AND a.diff ? 'content'))
          OFFSET 0
        ) a
        -- A content-writing row by the trigger's rule: a capture, or an update
        -- whose text CHANGED by 003's normalised fingerprint — 018's unchanged
        -- edit (case, whitespace) is in the diff and is not a change of writer,
        -- on the row or here (first review pass: the two disagreed, and a pass
        -- rewrote the trigger's stamp).
        WHERE a.action = 'capture' OR a.fb IS DISTINCT FROM a.fa
        -- The row whose text stands first; then the newest transaction; then
        -- the order inside it. Not seq alone (second review pass — see the
        -- header): a pre-050 seq is heap order, and heap order lies after
        -- 046's amendments and a VACUUM.
        ORDER BY (a.action = 'update' AND a.fa IS NOT DISTINCT FROM f.fp) DESC,
                 a.created_at DESC, a.seq DESC
        LIMIT 1
      ) w ON true
      WHERE t.metadata IS NULL OR jsonb_typeof(t.metadata) = 'object'
    ) d
  $scan$, v_tbl);

  EXECUTE format('SELECT count(*) FILTER (WHERE differs), count(*) FILTER (WHERE awaiting) FROM %I', v_tbl)
    INTO v_differ, v_awaiting;

  IF v_differ > 0 THEN
    -- The stamp trigger takes the keys as given under this setting; the audit
    -- row each write leaves names the door and nobody. Both restored below —
    -- a hand call must not leave the transaction's actor changed.
    PERFORM set_config('ob1.actor_amend', 'backfill', true);
    PERFORM set_config('ob1.actor', '{"via": "backfill_thought_actors"}', true);
    -- EXCLUSIVE, as 023 takes it, BEFORE the ALTER: the ALTER's own SHARE ROW
    -- EXCLUSIVE does not conflict with the ROW SHARE update_thought holds on
    -- its row between its lock and its UPDATE, so a pass that met an edit in
    -- flight waited on the row while the edit waited on the table — a
    -- deadlock, the pass the victim (run-it, first review pass, reproduced).
    -- EXCLUSIVE conflicts with ROW SHARE, so the pass waits its turn instead;
    -- readers (ACCESS SHARE) proceed. Held to commit, which is why each call
    -- is its own transaction; lock_timeout 10 s aborts it cleanly.
    LOCK TABLE thoughts IN EXCLUSIVE MODE;
    -- A stamp is not an edit: 001's trigger would bump updated_at on every
    -- row written, and 018's stale-read guard and 021's evidence rule both
    -- read it. Held off for the write, to commit, as 023 holds it.
    ALTER TABLE thoughts DISABLE TRIGGER thoughts_updated_at;

    EXECUTE format($write$
    UPDATE thoughts t
       SET metadata = (COALESCE(t.metadata, '{}'::jsonb) - 'actor_kind' - 'actor_name' - 'trust')
                      || CASE WHEN d.kind IS NOT NULL THEN jsonb_build_object('actor_kind', d.kind) ELSE '{}'::jsonb END
                      || CASE WHEN d.name IS NOT NULL THEN jsonb_build_object('actor_name', d.name) ELSE '{}'::jsonb END
                      || CASE WHEN d.trust IS NOT NULL THEN jsonb_build_object('trust', d.trust) ELSE '{}'::jsonb END
      FROM (SELECT id, updated_at, kind, name, trust FROM %I WHERE differs LIMIT %s) d
     WHERE t.id = d.id
       -- Re-checked on the locked row: a thought edited since the scan has a
       -- newer writer, stamped by the trigger; it is left for the next pass.
       AND t.updated_at IS NOT DISTINCT FROM d.updated_at
       -- …and one another pass marked meanwhile — updated_at held still, so
       -- the marks themselves are compared — is not written or counted again
       -- (run-it, first review pass: two passes each reported every row).
       AND (t.metadata->>'actor_kind' IS DISTINCT FROM d.kind OR (d.kind IS NULL AND t.metadata ? 'actor_kind')
            OR t.metadata->>'actor_name' IS DISTINCT FROM d.name OR (d.name IS NULL AND t.metadata ? 'actor_name')
            OR t.metadata->>'trust' IS DISTINCT FROM d.trust OR (d.trust IS NULL AND t.metadata ? 'trust'))
    $write$, v_tbl, COALESCE(p_limit::text, 'ALL'));
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    ALTER TABLE thoughts ENABLE TRIGGER thoughts_updated_at;
    PERFORM set_config('ob1.actor', COALESCE(v_prev_actor, ''), true);
    PERFORM set_config('ob1.actor_amend', COALESCE(v_prev_amend, ''), true);
  END IF;

  RETURN jsonb_build_object('ok', true, 'rows', v_rows, 'differing', v_differ, 'awaiting', v_awaiting);
END;
$$;

COMMENT ON FUNCTION backfill_thought_actors(integer) IS
  'Sets metadata.actor_kind, metadata.actor_name and (since 073) metadata.trust on every thought to what thought_audit derives for the write of its current content — the update row whose after-text is the row''s text, else the capture when no update ever changed the text (update rows present and none matching: nobody), the newest by created_at then seq among matches: ob1_registry_kind for its id or name NOW (so a reclassified key reaches its rows) else the actor_kind 046 stamped, its actor_name, and ob1_trust_ceiling of that kind and the write''s declaration (its actor_context.claimed trust, else a trust that differs from its kind) — wherever the row and the log disagree, stripping a mark no audit row vouches for. Returns {ok, rows (written this call), differing (found disagreeing), awaiting (writer named but unclassified — set_agent_kind, then this)}. p_limit (at least 1) bounds the rows written and the write lock per call, not the scan (every call derives every thought) nor the audit rows (one per row written); each call its own transaction. Holds the updated_at trigger for the write (a stamp is not an edit), which needs the table''s owner; each row written leaves an audit row whose origin is backfill_thought_actors. Idempotent: a second pass finds nothing. Migration 050 / SMD-1726; trust 073 / SMD-1724.';

-- Every thought already written takes its trust now — or the batch
-- OB1_BACKFILL_LIMIT names, the rest by hand.
SELECT backfill_thought_actors({{BACKFILL_LIMIT}});
