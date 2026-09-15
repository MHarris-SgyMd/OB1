-- ============================================================================
-- 032 — update_thought takes provenance: supersedes and derived_from can be
--        set, changed and cleared through the one edit function, and the
--        review path writes through it (SMD-1323)
--
-- Why
--   025 put derived_from and supersedes on thoughts and let the 3-argument
--   upsert_thought set them from the payload envelope, and deferred the other
--   half in its own body: a re-capture ADDS provenance and never clears it —
--   "removing or changing provenance is update_thought's job (a follow-up)".
--   Nothing took the follow-up. So a supersession recorded wrong at capture
--   had two ways out, a raw UPDATE or delete_thought. And when 029 needed to
--   write supersedes on an accepted proposal, its ticket's "accepting one
--   calls update_thought" could not be honoured — update_thought had no
--   provenance parameter — so review_supersession_proposal set ob1.actor,
--   locked the row and wrote the column in one UPDATE of its own; 025's audit
--   trigger and 001's updated_at trigger made the outcome the same as an
--   edit's, and 029's header states the departure and names this ticket.
--   018's "one writer stays one writer" was bent by one function.
--
-- What
--   1. update_thought gains a NINTH parameter, p_provenance jsonb DEFAULT NULL:
--      the envelope shape upsert_thought has read since 025,
--        {"supersedes": <uuid> | null, "derived_from": [<uuid>, …] | null}
--      An ABSENT key leaves its column alone. A JSON null CLEARS it. A value
--      SETS it, validated as 025 validates at capture: derived_from through
--      validate_derived_from (below) — an array of UUID strings naming
--      thoughts that exist, canonicalised — and supersedes as a UUID string
--      naming a thought that exists and would not close a loop. The
--      8-argument form is DROPPED first and its ACL replayed onto the new one
--      (021's mechanism, 020's block): an overload beside it would make every
--      call with eight arguments or fewer "function is not unique". 021's body
--      is carried forward verbatim — 018's guard, lock and fingerprint rule,
--      013's context, 009's guard, 008's actor, 021's label — with the
--      envelope read before the locks, the existence check and cycle walk
--      after the row is locked, and two CASEs in the UPDATE.
--   2. validate_derived_from(jsonb): 025's element rule as ONE function. Takes
--      the envelope's value, raises 025's three refusals (not an array, a
--      non-UUID element, a ghost), returns the canonical array (lowercased,
--      de-duplicated, sorted) or NULL for null and []. upsert_thought keeps
--      its inline copy until its next redefinition (SMD-1043) takes this one —
--      the shape 016's content_fingerprint_of took, with 018 the first caller
--      and upsert_thought's inline hash still pending. test-schema [32] holds
--      the two equal meanwhile.
--   3. review_supersession_proposal is redefined (029's body) to call
--      update_thought: accept passes {"supersedes": <older>} on the
--      superseding thought; reject passes {"supersedes": null} when the
--      pointer it wrote still stands. Its own UPDATEs of thoughts and its
--      cycle walk are gone — WOULD_CYCLE comes back from update_thought, so a
--      hand edit and an acceptance are refused by the same walk. It keeps the
--      proposal-level rules (DIRECTION_REQUIRED, ALREADY_ACCEPTED,
--      EDITED_SINCE, ALREADY_SUPERSEDES, pointer_written, "undo only your own
--      write"), the advisory lock that serialises acceptances, and its read
--      of the superseding row under it.
--
-- The rules of a provenance edit
--   * It is an edit. The row is locked FOR UPDATE as every edit's is,
--     if_unchanged_since is a predicate on the write, updated_at moves (a
--     client's stale if_unchanged_since is refused; 021's evidence rule stops
--     vouching for the row's vector), and the audit row carries the diff with
--     the actor — what 029's UPDATE did under the triggers, now by the one
--     path. Content, vector, label, fingerprint and windows are untouched
--     unless p_content arrived: 021's CASEs are unchanged.
--   * supersedes must be a UUID string (shape: RAISE, as 025 does at
--     capture) naming a thought that exists. Existence is answered as a
--     REFUSAL — {ok:false, error:'SUPERSEDES_NOT_FOUND', supersedes} — where
--     the ticket said "by the self-FK": the walk reads the target's row
--     anyway, so the answer is free, and update_thought's contract is
--     refusals as objects (NOT_FOUND, STALE_READ, DUPLICATE_CONTENT); a
--     23503 at the tool boundary is the opaque error 009 removed. The FK
--     still stands behind it, for the race (the target deleted between the
--     read and the UPDATE) and for every other writer.
--   * A loop is refused — {ok:false, error:'WOULD_CYCLE', supersedes} — when
--     the target IS this thought, or the chain of supersedes pointers from
--     the target reaches it (029's walk, bounded at 1000 steps and refused
--     beyond). derived_from is not walked: it is a history record, not a
--     version chain (025), and trace_provenance is cycle-guarded.
--   * Lock order. A supersedes write takes 029's advisory lock
--     (hashtext('ob1:supersession-review'), transaction-scoped) BEFORE the
--     row lock, so the walk reads committed pointers and two writers cannot
--     each close half a loop. Every path then acquires in one order —
--     supersession lock, row, fingerprint lock: review takes the advisory
--     lock, then the row, then calls update_thought (the advisory lock is
--     re-entrant within a session, the row already held); a hand edit
--     naming supersedes takes the same three in the same order; an edit
--     without it takes row then fingerprint lock, as 018 wrote. No two
--     orders cross.
--   * The row lock is FOR NO KEY UPDATE now, not 018's FOR UPDATE — the one
--     change to a line 018 wrote, and this migration's reason: writing
--     supersedes is the first time update_thought writes a FOREIGN KEY
--     column, and the FK check takes FOR KEY SHARE on the TARGET row — a
--     fourth lock, on another row of thoughts, taken last. FOR KEY SHARE
--     conflicts with FOR UPDATE and not with FOR NO KEY UPDATE. Under FOR
--     UPDATE: A edits Q with content T and supersedes Z (holds the
--     supersession lock, Q, the fingerprint lock for T); B edits Z with
--     content T (holds Z, waits on the fingerprint lock); A's UPDATE waits
--     for KEY SHARE on Z — a deadlock, and one caller gets 40P01 where 018
--     promised DUPLICATE_CONTENT. Under FOR NO KEY UPDATE A's UPDATE proceeds
--     and B follows. What FOR NO KEY UPDATE keeps: it conflicts with itself,
--     with FOR UPDATE and with FOR SHARE, so two edits of one row still
--     serialise, 022's FOR NO KEY UPDATE read in upsert_thought is still
--     ordered against it, and delete_thought's DELETE (FOR UPDATE) still
--     waits. What it gives up: nothing — the id never changes, and KEY SHARE
--     is the only lock it lets through. db/test-live.ts [6d] holds both arms
--     (a FOR UPDATE holder deadlocks, the function does not).
--   * derived_from through the envelope REPLACES the array (null or []
--     clears it); it does not append. 025's re-capture already does "add if
--     empty", a merge would be a second verb, and a caller who wants to add
--     reads the row and passes the union.
--
-- Safety
--   * No column, no table change. One function replaced under a new
--     signature — the 8-argument form dropped IF EXISTS, and 018's 7-argument
--     form IF EXISTS too, so a brain where 018 was re-applied by hand is left
--     with one function; the ACL of whichever existed is replayed — one
--     function redefined under its signature, one new function.
--   * Idempotent: a re-run finds the 9-argument form, captures no ACL, drops
--     nothing, and CREATE OR REPLACE keeps the ACL (021's design).
--   * No DELETE, no data change: existing supersedes / derived_from values
--     are not touched.
--   * Privileges: plain SECURITY INVOKER, no GRANT, as before. update_thought
--     writes two more columns of thoughts, which the editing role writes
--     already.
--
-- What a successor to update_thought must carry
--   Everything 021 listed — 008's ob1.actor; 009's millisecond guard as a
--   predicate in the UPDATE; 013's context in the chunk INSERT; 016's
--   content_fingerprint_of; 018's row lock (FOR NO KEY UPDATE since this
--   file — see the lock-order rule), advisory lock, duplicate_of /
--   fingerprint_held_by and the ob1:unchanged-edit-not-duplicate sentinel;
--   021's label CASE — AND the envelope read (shape guard, the two "key
--   present" flags), validate_derived_from, the supersession lock before the
--   row lock, the existence check and cycle walk after it, the two CASEs in
--   the UPDATE and the two refusals. It must DROP the 9-argument form first
--   with its ACL replayed, as this file does the 8-argument one. SMD-1043
--   (the advisory lock in upsert_thought) touches the OTHER function;
--   whichever lands second carries the first's body.
--
-- Callers
--   db/config.mjs UPDATE_THOUGHT_SIGNATURE names the 9-argument form and
--   SUPERSEDED_SIGNATURES the 8-argument one; both stores send p_provenance
--   (NULL when the caller named none); reembed.ts's positional 8-argument
--   call resolves through the default, and its refusal names this form;
--   preflight's `edit signature` reads for the 9-argument form alone, with
--   the DROP as the remedy for an older one beside it; the MCP update_thought
--   tool takes `supersedes` (an id to set, null to clear).
--
-- Prerequisites
--   021 (the 8-argument update_thought this replaces), 025 (the columns), 029
--   (the review function). Applied by `bun db/migrate.ts`.
--
-- Expected outcome
--   One update_thought, of nine parameters. update_thought(id, p_provenance
--   => '{"supersedes": "<uuid>"}') sets the pointer, '{"supersedes": null}'
--   clears it, a ghost or a loop is refused by name; derived_from likewise.
--   review_supersession_proposal's accept and reject go through it, and its
--   body holds no UPDATE of thoughts.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- validate_derived_from — 025's element rule, once
--
-- Its three RAISEs are 025's, minus the caller prefix (two callers now). NULL
-- and JSON null and [] all return SQL NULL — "not derived", one spelling.
-- STABLE: it reads thoughts and writes nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION validate_derived_from(p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v jsonb := p_value;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(v) <> 'array' THEN
    RAISE EXCEPTION
      'derived_from must be a JSON array of thought UUID strings, got %.', jsonb_typeof(v);
  END IF;
  -- Every element a UUID STRING — not a number, bool, object, array or JSON
  -- null, which the table's array-shape CHECK cannot reach.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v) AS e
    WHERE jsonb_typeof(e) <> 'string'
       OR (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION
      'derived_from must contain only thought UUID strings; got a non-UUID element in %.', v;
  END IF;
  -- …naming a thought that exists: a jsonb array cannot be a foreign key.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(v) AS ref(id)
    WHERE NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = ref.id::uuid)
  ) THEN
    RAISE EXCEPTION
      'derived_from references a thought that does not exist (in %).', v;
  END IF;
  IF jsonb_array_length(v) = 0 THEN
    RETURN NULL;
  END IF;
  -- Canonical: lowercased (the GIN containment find_derivatives uses is
  -- byte-exact), de-duplicated (a repeated source is one edge), sorted (a
  -- stable stored value) — 025's rule, review pass 1 of SMD-1253.
  SELECT to_jsonb(array_agg(DISTINCT lower(e) ORDER BY lower(e)))
    INTO v
    FROM jsonb_array_elements_text(v) AS e;
  RETURN v;
END;
$$;

COMMENT ON FUNCTION validate_derived_from(jsonb) IS
  'The derived_from rule (025): NULL, JSON null and [] are NULL; otherwise a JSON array whose every element is a UUID string naming an existing thought, returned lowercased, de-duplicated and sorted, or an exception. update_thought reads it (032); upsert_thought carries the same rule inline until its next redefinition. Migration 032 / SMD-1323.';

-- ---------------------------------------------------------------------------
-- update_thought — a ninth parameter, so the 8-argument form goes first
--
-- Its privileges are read before the DROP so the CREATE can be given the same
-- ones (021's block, 020's mechanism). The session-scoped setting holds the
-- aclitem[] as text; empty — and the replay below does nothing — when the
-- 9-argument form already exists (a re-run: CREATE OR REPLACE keeps its ACL),
-- when no older form exists, or when its ACL is NULL (the defaults). The
-- 8-argument form's ACL is taken when that form EXISTS — its NULL (the
-- defaults) is the answer then, not a reason to look further; 018's
-- 7-argument form — a hand re-apply of 018 over 021 leaves it beside the
-- current one — is read only when there is no 8-argument form.
-- ---------------------------------------------------------------------------
SELECT set_config('ob1.acl_update_thought',
                  CASE WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb)') IS NOT NULL THEN ''
                       WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)') IS NOT NULL THEN
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)')), '')
                       ELSE
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb)')), '') END,
                  false);

