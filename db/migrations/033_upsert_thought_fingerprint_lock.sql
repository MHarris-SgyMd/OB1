-- ============================================================================
-- 033 — a capture takes the fingerprint lock too, and every writer takes it
--        before its row: writers of one text are serialised whichever
--        function they come through (SMD-1043)
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
--   1. Both inserting upsert_thought overloads take the fingerprint lock —
--      PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0)) —
--      BEFORE anything reads or writes the row the text lands on: before
--      022's FOR NO KEY UPDATE label read in the 3-argument form, before the
--      INSERT in both. Spelled exactly as 018 spells it (test-schema [33]
--      holds the three bodies to one spelling), so the same key is the same
--      lock. 013's 4-argument form delegates to the 3-argument body and is
--      not redefined.
--   2. update_thought takes the same lock BEFORE its row read, whenever
--      content arrives — not after it and only when the row does not already
--      own the key, as 018 wrote. 018's shortcut stays for the second hash
--      and the lookup (a row that owns the key has nothing to look up); only
--      the lock is unconditional and early. This is what makes the order
--      below one order for every writer; without it the first review pass
--      of this change reproduced a four-transaction deadlock (see "Lock
--      order"). 032's body otherwise verbatim, under 032's signature — no
--      DROP is needed for that, but 032's DROP of the 8- and 7-argument forms
--      with the ACL replayed is carried, so a brain where 021 or 018 was
--      re-applied by hand over 032 is left with one function by this file
--      too, and test-schema's restore of the last definer means what it did.
--   3. The 3-argument form takes 029/032's supersession lock —
--      pg_advisory_xact_lock(hashtext('ob1:supersession-review')) — when the
--      envelope names a supersedes, first of all, so a re-capture filling a
--      NULL pointer is ordered against update_thought's walk and the review
--      path's write.
--   4. The 3-argument form validates derived_from through 032's
--      validate_derived_from and both forms hash through 016's
--      content_fingerprint_of: 025's inline copy of the element rule and the
--      last two inline copies of the hash rule are gone. The refusals are
--      validate_derived_from's, without the `upsert_thought:` prefix 025's
--      carried; the supersedes shape check keeps its own message and its
--      prefix, as it had.
--   5. The 2-argument form reads p_payload.actor into ob1.actor as the
--      3-argument form has since 008. It never did — 008 redefined only the
--      3-argument body — so a capture through PostgREST's two-step fallback,
--      the one caller of this form, wrote an unattributed audit row. The one
--      thing here that is not a lock.
--   Otherwise the three bodies are carried forward verbatim: upsert_thought's
--   005 guard, 021 label in the INSERT and its ON CONFLICT clause, 022 label
--   read with its FOUND and the chunk DELETE under its condition, the
--   ob1:vector-replaces-chunks sentinel, 025 envelope read and its two
--   columns; update_thought's everything 032 listed.
--
-- Lock order
--   Every writer of thoughts acquires in ONE order — supersession lock,
--   fingerprint lock, row — or a suffix of it, and takes at most one of each:
--     * a capture naming supersedes: supersession → fingerprint → the row
--       the text lands on (FOR NO KEY UPDATE, or the INSERT's own lock);
--     * a capture without: fingerprint → row;
--     * update_thought with content: supersession (when supersedes is named)
--       → fingerprint → the edited row; without content: supersession → row;
--     * review_supersession_proposal (032): the proposal row FOR UPDATE →
--       supersession → the superseding row → update_thought without content,
--       re-entrant on both (reject locks the superseding row with no
--       advisory lock).
--   The FK check a supersedes write makes takes FOR KEY SHARE on the target
--   row last, and KEY SHARE does not conflict with FOR NO KEY UPDATE (032).
--   Among these writers — every capture, every edit, the review path — one
--   total order over the lock classes and one lock of each class per
--   transaction: no two of them can each hold what the other waits for.
--   OUTSIDE the order, and stated (the second review pass): delete_thought
--   (009) takes no advisory lock, and its DELETE holds the row FOR UPDATE
--   while 029's ON DELETE CASCADE reaches the proposals that name it. An
--   acceptance holding the proposal row and asking KEY SHARE on the deleted
--   thought, against a delete holding that thought and asking the proposal
--   row, is a cycle of two shipped functions — reproduced 23 times in 40
--   against a real server, pre-existing since 029/032, and SMD-1462's: the
--   delete takes the supersession lock first there. A plain edit naming
--   supersedes does not cross it (0 in 60): the delete's SET NULL cascade
--   (025's FK) does wait on the edited row, but the edit takes KEY SHARE on
--   the target only when it CHANGES the pointer — Postgres skips the FK
--   check for an unchanged value — and a changed pointer names another row
--   than the one being deleted, so the two never hold what the other waits
--   for. (A target deleted between the walk and the UPDATE surfaces as
--   23503, not SUPERSEDES_NOT_FOUND — SMD-1462 carries that too.)
--
--   Why the edit's order moved. The first version of this file took the
--   capture's locks fingerprint → row and left 018's edit at row →
--   fingerprint, and argued the two cannot cross in a pair: the row a capture
--   waits for under the lock for X is the row that OWNS X, and an edit of
--   that row into X skips the lock (018's rule). True of any two
--   transactions, and this change's first review pass reproduced a cycle of
--   FOUR: R owns Y and R' owns X; edit(R → X) holds R and waits on the lock
--   for X; capture(X) holds that lock and waits on R' (its label read);
--   edit(R' → Y) holds R' and waits on the lock for Y; capture(Y) holds that
--   lock and waits on R. Two edits swapping two rows' texts while both texts
--   are re-captured, all within one statement's duration — rare, but a hard
--   cycle Postgres breaks with 40P01 in one of the four, where nothing before
--   this file could deadlock at all (the captures held no advisory lock).
--   With the edit taking the fingerprint lock first there is no order left
--   to cross. db/test-live.ts [6f] runs the four by hand in 018's order and
--   gets the deadlock, then through the shipped functions and does not.
--
--   Under READ COMMITTED — the default, and what every caller here runs at,
--   as 018's and 023's headers say — each statement takes a fresh snapshot,
--   so a waiter's label read and INSERT run after the holder's commit and see
--   its row: 022's rule applies where 022 said the lock was needed for it to.
--   023's LOCK TABLE … IN EXCLUSIVE MODE is a table lock, ordered against
--   every INSERT and row lock and not against an advisory lock, and the
--   backfill takes no advisory lock: a capture holding the fingerprint lock
--   and waiting on the table, or a backfill holding the table while a
--   capture waits on the fingerprint lock, cannot deadlock (the review pass
--   ran the three-way with the backfill as well: clean).
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
--   no vector and is not a capture path this server uses). And a caller that
--   wraps several calls in one transaction holds every lock its earlier calls
--   took, as 018 said; no shipped caller does.
--
-- The sentinel
--   Both capture bodies carry `ob1:capture-takes-fingerprint-lock`, a
--   CONTRACT SENTINEL in 014's convention: preflight's `atomic capture` reads
--   it over a direct connection and warns without it — 025 or any earlier
--   file re-applied by hand puts an unlocked body back, CREATE OR REPLACE and
--   all, and nothing else would say so. A successor that keeps the lock
--   keeps the sentinel; one that drops the lock must drop it. update_thought
--   keeps 018's `ob1:unchanged-edit-not-duplicate`; its lock order has no
--   sentinel (032 re-applied by hand puts the row → fingerprint order back,
--   which is 032's behaviour and the rare cycle above — a hand re-apply, the
--   class SMD-1451 covers, and test-schema [33] reads the order by position).
--
-- Cost
--   One advisory lock acquire per capture, and one per edit with content
--   (018 took it for every edit that would take a new key; the rows a
--   re-embed pass visits own theirs, so those gain one): a hash table entry
--   in shared memory, no I/O. Captures measured at 1,024 dimensions, 2,000
--   operations per line, alternating arms each on a fresh schema, the cold
--   first arm discarded: a fresh 2-argument capture 0.80 ms at 032 against
--   0.39 and 0.68 ms at 033; a fresh 3-argument capture with a vector 5.8 ms
--   against 5.0 and 5.7 ms (the HNSW insert is the cost); a re-capture
--   without a vector 2.3–2.7 ms against 2.0–3.0 ms; with a vector at the same
--   label 2.2–2.6 ms against 2.2–3.4 ms. Inside the run-to-run spread on
--   every line (FORK.md change 62 has the design).
--   One cost is not per operation but a ceiling (third review pass): a
--   capture NAMING supersedes holds the one brain-wide supersession key from
--   before its label read to commit — through the HNSW insert — so such
--   captures have no parallelism among themselves: 200 concurrent at 1,024
--   dimensions took 1,388 ms, 6.9 ms each, the serial per-call cost; 50
--   concurrent ran 3.4–4.4× slower than the same 50 without supersedes.
--   About 145 pointer-naming captures a second at the shipped width,
--   whatever the worker count. A fresh row cannot close a loop — only the
--   ON CONFLICT fill can — but which of the two a capture is becomes known
--   only under the fingerprint lock, and the supersession lock must come
--   before it (update_thought's order); SMD-1453 holds whether the fill
--   should stay, and with it whether this lock stays on the capture path.
--
-- Safety
--   * Additive. No column, no signature change (CREATE OR REPLACE under the
--     three existing signatures, so each form's ACL is kept), no table
--     change, no data change, no backfill. update_thought's older forms are
--     dropped IF EXISTS with the ACL replayed — 032's block, which finds
--     nothing to do on a brain at 032.
--   * Idempotent: a re-run replaces the bodies with themselves and re-issues
--     the COMMENTs.
--   * Privileges: SECURITY INVOKER as before; the 3-argument form still needs
--     DELETE on thought_chunks (022). No GRANT.
--   * 018's file is applied and hashed by the ledger, so its header and its
--     COMMENT stay as written; the COMMENTs on update_thought and
--     validate_derived_from are re-issued here without the clauses this file
--     makes false, and db/README.md, reembed.ts and FORK.md move.
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
--   `ob1:capture-takes-fingerprint-lock` sentinel in both bodies.
--
-- What a successor to update_thought must carry
--   Everything 032 listed, with one line moved: the fingerprint lock is taken
--   before the row read whenever p_content is given, not inside the
--   not-owned branch after it. A successor under a NEW signature must drop
--   the 9-argument form first with its ACL replayed, as 032 dropped the
--   8-argument one; one under the same signature carries the DROP block for
--   the older forms as this file does.
--
-- Callers
--   Nothing changes its call. preflight's `atomic capture` names this file as
--   the last definer of both capture forms and reads the sentinel; `edit
--   signature` is unchanged (the signature is 032's); test-schema [33],
--   test-live [6e] and [6f], and test-upgrade [12] hold the behaviour;
--   reembed.ts's header and db/README.md no longer say the lock covers edits
--   only.
--
-- Prerequisites
--   016 (content_fingerprint_of), 025 (the 3-argument body this carries, the
--   columns), 032 (validate_derived_from, the update_thought body this
--   carries, the review function). Applied by `bun db/migrate.ts`.
--
-- Expected outcome
--   Three upsert_thought overloads and one update_thought as before. A
--   capture of text X while an edit to X is in flight waits on the advisory
--   lock and then merges; the edit, if it came second, is told
--   DUPLICATE_CONTENT rather than raising. Four writers on two texts finish.
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
  -- fingerprint lock. The same order as update_thought's and a prefix of
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

COMMENT ON FUNCTION validate_derived_from(jsonb) IS
  'The derived_from rule (025): NULL, JSON null and [] are NULL; otherwise a JSON array whose every element is a UUID string naming an existing thought, returned lowercased, de-duplicated and sorted, or an exception. Both writers call it — update_thought since 032, upsert_thought since 033. Migration 032 / SMD-1323.';

-- ---------------------------------------------------------------------------
-- update_thought: 032's body with the fingerprint lock moved before the row
-- read. 032's ACL capture and DROP of the older forms are carried so that a
-- brain where 021 or 018 was re-applied by hand ends with one function here
-- too — see 032's header for the mechanism; on a brain at 032 the setting is
-- empty and the DROPs find nothing.
-- ---------------------------------------------------------------------------
SELECT set_config('ob1.acl_update_thought',
                  CASE WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb)') IS NOT NULL THEN ''
                       WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)') IS NOT NULL THEN
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)')), '')
                       ELSE
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb)')), '') END,
                  false);

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
  -- value sets it. Defaulted, so every 8-argument caller resolves here now
  -- that the 8-argument form is gone.
  p_provenance         jsonb       DEFAULT NULL
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
  -- connection; set before the UPDATE so the AFTER trigger sees it.
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;

  -- 032: a supersedes write is serialised with every other on 029's lock,
  -- taken BEFORE the row lock — see "Lock order" in 033's header — so the
  -- walk below reads committed pointers. Re-entrant: review_supersession_proposal
  -- holds it already when it calls here.
  IF v_supersedes IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));
  END IF;

  -- 033: the fingerprint lock BEFORE the row, whenever content arrives — the
  -- order every capture takes since this migration, so no writer holds a row
  -- while waiting on a fingerprint lock another writer holds while waiting
  -- on a row. 018 took it after the row read and only when the row did not
  -- already own the key; the second hash and the lookup still skip that
  -- case below, the lock does not. 003's rule, through 016's function: a
  -- fingerprint computed differently here would silently stop matching the
  -- ones capture writes.
  IF p_content IS NOT NULL THEN
    v_fingerprint := content_fingerprint_of(p_content);
    PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));
  END IF;

  -- The row lock: what "unchanged" is decided against below is the row as it
  -- is NOW, and stays so until this transaction ends. Without the lock a
  -- caller passing no if_unchanged_since could read text X, have another edit
  -- commit Y, and write X back over it as an "unchanged" edit that 013 would
  -- have refused. FOR NO KEY UPDATE, not 018's FOR UPDATE (032): the
  -- supersedes write below takes FOR KEY SHARE on the target row, which FOR
  -- UPDATE on that row — another edit of it, waiting on a fingerprint lock
  -- this one holds — would deadlock with. Two edits of one row still
  -- serialise, and delete_thought still waits.
  SELECT * INTO v_existing FROM thoughts WHERE id = p_id FOR NO KEY UPDATE;
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
      -- same-text re-save through the tool. (The lock above is held anyway
      -- since 033: one order for every writer.)
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
    -- 032: each provenance column moves only when the envelope names its key
    -- — to the value given, NULL included.
    supersedes          = CASE WHEN v_set_supersedes THEN v_supersedes ELSE supersedes END,
    derived_from        = CASE WHEN v_set_derived    THEN v_derived    ELSE derived_from END,
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

