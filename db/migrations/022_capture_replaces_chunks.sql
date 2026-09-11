-- ============================================================================
-- 022 — a re-capture's windows stay while the label vouches for them, and go
--       when it does not
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
--   read and the row LOCKED before the write, when a vector arrives, and one
--   block after it:
--
--     IF p_embedding IS NOT NULL THEN
--       SELECT embedding_model INTO v_old_label
--         FROM thoughts WHERE content_fingerprint = v_fingerprint FOR NO KEY UPDATE;
--       v_existed := FOUND;
--     END IF;
--     INSERT … ON CONFLICT … DO UPDATE … RETURNING id INTO v_id;
--     IF p_embedding IS NOT NULL AND v_existed
--        AND (v_old_label = p_payload->>'embedding_model') IS NOT TRUE THEN
--       DELETE FROM thought_chunks WHERE thought_id = v_id;
--     END IF;
--
--   Locked, because the label must be the label of the row the INSERT lands
--   on. Under READ COMMITTED, ON CONFLICT DO UPDATE lands on whatever row
--   holds the fingerprint WHEN IT RUNS — a row another transaction committed
--   after this one's snapshot included — so a label read without the lock
--   could be the row's label before a concurrent edit that changed it (an
--   update_thought at model B writing B's windows, then this capture reading
--   "A" and removing them; the first version of this migration read it in a
--   CTE, and its second review pass found this). Locked, a writer to the
--   same text is waited for, or waits: update_thought locks the row FOR
--   UPDATE (018), which conflicts with this lock, so the two are ordered
--   either way. FOR NO KEY UPDATE, not FOR UPDATE: every foreign key onto
--   thoughts(id) — thought_chunks, thought_work_claims, 016's mention and
--   edge tables — holds FOR KEY SHARE on the parent row while its inserting
--   transaction is open, and FOR UPDATE is the one row lock that conflicts
--   with it. db/reembed.ts enqueues a whole corpus in one transaction, so
--   with FOR UPDATE a re-capture of any existing text waited out the entire
--   enqueue (measured by the third review pass: 4 s against a small held
--   enqueue, 1 ms with this lock — the same as 021's plain INSERT, which
--   takes FOR NO KEY UPDATE itself because no key column is set).
--
--   v_existed — the row was there to lock — bounds the DELETE to a
--   re-capture. Without it the DELETE ran on every fresh insert too, finding
--   nothing but needing the privilege (Postgres checks it before it looks
--   for rows), and two shapes the row lock cannot cover became destructive:
--     * two FIRST captures of one text racing, one with windows and one
--       without — the second's SELECT finds nothing, its INSERT waits on the
--       first's speculative insert and updates the first's row;
--     * an update_thought MOVING another row onto this text — its new
--       fingerprint is not in this transaction's snapshot, the SELECT finds
--       nothing, the INSERT waits on the unique index and lands on the row
--       the edit just gave windows to.
--   In both the label read is NULL — nothing was found — and a DELETE keyed
--   on it would have removed windows another writer had just committed, at
--   the same model as well as another. With v_existed false nothing is
--   removed: the other writer's windows stay, which is exactly 021's
--   behaviour, and at another model the SMD-1175 state — for that race only.
--   SMD-1043's advisory lock on the fingerprint, which update_thought already
--   takes and which serialises captures of one text before either inserts,
--   closes both shapes by making the SELECT find the row; it is that
--   ticket's mechanism, not this one's. Otherwise `(v_old_label = new) IS
--   NOT TRUE` is the whole condition: NULL on either side, or a different
--   model.
--
--   Two consequences of "unknown vouches for nothing", decided on purpose:
--     * A row 021 left unlabelled — every pre-021 vector no finished pass
--       vouched for, on a brain upgraded through 021 that has not yet run
--       one — loses its windows on its first chunkless re-capture at ANY
--       model, the same one included. The alternative, keeping them when
--       the old label is unknown, would leave the windows of a pre-021 vector
--       at the old model under a new-model label: SMD-1175's motivating case,
--       for exactly those rows. The remedy is the pass 021 already asks for
--       (db/reembed.ts under the model's own key pools the unlabelled rows,
--       labels them and rewrites their windows through update_thought), and
--       reembed.ts says how many unlabelled rows its pool holds before it
--       runs.
--     * "The same model" is 021's rule — string equality of the label, as
--       OB1_EMBEDDING_MODEL spells it, and nothing else. Two servers sharing
--       a brain that spell one model two ways ("openai/text-embedding-3-small"
--       through OpenRouter, "text-embedding-3-small" direct) are two models
--       to every reader of the column — preflight's `vector models` already
--       reports them as such — and to this rule too: each re-save from the
--       other server would remove the windows and flip the label. Spell it
--       the same, which the `vector models` warning is there to say.
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
--   Considered and not built: a trigger on thoughts — AFTER UPDATE OF
--   embedding, WHEN the vector or label changed and the old label does not
--   vouch, one DELETE — which would see the row's old label as OLD, for every
--   writer, with no lock and no sentinel. Not here: the two writers that send
--   windows (007's form, update_thought) already replace them wholesale, so
--   the trigger would run beside their DELETE on every edit and every
--   re-embedded row, and the rule is about the one writer that sends nothing
--   about the windows — a capture landing on an existing row. It also fires
--   on a raw UPDATE of the vector, which 021 leaves to the operator on
--   purpose. If a fourth writer ever needs the rule, the trigger is where it
--   goes.
--
-- Cost
--   When a vector arrives: one probe on 003's unique index — FOR NO KEY
--   UPDATE, on the row the INSERT is about to lock anyway — and, on a
--   re-capture whose label does not vouch, one DELETE bounded by thought_id
--   on 007's thought_chunks_thought_id_idx. A fresh insert runs the probe
--   and finds nothing; a capture with no vector runs neither. Measured
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
--   migration on, the three writers leave no new stale set (a raw UPDATE of
--   the vector around them is the operator's, as 021 says). For rows left
--   earlier, a
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
--   CONFLICT clause — and now the FOR NO KEY UPDATE read of the row's label
--   with its FOUND, the chunk DELETE under the condition above, and the
--   sentinel. SMD-1043 (the advisory lock in both inserting
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
--     Preflight's `chunk delete privilege` checks the connection's role over
--     a direct connection and prints the GRANT.
--   * Idempotent. CREATE OR REPLACE of one function; COMMENT re-issued.
--
-- Prerequisites
--   Migration 021 (the body this carries) and 007 (thought_chunks). Applied
--   by `bun db/migrate.ts`.
--
-- Expected outcome
--   Three upsert_thought overloads, as before. A chunkless re-capture with a
--   vector labelled with the model the row's vector is labelled with leaves
--   the thought's chunk rows as they were; one labelled with another model,
--   or with none, or over a row whose label is unknown, leaves none.
--   Preflight's `atomic capture` reports the body is 022's.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- upsert_thought(text, jsonb, vector) — 021's body, and the windows stay while
-- the label vouches for them. Repeated in full because CREATE OR REPLACE has no
-- partial form; the additions are the locked read before the INSERT and the
-- block after it.
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
  -- 022: whether a row was there to lock, and the model its vector — and so
  -- its windows — was labelled with before this write (NULL: unknown).
  v_existed     boolean := false;
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

  -- 022: the row this capture lands on, if any, locked — so the INSERT below
  -- lands on THIS row, not on one a concurrent writer commits meanwhile — and
  -- its label before the write, which says whether its windows still hold.
  -- FOR NO KEY UPDATE: ordered against update_thought's FOR UPDATE, not
  -- against the FOR KEY SHARE every foreign key onto this row holds.
  IF p_embedding IS NOT NULL THEN
    SELECT embedding_model INTO v_old_label
      FROM thoughts WHERE content_fingerprint = v_fingerprint FOR NO KEY UPDATE;
    v_existed := FOUND;
  END IF;

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
  -- convention); preflight's `atomic capture` check reads it. 022: the windows
  -- stay while the label vouches for them — the row's vector was labelled
  -- with a model and the vector arriving is labelled with the same one — and
  -- go in every other case: a label unknown on either side, or another model.
  -- No vector arriving keeps vector, label and windows alike; a fresh insert
  -- runs no DELETE (v_existed), and neither does a race the lock could not
  -- cover — see the header. The 4-argument form delegates here and then
  -- writes the caller's windows; update_thought does the same for an edit.
  IF p_embedding IS NOT NULL AND v_existed
     AND (v_old_label = p_payload->>'embedding_model') IS NOT TRUE THEN
    DELETE FROM thought_chunks WHERE thought_id = v_id;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector) IS
  'Atomic capture: content + metadata + embedding in one statement. Reads p_payload.actor, if present, into the ob1.actor transaction setting so the audit trigger can attribute the write on either store, and p_payload.embedding_model, if present, into thoughts.embedding_model beside the vector (021); on a re-capture the label follows the vector — kept with a kept vector, the caller''s with a new one — and the chunk rows stay only while the label vouches for them (022): a vector arriving under the same model the row''s vector was labelled with keeps the windows, any other label — or none, on either side — removes them; no vector arriving keeps them.';