-- Beside the 9-argument form either older one would make every call with its
-- arity or fewer ambiguous (see the header); IF EXISTS keeps this file
-- re-runnable. Nothing in the catalog depends on them — callers resolve the
-- name at call time.
DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text);
DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb);

-- 021's body — see "What a successor must carry" in the header — with the
-- parameter, the envelope read, the walk and two CASEs added. Repeated in full
-- because CREATE OR REPLACE has no partial form.
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
  -- taken BEFORE the row lock — see "Lock order" in the header — so the walk
  -- below reads committed pointers. Re-entrant: review_supersession_proposal
  -- holds it already when it calls here.
  IF v_supersedes IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));
  END IF;

  -- The row lock: what "unchanged" is decided against below is the row as it
  -- is NOW, and stays so until this transaction ends. Without the lock a
  -- caller passing no if_unchanged_since could read text X, have another edit
  -- commit Y, and write X back over it as an "unchanged" edit that 013 would
  -- have refused. Taken before the fingerprint advisory lock, so the two are
  -- always acquired in the same order — see 018's "The rule", 2. FOR NO KEY
  -- UPDATE, not 018's FOR UPDATE (032): the supersedes write below takes
  -- FOR KEY SHARE on the target row, which FOR UPDATE on that row — another
  -- edit of it, waiting on a fingerprint lock this one holds — would
  -- deadlock with; see "Lock order" in the header. Two edits of one row still
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
      -- unique index. See "The rule", 2, in 018's header.
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