-- 032's ACL replay onto the 9-argument form, verbatim, from whichever older
-- form the capture above read — nothing on a brain that already had the
-- 9-argument form (CREATE OR REPLACE keeps its ACL).
DO $acl$
DECLARE
  v_acl  text := current_setting('ob1.acl_update_thought', true);
  v_item record;
BEGIN
  IF v_acl IS NULL OR v_acl = '' THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb) FROM PUBLIC';
  FOR v_item IN
    SELECT DISTINCT a.grantee FROM pg_proc p, aclexplode(p.proacl) AS a
    WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb)') AND a.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb) FROM %s', quote_ident(pg_get_userbyid(v_item.grantee)));
  END LOOP;
  FOR v_item IN SELECT grantee, privilege_type, is_grantable FROM aclexplode(v_acl::aclitem[]) LOOP
    IF v_item.privilege_type = 'EXECUTE' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb) TO %s%s',
                     CASE WHEN v_item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_item.grantee)) END,
                     CASE WHEN v_item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END IF;
  END LOOP;
END
$acl$;

-- update_thought's COMMENT, re-issued without the clause 018 wrote and 021
-- and 032 carried — "captures through upsert_thought are not" — which this
-- file makes false, and with the lock order it now has. 018's file is hashed
-- by the ledger and stays as written.
COMMENT ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb) IS
  'Edit a thought by id. Recomputes content_fingerprint and replaces chunks — with their context — when content changes; an edit whose text normalises to what the row holds is never DUPLICATE_CONTENT, and reports duplicate_of when another row holds that text (a pair from before migration 003), or fingerprint_held_by when a row holds the key under other text, leaving this row''s fingerprint NULL. Every edit with content takes the fingerprint advisory lock (READ COMMITTED) — the one every capture through upsert_thought takes since 033 — and then locks the row FOR NO KEY UPDATE (032; FOR UPDATE until then, which the supersedes write''s FK check could deadlock with); both locks are held until the caller''s transaction ends, refusals included. Checks if_unchanged_since as a predicate in the UPDATE, so the guard is atomic. p_embedding_model (021) is written to thoughts.embedding_model beside the vector — the label follows the vector: untouched without content, NULL with content and no vector. p_provenance (032) is the envelope {"supersedes": uuid|null, "derived_from": [uuid…]|null}: an absent key leaves the column, a JSON null clears it, a value sets it — derived_from validated by validate_derived_from, supersedes an existing thought that closes no loop, the write serialised with review_supersession_proposal''s. Returns {ok:false, error} for NOT_FOUND | STALE_READ | DUPLICATE_CONTENT | SUPERSEDES_NOT_FOUND | WOULD_CYCLE.';
