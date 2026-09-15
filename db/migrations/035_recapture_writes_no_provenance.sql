-- ============================================================================
-- 035 — a re-capture writes no provenance: the envelope's derived_from and
--        supersedes land on a first capture only, so the capture path can
--        never close a supersession loop and needs no supersession lock
--        (SMD-1453)
--
-- Why
--   025 let the 3-argument upsert_thought fill a NULL derived_from or
--   supersedes on a re-capture of the same text — COALESCE(thoughts.x,
--   EXCLUDED.x), "add if empty, never change" — because update_thought then
--   had no way to set provenance after the fact. It never checked whether the
--   pointer it filled closed a loop: 029's cycle walk was the review path's,
--   032 moved it into update_thought, and the capture path had none. So R
--   with no pointer, X superseding R, then a capture of R's text naming
--   supersedes X — one after another, no race — wrote R → X → R, and both
--   rows read as superseded (033's header states it; test-schema [33] wrote
--   the loop as the residue). 033 took the supersession lock around the fill
--   to order it against update_thought's walk, and measured what that lock
--   costs: a capture NAMING supersedes held the one brain-wide key from
--   before its label read to commit, HNSW insert included — 200 concurrent at
--   1,024 dimensions took 1,388 ms, 6.9 ms each, the serial cost; about 145
--   pointer-naming captures a second whatever the worker count. The lock
--   existed only for the fill: a fresh row cannot close a loop, but which of
--   the two a capture is becomes known only under the fingerprint lock, and
--   the supersession lock had to come before that one.
--
--   SMD-1453 offered three: walk the fill (a refusal on the capture path, the
--   lock and its ceiling kept), refuse the fill (a dedup of text that exists
--   raises), or drop it. This file drops it. 032's envelope has been the way
--   to set, change and clear provenance on an existing thought since change
--   60 — walked, audited, one function — so the fill's reason is gone, and a
--   rule with one owner is better than the same rule in two bodies. A capture
--   of text that is already there is a dedup: it merges metadata and, with a
--   vector, moves the vector, label and windows by 021's and 022's rules; it
--   does not decide what the existing thought derives from or replaces. And
--   the caller is TOLD, not surprised: the return carries `existed`.
--
-- What
--   1. The 3-argument form's ON CONFLICT clause no longer sets derived_from or
--      supersedes. A fresh INSERT writes both from the envelope as 025 did; a
--      re-capture leaves both columns exactly as they were, whatever the
--      envelope names. Validation is unchanged and runs before the write is
--      known to be a dedup: a malformed derived_from (one naming no thought
--      included) or a supersedes that is not a UUID string is refused either
--      way (validate_derived_from's message, 025's shape message). A
--      supersedes UUID that names no thought is the FK's to refuse, and the
--      FK runs on the INSERT only — see "What it closes".
--   2. The supersession lock leaves the capture path. 033 took
--      pg_advisory_xact_lock(hashtext('ob1:supersession-review')) first when
--      the envelope named supersedes; with no pointer ever written onto an
--      existing row there is nothing for it to order (see "Lock order").
--   3. The return says whether the row was there:
--        {"id": …, "fingerprint": …, "existed": true|false}
--      `existed` true means the metadata merged, the vector and windows moved
--      by 021/022's rules, and any provenance the envelope named was NOT
--      written. 022's label read — FOR NO KEY UPDATE on the row the text
--      lands on — runs for every capture now, not only with a vector, so the
--      flag is right for a vectorless capture too (one index probe under the
--      fingerprint lock; the chunk DELETE keeps its condition). `existed`
--      means a row HELD THIS FINGERPRINT: a legacy row with a NULL one (from
--      before 003, until 023's backfill reaches it) is not found, and the
--      capture inserts a twin — 003/023's semantics, unchanged here. 013's
--      4-argument form returns v_result || {"chunks": n}, so the key passes
--      through to both servers; the capture tool tells the caller, naming
--      update_thought's `supersedes` when supersedes was sent, and saying the
--      tools have no way to set derived_from on an existing thought when that
--      was.
--   4. The 2-argument form is carried verbatim from 033 — 005's guard, 008's
--      actor, content_fingerprint_of, the fingerprint lock, its sentinel — so
--      this file is the last definer of BOTH inserting forms and preflight's
--      `atomic capture` has one remedy for every stale state, as 033 had. It
--      takes no vector and reads no provenance (033's header says so); it
--      returns no `existed` — the two-step fallback is its one
--      caller and attaches the vector afterwards either way.
--   Otherwise the 3-argument body is 033's, verbatim: 005's guard, 008's
--   actor, 016's content_fingerprint_of, 021's label in the INSERT and its ON
--   CONFLICT clause, 022's read with its FOUND and the chunk DELETE under its
--   condition, the ob1:vector-replaces-chunks sentinel, 025's envelope read
--   and both columns in the INSERT, 032's validate_derived_from, 033's
--   fingerprint lock before the read and the ob1:capture-takes-fingerprint-
--   lock sentinel. update_thought is not redefined: 033 stays its last
--   definer, with the order 033 gave it.
--
-- Lock order
--   033's order for every writer of thoughts — supersession lock, fingerprint
--   lock, row — stands; the capture path now takes a shorter suffix of it:
--     * a capture, naming supersedes or not: fingerprint → the row the text
--       lands on (FOR NO KEY UPDATE, or the INSERT's own lock), then the FK
--       check's FOR KEY SHARE on the target when a fresh row names one;
--     * update_thought with content: supersession (when supersedes is named)
--       → fingerprint → the edited row; without content: supersession → row;
--     * review_supersession_proposal (032): the proposal row FOR UPDATE →
--       supersession → the superseding row → update_thought without content.
--   Still one total order over the lock classes and at most one lock of each
--   per transaction, so no two of these can each hold what the other waits
--   for; test-live [6f]'s four writers on two texts hold as before.
--
--   Why a capture needs no supersession lock. The lock serialises writers of
--   the supersedes column so that update_thought's walk reads pointers no
--   concurrent writer is changing. A capture now writes that column on a
--   fresh row only, and a fresh row cannot be part of a loop: a loop through
--   it needs some row's pointer to reach it, and until this transaction
--   commits no other transaction can see its id to name it (READ COMMITTED,
--   and the FK would refuse an id that is not there). A walk running
--   meanwhile reads the committed graph, which the fresh row is not yet in;
--   once it is, it is a leaf that points at an existing row. So the pointer a
--   capture writes is never one a concurrent walk needs ordering against.
--   The KEY SHARE its FK check takes on the target does not conflict with
--   update_thought's FOR NO KEY UPDATE on that row (032) and is taken last;
--   delete_thought's FOR UPDATE on the target does conflict, and the capture
--   waits for the delete and then fails its FK check — 23503, the same
--   outcome as before this file, and SMD-1462's to word.
--
--   Under READ COMMITTED, as 018, 023 and 033 require. 023's LOCK TABLE …
--   IN EXCLUSIVE MODE is ordered against the row read and the INSERT and not
--   against the fingerprint lock, and the backfill takes no advisory lock;
--   the unconditional read adds a ROW SHARE table lock the vectorless path
--   did not hold before the INSERT took its own, ordered the same way.
--
-- What it closes, and what it does not
--   Closed: the capture path cannot write a supersession loop by any
--   sequence — the residue 033 stated, [33] wrote and SMD-1453 held. A loop
--   now needs a writer outside the two functions (raw SQL). Closed with it:
--   the ceiling — a capture naming supersedes holds no brain-wide lock, so
--   such captures parallelise like any other (measured below).
--   Changed, and stated: 025's "a re-capture may add provenance the row did
--   not have" is gone. A caller that captured a thought and later wants to
--   record what it supersedes or derives from re-captures nothing: it calls
--   update_thought with the envelope (the capture tool's reply names it).
--   Changed with it: a re-capture naming a supersedes that names NO thought
--   is not refused — the FK ran only on the fill; a first capture's FK still
--   refuses one — so `existed` is true with nothing written, and
--   update_thought, the path the reply names, refuses it by name
--   (SUPERSEDES_NOT_FOUND): the caller learns one step later, not never.
--   The shape checks (a UUID string; validate_derived_from's existence
--   check for derived_from) run on a dedup as before.
--   Not closed, and not this file's: delete_thought outside the lock order
--   (SMD-1462); the 2-argument form's silence on the envelope's provenance
--   (PostgREST's two-step fallback drops it, as it has since 025); a walk
--   over derived_from — an array with no acyclicity rule anywhere, which
--   trace_provenance is cycle-guarded against (026); 022's "unknown vouches
--   for nothing" (SMD-1245).
--
-- The sentinel
--   The 3-argument body carries `ob1:re-capture-writes-no-provenance`, a
--   CONTRACT SENTINEL in 014's convention, beside 022's and 033's: preflight's
--   `atomic capture` reads it over a direct connection and warns without it —
--   033 re-applied by hand puts the fill and the supersession lock back,
--   CREATE OR REPLACE and all, and nothing else would say so. A successor
--   that keeps "a re-capture writes no provenance" keeps the sentinel; one
--   that writes provenance onto an existing row again must drop it. Both
--   bodies keep `ob1:capture-takes-fingerprint-lock` — the lock stays.
--
-- Cost
--   Less: one advisory lock acquire fewer per capture naming supersedes, and
--   the ceiling gone. Measured with 033's design — alternating arms each on a
--   fresh schema, 033, 035, 033, 035, the cold first arm discarded — at 1,024
--   dimensions, HNSW, a 300-row corpus, the SQL store with 64 connections:
--   50 concurrent captures naming supersedes against 50 naming none, medians
--   of four rounds, 292.6 vs 91.3 ms and 284.4 vs 87.7 ms at 033 (3.2×), 94.2
--   vs 79.7 ms and 73.6 vs 74.0 ms at 035 (1.2×, 1.0×); 200 concurrent naming
--   supersedes 1,650.7 and 1,358.6 ms at 033, 342.2 and 308.4 ms at 035 —
--   inside the plain arms' own spread (200 naming none: 410.9 / 317.2 ms at
--   033, 346.8 / 334.5 ms at 035); one serial capture naming supersedes 7.30 / 6.75 ms at 033,
--   7.22 / 6.27 ms at 035 — the per-call cost is the HNSW insert either way,
--   the lock only took the parallelism. 470 pointers written in every arm.
--   More: one index probe per vectorless 3-argument capture — the row read
--   that ran only with a vector runs always — under the fingerprint lock, on
--   the partial unique index; no I/O beyond the probe the INSERT's ON
--   CONFLICT arbitration makes anyway.
--
-- Safety
--   * Additive. No column, no signature change (CREATE OR REPLACE under the
--     two existing signatures, so each form's ACL is kept), no table change,
--     no data change, no backfill: a pointer a re-capture filled before this
--     file stays, loop or not. No shipped code sends supersedes on its own
--     (consolidate.ts writes through the review path), but capture_thought
--     forwards a caller's, so a loop is possible wherever a client re-captured
--     existing text naming one. To find a loop that was written: a
--     two-row one is `SELECT a.id, b.id FROM thoughts a JOIN thoughts b ON
--     b.id = a.supersedes AND b.supersedes = a.id`; update_thought's envelope
--     with {"supersedes": null} clears one side, audited.
--   * Idempotent: a re-run replaces the bodies with themselves and re-issues
--     the COMMENTs.
--   * Privileges: SECURITY INVOKER as before; the 3-argument form still needs
--     DELETE on thought_chunks (022). No GRANT.
--   * The return gains a key; nothing that reads the return breaks on an
--     extra key (both stores read `id`; 013's form appends `chunks`).
--   * 032's COMMENT on review_supersession_proposal said "a capture's
--     add-if-empty through upsert_thought aside"; 032's file is applied and
--     hashed by the ledger, so the COMMENT is re-issued here with the aside
--     replaced by the rule (a first capture sets the column on its own new
--     row; a re-capture does not touch it) and "every edit" made "every
--     write onto an existing thought", as 033 re-issued update_thought's.
--
-- What a successor to upsert_thought must carry
--   Everything 033 listed — 005's non-object guard, 008's ob1.actor in both
--   forms, 021's embedding_model in the INSERT and its ON CONFLICT clause,
--   022's FOR NO KEY UPDATE read with its FOUND and the chunk DELETE under
--   its condition and the `ob1:vector-replaces-chunks` sentinel, 025's
--   derived_from / supersedes read from the envelope and their two columns
--   in the INSERT (and NOT in the ON CONFLICT clause), validate_derived_from,
--   content_fingerprint_of, the fingerprint lock before the read (3-argument)
--   and before the INSERT (both) with the `ob1:capture-takes-fingerprint-lock`
--   sentinel in both bodies — MINUS the supersession lock, PLUS the
--   unconditional read, `existed` in the return, and the
--   `ob1:re-capture-writes-no-provenance` sentinel.
--
-- Callers
--   Nothing changes its call. server-portable/store.ts's CaptureResult gains
--   `existed`, both stores read it, and the capture tool's reply names
--   update_thought when provenance was sent and the text was already there.
--   preflight's `atomic capture` names this file as the last definer of both
--   capture forms and reads the new sentinel beside the two before it;
--   test-schema [35], test-live [6e] (arm 3: a capture naming supersedes is
--   NOT held by the supersession lock now) and [13], and test-upgrade [13]
--   hold the behaviour; db/README.md and FORK.md change 66 say what is true.
--
-- Prerequisites
--   016 (content_fingerprint_of), 025 (the columns), 032
--   (validate_derived_from), 033 (the bodies this carries). Applied by
--   `bun db/migrate.ts`.
--
-- Expected outcome
--   Three upsert_thought overloads and one update_thought as before. A
--   re-capture naming supersedes or derived_from leaves the row's provenance
--   as it was and returns existed = true; a first capture writes it and
--   returns existed = false; no capture takes the supersession lock; R → X →
--   R cannot be written through upsert_thought.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The 2-argument form: 033's body, carried verbatim so this file is the last
-- definer of both inserting forms (one remedy in preflight).
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
  'Capture without a vector: content + metadata, merged into the row holding the same normalised text. Reads p_payload.actor (008, here since 033) for the audit trigger. Takes the fingerprint advisory lock before the write (033), the one update_thought takes, so a capture and an edit of one text are serialised (READ COMMITTED). Refuses a non-object payload (005). Reads no provenance from the envelope. Called by PostgREST clients by name and the two-step capture fallback; the servers capture through the 3- and 4-argument forms. Body unchanged since 033; 035 is the last definer.';

-- ---------------------------------------------------------------------------
-- The 3-argument form: 033's body; provenance on a fresh row only, no
-- supersession lock, the row read for every capture, `existed` returned
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
  -- its windows — was labelled with before this write (NULL: unknown). 035:
  -- read for every capture, so `existed` in the return is always right.
  v_existed     boolean := false;
  v_old_label   text;
  -- 025: the provenance the envelope carries, if any — written on a fresh
  -- row only (035).
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
  -- exist, canonicalised, or one of its three exceptions. 035: validated
  -- before the write is known to be a dedup, so a bad reference is refused
  -- whether or not the text is new.
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

  -- 035: no supersession lock here. 033 took it first when the envelope named
  -- supersedes, to order the ON CONFLICT fill of a NULL pointer against
  -- update_thought's cycle walk; the fill is gone, and the pointer a fresh
  -- row writes is one no concurrent walk can reach (see the header).

  -- ob1:capture-takes-fingerprint-lock — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `atomic capture` reads it. 033: the lock 018
  -- takes for an edit that would take this key, spelled the same. Taken
  -- BEFORE the row read, so a concurrent writer of this text — an edit
  -- taking the key, a first capture racing this one, an edit moving another
  -- row onto it — has committed before the read runs and the read finds its
  -- row (READ COMMITTED: a fresh snapshot per statement); without it those
  -- three found no row, and a re-capture's windows were left as they were.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));

  -- 022: the row this capture lands on, if any, locked — so the INSERT below
  -- lands on THIS row, not on one a concurrent writer commits meanwhile — and
  -- its label before the write, which says whether its windows still hold.
  -- FOR NO KEY UPDATE: ordered against update_thought's row lock, not
  -- against the FOR KEY SHARE every foreign key onto this row holds. 035:
  -- for every capture, not only one with a vector — `existed` below.
  SELECT embedding_model INTO v_old_label
    FROM thoughts WHERE content_fingerprint = v_fingerprint FOR NO KEY UPDATE;
  v_existed := FOUND;

  -- 021: the label is written beside the vector, from the envelope; NULL when
  -- the caller named none (an older server), which is a vector of unknown model.
  -- 025: derived_from and supersedes are written beside them, validated above
  -- — on a fresh row (035).
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
                               ELSE EXCLUDED.embedding_model END
        -- ob1:re-capture-writes-no-provenance — a CONTRACT SENTINEL, not
        -- prose (the 014 convention); preflight's `atomic capture` reads it.
        -- 035: derived_from and supersedes are NOT in this SET. 025 filled a
        -- NULL one here (COALESCE(thoughts.x, EXCLUDED.x)) and never walked
        -- the pointer for a loop; a dedup of identical content is not the
        -- place to decide what the existing thought derives from or
        -- replaces. Setting, changing or clearing provenance on an existing
        -- thought is update_thought's, through its p_provenance envelope
        -- (032): walked, audited, one function. The return's `existed` tells
        -- the caller the envelope's provenance was not written.
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

  -- 035: `existed` — the text was already captured; metadata merged, vector
  -- and windows by 021/022, provenance in the envelope not written.
  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint, 'existed', v_existed);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector) IS
  'Atomic capture: content + metadata + embedding in one statement. Reads p_payload.actor (008), p_payload.embedding_model (021), and p_payload.derived_from / p_payload.supersedes (025) from the envelope. derived_from is validated by validate_derived_from — an array of existing thought UUIDs, or the write is refused (SMD-1253); supersedes'' existence is the self-FK''s, checked where the column is written — a first capture (035). Takes the fingerprint advisory lock before the write (033), the one update_thought takes, so a capture and an edit of one text are serialised (READ COMMITTED); no supersession lock (035). On a re-capture the label follows the vector, the chunk rows stay only while the label vouches for them (022), and the envelope''s provenance is NOT written (035) — provenance lands on a first capture only; setting, changing or clearing it on an existing thought is update_thought''s p_provenance (032). Returns {id, fingerprint, existed}: existed true means the text was already there and any provenance named was not written.';

-- 032's COMMENT, re-issued with the aside this file makes false ("a capture's
-- add-if-empty through upsert_thought aside") replaced by the rule: every
-- write of thoughts.supersedes onto an existing thought goes through
-- update_thought; a first capture sets it on its own new row.
COMMENT ON FUNCTION review_supersession_proposal(uuid, text, text, text, jsonb, boolean) IS
  'The reviewer''s decision on one proposal, and the only path from the table to thoughts.supersedes — through update_thought since migration 032, so every write of the column onto an existing thought goes through the one edit function (a first capture sets it on its own new row; since 035 a re-capture does not touch it): accept sets the pointer on the thought the verdict (or p_direction, required for an undirected verdict) names as current, refusing a pointer at a third thought, one that would close a loop (update_thought''s walk), or a pair whose text changed since it was judged unless p_force; reject marks the row and clears an accepted write of its own while it still stands. p_actor is set on ob1.actor for the audit trigger. Migration 029 / 032 / 035.';