-- Re-issued: a DROP loses the COMMENT (021's). A description, not a marker —
-- the sentinel in the body is that.
COMMENT ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb) IS
  'Edit a thought by id. Recomputes content_fingerprint and replaces chunks — with their context — when content changes; an edit whose text normalises to what the row holds is never DUPLICATE_CONTENT, and reports duplicate_of when another row holds that text (a pair from before migration 003), or fingerprint_held_by when a row holds the key under other text, leaving this row''s fingerprint NULL. The row is locked FOR NO KEY UPDATE (032; FOR UPDATE until then, which the supersedes write''s FK check could deadlock with) and edits that would take a key the row does not own are serialised on an advisory lock (READ COMMITTED; captures through upsert_thought are not); both locks are held until the caller''s transaction ends, refusals included. Checks if_unchanged_since as a predicate in the UPDATE, so the guard is atomic. p_embedding_model (021) is written to thoughts.embedding_model beside the vector — the label follows the vector: untouched without content, NULL with content and no vector. p_provenance (032) is the envelope {"supersedes": uuid|null, "derived_from": [uuid…]|null}: an absent key leaves the column, a JSON null clears it, a value sets it — derived_from validated by validate_derived_from, supersedes an existing thought that closes no loop, the write serialised with review_supersession_proposal''s. Returns {ok:false, error} for NOT_FOUND | STALE_READ | DUPLICATE_CONTENT | SUPERSEDES_NOT_FOUND | WOULD_CYCLE.';

