-- ============================================================================
-- 022 — a new vector replaces the chunks, on every capture path
--
-- Why (Linear SMD-1175, found by SMD-1068's second review pass)
--   upsert_thought(text, jsonb, vector) — 004's atomic capture, last redefined
--   by 021 — replaces the parent's vector and label on a re-capture of the
--   same normalised text and never touches thought_chunks. Only the
--   4-argument form (007, 013) and update_thought (009, 018, 021) replace
--   chunk rows, and every caller routes a capture that produced NO windows to
--   the 3-argument form: both stores (`chunks.length ? 4-arg : 3-arg`) and the
--   Supabase Edge Function server, which never makes windows. So a thought
--   first captured with chunks and later re-captured through a path that
--   yields none — the Edge server, or server-portable after OB1_CHUNK_TOKENS
--   grew or the provider's window changed so the text fits one call — kept
--   its old chunk rows under a parent whose vector had moved. match_thoughts
--   searches those rows (007's chunk CTE), so the thought was found by windows
--   of a vector it no longer had. Silently: no error on the write, none on
--   the search.
--
--   Pre-existing since 007. 021 made it worse in one respect and visible in
--   none: the re-capture writes the new model's label on the parent, so
--   preflight's `vector models` reports the thought at the target and
--   db/reembed.ts's pool — the rows not at the target — skips it. Old-model
--   windows under a parent that says it is at the new model, and no reader
--   able to tell. 021's header said so ("A re-capture through the 3-argument
--   form … leaves 007's chunk rows as they were, which predates this
--   migration and is not changed by it"); this migration changes it.
--
-- The rule: the chunks follow the vector, as the label does (021)
--   A caller that sends a vector and no chunks has said this text needs no
--   windows — a wider window, or a writer that never makes them. A caller
--   that sends no vector (a metadata-only re-capture, an older server's
--   dedup path) keeps the row's vector, its label, and its windows. The
--   3-argument body below is 021's, byte for byte — 005's guard, 008's actor,
--   021's label in the INSERT and its ON CONFLICT clause — plus one block
--   after the INSERT:
--
--     IF p_embedding IS NOT NULL THEN
--       DELETE FROM thought_chunks WHERE thought_id = v_id;
--     END IF;
--
--   This is the wholesale replacement the other two writers already do:
--   007's 4-argument form deletes every chunk row before inserting the
--   caller's, and update_thought with content and p_chunks NULL deletes them
--   all. The three writers now agree, and 021's sentence about the chunks —
--   "where they were written the parent's label is theirs" — is unconditional
--   again: a chunk row exists only under the vector it was written with.
--
--   Considered and not done: keeping the windows when the old and new labels
--   agree (same model, still-valid vectors). A chunk row carries no model and
--   no time, the label may be NULL on either side (unknown), and
--   update_thought does not do it — a chunkless edit through the tool drops
--   the windows whatever the model. The honest reading of a chunkless capture
--   is the last writer's judgement that the text needs no windows; a thought
--   the Edge server re-captures looks, afterwards, like one it captured.
--
-- Cost
--   One DELETE per capture that carries a vector, bounded by thought_id on
--   007's thought_chunks_thought_id_idx. On a fresh insert — nearly every
--   capture — it finds nothing. plpgsql cannot tell ON CONFLICT's UPDATE from
--   the INSERT without reading xmax, and the probe is cheaper than the
--   distinction. Measured at 1,024 dimensions, 2,000 operations per line,
--   two rounds each at 021 and at 022 on the same container: fresh
--   3-argument captures 0.9–1.4 ms each before and 1.2–1.4 ms after;
--   re-captures 1.3–1.6 ms before and 1.2–1.4 ms after; re-captures with no
--   vector 0.35–0.46 ms before and 0.32–0.38 ms after. The difference is
--   inside the run-to-run spread, on either side of it.
--
-- Not the 4-argument form
--   It delegates to this one (007: "so fingerprinting and conflict handling
--   live in one place") and then does its own DELETE and INSERT, so it now
--   inherits this DELETE and its own becomes a second, empty probe. It is not
--   redefined here: fewer bodies carried, and 013 stays its last definer.
--
-- No backfill
--   A chunk row left behind before this migration cannot be told from a live
--   one — no model, no timestamp — so nothing here removes any. From this
--   migration on, no new stale set is left. For rows left earlier, a
--   db/reembed.ts pass under a --job key pools every thought and regenerates
--   its windows through update_thought; a pass under the model's own key
--   reaches only the thoughts not at the target, which — after a chunkless
--   re-capture by a server at the target — a thought with stale windows is
--   not.
--
-- The sentinel
--   The body carries `ob1:vector-replaces-chunks`, a CONTRACT SENTINEL in
--   014's convention (`ob1:filter-inside-scan`, `ob1:unchanged-edit-not-
--   duplicate`): preflight's `atomic capture` check reads the 3-argument
--   body and warns when the sentinel is absent — 021 re-applied by hand puts
--   021's body back, CREATE OR REPLACE and all, and nothing else would say
--   so. db/test-schema.ts [23] asserts the sentinel is in the shipped body.
--
-- What a successor must carry
--   Everything 021 listed for this body — 005's non-object guard, 008's
--   ob1.actor, p_payload->>'embedding_model' in the INSERT and its ON
--   CONFLICT clause — and now the chunk DELETE under `p_embedding IS NOT
--   NULL`, with the sentinel. SMD-1043 (the advisory lock in both inserting
--   overloads, and 016's content_fingerprint_of in place of the inline hash)
--   is the next redefinition and takes both from here.
--
-- Safety
--   * Additive. No column added, altered or dropped; no signature changed;
--     no DROP. The one DELETE is bounded to the row being captured, inside the
--     function, and runs only when a vector arrives.
--   * Idempotent. CREATE OR REPLACE of one function; COMMENT re-issued.
--
-- Prerequisites
--   Migration 021 (the body this carries) and 007 (thought_chunks). Applied
--   by `bun db/migrate.ts`.
--
-- Expected outcome
--   Three upsert_thought overloads, as before; a chunkless re-capture with a
--   vector leaves the thought with no chunk rows; preflight's `atomic capture`
--   reports the body is 022's.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- upsert_thought(text, jsonb, vector) — 021's body, and the chunks follow the
-- vector. Repeated in full because CREATE OR REPLACE has no partial form; the
-- only addition is the block after the INSERT.
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

  -- ob1:vector-replaces-chunks — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `atomic capture` check reads it. 022: the chunks
  -- follow the vector, as the label does. A vector arriving through this form
  -- came with no windows, so the windows of the vector before it go; no vector
  -- keeps the row's vector, label and windows alike. On a fresh insert this
  -- finds nothing. The 4-argument form delegates here and then writes the
  -- caller's windows; update_thought does the same for an edit.
  IF p_embedding IS NOT NULL THEN
    DELETE FROM thought_chunks WHERE thought_id = v_id;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector) IS
  'Atomic capture: content + metadata + embedding in one statement. Reads p_payload.actor, if present, into the ob1.actor transaction setting so the audit trigger can attribute the write on either store, and p_payload.embedding_model, if present, into thoughts.embedding_model beside the vector (021); on a re-capture the label follows the vector — kept with a kept vector, the caller''s with a new one — and so do the chunk rows (022): a vector arriving through this form removes the thought''s windows, none arriving keeps them.';
