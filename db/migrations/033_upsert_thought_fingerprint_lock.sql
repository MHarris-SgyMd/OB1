-- ============================================================================
-- 033 — a capture takes the fingerprint lock too: writers of one text are
--        serialised whichever function they come through (SMD-1043)
--
-- Why
--   018 serialised update_thought calls that would take a fingerprint key on
--   pg_advisory_xact_lock(hashtextextended(fingerprint, 0)), so two edits
--   into the same text get DUPLICATE_CONTENT (or duplicate_of) instead of
--   racing to the unique index. upsert_thought — the 2-argument body from
--   005, the 3-argument body 025 last defined, and 013's 4-argument form that
--   delegates to it — wrote content_fingerprint with no lock. So a capture of
--   text X committing while an edit to X sat between its lookup and its
--   UPDATE still raised `duplicate key value violates unique constraint
--   "idx_thoughts_fingerprint"`: at the MCP boundary as `update_thought
--   failed: …`, in db/reembed.ts as a failed claim whose remedy is
--   --retry-failed. 018's header, its COMMENT, db/README.md, reembed.ts and
--   FORK.md change 33 each carried a disclaimer scoping the lock to edits;
--   SMD-1022's second review pass counted six and said the honest fix is to
--   cover the other writer. 022's header then named two more shapes its row
--   lock cannot cover — two first captures of one text racing, and an edit
--   moving another row onto this text — where the capture's label read finds
--   no row and a re-capture's windows are left as they were; and 032's header
--   a third, a re-capture filling a NULL supersedes pointer without the
--   supersession lock. All four are the same fact: the capture path took no
--   lock a concurrent writer of the same text also takes.
--
-- What
--   1. Both inserting overloads take the fingerprint lock —
--      PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0)) —
--      BEFORE anything reads or writes the row the text lands on: before
--      022's FOR NO KEY UPDATE label read in the 3-argument form, before the
--      INSERT in both. Spelled exactly as 018 spells it (test-schema [33]
--      holds the two bodies to one spelling), so the same key is the same
--      lock. 013's 4-argument form delegates to the 3-argument body and is
--      not redefined.
--   2. The 3-argument form takes 029/032's supersession lock —
--      pg_advisory_xact_lock(hashtext('ob1:supersession-review')) — when the
--      envelope names a supersedes, first of all, so a re-capture filling a
--      NULL pointer is ordered against update_thought's walk and the review
--      path's write.
--   3. The 3-argument form validates derived_from through 032's
--      validate_derived_from and both forms hash through 016's
--      content_fingerprint_of: 025's inline copy of the element rule and the
--      last two inline copies of the hash rule are gone. The refusals are
--      validate_derived_from's, without the `upsert_thought:` prefix 025's
--      carried; the supersedes shape check keeps its own message and its
--      prefix, as it had.
--   4. The 2-argument form reads p_payload.actor into ob1.actor as the
--      3-argument form has since 008. It never did — 008 redefined only the
--      3-argument body — so a capture through PostgREST's two-step fallback,
--      the one caller of this form, wrote an unattributed audit row. The one
--      thing here that is not a lock.
--   Otherwise both bodies are carried forward verbatim: 005's non-object
--   guard, 021's label in the INSERT and its ON CONFLICT clause, 022's label
--   read with its FOUND and the chunk DELETE under its condition, the
--   ob1:vector-replaces-chunks sentinel, 025's envelope read and its two
--   columns in the INSERT and the ON CONFLICT clause.
--
-- Lock order
--   Every writer of thoughts now acquires in one order — supersession lock,
--   fingerprint lock, row — or a suffix of it:
--     * a capture naming supersedes: supersession → fingerprint → the row
--       the text lands on (FOR NO KEY UPDATE, or the INSERT's own lock);
--     * a capture without: fingerprint → row;
--     * update_thought (032): supersession (when supersedes is named) → the
--       edited row → fingerprint (when the row does not already own the key);
--     * review_supersession_proposal (032): supersession → row →
--       update_thought, re-entrant.
--   The edit takes its row before the fingerprint lock and the capture the
--   other way round, and the two cannot cross: the row a capture waits for
--   under the fingerprint lock for X is the row that OWNS X, and an edit of
--   that row into text X skips the lock — 018's rule, the unique index says
--   nobody else can hold it — while an edit of it into any other text Y
--   takes the lock for Y, not X. An edit of another row into X waits on the
--   lock the capture holds and, once the capture commits, finds its row and
--   answers DUPLICATE_CONTENT (test-live [6e]). The capture's row lock is
--   FOR NO KEY UPDATE (022), so the foreign keys' KEY SHARE never enters the
--   cycle 032 found for FOR UPDATE.
--
--   Under READ COMMITTED — the default, and what every caller here runs at,
--   as 018's and 023's headers say — each statement takes a fresh snapshot,
--   so a waiter's label read and INSERT run after the holder's commit and see
--   its row: 022's rule applies where 022 said the lock was needed for it to.
--   023's LOCK TABLE … IN EXCLUSIVE MODE is a table lock, ordered against
--   every INSERT and row lock and not against an advisory lock, and the
--   backfill takes no advisory lock: a capture holding the fingerprint lock
--   and waiting on the table, or a backfill holding the table while a
--   capture waits on the fingerprint lock, cannot deadlock.
--
-- What it closes, and what it does not
--   Closed: a capture racing an edit to the same text — the edit is told
--   DUPLICATE_CONTENT (or duplicate_of) instead of raising 23505; two first
--   captures of one text — the second finds the first's row, so 022's rule
--   decides its windows; an edit moving a row onto this text as it is
--   captured — likewise; and a capture filling a NULL pointer while an edit
--   walks the chain — ordered now, so 032's walk reads a committed pointer.
--   Not closed, and stated: a re-capture filling a NULL supersedes pointer is
--   NOT walked for a loop. A row R with no pointer, an X that supersedes R,
--   then a capture of R's text naming supersedes X, one after another with no
--   race, writes R → X → R. 025's "add if empty" never walked (029's walk was
--   the review path's and 032 moved it into update_thought); the lock orders
--   the fill against the walk, it does not add one. trace_provenance is
--   cycle-guarded, so the cost is two rows both labelled superseded; SMD-1453
--   holds whether the fill should walk, refuse, or go — 032's envelope makes
--   "go" possible now. Also unchanged: 022's "unknown vouches for nothing"
--   for a caller that sends a vector and no label (SMD-1245's question),
--   and the 2-argument form's silence on derived_from / supersedes (it takes
--   no vector and is not a capture path this server uses).
--
-- The sentinel
--   Both bodies carry `ob1:capture-takes-fingerprint-lock`, a CONTRACT
--   SENTINEL in 014's convention: preflight's `atomic capture` reads it over
--   a direct connection and warns without it — 025 or any earlier file
--   re-applied by hand puts an unlocked body back, CREATE OR REPLACE and all,
--   and nothing else would say so. A successor that keeps the lock keeps the
--   sentinel; one that drops the lock must drop it.
--
-- Cost
--   One advisory lock acquire per capture: a hash table entry in shared
--   memory, no I/O. Measured at 1,024 dimensions, 2,000 operations per line,
--   alternating arms each on a fresh schema, the cold first arm discarded: a
--   fresh 2-argument capture 0.80 ms at 032 against 0.39 and 0.68 ms at 033;
--   a fresh 3-argument capture with a vector 5.8 ms against 5.0 and 5.7 ms
--   (the HNSW insert is the cost); a re-capture without a vector 2.3–2.7 ms
--   against 2.0–3.0 ms; with a vector at the same label 2.2–2.6 ms against
--   2.2–3.4 ms. Inside the run-to-run spread on every line (FORK.md change
--   61 has the design).
--
-- Safety
--   * Additive. No column, no signature change (CREATE OR REPLACE under the
--     two existing signatures, so each form's ACL is kept), no table change,
--     no data change, no backfill.
--   * Idempotent: a re-run replaces the bodies with themselves and re-issues
--     the COMMENTs.
--   * Privileges: SECURITY INVOKER as before; the 3-argument form still needs
--     DELETE on thought_chunks (022). No GRANT.
--   * 018's file is applied and hashed by the ledger, so its header and its
--     COMMENT stay as written; the COMMENT on update_thought is re-issued
--     here without the "captures are not" clause, and db/README.md,
--     reembed.ts and FORK.md move.
--
-- What a successor to upsert_thought must carry
--   Everything 025 listed — 005's non-object guard, 008's ob1.actor (in BOTH
--   forms now), 021's embedding_model in the INSERT and its ON CONFLICT
--   clause, 022's FOR NO KEY UPDATE label read with its FOUND, the chunk
--   DELETE under its condition and the `ob1:vector-replaces-chunks` sentinel,
--   025's derived_from / supersedes read from the envelope and their two
--   columns in the INSERT and the ON CONFLICT clause — AND the fingerprint
--   lock before the label read (3-argument) and before the INSERT (both),
--   the supersession lock before it when supersedes is named,
--   validate_derived_from, content_fingerprint_of, and the
--   `ob1:capture-takes-fingerprint-lock` sentinel in both bodies. 032's
--   update_thought is the other writer; whichever is redefined next carries
--   the lock order above.
--
-- Callers
--   Nothing changes its call. preflight's `atomic capture` names this file as
--   the last definer of both forms and reads the sentinel; test-schema [33],
--   test-live [6e] and test-upgrade [12] hold the behaviour; reembed.ts's
--   header and db/README.md no longer say the lock covers edits only.
--
-- Prerequisites
--   016 (content_fingerprint_of), 025 (the 3-argument body this carries, the
--   columns), 032 (validate_derived_from). Applied by `bun db/migrate.ts`.
--
-- Expected outcome
--   Three upsert_thought overloads as before. A capture of text X while an
--   edit to X is in flight waits on the advisory lock and then merges; the
--   edit, if it came second, is told DUPLICATE_CONTENT rather than raising.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The 2-argument form: 005's body, hashing through 016, locked, attributed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_thought(p_content text, p_payload jsonb DEFAULT '{}')
RETURNS jsonb AS $$
DECLARE
  v_fingerprint text;
  v_id          uuid;
BEGIN
  -- 005's guard, carried forward verbatim.
  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_payload);
  END IF;

  -- 008's actor, as the 3-argument form has read it since then (033): the
  -- audit trigger attributes a capture through PostgREST's two-step fallback,
  -- the one caller of this form, instead of recording NULL. Transaction-local.
  IF p_payload ? 'actor' THEN
    PERFORM set_config('ob1.actor', p_payload->>'actor', true);
  END IF;

  v_fingerprint := content_fingerprint_of(p_content);

  -- ob1:capture-takes-fingerprint-lock — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `atomic capture` reads it. 033: the lock 018
  -- takes for an edit that would take this key, spelled the same, taken
  -- before the INSERT so a capture and an edit of one text are serialised
  -- and the second sees the first's committed row (READ COMMITTED).
  PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));

  INSERT INTO thoughts (content, content_fingerprint, metadata)
  VALUES (p_content, v_fingerprint, COALESCE(p_payload->'metadata', '{}'::jsonb))
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
  SET updated_at = now(),
      metadata   = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION upsert_thought(text, jsonb) IS
  'Capture without a vector: content + metadata, merged into the row holding the same normalised text. Reads p_payload.actor (008, here since 033) for the audit trigger. Takes the fingerprint advisory lock before the write (033), the one update_thought takes, so a capture and an edit of one text are serialised (READ COMMITTED). Refuses a non-object payload (005). Called by PostgREST clients by name and the two-step capture fallback; the servers capture through the 3- and 4-argument forms.';

