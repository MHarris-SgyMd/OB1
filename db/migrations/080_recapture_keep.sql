-- =============================================================================
-- Migration 080: a capture-only key's re-capture leaves the row it lands on —
--                p_payload.recapture = 'keep' merges no metadata, appends no
--                event and writes no windows onto a thought that already
--                holds the text (SMD-2539)
-- =============================================================================
--
-- WHY
--   A capture-only key (scope `capture`, SMD-1298) may add thoughts and alter
--   none: capture_thought is its one tool. A re-capture broke that. Text that
--   is already a thought lands on the row holding it (003's fingerprint, 035's
--   existing-row path), and that path merges the payload's metadata over the
--   row's — the caller's keys, and metadata.source, which the server sets to
--   the caller's `source` — appends an update event in the caller's name and
--   moves updated_at. So a capture key that could guess another key's text
--   could relabel that thought: SMD-2473's first review pass did it against
--   the real server (metadata.source 'mcp' became 'codex', the probe's key
--   landed, updated_at moved). That label is what a `source:` egress term
--   gates the passes on (SMD-1941), and what SMD-1297's planned per-source
--   weight would read. A vector arriving under another model replaced the
--   row's and dropped its windows (022), and the 4-argument form replaced the
--   windows outright.
--
-- WHAT
--   * p_payload.recapture — 'keep' or 'merge'. Absent, or a JSON null, is
--     'merge', the behaviour before this file; anything else is refused
--     before the write. The server sends 'keep' for a key that cannot read
--     (the capture scope) and nothing for a write key, which holds
--     update_thought and so gains nothing from the merge it keeps.
--   * Under 'keep', a capture that lands on an existing row writes nothing to
--     it: no metadata merge, no event, no updated_at, no vector refresh, no
--     window DELETE or replacement, no lineage row. One exception: a vector
--     onto a row that has none is attached, as an update event carrying the
--     vector's presence alone (the row's metadata on both sides, nothing
--     declared) projected with the caller's vector and label — so updated_at
--     moves, the audit row names the capture key, and the vector's lineage
--     row is thoughts_record_vector_lineage's (061), as for any vector. The
--     windows are not written: the 4-argument form writes none under 'keep'.
--     Windows a vectorless row holds go by 022's rule unless its label is the
--     arriving vector's. A fresh text is captured as before, 'keep' or not.
--   * Each form's return keeps its keys — the 2-argument form's {id,
--     fingerprint}, the 3-argument form's {id, fingerprint, existed,
--     supersedes}, the 4-argument form's with chunks (0 under 'keep' on an
--     existing row) — so the caller still gets the id a hook supersedes its
--     own summary with.
--     The server tells a key that cannot read neither `existed` nor the
--     pointer (SMD-1298), so its reply is a fresh capture's, ids aside.
--   * All three upsert_thought forms: the 2- and 3-argument forms are 073's
--     bodies and the 4-argument form 061's, each with the rule above and the
--     sentinel ob1:recapture-keep-leaves-the-row; nothing else moves. This
--     file is their last definer, so it is preflight's `atomic capture`
--     remedy for every stale body its guard allows (before 073, preflight
--     names 073 or 061 first); 073 or 061 re-applied by hand puts back a
--     body that merges whatever the payload says.
--
-- NOT HERE
--   * The id a re-capture returns, which tells a capture key that holds an
--     earlier id whether the text still stands there: SMD-2554.
--   * Timing: a re-capture under 'keep' does less work than a fresh capture.
--     SMD-2473 left timing out of the oracle rule, and so does this file.
--   * The PostgREST two-step capture fallback, taken when the form the store
--     called is missing: the 3-argument one (before 004, which preflight
--     fails) or the 4-argument one (whose presence preflight does not check).
--     Its plain UPDATE writes the vector onto an existing row whatever the
--     word says: SMD-2605.
--
-- Idempotent: CREATE OR REPLACE throughout, under the signatures each form
-- already has, so each keeps its owner and grants.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regprocedure('ob1_declared_trust(jsonb, jsonb, jsonb)') IS NULL
     OR to_regprocedure('ob1_actor_stamp(jsonb, text)') IS NULL
     OR to_regprocedure('ob1_actor_stamp_kept(jsonb, jsonb)') IS NULL
     OR to_regprocedure('ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid)') IS NULL
     OR to_regprocedure('ob1_refresh_thought_vector(uuid, vector, text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 080 needs 060, 061 and 073 (ob1_refresh_thought_vector, ob1_record_derivation, ob1_declared_trust, ob1_actor_stamp); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. upsert_thought(text, jsonb) — 073's body, with 'keep'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_thought(p_content text, p_payload jsonb DEFAULT '{}')
RETURNS jsonb AS $$
DECLARE
  v_fingerprint text;
  v_id          uuid;
  v_existed     boolean := false;
  v_event       jsonb;
  v_decl        jsonb;  -- 073: v_event with the payload's trust folded in
  v_old_meta    jsonb;
  v_new_meta    jsonb;
  v_diff        jsonb;
  v_ev          uuid;
  v_keep        boolean;  -- 080: p_payload.recapture = 'keep'
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

  -- 080: what a re-capture may write — 'merge', the default, or 'keep' —
  -- refused here by the key's name, before the write is known to be one.
  -- A JSON null is no word, as the lineage envelope's is.
  IF p_payload ? 'recapture' AND jsonb_typeof(p_payload->'recapture') <> 'null'
     AND (jsonb_typeof(p_payload->'recapture') <> 'string' OR p_payload->>'recapture' NOT IN ('keep', 'merge')) THEN
    RAISE EXCEPTION 'upsert_thought: p_payload.recapture must be "keep" or "merge", got %.', p_payload->'recapture';
  END IF;
  v_keep := COALESCE(p_payload->>'recapture' = 'keep', false);

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
  -- 073: a payload's metadata.trust is a declaration — folded into the event
  -- once the row is read (v_decl, below: on a re-capture an echo of the
  -- row's own trust is none), so the stamp and the append weigh one word
  -- (ob1_declared_trust), and a new text is stamped with its trust
  -- (ob1_actor_stamp(jsonb, text)).

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
      v_decl     := ob1_declared_trust(v_event, p_payload->'metadata', NULL);
      v_new_meta := ob1_actor_stamp(COALESCE(p_payload->'metadata', '{}'::jsonb), v_decl->>'trust');
      v_diff     := ob1_thought_diff('capture', NULL, p_content, NULL, v_new_meta, false, false,
                                     NULL, NULL, NULL, NULL, NULL, v_fingerprint);
      v_ev       := ob1_append_thought_event(v_id, 'capture', v_new_meta->>'source', v_diff, v_decl);
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
  IF v_existed AND v_keep THEN
    -- ob1:recapture-keep-leaves-the-row — a CONTRACT SENTINEL, not prose (the
    -- 014 convention); preflight's `atomic capture` reads it. 080: under
    -- 'keep' (the server's word for a key that cannot read) the existing row
    -- is left as it is — no merge, no event, no updated_at; this form takes
    -- no vector, so nothing at all (SMD-2539).
    NULL;
  ELSIF v_existed THEN
    -- A re-capture: the metadata merged as 046's ON CONFLICT merged it, the
    -- stamp kept (050: the mark follows the content, and the content is the
    -- same), 046's no-op gate — an update event only when the merge changed
    -- something or the envelope declared stance, cites or a window; a write
    -- that changes nothing writes nothing and moves no updated_at (060's
    -- named delta).
    v_decl     := ob1_declared_trust(v_event, p_payload->'metadata', v_old_meta);
    v_new_meta := ob1_actor_stamp_kept(v_old_meta || COALESCE(p_payload->'metadata', '{}'::jsonb), v_old_meta);
    v_diff     := ob1_thought_diff('update', p_content, p_content, v_old_meta, v_new_meta, false, false,
                                   NULL, NULL, NULL, NULL, v_fingerprint, v_fingerprint);
    IF v_diff <> '{}'::jsonb OR COALESCE(v_decl ?| ARRAY['stance', 'cites', 'valid_from', 'valid_until', 'trust', 'actor_kind'], false) THEN
      v_ev := ob1_append_thought_event(v_id, 'update', v_new_meta->>'source', v_diff, v_decl);
      IF v_ev IS NOT NULL THEN  -- 046's late gate may drop an unchanged write carrying only a trust or an actor_kind
        PERFORM ob1_project_thought_event(v_ev);
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION upsert_thought(text, jsonb) IS
  'Capture without a vector: content + metadata, merged into the row holding the same normalised text. Reads p_payload.actor (008, here since 033) for the audit row. Takes the fingerprint advisory lock before the row read (033), the one update_thought takes, so a capture and an edit of one text are serialised (READ COMMITTED), and since 060 locks the row it lands on FOR NO KEY UPDATE as the 3-argument form does. Refuses a non-object payload (005). Reads no provenance from the envelope. Reads p_payload.event (046) — {stance, cites, valid_from, valid_until, trust, actor_kind} — validated by validate_write_event and carried by the append. Since 060 the event is appended first (ob1_append_thought_event) and the row projected from it (ob1_project_thought_event); a re-capture that changes nothing writes nothing and moves no updated_at. Called by PostgREST clients by name and the two-step capture fallback; the servers capture through the 3- and 4-argument forms. Since 073 a payload''s metadata.trust is a declaration folded into the event (ob1_declared_trust) and a new text''s metadata carries the trust the append records (ob1_actor_stamp(jsonb, text)); a re-capture keeps the row''s. Since 080 p_payload.recapture = ''keep'' leaves an existing row as it is — no merge, no event, no updated_at; absent or ''merge'' is the merge above, any other value is refused (SMD-2539). Migration 003 / 005 / 033 / 035 / 046 / 060 (SMD-2116) / 073 (SMD-1724) / 080 (SMD-2539).';

-- ---------------------------------------------------------------------------
-- 2. upsert_thought(text, jsonb, vector) — 073's body, with 'keep'.
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
  v_decl           jsonb;  -- 073: v_event with the payload's trust folded in
  v_new_meta       jsonb;
  v_diff           jsonb;
  v_ev             uuid;
  v_label          text := p_payload->>'embedding_model';  -- 021
  -- 061: the lineage envelope — {"metadata": recipe, "chunks": recipe} —
  -- what the caller's producers declare about the tags (and, for the
  -- 4-argument form, the windows) this write carries. Absent: no row.
  v_lineage        jsonb := p_payload->'lineage';
  -- 080: p_payload.recapture = 'keep' — an existing row is left as it is,
  -- save a vector it lacks (SMD-2539).
  v_keep           boolean;
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

  -- 080: what a re-capture may write — 'merge', the default, or 'keep' —
  -- refused here by the key's name, before the write is known to be one.
  -- A JSON null is no word, as the lineage envelope's is.
  IF p_payload ? 'recapture' AND jsonb_typeof(p_payload->'recapture') <> 'null'
     AND (jsonb_typeof(p_payload->'recapture') <> 'string' OR p_payload->>'recapture' NOT IN ('keep', 'merge')) THEN
    RAISE EXCEPTION 'upsert_thought: p_payload.recapture must be "keep" or "merge", got %.', p_payload->'recapture';
  END IF;
  v_keep := COALESCE(p_payload->>'recapture' = 'keep', false);

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
  -- 073: a payload's metadata.trust is a declaration — folded into the event
  -- once the row is read (v_decl, below: on a re-capture an echo of the
  -- row's own trust is none), so the stamp and the append weigh one word
  -- (ob1_declared_trust), and a new text is stamped with its trust
  -- (ob1_actor_stamp(jsonb, text)).

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
      v_decl     := ob1_declared_trust(v_event, p_payload->'metadata', NULL);
      v_new_meta := ob1_actor_stamp(COALESCE(p_payload->'metadata', '{}'::jsonb), v_decl->>'trust');
      v_diff     := ob1_thought_diff('capture', NULL, p_content, NULL, v_new_meta, false, p_embedding IS NOT NULL,
                                     NULL, v_supersedes::uuid, NULL, v_derived, NULL, v_fingerprint);
      v_ev       := ob1_append_thought_event(v_id, 'capture', v_new_meta->>'source', v_diff, v_decl);
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
      -- 080: and the capture diff the rolled-back block computed — a local
      -- survives the rollback, and under 'keep' nothing below recomputes it,
      -- so the lineage gate read its `metadata` key and recorded the capture
      -- key's tag recipe on the row that landed (SMD-2539 review pass 1).
      v_diff := NULL;
    END;
  END IF;
  IF v_existed AND v_keep THEN
    -- ob1:recapture-keep-leaves-the-row — a CONTRACT SENTINEL, not prose (the
    -- 014 convention); preflight's `atomic capture` reads it. 080: under
    -- 'keep' (the server's word for a key that cannot read) the existing row
    -- is left as it is — no merge, no event, no updated_at, no vector
    -- refresh, no window DELETE — save a vector onto a row that has none: an
    -- update event carrying the vector's presence alone, the row's metadata
    -- on both sides and nothing declared, projected with the caller's vector
    -- and label (SMD-2539). The provenance is 035's: not written.
    IF p_embedding IS NOT NULL AND NOT v_old_has_vec THEN
      v_diff := ob1_thought_diff('update', p_content, p_content, v_old_meta, v_old_meta,
                                 false, true,
                                 v_old_sup, v_old_sup, v_old_derived, v_old_derived, v_fingerprint, v_fingerprint);
      v_ev   := ob1_append_thought_event(v_id, 'update', v_old_meta->>'source', v_diff, NULL);
      IF v_ev IS NOT NULL THEN
        PERFORM ob1_project_thought_event(v_ev, p_embedding, v_label);
      END IF;
    END IF;
    v_supersedes_now := v_old_sup;
  ELSIF v_existed THEN
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
    v_decl     := ob1_declared_trust(v_event, p_payload->'metadata', v_old_meta);
    v_new_meta := ob1_actor_stamp_kept(v_old_meta || COALESCE(p_payload->'metadata', '{}'::jsonb), v_old_meta);
    v_diff     := ob1_thought_diff('update', p_content, p_content, v_old_meta, v_new_meta,
                                   v_old_has_vec, v_old_has_vec OR p_embedding IS NOT NULL,
                                   v_old_sup, v_old_sup, v_old_derived, v_old_derived, v_fingerprint, v_fingerprint);
    IF v_diff <> '{}'::jsonb OR COALESCE(v_decl ?| ARRAY['stance', 'cites', 'valid_from', 'valid_until', 'trust', 'actor_kind'], false) THEN
      v_ev := ob1_append_thought_event(v_id, 'update', v_new_meta->>'source', v_diff, v_decl);
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
  -- 080: under 'keep' only a vector attached to a row that had none comes
  -- here; a row's own vector stays, and so do its windows.
  IF p_embedding IS NOT NULL AND v_existed
     AND (v_old_label = v_label) IS NOT TRUE
     AND NOT (v_keep AND v_old_has_vec) THEN
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
  -- `supersedes`, the row's pointer as it stands after this write. 080:
  -- under 'keep' the same keys, the row left as it was.
  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint, 'existed', v_existed, 'supersedes', v_supersedes_now);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector) IS
  'Atomic capture: content + metadata + embedding in one call. Reads p_payload.actor (008), p_payload.embedding_model (021), p_payload.derived_from / p_payload.supersedes (025), p_payload.event (046: {stance, cites, valid_from, valid_until, trust, actor_kind}, validated by validate_write_event and carried by the append) and p_payload.lineage (061: {metadata: recipe} — the tags'' derivation, recorded in `derivations` with the write; absent, no row) from the envelope. derived_from is validated by validate_derived_from — an array of existing thought UUIDs, or the write is refused (SMD-1253); supersedes'' existence is the self-FK''s, checked where the column is written — a first capture (035). Takes the fingerprint advisory lock before the row read (033), the one update_thought takes, so a capture and an edit of one text are serialised (READ COMMITTED); no supersession lock (035). Since 060 the event is appended first (ob1_append_thought_event) and the row projected from it (ob1_project_thought_event) with the caller''s vector: a fresh text is a capture event; a re-capture is an update event only when the metadata merge, the vector''s presence or a declared event gives it one, a vector onto a row that has one is a refresh with no event and no updated_at, and a re-capture that changes nothing writes nothing. On a re-capture the label follows the vector, the chunk rows stay only while the label vouches for them (022) — and their lineage row with them (061) — and the envelope''s provenance is NOT written (035) — setting, changing or clearing it is update_thought''s p_provenance (032). Returns {id, fingerprint, existed, supersedes}. Since 073 a payload''s metadata.trust is a declaration folded into the event (ob1_declared_trust) and a new text''s metadata carries the trust the append records (ob1_actor_stamp(jsonb, text)); a re-capture keeps the row''s. Since 080 p_payload.recapture = ''keep'' (the server''s, for a key that cannot read; absent or ''merge'' is the merge above, any other value is refused) leaves an existing row as it is — no metadata merge, no event, no updated_at, no vector refresh, no window DELETE, no lineage row — save a vector onto a row without one, attached as an update event carrying its presence alone; a fresh text is captured as before (SMD-2539). Migration 004 / 021 / 022 / 025 / 033 / 035 / 046 / 060 / 061 (SMD-1731) / 073 (SMD-1724) / 080 (SMD-2539).';

-- ---------------------------------------------------------------------------
-- 3. upsert_thought(text, jsonb, vector, jsonb) — 061's body, with 'keep'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_thought(
  p_content   text,
  p_payload   jsonb,
  p_embedding vector({{EMBEDDING_DIM}}),
  p_chunks    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_result jsonb;
  v_id     uuid;
  v_n      int := 0;
BEGIN
  v_result := upsert_thought(p_content, p_payload, p_embedding);
  v_id     := (v_result->>'id')::uuid;

  -- ob1:recapture-keep-leaves-the-row — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `atomic capture` reads it. 080: under
  -- 'keep' (validated by the 3-argument form above) a capture that landed on
  -- an existing row writes no windows and leaves the row's, and their
  -- lineage row (SMD-2539).
  IF p_payload->>'recapture' = 'keep' AND (v_result->>'existed')::boolean THEN
    RETURN v_result || jsonb_build_object('chunks', 0);
  END IF;

  DELETE FROM thought_chunks WHERE thought_id = v_id;
  -- 061: the set is replaced wholesale, so its lineage row goes with it.
  DELETE FROM derivations WHERE artifact_kind = 'chunks' AND artifact_id = v_id;

  IF p_chunks IS NOT NULL AND jsonb_array_length(p_chunks) > 0 THEN
    INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding, context)
    SELECT
      v_id,
      (ord - 1)::int,
      elem->>'content',
      (elem->>'embedding')::vector({{EMBEDDING_DIM}}),
      elem->>'context'
    FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS a(elem, ord);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    -- ob1:derivation-recorded-with-its-artifact — a CONTRACT SENTINEL, not prose
    -- (the 014 convention). 061: the windows' lineage row commits with the
    -- windows (SMD-1731): the caller's recipe from p_payload.lineage.chunks
    -- (the window parameters, the blurb model) when it declares one; the
    -- label alone when it does not — a deterministic split whose parameters
    -- were not declared, said so. The set's size rides the recipe either way.
    PERFORM ob1_record_derivation('chunks', v_id, ARRAY[v_id], ARRAY[v_result->>'fingerprint'], 'capture',
      COALESCE(CASE WHEN jsonb_typeof(p_payload->'lineage'->'chunks') = 'object' THEN p_payload->'lineage'->'chunks' END,
               jsonb_build_object('deterministic', true, 'declared', false)
                 || jsonb_strip_nulls(jsonb_build_object('model', p_payload->>'embedding_model')))
        || jsonb_build_object('count', v_n),
      ob1_actor_agent_id());
  END IF;

  RETURN v_result || jsonb_build_object('chunks', v_n);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector, jsonb) IS
  'Atomic capture including per-chunk embeddings and their situating context. Replaces any existing chunks for the thought — and, since 061, the chunk set''s lineage row in `derivations` (artifact_kind chunks, the thought''s id; the recipe from p_payload.lineage.chunks when the caller declares one, the label alone when not; no windows, no row). Overload of the 3-arg form, which it delegates to. Since 080, under p_payload.recapture = ''keep'' a capture that lands on an existing row writes no windows and leaves the row''s (SMD-2539). Migration 007 / 013 / 061 (SMD-1731) / 080 (SMD-2539).';
