-- ============================================================================
-- 021 — thoughts.embedding_model: a vector carries the model that produced it
--
-- Why
--   Nothing in the schema says which model a stored vector came from.
--   ob1_config.embedding_model (006) records the model the corpus is MEANT to
--   be at, and since SMD-1024 preflight infers whether it IS at it from the
--   claim table: a re-embed pass is unfinished while any row under its key is
--   pending, leased or failed. That is a proxy for a fact no row stores, and it
--   vanishes when the rows do — migration 015's fourth principle ("clear a
--   work_type's terminal rows by hand to start over") and preflight's own
--   remedy for a superseded key both tell the operator to DELETE claim rows. A
--   pass to B dies at 5%, the operator clears its rows to start over and is
--   interrupted: every check is green (`embedding contract … matching`,
--   `re-embed pass … none unfinished`) with 95% of vectors another model's,
--   and nothing left in the database can ever say so. The same blindness made
--   db/reembed.ts end a switch with a paragraph saying that thoughts captured
--   meanwhile by a server not yet switched carry the previous model's vectors
--   "and nothing here can tell" (SMD-1068, filed by SMD-1024's second review
--   pass).
--
-- The column
--   `thoughts.embedding_model text`, NULLABLE, written by the same statement
--   that writes `embedding`, so the label can never describe a vector it did
--   not arrive with. Its value is the model's name exactly as
--   OB1_EMBEDDING_MODEL gives it — the string ob1_config.embedding_model
--   records — so "at the recorded model" is string equality and nothing else.
--   The width is the column's (006 refuses any other) and needs no second
--   label. NULL means UNKNOWN, not "the default": every row from before this
--   migration, every row a raw INSERT wrote, every capture from a writer that
--   names no model. A row with no vector has no label either — there is
--   nothing for it to be the model of.
--
-- The one backfill there is evidence for
--   Stamping the recorded model on every existing row would be exactly the
--   guess this column exists to stop making — on the day 021 is applied the
--   corpus may well be at two models, which is the case that motivated it.
--   But a row a re-embed pass wrote IS evidence: its succeeded claim row under
--   `reembed:<model>@<dim>[:suffix]` names the model, and the pass wrote the
--   vector before it released the claim, so `updated_at <= finished_at` says
--   nothing has written the row since (update_thought moves updated_at; a
--   later capture or edit puts it past finished_at and the row stays NULL).
--   Those rows, and only those, are labelled below from the latest such
--   claim; a key naming no model (`reembed:nightly`) is no evidence and a row
--   whose updated_at is NULL cannot be judged. The label is a fact about a
--   vector already there, not an edit: 001's updated_at trigger is held off
--   for the statement — inside one DO block, so the hold and its release
--   cannot be separated however the file is run — and no row's updated_at
--   moves (a client holding a pre-migration read would otherwise be told
--   STALE_READ on its next edit for a row nothing changed); 008's audit
--   trigger sees no event in it. Without this, the first plain
--   run of reembed.ts after upgrading would re-embed a whole corpus a
--   finished pass had already proved was at the model — NULL is "not at the
--   target" to that tool, and rightly, since nothing else says otherwise.
--   What stays NULL after this is what genuinely has no evidence, and the
--   first pass over it is what labels it; reembed.ts says how many such rows
--   its pool holds before it runs. The one imprecision: a pre-021 edit that
--   began after the pass's write and before its release is stamped with the
--   pass's model although its vector was the editing server's — a window of
--   a second or so, once, per row a pass touched. And one caveat about the
--   evidence itself: between change 29 and change 35 (PRs #10 to #16)
--   reembed.ts accepted a --job naming a model other than the shell's, so a
--   run in that window could have written model A's vectors under B's key;
--   such rows are labelled B here and the label vouches for them. A brain that
--   ran such a job should clear that key's rows before applying this.
--
--   thought_chunks gets no column. Chunk rows are written by the 4-argument
--   upsert_thought and by update_thought, in the same statement as the
--   parent's vector, from one embedCapture() with one model — so where they
--   were written the parent's label is theirs. A re-capture through the
--   3-argument form (a capture that produced no windows) replaces the parent's
--   vector and label and leaves 007's chunk rows as they were, which predates
--   this migration and is not changed by it.
--
--   No index. The two readers are a grouped count once per server start
--   (preflight) and one scan per re-embed run; both are over a column with a
--   handful of distinct values, and an index would cost every capture.
--
-- The rule: the label follows the vector
--   * upsert_thought(text, jsonb, vector) — the INSERT writes
--     p_payload->>'embedding_model' beside the vector, and NULL when the
--     vector is NULL, whatever the envelope names. On conflict (a re-capture
--     of the same text): when the caller sent no vector the row keeps its
--     vector AND its label; when it sent one, the row takes the new vector and
--     the caller's label — NULL when the caller named none, which is what a
--     capture from an older server is: a vector of unknown model. The
--     2-argument form writes no vector and touches neither column. The
--     4-argument form delegates to this one (007) and inherits the rule.
--   * update_thought — content absent: the label is untouched, like the
--     vector. Content present with no vector: the label is NULL, like the
--     vector. Content present with a vector: the label is p_embedding_model.
--   * Nothing enforces the rule on a raw UPDATE of `embedding` around these
--     functions, and no trigger could: a same-model re-embed replaces the
--     vector with the label unchanged, which is indistinguishable from a raw
--     write that left a stale label. A raw vector write is the operator's; it
--     leaves the label describing the vector before it.
--
-- Where the label comes from — the caller, never ob1_config
--   The server knows the model it embedded with; ob1_config knows the model
--   the corpus is being moved to; they differ exactly during a switch, because
--   reembed.ts --switch-model records the new model FIRST, on purpose (015,
--   SMD-1024). A writer reading ob1_config would stamp the new model on a
--   not-yet-switched server's old vectors — the one case the column is for.
--   So the server passes the model it used (embed.ts's configuration), and
--   reembed.ts passes its own.
--
-- How the two writers take it, and why differently
--   upsert_thought has three overloads and 004's header forbids a default on
--   any of them: a defaulted fourth parameter beside the 4-argument chunk form
--   would make an untyped 4-argument call "function is not unique". Its
--   p_payload has been an ENVELOPE since 004, and 008 put the actor there for
--   this exact constraint — so the label rides as p_payload.embedding_model,
--   on both stores, with no signature change; only the 3-argument body is
--   redefined below.
--
--   update_thought has one form, no envelope, and every parameter but the id
--   defaulted — so it gains an eighth, p_embedding_model text DEFAULT NULL.
--   The 7-argument form is DROPPED first, as 020 did for the search functions:
--   CREATE OR REPLACE with a new parameter would leave the old form beside the
--   new one, and every call with seven arguments or fewer — the servers until
--   this change, reembed.ts, every PostgREST caller by name, every hand-written
--   SELECT — would fail with "function is not unique". After the drop a
--   7-argument call resolves through the default. 020's ACL replay runs across
--   the drop (below), and COMMENT ON FUNCTION is re-issued, since a DROP loses
--   it.
--
-- What the audit sees: nothing new
--   008's trigger (redefined by 010) diffs content, metadata and the
--   embedding's PRESENCE. A label change is not an event, so a re-embed still
--   writes no audit row, and a label-only difference writes none. Asserted in
--   db/test-schema.ts [22] and db/test-live.ts [9].
--
-- What reads it
--   * server-portable/preflight.ts, `vector models`: the corpus grouped by
--     label. Every labelled vector at the recorded model is ok; vectors at
--     other models are a warning naming each model and its count, with the
--     reembed.ts command as the remedy; unlabelled vectors are detail. The
--     column absent under a server that sends the label is a failure. Beside
--     it, `edit signature`: the eight-argument update_thought present and
--     alone (018 re-applied by hand puts the 7-argument form back beside it —
--     the ambiguity above).
--   * db/reembed.ts: under the model's own key the pool is built from the
--     rows not at the target (no vector, or `embedding_model IS DISTINCT FROM
--     <model>`) rather than from every thought — a --job key is a backfill
--     whose reason is not the model, and pools every thought as before — and
--     on every run, under any key, a SUCCEEDED row whose thought is not at the
--     target returns to the pool — the row says done, the thought says
--     otherwise, the data wins. That is what retires the "nothing here can
--     tell" paragraph: a capture or edit made by a server still on the old
--     model, before or after the pass finished, is found by the next run
--     because its row says which model it is at.
--
-- What a successor must carry
--   Everything the two bodies hold: 005's non-object guard, 008's ob1.actor,
--   009's millisecond-truncated if_unchanged_since predicate in the UPDATE,
--   013's context in the chunk insert, 018's FOR UPDATE, advisory lock,
--   content_fingerprint_of and the `ob1:unchanged-edit-not-duplicate`
--   sentinel — and now p_payload->>'embedding_model' in the INSERT and its ON
--   CONFLICT clause, and the eighth parameter with its CASE in the UPDATE.
--   The signature of update_thought is UPDATE_THOUGHT_SIGNATURE in
--   db/config.mjs; a redefinition that changes it must drop this form first.
--
-- Safety
--   * Additive. One nullable column added to `thoughts`; no column altered or
--     dropped. The only write to existing rows is the evidence-based label
--     above; no DELETE beyond the chunk replacement 009 does.
--   * Idempotent. ADD COLUMN IF NOT EXISTS; the DROP is IF EXISTS; the ACL
--     replay runs only on the run that creates the eight-argument form (a
--     re-run finds it present, CREATE OR REPLACE keeps its ACL, and the
--     replay does nothing).
--
-- Prerequisites
--   Migration 018 (the update_thought body this replaces) and 008 (the
--   upsert_thought body). Applied by `bun db/migrate.ts`.
--
-- Expected outcome
--   `thoughts.embedding_model`; both writers carrying the label; one
--   update_thought, of eight parameters; preflight and reembed.ts reading the
--   column.
-- ============================================================================

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS embedding_model text;

COMMENT ON COLUMN thoughts.embedding_model IS
  'The model that produced `embedding`, as OB1_EMBEDDING_MODEL names it (the string ob1_config.embedding_model records); written by the same statement as the vector and NULL when that statement named none — a row from before migration 021, a raw INSERT, a capture from an older server. Unknown, not the default. The row''s chunks share the label: they are written in the same call from the same model.';


-- ---------------------------------------------------------------------------
-- The one backfill there is evidence for — see the header. A row a re-embed
-- pass wrote, released as succeeded under a key naming the model, and not
-- written since (updated_at <= finished_at): labelled from the latest such
-- claim. Everything else stays NULL. Idempotent: a labelled row is not
-- selected again. The key's shape is config.mjs's (reembedKey/parseReembedKey):
-- `reembed:<model>@<dim>[:suffix]`, the model read up to the LAST "@".
--
-- 001's BEFORE UPDATE trigger would stamp updated_at = now() on every row
-- labelled, and the label is not an edit (see the header); the trigger is held
-- off for the UPDATE. The three statements are ONE — a DO block — so the
-- DISABLE and the ENABLE cannot be separated however the file is run: under
-- bun migrate.ts the whole file is a transaction anyway (and the locks it
-- takes, ADD COLUMN's included, are held until it commits, as every
-- migration's DDL is), and by hand under autocommit a failure inside the block
-- rolls the DISABLE back with it (fourth review pass — preflight's `updated_at
-- trigger` check still says so if a hand DISABLE is ever left behind).
-- ---------------------------------------------------------------------------
DO $bf$
BEGIN
  ALTER TABLE thoughts DISABLE TRIGGER thoughts_updated_at;
  UPDATE thoughts t
     SET embedding_model = e.model
  FROM (
    SELECT DISTINCT ON (k.thought_id) k.thought_id, k.model, k.finished_at
      FROM (
        SELECT c.thought_id, c.finished_at,
               substring(c.work_type FROM '^reembed:(.+)@[0-9]+(?::[^@]*)?$') AS model
          FROM thought_work_claims c
         WHERE c.status = 'succeeded' AND c.finished_at IS NOT NULL
      ) k
     WHERE k.model IS NOT NULL
     ORDER BY k.thought_id, k.finished_at DESC
  ) e
 WHERE t.id = e.thought_id
   AND t.embedding_model IS NULL
   AND t.embedding IS NOT NULL
     AND t.updated_at <= e.finished_at;
  ALTER TABLE thoughts ENABLE TRIGGER thoughts_updated_at;
END
$bf$;

-- ---------------------------------------------------------------------------
-- upsert_thought(text, jsonb, vector) — the label rides in the envelope
--
-- 008's body — 005's guard and the actor carried verbatim — with the column
-- added to the INSERT and to the ON CONFLICT clause. p_payload is read for
-- `embedding_model` as it is read for `actor`; a payload without the key is
-- every older caller, and writes NULL. See the header for why not a parameter.
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

  -- 021: the label is written beside the vector, from the envelope; NULL when
  -- the caller named none (an older server), which is a vector of unknown model.
  INSERT INTO thoughts (content, content_fingerprint, metadata, embedding, embedding_model)
  VALUES (
    p_content,
    v_fingerprint,
    COALESCE(p_payload->'metadata', '{}'::jsonb),
    p_embedding,
    CASE WHEN p_embedding IS NULL THEN NULL ELSE p_payload->>'embedding_model' END
  )
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
    SET updated_at = now(),
        metadata   = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
        embedding  = COALESCE(EXCLUDED.embedding, thoughts.embedding),
        -- The label follows the vector (021): kept with a kept vector, the
        -- caller's with a new one — NULL if the caller named none.
        embedding_model = CASE WHEN EXCLUDED.embedding IS NULL THEN thoughts.embedding_model
                               ELSE EXCLUDED.embedding_model END
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector) IS
  'Atomic capture: content + metadata + embedding in one statement. Reads p_payload.actor, if present, into the ob1.actor transaction setting so the audit trigger can attribute the write on either store, and p_payload.embedding_model, if present, into thoughts.embedding_model beside the vector (021); on a re-capture the label follows the vector — kept with a kept vector, the caller''s with a new one.';

-- ---------------------------------------------------------------------------
-- update_thought — an eighth parameter, so the 7-argument form goes first
--
-- Its privileges are read before the DROP so the CREATE can be given the same
-- ones (020's mechanism; see its header). The session-scoped setting holds the
-- aclitem[] as text; empty — and the replay below does nothing — when the
-- eight-argument form already exists (a re-run: CREATE OR REPLACE keeps its
-- ACL), when the old form does not exist, or when its ACL is NULL (the
-- defaults).
-- ---------------------------------------------------------------------------
SELECT set_config('ob1.acl_update_thought',
                  CASE WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)') IS NOT NULL THEN ''
                       ELSE COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb)')), '') END,
                  false);

-- Beside the eight-argument form the 7-argument one would make every call with
-- seven arguments or fewer ambiguous (see the header); IF EXISTS keeps this
-- file re-runnable. Nothing in the catalog depends on it — callers resolve the
-- name at call time.
DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb);

-- 018's body — see "What a successor must carry" in the header — with the
-- parameter and one CASE added. Repeated in full because CREATE OR REPLACE has
-- no partial form.
CREATE OR REPLACE FUNCTION update_thought(
  p_id                 uuid,
  p_content            text        DEFAULT NULL,
  p_metadata_patch     jsonb       DEFAULT NULL,
  p_embedding          vector({{EMBEDDING_DIM}}) DEFAULT NULL,
  p_chunks             jsonb       DEFAULT NULL,
  p_if_unchanged_since timestamptz DEFAULT NULL,
  p_actor              jsonb       DEFAULT NULL,
  -- 021: the model that produced p_embedding, as OB1_EMBEDDING_MODEL names it.
  -- Defaulted, so every 7-argument caller resolves here now that the
  -- 7-argument form is gone; NULL with a vector is a vector of unknown model.
  p_embedding_model    text        DEFAULT NULL
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
BEGIN
  -- 008: transaction-local, so it cannot outlive this call on a pooled
  -- connection; set before the UPDATE so the AFTER trigger sees it.
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;

  -- FOR UPDATE: what "unchanged" is decided against below is the row as it is
  -- NOW, and stays so until this transaction ends. Without the lock a caller
  -- passing no if_unchanged_since could read text X, have another edit commit
  -- Y, and write X back over it as an "unchanged" edit that 013 would have
  -- refused. Taken before the advisory lock, so the two are always acquired in
  -- the same order — see "The rule", 2.
  SELECT * INTO v_existing FROM thoughts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;

  -- 009: a stale read is told apart from a missing row before the write, so
  -- the caller gets the reason rather than a bare "0 rows". Truncated on both
  -- sides to milliseconds — JavaScript's Date carries no more, and a caller
  -- passing back exactly what it read must pass this.
  IF p_if_unchanged_since IS NOT NULL
     AND date_trunc('milliseconds', COALESCE(v_existing.updated_at, v_existing.created_at))
         > date_trunc('milliseconds', p_if_unchanged_since) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'STALE_READ',
      'current_updated_at', COALESCE(v_existing.updated_at, v_existing.created_at));
  END IF;

  IF p_content IS NOT NULL THEN
    -- 003's rule, through 016's function: a fingerprint computed differently
    -- here would silently stop matching the ones capture writes.
    v_fingerprint := content_fingerprint_of(p_content);

    IF v_existing.content_fingerprint = v_fingerprint THEN
      -- The row already owns this key, and it is locked: the unique index
      -- says no other row can hold it, so there is nothing to serialise and
      -- nothing to look up. The common case — every fingerprinted row a
      -- re-embed pass visits, every same-text re-save through the tool.
      v_unchanged := true;
    ELSE
      v_unchanged := v_fingerprint = content_fingerprint_of(v_existing.content);

      -- Serialise every edit that would take this key until commit, so the
      -- lookup below sees the other edit's row rather than racing it to the
      -- unique index. See "The rule", 2, in the header.
      PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));

      -- ob1:unchanged-edit-not-duplicate — a CONTRACT SENTINEL, not prose (the
      -- 014 convention). The one definition of "another row holding this key":
      -- the refusal below and the duplicate_of report both read it. The
      -- holder's text is hashed again, because a stale key — a raw update of
      -- content around this function — is not the same text, and must not be
      -- reported as a twin.
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

  /**
   * One statement. The `if_unchanged_since` predicate is repeated here rather
   * than relied on from the check above: between that SELECT and this UPDATE
   * another writer can commit, which is the race upstream's version has. The
   * WHERE clause is the actual guard; the check above exists only to produce a
   * better error message.
   */
  UPDATE thoughts SET
    content             = COALESCE(p_content, content),
    -- v_other is set only when content arrived: another row holds this key,
    -- so this row must not claim it — NULL, whatever a raw update around this
    -- function may have left here.
    content_fingerprint = CASE
                            WHEN p_content IS NULL   THEN content_fingerprint
                            WHEN v_other IS NOT NULL THEN NULL
                            ELSE v_fingerprint
                          END,
    metadata            = CASE WHEN p_metadata_patch IS NOT NULL
                               THEN metadata || p_metadata_patch ELSE metadata END,
    -- Only when content arrived. A metadata-only edit must not blank the
    -- vector and quietly remove the row from every semantic search.
    embedding           = CASE WHEN p_content IS NOT NULL THEN p_embedding ELSE embedding END,
    -- The label follows the vector (021): untouched when the vector is,
    -- NULL when the vector is set to NULL, the caller's when a vector arrives.
    embedding_model     = CASE
                            WHEN p_content IS NULL   THEN embedding_model
                            WHEN p_embedding IS NULL THEN NULL
                            ELSE p_embedding_model
                          END,
    updated_at          = now()
  WHERE id = p_id
    AND (p_if_unchanged_since IS NULL
         OR date_trunc('milliseconds', COALESCE(updated_at, created_at))
            <= date_trunc('milliseconds', p_if_unchanged_since))
  RETURNING updated_at INTO v_updated;

  IF v_updated IS NULL THEN
    -- Lost the race after the check above passed.
    RETURN jsonb_build_object('ok', false, 'error', 'STALE_READ');
  END IF;

  -- Chunks describe the content, so they follow it: replaced wholesale, as
  -- migration 007's capture path does, carrying 013's context.
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

-- The old form's ACL, replayed onto the new one (020's block, for this
-- function). Empty setting — a re-run, no old function, or the defaults — and
-- nothing is done. Otherwise: revoke from EVERY grantee the CREATE gave the
-- new function (PUBLIC, and whatever ALTER DEFAULT PRIVILEGES added — on
-- Supabase anon, authenticated, service_role), then grant exactly what the old
-- ACL held, grant option included.
DO $acl$
DECLARE
  v_acl  text := current_setting('ob1.acl_update_thought', true);
  v_item record;
BEGIN
  IF v_acl IS NULL OR v_acl = '' THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text) FROM PUBLIC';
  FOR v_item IN
    SELECT DISTINCT a.grantee FROM pg_proc p, aclexplode(p.proacl) AS a
    WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)') AND a.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text) FROM %s', quote_ident(pg_get_userbyid(v_item.grantee)));
  END LOOP;
  FOR v_item IN SELECT grantee, privilege_type, is_grantable FROM aclexplode(v_acl::aclitem[]) LOOP
    IF v_item.privilege_type = 'EXECUTE' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text) TO %s%s',
                     CASE WHEN v_item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_item.grantee)) END,
                     CASE WHEN v_item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END IF;
  END LOOP;
END
$acl$;

-- Re-issued: a DROP loses the COMMENT (018's). A description, not a marker —
-- the sentinel in the body is that.
COMMENT ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text) IS
  'Edit a thought by id. Recomputes content_fingerprint and replaces chunks — with their context — when content changes; an edit whose text normalises to what the row holds is never DUPLICATE_CONTENT, and reports duplicate_of when another row holds that text (a pair from before migration 003), or fingerprint_held_by when a row holds the key under other text, leaving this row''s fingerprint NULL. The row is locked FOR UPDATE and edits that would take a key the row does not own are serialised on an advisory lock (READ COMMITTED; captures through upsert_thought are not); both locks are held until the caller''s transaction ends, refusals included. Checks if_unchanged_since as a predicate in the UPDATE, so the guard is atomic. p_embedding_model (021) is written to thoughts.embedding_model beside the vector — the label follows the vector: untouched without content, NULL with content and no vector. Returns {ok:false, error} for NOT_FOUND | STALE_READ | DUPLICATE_CONTENT.';
