-- ============================================================================
-- 008 — thought_audit: an append-only record of every mutation
--
-- Why
--   Nothing recorded who changed what. The product actively encourages several
--   clients writing to one brain — Claude Desktop, ChatGPT, a background
--   importer — and "where did this come from" and "what was here before" were
--   both unanswerable. Audit only ever describes events that happened after it
--   existed, so every capture made before this migration is permanently
--   unattributed. That asymmetry is why it belongs in core rather than in an
--   extension.
--
-- Ported from schemas/thought-audit, with three deliberate departures. Each is
-- a correctness fix rather than a preference:
--
--   1. APPEND-ONLY IS ENFORCED BY A TRIGGER, NOT BY GRANTS.
--      Upstream grants SELECT, INSERT to `service_role` and never grants UPDATE
--      or DELETE. That works on Supabase, where the application role is not the
--      table owner. Off Supabase the application connects as a role that owns
--      the schema, and an owner holds privileges implicitly that cannot be
--      revoked — so the grant approach would have offered no protection at all
--      while appearing to. The trigger below refuses UPDATE and DELETE
--      regardless of role, including for the owner and for a superuser.
--
--   2. NO RLS AND NO service_role GRANT.
--      `service_role` is Supabase-managed and does not exist here; migration 004
--      set this precedent and db/test-schema.ts asserts the absence of both.
--      RLS on a table only ever accessed by its owner never fires.
--
--   3. THE AUDIT ROW IS WRITTEN BY A TRIGGER IN THE SAME TRANSACTION.
--      Upstream describes audit writes as "fire-and-forget from the MCP server
--      — failures here never block the main operation". For an audit log that
--      means silently losing the events it exists to record. A trigger on
--      `thoughts` cannot fail separately from the mutation it describes, and it
--      covers every path into the table: capture, the update and delete tools
--      coming in SMD-927, and any direct SQL.
--
--      The cost is that a trigger cannot see application state, so the actor
--      arrives through a transaction-local setting — see `ob1.actor` below.
--
-- Safety
--   * Additive. `thoughts` gains no columns and loses none, satisfying the
--     project rule against altering that table.
--   * `thought_id` is deliberately NOT a foreign key. Audit rows must outlive
--     the thoughts they describe, and the delete event is the one most worth
--     keeping.
--   * Idempotent.
--
-- Prerequisites
--   Migration 007. Applied by `bun db/migrate.ts`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS thought_audit (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- No FK, on purpose. See the header.
  thought_id        UUID        NOT NULL,

  action            TEXT        NOT NULL
    CHECK (action IN ('capture', 'update', 'delete')),

  -- Copied from metadata.source at mutation time so "what did this client do"
  -- needs no join against a row that may since have been deleted.
  source            TEXT,

  /**
   * The name of the access key that performed the mutation, from
   * server-portable/auth.ts's `Principal`. A first-class column rather than a
   * key inside actor_context, because it is the closest thing this deployment
   * has to a stable agent identity and SMD-928 is expected to promote it to a
   * canonical id — promoting a column is a migration, promoting a JSON key is
   * an archaeology exercise.
   *
   * NULL for a mutation made outside the server (a migration, a manual fix, an
   * import script run by hand). That distinction is worth preserving rather
   * than papering over with a placeholder.
   */
  actor_name        TEXT,

  -- Opaque per-session identifier, grouping the writes of one conversation or
  -- one import run. Nothing populates this yet; it is here because adding a
  -- column to an append-only table later means a migration over history.
  author_session_id TEXT,

  /**
   * capture — the metadata the row was created with.
   * update  — before/after for the fields that actually changed.
   * delete  — previous_content and previous_metadata in full, so the row is
   *           recoverable from this log alone. That is what makes a hard
   *           delete survivable, and therefore what makes SMD-927 safe.
   */
  diff              JSONB,

  -- Free-form, analytical only. Nothing should depend on its shape.
  actor_context     JSONB,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE thought_audit IS
  'Append-only log of every capture/update/delete on thoughts. Written by a trigger inside the mutating transaction, so an event cannot be lost independently of the change it describes. thought_id is deliberately not a foreign key so audit rows outlive their subject. UPDATE and DELETE are refused by trigger, not by grant.';

COMMENT ON COLUMN thought_audit.actor_name IS
  'Access key name from server-portable/auth.ts, via the ob1.actor transaction setting. NULL for mutations made outside the server.';

COMMENT ON COLUMN thought_audit.diff IS
  'capture: creating metadata. update: before/after of changed fields. delete: previous_content and previous_metadata, in full, for recovery.';

CREATE INDEX IF NOT EXISTS thought_audit_thought_id_idx
  ON thought_audit (thought_id);

CREATE INDEX IF NOT EXISTS thought_audit_created_at_idx
  ON thought_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS thought_audit_actor_idx
  ON thought_audit (actor_name, created_at DESC)
  WHERE actor_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS thought_audit_session_idx
  ON thought_audit (author_session_id)
  WHERE author_session_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Append-only, enforced
--
-- A BEFORE trigger rather than a rule or a grant: it fires for every role
-- including the owner, and it cannot be bypassed by a mistaken GRANT later.
-- Pruning old rows therefore requires dropping this trigger in a migration,
-- which is exactly the conscious decision it should be.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thought_audit_refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- The guidance is in the MESSAGE rather than in USING HINT deliberately.
  -- Bun's Postgres client returns the HINT field as UTF-16 bytes with
  -- interleaved nulls ("T\0o\0 \0p\0r\0u\0n\0e\0…"), so anything put there is
  -- unreadable to the runtime this server actually uses. A hint nobody can read
  -- is worse than no hint, because it looks like it worked.
  RAISE EXCEPTION
    'thought_audit is append-only: % is not permitted. To prune history, DROP TRIGGER thought_audit_immutable in a migration — deliberately, and with a record of why.',
    TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS thought_audit_immutable ON thought_audit;
CREATE TRIGGER thought_audit_immutable
  BEFORE UPDATE OR DELETE ON thought_audit
  FOR EACH ROW EXECUTE FUNCTION thought_audit_refuse_mutation();

-- ---------------------------------------------------------------------------
-- The actor, carried on the transaction
--
-- A trigger cannot read application state, so the server sets `ob1.actor` with
-- SET LOCAL before mutating. SET LOCAL is scoped to the transaction, so it
-- cannot leak between requests sharing a pooled connection — which a plain
-- `set_config(..., false)` or a session GUC would.
--
-- `current_setting(..., true)` returns NULL when unset rather than raising, so
-- a mutation from a migration or a psql session is audited with a NULL actor
-- instead of failing. Audit should observe, not obstruct.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_current_actor()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  raw text := current_setting('ob1.actor', true);
BEGIN
  IF raw IS NULL OR raw = '' THEN
    RETURN NULL;
  END IF;
  RETURN raw::jsonb;
EXCEPTION WHEN others THEN
  -- A malformed setting must not break a capture. Record the mutation with an
  -- unknown actor rather than losing both the change and its audit row.
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION ob1_current_actor() IS
  'Reads the ob1.actor transaction-local setting as jsonb: {name, source, session}. NULL when unset or malformed, so audit never blocks a mutation.';

-- ---------------------------------------------------------------------------
-- The audit trigger on thoughts
--
-- INSERT maps to `capture` and UPDATE to `update`, which correctly reflects
-- what upsert_thought does: a re-capture of identical content takes the
-- ON CONFLICT branch and is an update, not a second capture.
--
-- Consequence worth knowing rather than hiding: the PostgREST store's two-step
-- fallback (insert the row, then attach the embedding) logs `capture + update`
-- for one logical capture, the second row recording only
-- `embedding_present: true`. Both mutations genuinely happened, so the log is
-- accurate — but audit row counts are not capture counts on that path.
-- Measured overhead of the trigger on 400 bulk inserts: 6%.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thoughts_write_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor    jsonb := ob1_current_actor();
  v_action text;
  v_diff   jsonb;
  v_id     uuid;
  v_source text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'capture';
    v_id     := NEW.id;
    v_source := NEW.metadata->>'source';
    v_diff   := jsonb_build_object('metadata', NEW.metadata);

  ELSIF TG_OP = 'UPDATE' THEN
    v_action := 'update';
    v_id     := NEW.id;
    v_source := NEW.metadata->>'source';
    -- Only what changed. Recording the whole row on every metadata touch would
    -- make the log expensive to store and tedious to read.
    v_diff := '{}'::jsonb;
    IF NEW.content IS DISTINCT FROM OLD.content THEN
      v_diff := v_diff || jsonb_build_object(
        'content', jsonb_build_object('before', OLD.content, 'after', NEW.content));
    END IF;
    IF NEW.metadata IS DISTINCT FROM OLD.metadata THEN
      v_diff := v_diff || jsonb_build_object(
        'metadata', jsonb_build_object('before', OLD.metadata, 'after', NEW.metadata));
    END IF;
    IF (NEW.embedding IS NULL) IS DISTINCT FROM (OLD.embedding IS NULL) THEN
      v_diff := v_diff || jsonb_build_object('embedding_present', NEW.embedding IS NOT NULL);
    END IF;

  ELSE  -- DELETE
    v_action := 'delete';
    v_id     := OLD.id;
    v_source := OLD.metadata->>'source';
    -- In full. The audit row has to be enough to reconstruct what was lost.
    v_diff   := jsonb_build_object(
      'previous_content',  OLD.content,
      'previous_metadata', OLD.metadata);
  END IF;

  INSERT INTO thought_audit (thought_id, action, source, actor_name, author_session_id, diff, actor_context)
  VALUES (
    v_id,
    v_action,
    COALESCE(actor->>'source', v_source),
    actor->>'name',
    actor->>'session',
    v_diff,
    -- NULL rather than an empty object when the actor carries nothing extra:
    -- `{}` on every row is storage and reading noise for no information.
    NULLIF(actor - 'name' - 'source' - 'session', '{}'::jsonb)
  );

  RETURN NULL;  -- AFTER trigger; the return value is ignored.
END;
$$;

DROP TRIGGER IF EXISTS thoughts_audit ON thoughts;
CREATE TRIGGER thoughts_audit
  AFTER INSERT OR UPDATE OR DELETE ON thoughts
  FOR EACH ROW EXECUTE FUNCTION thoughts_write_audit();

-- ---------------------------------------------------------------------------
-- Carrying the actor through upsert_thought, so BOTH stores attribute
--
-- The trigger reads a transaction-local setting, which the SQL store can set
-- directly. The PostgREST store cannot: it issues one RPC per call with no
-- transaction of its own to scope a setting to.
--
-- Rather than a fifth overload, the actor rides in `p_payload`, which has been
-- an ENVELOPE since migration 004 — that function reads only
-- `p_payload->'metadata'` and ignores every other key. So `p_payload.actor`
-- costs nothing, changes no signature, and works identically on both paths.
--
-- Only the 3-argument form needs redefining: migration 007's 4-argument form
-- delegates to this one, so it inherits the behaviour.
--
-- An audit row with a NULL actor on a supported store would have been exactly
-- the silent degradation this fork keeps removing — visible only to someone who
-- went looking, and indistinguishable from a mutation that genuinely had no
-- principal.
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
  v_fingerprint text;
  v_id          uuid;
BEGIN
  /**
   * Migration 005's guard, carried forward verbatim.
   *
   * This is the trap in redefining a function from a later migration: CREATE OR
   * REPLACE takes the whole body, so every change made to it in between is
   * silently reverted. Writing this file without the check dropped 005's
   * validation and db/test-schema.ts caught it immediately — which is the only
   * reason it is here. Anything that redefines upsert_thought again must carry
   * this, and the audit setting below, forward too.
   */
  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_payload);
  END IF;

  -- Transaction-local, so it cannot outlive this call on a pooled connection.
  -- Set before the INSERT so the AFTER trigger sees it.
  IF p_payload ? 'actor' THEN
    PERFORM set_config('ob1.actor', p_payload->>'actor', true);
  END IF;

  v_fingerprint := encode(
    sha256(convert_to(
      lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))),
      'UTF8'
    )),
    'hex'
  );

  INSERT INTO thoughts (content, content_fingerprint, metadata, embedding)
  VALUES (
    p_content,
    v_fingerprint,
    COALESCE(p_payload->'metadata', '{}'::jsonb),
    p_embedding
  )
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
    SET updated_at = now(),
        metadata   = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
        embedding  = COALESCE(EXCLUDED.embedding, thoughts.embedding)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector) IS
  'Atomic capture: content + metadata + embedding in one statement. Reads p_payload.actor, if present, into the ob1.actor transaction setting so the audit trigger can attribute the write on either store.';

-- No GRANT. `service_role` is Supabase-managed and absent here; the application
-- connects as a role that already owns these objects. Append-only is enforced
-- by the trigger above precisely because grants cannot express it for an owner.
