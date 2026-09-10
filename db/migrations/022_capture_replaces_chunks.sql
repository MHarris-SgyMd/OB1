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
-- The rule: the windows stay while the label vouches for them
--   The chunk rows were written in the same call as the vector before this
--   one, by the same model (021's header: "where they were written the
--   parent's label is theirs"), and the conflict says the TEXT is the same
--   (003's fingerprint). So they are still valid evidence exactly when the
--   model is the same — and the row's label says which model that was:
--
--     * the row was labelled with a model, and the vector arriving is
--       labelled with the SAME one → the windows stay. That model's vectors
--       of windows of this text, still. A note windowed by server-portable
--       and re-saved through the Edge server, which makes no windows, keeps
--       the tail-anchored recall 007 added; a window that grew keeps the
--       windows it no longer needs, which cost nothing and answer the same.
--     * anything else — the row's label unknown (NULL: a vector from before
--       021, or a caller that named no model), the arriving label unknown,
--       or a different model → the windows go. Nothing vouches for them, or
--       the model they were written by is not the model the row is at.
--     * no vector arriving (a metadata-only re-capture, an older server's
--       dedup path) → the row keeps its vector, its label and its windows.
--
--   The 3-argument body below is 021's — 005's guard, 008's actor, 021's
--   label in the INSERT and its ON CONFLICT clause — with the row's label
--   read in the same statement as the write (a CTE the RETURNING list reads:
--   one snapshot, no window between a SELECT and the INSERT), and one block
--   after it:
--
--     IF p_embedding IS NOT NULL AND v_existed
--        AND (v_old_label IS NULL OR v_old_label IS DISTINCT FROM p_payload->>'embedding_model') THEN
--       DELETE FROM thought_chunks WHERE thought_id = v_id;
--     END IF;
--
--   Why not unconditional, as 007's 4-argument form and update_thought are.
--   Those two callers SEND windows, or send content: the 4-argument form
--   replaces the windows with the caller's, and an edit through
--   update_thought may have changed the text, so its windows are the
--   caller's to supply. A chunkless re-capture of the same text supplies
--   nothing about the windows; the first version of this migration removed
--   them whatever the model, and its first review pass showed the cost on
--   the very path the header names — a server-portable-windowed note
--   re-saved from Claude Desktop at the same model lost its ending from
--   search, silently. The label is the one fact in the row that says whether
--   the windows are still the vector's; keying on it fixes SMD-1175's case
--   (a different model) and leaves valid windows alone.
--
-- Cost
--   One DELETE per re-capture that carries a vector and whose label does not
--   vouch, bounded by thought_id on 007's thought_chunks_thought_id_idx; a
--   fresh insert (v_existed false) runs none. The CTE is one probe on 003's
--   unique index for the row the INSERT is about to find anyway. Measured
--   for the first version — the DELETE on every vectored capture, fresh
--   inserts included — at 1,024 dimensions, 2,000 operations per line, two
--   rounds each at 021 and at 022 on the same container: fresh 3-argument
--   captures 0.9–1.4 ms each before and 1.2–1.4 ms after; re-captures
--   1.3–1.6 ms before and 1.2–1.4 ms after; re-captures with no vector
--   0.35–0.46 ms before and 0.32–0.38 ms after. Inside the run-to-run
--   spread, on either side of it; this version does less.
--
-- Not the 4-argument form
--   It delegates to this one (007: "so fingerprinting and conflict handling
--   live in one place") and then deletes every chunk row and inserts the
--   caller's, whatever the label — the caller sent windows, and they are the
--   windows. It is not redefined here: fewer bodies carried, and 013 stays
--   its last definer.
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
--   duplicate`): preflight's `atomic capture` check, over a direct
--   connection, reads the 3-argument body and warns when the sentinel is
--   absent — 021 re-applied by hand puts 021's body back, CREATE OR REPLACE
--   and all, and nothing else would say so. Over PostgREST the catalog is
--   not reachable and the check says so. db/test-schema.ts [23] asserts the
--   sentinel is in the shipped body.
--
-- What a successor must carry
--   Everything 021 listed for this body — 005's non-object guard, 008's
--   ob1.actor, p_payload->>'embedding_model' in the INSERT and its ON
--   CONFLICT clause — and now the CTE reading the row's label, the chunk
--   DELETE under the condition above, and the sentinel. SMD-1043 (the
--   advisory lock in both inserting
--   overloads, and 016's content_fingerprint_of in place of the inline hash)
--   is the next redefinition and takes both from here.
--
-- Safety
--   * Additive. No column added, altered or dropped; no signature changed;
--     no DROP. The one DELETE is bounded to the row being captured, inside the
--     function, and runs only on a re-capture whose vector the label does not
--     vouch for.
--   * Privileges. The function is SECURITY INVOKER, so the DELETE runs as the
--     calling role: a role that captures must hold DELETE on thought_chunks.
--     007's 4-argument form and 009's update_thought needed it already; a
--     role that only ever captured chunklessly did not, and does from here.
--     Preflight's `atomic capture` checks the connection's role over a direct
--     connection and prints the GRANT.
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
-- upsert_thought(text, jsonb, vector) — 021's body, and the windows stay while
-- the label vouches for them. Repeated in full because CREATE OR REPLACE has no
-- partial form; the additions are the CTE the RETURNING list reads, and the
-- block after the INSERT.
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
  -- 022: whether this capture landed on a row, and the model that row's
  -- vector — and so its windows — was labelled with before the write.
  v_existed     boolean;
  v_old_label   text;
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
  -- 022: the row this capture lands on, if any, read in the same statement —
  -- its label before the write is what says whether its windows still hold.
  WITH before AS (
    SELECT embedding_model FROM thoughts WHERE content_fingerprint = v_fingerprint
  )
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
  RETURNING id, EXISTS (SELECT 1 FROM before), (SELECT embedding_model FROM before)
  INTO v_id, v_existed, v_old_label;

  -- ob1:vector-replaces-chunks — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `atomic capture` check reads it. 022: the windows
  -- stay while the label vouches for them — the row's vector was labelled
  -- with a model and the vector arriving is labelled with the same one — and
  -- go in every other case: a label unknown on either side, or another model.
  -- No vector arriving keeps vector, label and windows alike; a fresh insert
  -- has none. The 4-argument form delegates here and then writes the caller's
  -- windows; update_thought does the same for an edit.
  IF p_embedding IS NOT NULL AND v_existed
     AND (v_old_label IS NULL OR v_old_label IS DISTINCT FROM p_payload->>'embedding_model') THEN
    DELETE FROM thought_chunks WHERE thought_id = v_id;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector) IS
  'Atomic capture: content + metadata + embedding in one statement. Reads p_payload.actor, if present, into the ob1.actor transaction setting so the audit trigger can attribute the write on either store, and p_payload.embedding_model, if present, into thoughts.embedding_model beside the vector (021); on a re-capture the label follows the vector — kept with a kept vector, the caller''s with a new one — and the chunk rows stay only while the label vouches for them (022): a vector arriving under the same model the row''s vector was labelled with keeps the windows, any other label — or none, on either side — removes them; no vector arriving keeps them.';
