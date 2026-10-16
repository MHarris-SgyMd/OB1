-- =============================================================================
-- Migration 098: an unlink takes the review lock — update_thought takes
--                ob1:supersession-review whenever its envelope names
--                supersedes, a clear included, so an unlink waits for an
--                accept as a re-point does (SMD-3045)
-- =============================================================================
--
-- WHY
--   088's update_thought takes 029's supersession lock only when it writes a
--   pointer onto a thought (v_supersedes IS NOT NULL). An unlink
--   ({"supersedes": null}) takes no lock an accept holds, and
--   review_supersession_proposal holds that lock for the whole accept — the
--   lapse included, which reads the tree above the accepted row (097's
--   ob1_lapse_walk) and then clears what it found. An unlink committed in
--   between moves a link out of that tree, and the lapse still clears the
--   capture-only pointers above it: SMD-3035's review pass 2 raced it live
--   (a pg_sleep between the walk and the clears; in that pass's run the
--   unlink returned 404 ms in, and the hook's pointer above it lapsed, the
--   accept ordered after an unlink it read before). The same pass found a
--   40P01 that is the same gap: one transaction unlinked a row (its row
--   lock, no review lock), then re-pointed it (the review lock, held by the
--   accept), while the accept's clear waited on that row.
--
-- WHAT
--   * update_thought — 088's body, under 088's signature, with one change:
--     the supersession lock is taken whenever p_provenance names supersedes
--     (v_set_supersedes), a JSON null included — before the fingerprint
--     lock and the row, where a re-point takes it. Whatever the row's
--     pointer is: it is read under the row lock, after this one, and an
--     unlocked read to skip the lock would reopen the race. Nothing else
--     moves: the same answers, the same refusals, the same writes, the
--     grants kept (CREATE OR REPLACE; an earlier form a re-applied older
--     file left is dropped and its grants replayed, as 088 did). A new
--     sentinel names the rule, and the comment says it.
--
-- Lock order
--   033's order — supersession lock, fingerprint lock, row — is now an
--   unlink's too, as it is a re-point's and delete_thought's (036), so
--   SMD-3035's 40P01 above has no crossing left: the unlink waits for the
--   accept, or the accept for the unlink's transaction. Outside the order,
--   as before: a writer's own transaction of several calls that holds a row
--   (a content edit, say) and then takes the review lock by any call — a
--   pointer write, a clear now too, a delete, a citation, rebuild_derived,
--   an accept — waits on the lock while a holder of it waits on something
--   the transaction holds: a row, or an advisory lock taken after the
--   review lock (a fingerprint lock, 033; a node-state bucket, 068).
--   Postgres breaks that with 40P01. Since this file that
--   holder can be a single-call unlink, which under 088 waited and then
--   passed (a re-point there closed the same cycle under both; review pass
--   1 raced it live on the row). No shipped caller makes such a
--   transaction (each store call is a transaction of its own); taking the
--   lock first, which is re-entrant, keeps one in the order.
--
-- NOT HERE
--   * 097's NOT HERE says that under an accept "only an unlink (which takes
--     none, 088) moves one" out from under the walk. Since this file no
--     write function moves one out: every write of a pointer through
--     update_thought, every delete and the review path wait on the lock the
--     accept holds. Two writes still take none and move nothing out: a
--     first capture naming supersedes (a new row, nothing above it; 092's
--     check refuses or waits on a capture-only pointer onto the tree), and
--     another taker's own lapse clears, which clear nothing the accept's
--     walk read as staying: a pointer it would clear too (its re-read under
--     the row lock then skips it), or one above its frontier that it never
--     read (from a row it clears it walks on only when 082's log took that
--     row, and no further than its 1,001-row bound; review pass 2). 097
--     stands as written — migrations are append-only (migrate.ts checks
--     each file's sha256) — and db/README says it.
--   * A taker that holds no review lock — a write key's re-capture, a text
--     move, board-sync's adoption (082's takings) — still has the window
--     between the walk's read and its clears: SMD-3046.
--
-- SAFETY
--   One function redefined under its own signature; its comment. MINOR:
--   nothing changes shape, no data step. EXECUTE as before. Re-applying 088
--   — or 061 or 073, which also hold the 11-argument update_thought — puts
--   the older gate back (060's 10-argument form lands beside it, which
--   preflight refuses); this file, applied after it, restores the lock and
--   drops an older form — update_thought alone: what else the older file
--   put back stays until `bun migrate.ts --reapply`, which restores every
--   body. Preflight does not read the gate: an 088 re-applied by hand over
--   this file passes its edit-signature check, as 073 re-applied over 088
--   did (SMD-1227; the remedies' order, SMD-3065). test-schema [88],
--   test-live [6j], test-upgrade [20ar].
--
-- Prerequisites
--   073 (ob1_declared_trust, ob1_actor_stamp; 088's body carries 073's).
--   Applied by `bun db/migrate.ts`.
--
-- Idempotent: CREATE OR REPLACE.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regprocedure('ob1_declared_trust(jsonb, jsonb, jsonb)') IS NULL
     OR to_regprocedure('ob1_actor_stamp(jsonb, text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 098 needs 073 (ob1_declared_trust, ob1_actor_stamp); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- update_thought — 088's body; an unlink takes the review lock.
-- ---------------------------------------------------------------------------
-- 088's mechanism, carried (073's, 061's, 060's, 046's): as the last
-- definer, this file is the one a re-apply restores. On a schema an older
-- file left with an earlier form, that form's ACL is captured, the form
-- dropped and the ACL replayed onto this one below; on the 11-argument
-- form, CREATE OR REPLACE keeps its ACL and nothing is captured.
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

  -- ob1:supersession-review (032/036): a supersedes write is serialised with
  -- every other on 029's lock, taken BEFORE the row lock — see "Lock order"
  -- in 033's header — so the walk below reads committed pointers.
  -- Re-entrant: review_supersession_proposal holds it already when it calls
  -- here.
  -- ob1:pointer-write-takes-review-lock — a CONTRACT SENTINEL, not prose (the
  -- 014 convention). 098 (SMD-3045): whenever the envelope names supersedes,
  -- a clear included, so an unlink waits for an accept as a re-point does —
  -- the accept's lapse reads the tree above the accepted row and then clears
  -- what it found, and an unlink between the two moved a link out from under
  -- it. Whatever the row's pointer: it is read under the row lock, after
  -- this one.
  IF v_set_supersedes THEN
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
  -- ob1:write-stamps-trust — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `edit signature` reads it. 073: the patch's
  -- metadata.trust is a declaration — folded into the event, against the
  -- row's own when the text stays (an echo of a read is none) and as given
  -- on a new text, so the stamp and the append weigh one word
  -- (ob1_declared_trust), and a new text is stamped with its trust
  -- (ob1_actor_stamp(jsonb, text)).
  v_event       := ob1_declared_trust(v_event, p_metadata_patch, CASE WHEN v_same_text THEN v_existing.metadata END);
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

  -- 088 (SMD-2744): what the write did to the stamp keys and to the
  -- patch, from inside the write — the stamp the row now carries (the
  -- after-image, which the projector wrote and the audit trigger checked),
  -- whether the patch moved anything the server does not set, and whether
  -- the text counts as the same (003's fingerprint). The server's reply
  -- diffs the patch against the stamp, with no read after the write.
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'updated_at', v_updated,
                            'stamp', COALESCE((SELECT jsonb_object_agg(k.key, k.value)
                                                 FROM jsonb_each(CASE WHEN jsonb_typeof(v_new_meta) = 'object' THEN v_new_meta ELSE '{}'::jsonb END) k
                                                WHERE k.key IN ('actor_kind', 'actor_name', 'trust')), '{}'::jsonb),
                            'same_text', v_same_text)
         || CASE WHEN p_metadata_patch IS NULL THEN '{}'::jsonb
                 -- A row whose metadata is SQL NULL (a raw writer's) takes no
                 -- patch — NULL || patch is NULL, as since 009 — and says so,
                 -- rather than merged or held (review pass 5).
                 -- On a change of text the stamp is written over it all the same,
                 -- and a word of trust the patch declared is taken (review pass 6).
                 WHEN v_existing.metadata IS NULL THEN jsonb_build_object(
                   'metadata_merged', COALESCE(NOT v_same_text AND jsonb_typeof(p_metadata_patch->'trust') = 'string'
                                               AND (v_new_meta->>'trust') IS NOT DISTINCT FROM (p_metadata_patch->>'trust'), false),
                   'patch_dropped', EXISTS (SELECT 1 FROM jsonb_object_keys(p_metadata_patch) k WHERE k NOT IN ('actor_kind', 'actor_name', 'trust')))
                 ELSE jsonb_build_object('metadata_merged', COALESCE(
                        -- ob1:patch-merged-beside-the-stamp — a CONTRACT SENTINEL,
                        -- not prose (the 014 convention). Moved: a key the server
                        -- does not set changed, or a change of text took the
                        -- patch's trust as its declaration. The stamp moving on
                        -- its own (a new text's writer) is not the patch's.
                        (CASE WHEN jsonb_typeof(v_existing.metadata) = 'object' THEN v_existing.metadata - 'actor_kind' - 'actor_name' - 'trust' ELSE v_existing.metadata END)
                          IS DISTINCT FROM
                        (CASE WHEN jsonb_typeof(v_new_meta) = 'object' THEN v_new_meta - 'actor_kind' - 'actor_name' - 'trust' ELSE v_new_meta END)
                        -- A trust is taken only as a word: a null or a non-string
                        -- declares nothing (ob1_declared_trust), and matching the
                        -- no-trust stamp of a key with no kind is no taking (review
                        -- pass 5).
                        -- COALESCE: a patch naming no trust makes jsonb_typeof NULL,
                        -- and NULL = 'string' is NULL — the verdict null, which the
                        -- server read as merged (review pass 6).
                        OR (NOT v_same_text AND COALESCE(jsonb_typeof(p_metadata_patch->'trust') = 'string', false)
                            AND (v_new_meta->>'trust') IS NOT DISTINCT FROM (p_metadata_patch->>'trust')), false))
            END
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
  'Edit a thought by id. Recomputes content_fingerprint and replaces chunks — with their context — when content changes; an edit whose text normalises to what the row holds is never DUPLICATE_CONTENT, and reports duplicate_of when another row holds that text (a pair from before migration 003), or fingerprint_held_by when a row holds the key under other text, leaving this row''s fingerprint NULL. Every edit with content takes the fingerprint advisory lock (READ COMMITTED) — the one every capture through upsert_thought takes since 033 — and then locks the row FOR NO KEY UPDATE (032); both locks are held until the caller''s transaction ends, refusals included. Checks if_unchanged_since against the locked row before the write — since 060 the one check, the row it read being the row it writes. Since 060 the edit is an event first: the after-image is computed in the body (050''s stamp arms, 046''s diff rule), appended (ob1_append_thought_event) and projected (ob1_project_thought_event); a same-text edit carrying a vector is a refresh with no event and no updated_at (ob1_refresh_thought_vector); an edit that changes nothing writes nothing. p_embedding_model (021) is written beside the vector — the label follows the vector: untouched without content, NULL with content and no vector. p_provenance (032) is the envelope {"supersedes": uuid|null, "derived_from": [uuid…]|null}: an absent key leaves the column, a JSON null clears it, a value sets it — derived_from validated by validate_derived_from, supersedes an existing thought that closes no loop, the write serialised with review_supersession_proposal''s. p_event (046) is the write event {"stance", "cites", "valid_from", "valid_until", "trust", "actor_kind"}: validated by validate_write_event (a bad shape is refused) and carried by the append, which stamps stance, cites and the window on the row and checks trust and actor_kind against the key rather than copying them. p_lineage (061) is the lineage envelope {"chunks": recipe, "metadata": recipe}: with content, the windows written are recorded in `derivations` (artifact_kind chunks) under the caller''s recipe, or the label alone when none is declared — no windows, no row; the tags are recorded (artifact_kind metadata) when the envelope names their recipe and the event moved the metadata. Returns {ok:true, id, updated_at, stamp, same_text, metadata_merged} — updated_at the row''s stamp after the call, unmoved by a refresh or a no-op; since 088 (SMD-2744) stamp the row''s actor_kind, actor_name and trust after the call, same_text whether the text counts as the one it held (003''s fingerprint), and, when a patch was given, metadata_merged whether it moved anything the server does not set or had its trust (a word) taken by a change of text — never null; on a row whose metadata is SQL NULL, which merges no patch, patch_dropped when the patch named a key the server does not set — or {ok:false, error} for NOT_FOUND | STALE_READ | DUPLICATE_CONTENT | SUPERSEDES_NOT_FOUND | WOULD_CYCLE. Since 073 the patch''s metadata.trust is a declaration folded into the event (ob1_declared_trust), a new text takes the trust the append records (ob1_actor_stamp(jsonb, text)) and an unchanged one keeps the row''s. Since 098 (SMD-3045) every call whose envelope names supersedes — a JSON null, which clears it, included — takes the supersession advisory lock (ob1:supersession-review, held to the end of the transaction) before the fingerprint lock and the row, so an unlink waits for an accept as a re-point does. Migration 009 / 013 / 018 / 021 / 032 / 033 / 046 / 060 / 061 (SMD-1731) / 073 (SMD-1724) / 088 (SMD-2744) / 098 (SMD-3045).';