-- ---------------------------------------------------------------------------
-- review_supersession_proposal — 029's body, writing thoughts through
-- update_thought and nothing else
--
-- The proposal-level rules and their order are 029's (see its header). What
-- changed: the cycle walk is gone — update_thought walks — and the two
-- UPDATEs of thoughts are two calls. A refusal update_thought returns
-- (WOULD_CYCLE; SUPERSEDES_NOT_FOUND or NOT_FOUND for a thought deleted in
-- the instant) is returned as it came, with this proposal's id and pair
-- added, so db/consolidate.ts reads superseded_id as before. Repeated in
-- full because CREATE OR REPLACE has no partial form.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION review_supersession_proposal(
  p_id        uuid,
  p_decision  text,
  p_note      text  DEFAULT NULL,
  p_direction text  DEFAULT NULL,
  p_actor     jsonb DEFAULT NULL,
  p_force     boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  r           supersession_proposals%ROWTYPE;
  v_dir       text;
  v_old_edited boolean;
  v_new_edited boolean;
  v_sup       uuid;
  v_old       uuid;
  v_current   uuid;
  v_n         int;
  v_r         jsonb;
BEGIN
  IF p_decision NOT IN ('accept', 'reject') THEN
    RAISE EXCEPTION 'review_supersession_proposal: p_decision must be accept or reject, got %', p_decision;
  END IF;
  IF p_direction IS NOT NULL AND p_direction NOT IN ('newer', 'older') THEN
    RAISE EXCEPTION 'review_supersession_proposal: p_direction must be newer or older, got %', p_direction;
  END IF;
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;

  SELECT * INTO r FROM supersession_proposals WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND', 'id', p_id);
  END IF;

  IF p_decision = 'reject' THEN
    v_n := 0;
    IF r.status = 'accepted' AND r.pointer_written THEN
      -- Undo this proposal's OWN write while it still stands, and no further:
      -- a pointer the acceptance found already there (set at capture) is not
      -- this proposal's to clear, nor one a later edit pointed elsewhere
      -- (029, review pass 1). Read under the row lock, cleared through
      -- update_thought (032) — the edit path, audited as one.
      v_old := CASE WHEN r.superseding_id = r.newer_id THEN r.older_id ELSE r.newer_id END;
      SELECT supersedes INTO v_current FROM thoughts WHERE id = r.superseding_id FOR NO KEY UPDATE;
      IF FOUND AND v_current = v_old THEN
        v_r := update_thought(r.superseding_id, p_actor => p_actor, p_provenance => '{"supersedes": null}'::jsonb);
        IF (v_r->>'ok')::boolean THEN
          v_n := 1;
        END IF;
      END IF;
    END IF;
    UPDATE supersession_proposals
       SET status = 'rejected', reviewed_at = now(), review_note = p_note, superseding_id = NULL, pointer_written = false
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'id', p_id, 'status', 'rejected', 'cleared', v_n > 0);
  END IF;

  -- accept
  IF r.status = 'accepted' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_ACCEPTED', 'id', p_id, 'superseding_id', r.superseding_id);
  END IF;
  v_dir := COALESCE(p_direction,
                    CASE r.verdict WHEN 'newer_supersedes_older' THEN 'newer'
                                   WHEN 'older_supersedes_newer' THEN 'older' END);
  IF v_dir IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DIRECTION_REQUIRED', 'id', p_id, 'verdict', r.verdict);
  END IF;
  IF v_dir = 'newer' THEN v_sup := r.newer_id; v_old := r.older_id;
  ELSE                    v_sup := r.older_id; v_old := r.newer_id;
  END IF;

  -- Acceptances are serialised on one advisory lock (transaction-scoped, as
  -- 018's): the walk in update_thought reads other rows' pointers, and two
  -- accepts running at once — A over B in one, B over A in the other — would
  -- each walk a chain the other has not committed yet and both write, closing
  -- the loop the check exists to refuse (029, review pass 1). update_thought
  -- takes the same lock for a supersedes write, re-entrant here, so a hand
  -- edit and an acceptance are serialised with each other too. A reviewer's
  -- call is human-paced; one lock for all of them costs nothing that shows.
  PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));
  -- The superseding row, locked; its current pointer decides. update_thought
  -- strengthens this to FOR UPDATE inside the same transaction.
  SELECT supersedes INTO v_current FROM thoughts WHERE id = v_sup FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND', 'id', p_id, 'thought_id', v_sup);
  END IF;
  -- The verdict was about the texts as judged. Either edited since (016's
  -- fingerprint differs; an unknown fingerprint counts as unchanged) is
  -- refused unless the reviewer, shown both texts, says p_force (029, review
  -- pass 3). Read here, under the advisory lock and after the superseding
  -- row is locked, so that row's text is what the write will see; the
  -- superseded thought's text is read unlocked, and an edit landing in that
  -- instant under a human-paced call is the residue (029, review pass 4).
  -- updated_at is not the signal: this function moves it itself.
  SELECT r.older_fingerprint IS NOT NULL AND r.older_fingerprint IS DISTINCT FROM content_fingerprint_of(content)
    INTO v_old_edited FROM thoughts WHERE id = r.older_id;
  SELECT r.newer_fingerprint IS NOT NULL AND r.newer_fingerprint IS DISTINCT FROM content_fingerprint_of(content)
    INTO v_new_edited FROM thoughts WHERE id = r.newer_id;
  IF NOT COALESCE(p_force, false) AND (COALESCE(v_old_edited, false) OR COALESCE(v_new_edited, false)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'EDITED_SINCE', 'id', p_id,
                              'older_edited', COALESCE(v_old_edited, false), 'newer_edited', COALESCE(v_new_edited, false));
  END IF;
  IF v_current IS NOT NULL AND v_current <> v_old THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_SUPERSEDES', 'id', p_id,
                              'superseding_id', v_sup, 'current', v_current);
  END IF;

  -- The write, when there is one: through update_thought (032), which walks
  -- the chain for a loop (WOULD_CYCLE) and answers a target deleted in the
  -- instant (SUPERSEDES_NOT_FOUND); a refusal is returned as it came, with
  -- this proposal's id and pair added. A pointer already holding the value
  -- is not written again — updated_at and the audit stay as they are, and
  -- pointer_written says so (029, review pass 1).
  IF v_current IS DISTINCT FROM v_old THEN
    v_r := update_thought(v_sup, p_actor => p_actor, p_provenance => jsonb_build_object('supersedes', v_old));
    IF NOT (v_r->>'ok')::boolean THEN
      RETURN v_r || jsonb_build_object('id', p_id, 'superseding_id', v_sup, 'superseded_id', v_old);
    END IF;
  END IF;
  UPDATE supersession_proposals
     SET status = 'accepted', reviewed_at = now(), review_note = p_note, superseding_id = v_sup,
         pointer_written = (v_current IS DISTINCT FROM v_old)
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'status', 'accepted',
                            'superseding_id', v_sup, 'superseded_id', v_old,
                            'written', v_current IS DISTINCT FROM v_old);
END;
$$;

COMMENT ON FUNCTION review_supersession_proposal(uuid, text, text, text, jsonb, boolean) IS
  'The reviewer''s decision on one proposal, and the only path from the table to thoughts.supersedes — through update_thought since migration 032, so the column has one writer: accept sets the pointer on the thought the verdict (or p_direction, required for an undirected verdict) names as current, refusing a pointer at a third thought, one that would close a loop (update_thought''s walk), or a pair whose text changed since it was judged unless p_force; reject marks the row and clears an accepted write of its own while it still stands. p_actor is set on ob1.actor for the audit trigger. Migration 029 / 032.';