-- ---------------------------------------------------------------------------
-- The 3-argument form: 025's body, the two locks before the read, one rule
-- each for the hash and for derived_from
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
  -- 025: the provenance the envelope carries, if any.
  v_derived     jsonb;
  v_supersedes  text  := p_payload->>'supersedes';
BEGIN
  /**
   * Migration 005's guard, carried forward verbatim.
   *
   * This is the trap in redefining a function from a later migration: CREATE OR
   * REPLACE takes the whole body, so every change made to it in between is
   * silently reverted. Writing 008 without the check dropped 005's validation
   * and db/test-schema.ts caught it immediately — which is the only reason it
   * is here. Anything that redefines upsert_thought again must carry this,
   * and the audit setting below, forward too.
   */
  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_payload);
  END IF;

  -- 025: derived_from is validated HERE — the write is the choke point, or an
  -- untrusted-input hole (SMD-1253, departure 3). 033: through 032's
  -- validate_derived_from, the one copy of the rule — NULL, JSON null and []
  -- come back NULL; otherwise an array of UUID strings naming thoughts that
  -- exist, canonicalised, or one of its three exceptions.
  v_derived := validate_derived_from(p_payload->'derived_from');

  -- 025: supersedes existence is the self-FK's job; check only its SHAPE here,
  -- so a bad string fails with a message about supersedes rather than a raw
  -- uuid cast error, and the FK reports a missing target.
  IF v_supersedes IS NOT NULL
     AND v_supersedes !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION
      'upsert_thought: supersedes must be a thought UUID string, got %.', v_supersedes;
  END IF;

  -- Transaction-local, so it cannot outlive this call on a pooled connection.
  -- Set before the INSERT so the AFTER trigger sees it.
  IF p_payload ? 'actor' THEN
    PERFORM set_config('ob1.actor', p_payload->>'actor', true);
  END IF;

  v_fingerprint := content_fingerprint_of(p_content);

  -- 033: the supersession lock (029, 032) FIRST when a pointer may be written
  -- — a re-capture fills a NULL one below — so the fill is ordered against
  -- update_thought's cycle walk and the review path's write; then the
  -- fingerprint lock. The same order as 032's update_thought and a prefix of
  -- every writer's (see the header).
  IF v_supersedes IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));
  END IF;

  -- ob1:capture-takes-fingerprint-lock — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `atomic capture` reads it. 033: the lock 018
  -- takes for an edit that would take this key, spelled the same. Taken
  -- BEFORE the label read, so a concurrent writer of this text — an edit
  -- taking the key, a first capture racing this one, an edit moving another
  -- row onto it — has committed before the read runs and the read finds its
  -- row (READ COMMITTED: a fresh snapshot per statement); without it those
  -- three found no row, and a re-capture's windows were left as they were.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));

  -- 022: the row this capture lands on, if any, locked — so the INSERT below
  -- lands on THIS row, not on one a concurrent writer commits meanwhile — and
  -- its label before the write, which says whether its windows still hold.
  -- FOR NO KEY UPDATE: ordered against update_thought's row lock, not
  -- against the FOR KEY SHARE every foreign key onto this row holds.
  IF p_embedding IS NOT NULL THEN
    SELECT embedding_model INTO v_old_label
      FROM thoughts WHERE content_fingerprint = v_fingerprint FOR NO KEY UPDATE;
    v_existed := FOUND;
  END IF;

  -- 021: the label is written beside the vector, from the envelope; NULL when
  -- the caller named none (an older server), which is a vector of unknown model.
  -- 025: derived_from and supersedes are written beside them, validated above.
  INSERT INTO thoughts (content, content_fingerprint, metadata, embedding, embedding_model, derived_from, supersedes)
  VALUES (
    p_content,
    v_fingerprint,
    COALESCE(p_payload->'metadata', '{}'::jsonb),
    p_embedding,
    CASE WHEN p_embedding IS NULL THEN NULL ELSE p_payload->>'embedding_model' END,
    v_derived,
    v_supersedes::uuid
  )
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
    SET updated_at = now(),
        metadata   = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
        embedding  = COALESCE(EXCLUDED.embedding, thoughts.embedding),
        -- The label follows the vector (021): kept with a kept vector, the
        -- caller's with a new one — NULL if the caller named none.
        embedding_model = CASE WHEN EXCLUDED.embedding IS NULL THEN thoughts.embedding_model
                               ELSE EXCLUDED.embedding_model END,
        -- 025: a re-capture of the same text may ADD provenance the row did not
        -- have, but never CHANGES or clears what is there — the EXISTING value
        -- wins (COALESCE(thoughts.x, EXCLUDED.x)), so it fills a NULL and is
        -- otherwise left alone. A dedup of identical content is not the place to
        -- rewrite an established derivation; removing or changing provenance is
        -- update_thought's, through its p_provenance envelope (032), and is
        -- audited. 033: the fill runs under the supersession lock and is not
        -- walked for a loop — see the header.
        derived_from = COALESCE(thoughts.derived_from, EXCLUDED.derived_from),
        supersedes   = COALESCE(thoughts.supersedes,   EXCLUDED.supersedes)
  RETURNING id INTO v_id;

  -- ob1:vector-replaces-chunks — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `atomic capture` check reads it. 022: the windows
  -- stay while the label vouches for them — the row's vector was labelled
  -- with a model and the vector arriving is labelled with the same one — and
  -- go in every other case: a label unknown on either side, or another model.
  -- No vector arriving keeps vector, label and windows alike; a fresh insert
  -- runs no DELETE (v_existed). The 4-argument form delegates here and then
  -- writes the caller's windows; update_thought does the same for an edit.
  IF p_embedding IS NOT NULL AND v_existed
     AND (v_old_label = p_payload->>'embedding_model') IS NOT TRUE THEN
    DELETE FROM thought_chunks WHERE thought_id = v_id;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector) IS
  'Atomic capture: content + metadata + embedding in one statement. Reads p_payload.actor (008), p_payload.embedding_model (021), and p_payload.derived_from / p_payload.supersedes (025) from the envelope. derived_from is validated by validate_derived_from — an array of existing thought UUIDs, or the write is refused (SMD-1253); supersedes'' existence is the self-FK''s. Takes the fingerprint advisory lock before the write (033), the one update_thought takes, so a capture and an edit of one text are serialised (READ COMMITTED) — and the supersession lock first when supersedes is named. On a re-capture the label follows the vector, the chunk rows stay only while the label vouches for them (022), and provenance is added if given but never cleared.';

-- ---------------------------------------------------------------------------
-- update_thought's COMMENT, re-issued without the clause 018 wrote and 021
-- and 032 carried — "captures through upsert_thought are not" — which this
-- file makes false. 018's file is hashed by the ledger and stays as written.
-- ---------------------------------------------------------------------------
COMMENT ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb) IS
  'Edit a thought by id. Recomputes content_fingerprint and replaces chunks — with their context — when content changes; an edit whose text normalises to what the row holds is never DUPLICATE_CONTENT, and reports duplicate_of when another row holds that text (a pair from before migration 003), or fingerprint_held_by when a row holds the key under other text, leaving this row''s fingerprint NULL. The row is locked FOR NO KEY UPDATE (032; FOR UPDATE until then, which the supersedes write''s FK check could deadlock with) and edits that would take a key the row does not own are serialised on an advisory lock (READ COMMITTED) that every capture through upsert_thought takes as well since 033; both locks are held until the caller''s transaction ends, refusals included. Checks if_unchanged_since as a predicate in the UPDATE, so the guard is atomic. p_embedding_model (021) is written to thoughts.embedding_model beside the vector — the label follows the vector: untouched without content, NULL with content and no vector. p_provenance (032) is the envelope {"supersedes": uuid|null, "derived_from": [uuid…]|null}: an absent key leaves the column, a JSON null clears it, a value sets it — derived_from validated by validate_derived_from, supersedes an existing thought that closes no loop, the write serialised with review_supersession_proposal''s. Returns {ok:false, error} for NOT_FOUND | STALE_READ | DUPLICATE_CONTENT | SUPERSEDES_NOT_FOUND | WOULD_CYCLE.';
