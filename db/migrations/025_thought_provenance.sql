-- ============================================================================
-- 025 — derivation and supersession: what a thought was built from, and which
--       thought it replaces
--
-- Why (Linear SMD-1253)
--   A row in thoughts can say WHO wrote it (008's audit, 010's agent identity)
--   and WHAT it mentions (016's entities and entity-to-entity edges). Nothing
--   said what a thought was DERIVED FROM, or that one thought REPLACES another.
--   That is fine while every row is an atomic capture. It stops being fine the
--   moment a derived artifact — a digest, a consolidation, a synthesis pass, or
--   anything a future agent writes back — lands in thoughts: the derived row is
--   then indistinguishable from a first-hand one, and match_thoughts will
--   happily rank last month's superseded digest beside today's, higher if it is
--   better written. Silent, plausible, wrong, invisible to every check — this
--   fork's favourite failure class.
--
--   016's edges do not cover it: they are entity-to-entity, evidenced by a
--   thought, never thought-to-thought. 020's recency blend does not either, and
--   its eval found recency LOWERS MRR on the standard corpus, so it defaults to
--   zero. This migration records the two facts as first-class columns and lets
--   retrieval and read-back see them.
--
-- Designed together, one mechanism per fact (the ticket's central instruction)
--   Upstream ships two overlapping schemas: schemas/provenance-chains (columns
--   on thoughts) and schemas/typed-reasoning-edges (a thought_edges table whose
--   six relation types include `supersedes`). Both claim supersession — one as a
--   column, one as an edge row. Absorbing both separately would make two
--   competing mechanisms for one fact, the exact defect 021 and 022 spent two
--   tickets removing. So supersession is ONE thing here: the `supersedes`
--   column. thought_edges is NOT built — this fork has no reasoning-edge
--   classifier to write supports/contradicts/depends_on rows, and building a
--   table with no producer is the speculative graph the SMD-948 GraphRAG spike
--   measured and declined. It stays a later ticket, as FORK.md change 30 (016)
--   already names it. `derived_from` (many sources) and `supersedes` (one prior
--   version) are two distinct facts, so two columns is one-mechanism-per-fact,
--   not two mechanisms for one.
--
-- Deliberate departures from upstream's provenance-chains (take the shape, not
-- the files — its versions do not apply here):
--
--   1. NO SECURITY DEFINER, NO service_role GRANT, NO RLS, NO `NOTIFY pgrst`.
--      Upstream's trace_provenance/find_derivatives are SECURITY DEFINER granted
--      to service_role — a Supabase role that does not exist off Supabase, where
--      the application connects as the role that owns the schema (db/README.md;
--      the precedent 004/008/010/016 set and db/test-schema.ts asserts). The
--      functions below are plain SECURITY INVOKER, ungranted, like every other
--      function this fork ships.
--
--   2. THE `sensitivity_tier` REDACTION BRANCH IS DROPPED.
--      Upstream's trace_provenance nulls the content of ancestors whose
--      metadata->>'sensitivity_tier' = 'restricted', and find_derivatives filters
--      them out. This fork has no tier notion, no RLS, and an owner connection
--      with BYPASSRLS — a tier with nothing enforcing it is the same theater as
--      the Supabase RLS policy db/README.md says not to port. If a tier ever
--      arrives it is SMD-950's subject (governed agent memory), and that ticket
--      adds the branch. Here the functions return content plainly.
--
--   3. `derived_from` ELEMENT VALIDATION IS upsert_thought's JOB.
--      A per-element UUID check cannot be a table CHECK (Postgres forbids
--      subqueries in CHECK), so the table enforces only "NULL or a JSON array".
--      Upstream pushes element validation to two application choke points, one of
--      them a recipe script. Here the write path IS the choke point: a
--      derived_from that is not an array of UUID strings, or references a thought
--      that does not exist, is rejected by upsert_thought below — or it is an
--      untrusted-input hole (the ticket's words). `supersedes` is a real
--      self-FK, so its existence is enforced by the constraint; upsert_thought
--      only checks its shape for a clean message.
--
--   4. `supersedes ... ON DELETE SET NULL` MEETS OUR HARD DELETE.
--      009's delete_thought is a hard DELETE; 008's append-only audit preserves
--      the deleted row's content in full so the hard delete is survivable. A
--      superseded parent must stay deletable: SET NULL nulls the newer thought's
--      pointer, the newer thought survives, and the parent's content lives on in
--      the audit delete row. RESTRICT would make delete_thought fail for any
--      superseded thought — a change to delete's contract; CASCADE would delete
--      the SUCCESSOR when its predecessor is removed, exactly backwards. The
--      SET NULL is itself an UPDATE on the child, so the audit trigger (extended
--      below to diff `supersedes`) records the pointer being cleared rather than
--      losing it to an empty diff.
--
--   5. `derivation_method` STAYS IN metadata, NOT A COLUMN.
--      It has no FK, index or query need, and upstream's own functions read
--      `type` and `source_type` from metadata already. trace_provenance surfaces
--      metadata->>'derivation_method' the same way. Only the two load-bearing
--      facts (a reverse-lookup target and a self-FK) become columns.
--
-- What retrieval does with it — measured, not assumed (the ticket, and 020's
-- precedent)
--   A supersedes column no search function reads buys nothing. The question —
--   exclude, down-weight, or merely label superseded rows — needs an eval the
--   way 020's recency blend did. evals/eval-supersession.ts measures label-only
--   against excluding superseded rows on a corpus seeded with superseded chains,
--   with a TypeScript oracle so no shipped search signature had to change to ask
--   the question. Its verdict (48 topics, half with a superseded twin, seed 1253):
--
--     On the TOPICAL task the fork measures against — any version of a topic is a
--     relevant answer — excluding superseded rows moves MRR by +0.000 (label-only
--     1.000, exclude 1.000). The numbers do not move, because a superseded thought
--     is still about its subject. Only under CURRENT-version relevance — the newer
--     thought is the sole right answer — does exclusion help (MRR 0.667 → 1.000,
--     +0.333), by removing the stale twin that outranks its replacement in 16 of
--     24 topics. So, exactly as the ticket says to when the numbers do not move on
--     the standard task, THE RANKING CHANGE DOES NOT SHIP: supersession is
--     LABELLED, not excluded or down-weighted. The label serves the
--     current-version reader without a ranking change the topical task cannot
--     justify — the same shape as 020's recency blend, measured to hurt and left
--     at zero. An exclude/down-weight is a follow-up; eval-supersession.ts is the
--     instrument to justify it.
--
--   This migration ships the RECORDING plus a search-output LABEL (the store
--   marks a returned hit that a newer thought supersedes; server-portable's
--   search_thoughts/list_thoughts print it, mirroring the ID: line SMD-1248
--   added). The ranking change in match_thoughts/search_thoughts_hybrid ships
--   only if the eval shows a decisive win; otherwise the column is labelling
--   only and this header says so, as 020 said recency stays at zero.
--
-- Read-back (satisfies Verify's "traces in both directions")
--   trace_provenance(id) walks UP the derived_from chain (ancestors);
--   find_derivatives(id) looks DOWN it (what was derived from this). Both are
--   cycle-guarded and depth/node-capped, and neither pages beyond its cap. No
--   MCP tool exposes them yet — 016's entity graph exposed none either
--   (FORK.md change 30) — read-back is covered by the store methods and
--   db/test-live.ts; an MCP read API is a follow-up.
--
-- Safety
--   * Additive. Two nullable columns added to thoughts with ADD COLUMN IF NOT
--     EXISTS; no existing column altered or dropped (the CLAUDE.md guard rail).
--     One CHECK and one self-FK, added drop-then-add so the file re-runs. Two
--     indexes, IF NOT EXISTS. Three functions by CREATE OR REPLACE (the audit
--     trigger function, upsert_thought, and the two read-back functions), each
--     carrying its predecessors' bodies forward verbatim — see below.
--   * Privileges. Unchanged from 022: upsert_thought is SECURITY INVOKER and
--     already needs DELETE on thought_chunks; it now also writes two columns of
--     thoughts, which the capturing role already writes. No GRANT.
--   * Idempotent. CREATE OR REPLACE / ADD COLUMN IF NOT EXISTS / CREATE INDEX
--     IF NOT EXISTS / drop-then-add constraints; COMMENTs re-issued.
--
-- What a successor to upsert_thought must carry
--   Everything 022 listed — 005's non-object guard, 008's ob1.actor,
--   021's embedding_model in the INSERT and its ON CONFLICT clause, 022's
--   FOR NO KEY UPDATE label read with its FOUND, the chunk DELETE under its
--   condition, and the `ob1:vector-replaces-chunks` sentinel — AND now the
--   `derived_from`/`supersedes` read from the envelope, their validation, and
--   their two columns in the INSERT and the ON CONFLICT clause. SMD-1043 (the
--   advisory lock, and 016's content_fingerprint_of for the inline hash) is
--   still the expected next redefinition and takes all of it from here.
--
-- Prerequisites
--   Migrations 001 (thoughts), 007 (thought_chunks), 008/010 (the audit
--   trigger this redefines) and 022 (the upsert_thought body this carries).
--   Applied by `bun db/migrate.ts`.
--
-- Expected outcome
--   thoughts gains `derived_from jsonb` and `supersedes uuid` (ten columns,
--   nine indexes counting the PK). A capture may carry either through the
--   payload envelope; a malformed derived_from is refused at the write.
--   trace_provenance and find_derivatives walk the chain both ways. Deleting a
--   superseded thought nulls its successor's pointer and is audited on both.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The two columns, their constraint, and their indexes
-- ---------------------------------------------------------------------------
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS derived_from jsonb;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS supersedes   uuid;

-- Array-shape only. Element-level UUID + existence validation cannot be a CHECK
-- (no subqueries), so it lives in upsert_thought — see departure 3. Drop-then-add
-- so the file re-runs; the constraint is NOT VALID-free because the columns are
-- new and every existing row has NULL, which the CHECK admits.
ALTER TABLE thoughts DROP CONSTRAINT IF EXISTS thoughts_derived_from_is_array;
ALTER TABLE thoughts ADD  CONSTRAINT thoughts_derived_from_is_array
  CHECK (derived_from IS NULL OR jsonb_typeof(derived_from) = 'array');

-- The self-FK. ON DELETE SET NULL — see departure 4. Added separately from the
-- column (not inline) so the drop-then-add names the constraint and re-runs.
ALTER TABLE thoughts DROP CONSTRAINT IF EXISTS thoughts_supersedes_fkey;
ALTER TABLE thoughts ADD  CONSTRAINT thoughts_supersedes_fkey
  FOREIGN KEY (supersedes) REFERENCES thoughts(id) ON DELETE SET NULL;

-- Reverse lookup for find_derivatives: `derived_from @> [id]` is a containment
-- query, which GIN on the jsonb column serves.
CREATE INDEX IF NOT EXISTS idx_thoughts_derived_from
  ON thoughts USING gin (derived_from);

-- "Is this thought superseded, and by which" — the store's label lookup and any
-- supersession-chain walk. Partial: only the rows that point at a predecessor.
CREATE INDEX IF NOT EXISTS idx_thoughts_supersedes
  ON thoughts (supersedes) WHERE supersedes IS NOT NULL;

COMMENT ON COLUMN thoughts.derived_from IS
  'JSON array of source thought UUIDs a derived artifact (digest, consolidation, synthesis) was built from. NULL for a first-hand capture. Array shape is a CHECK; element UUID + existence is enforced by upsert_thought, not a constraint (no subqueries in CHECK). Read UP by trace_provenance, DOWN by find_derivatives. Migration 025 / SMD-1253.';

COMMENT ON COLUMN thoughts.supersedes IS
  'The prior thought this one replaces (the pointer lives on the NEWER thought). Self-FK ON DELETE SET NULL: a superseded thought stays hard-deletable (009), its content preserved in the audit delete row (008), and clearing the successor''s pointer is itself audited. Migration 025 / SMD-1253.';

-- ---------------------------------------------------------------------------
-- The audit trigger, extended to see provenance (010's body carried forward)
--
-- 010's thoughts_write_audit, verbatim, plus: the UPDATE branch diffs
-- `supersedes` and `derived_from`, so a SET NULL cascade from a deleted parent
-- (an UPDATE that touches only `supersedes`) produces a non-empty diff and is
-- recorded rather than swallowed by the "an update that changed nothing is not
-- an event" guard; the DELETE branch keeps the prior provenance in the recovery
-- diff; and the capture diff notes it when present. CREATE OR REPLACE takes the
-- whole body, so 010's v_agent id-parsing and canonical_agent_id are repeated in
-- full — dropping them would silently un-attribute every write.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thoughts_write_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor    jsonb := ob1_current_actor();
  v_action text;
  v_diff   jsonb;
  v_id     uuid;
  v_source text;
  v_agent  uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'capture';
    v_id     := NEW.id;
    v_source := NEW.metadata->>'source';
    v_diff   := jsonb_build_object('metadata', NEW.metadata);
    -- 025: a captured derivation is part of what the row was created with.
    IF NEW.derived_from IS NOT NULL THEN
      v_diff := v_diff || jsonb_build_object('derived_from', NEW.derived_from);
    END IF;
    IF NEW.supersedes IS NOT NULL THEN
      v_diff := v_diff || jsonb_build_object('supersedes', NEW.supersedes);
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    v_action := 'update';
    v_id     := NEW.id;
    v_source := NEW.metadata->>'source';
    -- Only what changed. Recording the whole row on every metadata touch would
    -- make the log expensive to store and tedious to read.
    v_diff := '{}'::jsonb;
    IF NEW.content IS DISTINCT FROM OLD.content THEN
      v_diff := v_diff || jsonb_build_object(
        'content', jsonb_build_object('before', OLD.content, 'after', NEW.content));
    END IF;
    IF NEW.metadata IS DISTINCT FROM OLD.metadata THEN
      v_diff := v_diff || jsonb_build_object(
        'metadata', jsonb_build_object('before', OLD.metadata, 'after', NEW.metadata));
    END IF;
    IF (NEW.embedding IS NULL) IS DISTINCT FROM (OLD.embedding IS NULL) THEN
      v_diff := v_diff || jsonb_build_object('embedding_present', NEW.embedding IS NOT NULL);
    END IF;
    -- 025: provenance is history too. The one that matters most is `supersedes`
    -- going NULL when a superseded parent is deleted — a change the old diff
    -- could not see, so the pointer vanished with no record. Now it is an event.
    IF NEW.supersedes IS DISTINCT FROM OLD.supersedes THEN
      v_diff := v_diff || jsonb_build_object(
        'supersedes', jsonb_build_object('before', OLD.supersedes, 'after', NEW.supersedes));
    END IF;
    IF NEW.derived_from IS DISTINCT FROM OLD.derived_from THEN
      v_diff := v_diff || jsonb_build_object(
        'derived_from', jsonb_build_object('before', OLD.derived_from, 'after', NEW.derived_from));
    END IF;

    /**
     * An update that changed nothing is not an event.
     *
     * The fingerprint dedup exists so a bulk re-import is idempotent, and a
     * re-capture of identical content takes the ON CONFLICT branch — moving
     * `updated_at` and nothing else. Recording that produced an audit row with
     * an empty diff per duplicate, so re-running a 10,000-thought import wrote
     * 10,000 rows saying nothing happened: unbounded growth on the exact
     * operation designed to be repeatable, and a log too noisy to read for the
     * question it exists to answer.
     *
     * `updated_at` moving on its own is bookkeeping, not history.
     */
    IF v_diff = '{}'::jsonb THEN
      RETURN NULL;
    END IF;

  ELSE  -- DELETE
    v_action := 'delete';
    v_id     := OLD.id;
    v_source := OLD.metadata->>'source';
    -- In full. The audit row has to be enough to reconstruct what was lost —
    -- 025 adds the prior provenance to that record.
    v_diff   := jsonb_build_object(
      'previous_content',     OLD.content,
      'previous_metadata',    OLD.metadata,
      'previous_derived_from', OLD.derived_from,
      'previous_supersedes',   OLD.supersedes);
  END IF;

  /**
   * A malformed id must not break the mutation, for the same reason
   * ob1_current_actor() swallows unparseable JSON: audit observes, it does not
   * obstruct. A bad value is recorded as no value.
   *
   * Guarded by a pattern rather than by BEGIN … EXCEPTION, which was the first
   * version. A plpgsql block with an EXCEPTION clause establishes a savepoint
   * every time it is ENTERED, not only when it raises — so the safe-looking
   * form would have added a subtransaction to every audit row, on a trigger
   * whose measured cost is already 6% of a bulk insert.
   *
   * The pattern is the canonical hyphenated form, which is the only one this
   * server emits. A uuid written some other way Postgres would accept is read
   * as no id, which fails the same direction as an unparseable one.
   */
  v_agent := CASE
    WHEN actor->>'agent_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (actor->>'agent_id')::uuid
  END;

  INSERT INTO thought_audit (
    thought_id, action, source, actor_name, canonical_agent_id,
    author_session_id, diff, actor_context)
  VALUES (
    v_id,
    v_action,
    COALESCE(actor->>'source', v_source),
    actor->>'name',
    v_agent,
    actor->>'session',
    v_diff,
    -- NULL rather than an empty object when the actor carries nothing extra:
    -- `{}` on every row is storage and reading noise for no information.
    NULLIF(actor - 'name' - 'source' - 'session' - 'agent_id', '{}'::jsonb)
  );

  RETURN NULL;  -- AFTER trigger; the return value is ignored.
END;
$$;

-- ---------------------------------------------------------------------------
-- upsert_thought(text, jsonb, vector) — 022's body, and now the provenance
-- envelope. Repeated in full because CREATE OR REPLACE has no partial form; the
-- additions are the derived_from/supersedes read + validation before the write,
-- and the two columns in the INSERT and its ON CONFLICT clause.
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
  v_derived     jsonb := p_payload->'derived_from';
  v_supersedes  text  := p_payload->>'supersedes';
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

  /**
   * 025: derived_from is validated HERE — the write is the choke point, or an
   * untrusted-input hole (SMD-1253, departure 3). A JSON null means "none". An
   * array is required otherwise; every element must be a UUID STRING (not a
   * number, bool, object, array or JSON null — jsonb_object elements the CHECK
   * cannot reach) AND must name a thought that exists (a jsonb array cannot be a
   * foreign key). A bad reference must fail the capture with a clear message,
   * not cast-error later inside trace_provenance.
   */
  IF v_derived IS NOT NULL AND jsonb_typeof(v_derived) NOT IN ('array', 'null') THEN
    RAISE EXCEPTION
      'upsert_thought: derived_from must be a JSON array of thought UUID strings, got %.',
      jsonb_typeof(v_derived);
  END IF;
  IF jsonb_typeof(v_derived) = 'array' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_derived) AS e
      WHERE jsonb_typeof(e) <> 'string'
         OR (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) THEN
      RAISE EXCEPTION
        'upsert_thought: derived_from must contain only thought UUID strings; got a non-UUID element in %.',
        v_derived;
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(v_derived) AS ref(id)
      WHERE NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = ref.id::uuid)
    ) THEN
      RAISE EXCEPTION
        'upsert_thought: derived_from references a thought that does not exist (in %).',
        v_derived;
    END IF;
    -- Normalise "[]" and JSON null alike to SQL NULL, so an empty array does
    -- not read as "derived from nothing" distinct from "not derived". A
    -- non-empty array is canonicalised: lowercased (the regex accepts either
    -- case, but the GIN containment find_derivatives uses is byte-exact, so an
    -- uppercase element would be invisible to the down-walk while the up-walk's
    -- ::uuid cast still saw it — the two directions must agree) and de-duplicated
    -- (a repeated source is one edge). Order is not meaningful, so sort for a
    -- stable stored value. Review pass 1, SMD-1253.
    IF jsonb_array_length(v_derived) = 0 THEN
      v_derived := NULL;
    ELSE
      SELECT to_jsonb(array_agg(DISTINCT lower(e) ORDER BY lower(e)))
        INTO v_derived
        FROM jsonb_array_elements_text(v_derived) AS e;
    END IF;
  ELSE
    v_derived := NULL;  -- JSON null or absent.
  END IF;

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
        -- update_thought's job (a follow-up), and would be audited. (Review pass
        -- 2: the arguments were the other way round, which let a re-capture with
        -- a different derived_from silently overwrite — the "changing" this
        -- comment says it does not do.)
        derived_from = COALESCE(thoughts.derived_from, EXCLUDED.derived_from),
        supersedes   = COALESCE(thoughts.supersedes,   EXCLUDED.supersedes)
  RETURNING id INTO v_id;

  -- ob1:vector-replaces-chunks — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `atomic capture` check reads it. 022: the windows
  -- stay while the label vouches for them — the row's vector was labelled
  -- with a model and the vector arriving is labelled with the same one — and
  -- go in every other case: a label unknown on either side, or another model.
  -- No vector arriving keeps vector, label and windows alike; a fresh insert
  -- runs no DELETE (v_existed), and neither does a race the lock could not
  -- cover — see 022's header. The 4-argument form delegates here and then
  -- writes the caller's windows; update_thought does the same for an edit.
  IF p_embedding IS NOT NULL AND v_existed
     AND (v_old_label = p_payload->>'embedding_model') IS NOT TRUE THEN
    DELETE FROM thought_chunks WHERE thought_id = v_id;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector) IS
  'Atomic capture: content + metadata + embedding in one statement. Reads p_payload.actor (008), p_payload.embedding_model (021), and p_payload.derived_from / p_payload.supersedes (025) from the envelope. derived_from is validated here — an array of existing thought UUIDs, or the write is refused (SMD-1253); supersedes'' existence is the self-FK''s. On a re-capture the label follows the vector, the chunk rows stay only while the label vouches for them (022), and provenance is added if given but never cleared.';

-- ---------------------------------------------------------------------------
-- Read-back: trace the derivation chain both ways
--
-- Both plain (SECURITY INVOKER), STABLE, cycle-guarded, depth/node-capped, no
-- tier branch (departures 1 and 2). trace_provenance walks UP derived_from;
-- find_derivatives looks DOWN it. type / source_type / derivation_method are
-- read from metadata (departure 5).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trace_provenance(
  p_thought_id uuid,
  p_max_depth  int DEFAULT 3,
  p_node_cap   int DEFAULT 250
)
RETURNS TABLE (
  thought_id        uuid,
  depth             int,
  parent_id         uuid,
  content           text,
  type              text,
  source_type       text,
  derivation_method text,
  created_at        timestamptz,
  cycle             boolean
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  -- Clamp the walk. A recursive CTE over a cycle or a fan-out is the one place
  -- a read can run away; the caps bound it regardless of what the caller asks.
  -- Cycles are bounded (the visited guard + depth); the node cap bounds OUTPUT.
  -- A cycle-free but DENSE DAG can still materialise many paths before the cap
  -- (UNION ALL, outer LIMIT) — no shipped writer produces one; bounding that
  -- work is SMD-1288.
  v_max_depth int := GREATEST(1, LEAST(COALESCE(p_max_depth, 3), 10));
  v_node_cap  int := GREATEST(1, LEAST(COALESCE(p_node_cap, 250), 2000));
BEGIN
  IF p_thought_id IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH RECURSIVE walk AS (
    SELECT
      t.id                                AS thought_id,
      0                                   AS depth,
      NULL::uuid                          AS parent_id,
      t.content,
      t.metadata->>'type'                 AS type,
      t.metadata->>'source_type'          AS source_type,
      t.metadata->>'derivation_method'    AS derivation_method,
      t.created_at,
      t.derived_from,
      ARRAY[t.id]                         AS visited,
      false                               AS cycle
    FROM thoughts t
    WHERE t.id = p_thought_id
    UNION ALL
    SELECT
      parent.id,
      w.depth + 1,
      w.thought_id,
      parent.content,
      parent.metadata->>'type',
      parent.metadata->>'source_type',
      parent.metadata->>'derivation_method',
      parent.created_at,
      parent.derived_from,
      w.visited || parent.id,
      parent.id = ANY(w.visited)
    FROM walk w
    -- The CHECK guarantees array-or-null, and upsert_thought validates elements,
    -- but a row written by anything else (direct SQL, COPY, a future writer)
    -- could hold a non-array or a non-UUID element. Coerce a non-array to '[]'
    -- and keep only UUID-shaped elements BEFORE the ::uuid cast, so a
    -- hand-written bad element is skipped rather than raising inside the read
    -- (the promise this comment used to make but the bare cast broke — review
    -- pass 1, SMD-1253). The regex-filtered cast still resolves parent by its
    -- primary key, so the walk stays index-driven.
    CROSS JOIN LATERAL (
      SELECT e AS parent_id_text
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(w.derived_from) = 'array' THEN w.derived_from ELSE '[]'::jsonb END
      ) AS e
      WHERE e ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) AS p
    JOIN thoughts parent ON parent.id = p.parent_id_text::uuid
    WHERE w.depth < v_max_depth AND NOT w.cycle
  )
  SELECT
    walk.thought_id, walk.depth, walk.parent_id, walk.content,
    walk.type, walk.source_type, walk.derivation_method, walk.created_at, walk.cycle
  FROM walk
  ORDER BY depth ASC, thought_id ASC
  LIMIT v_node_cap;
END;
$$;

COMMENT ON FUNCTION trace_provenance(uuid, int, int) IS
  'Walks UP the derived_from chain from a thought (depth 0) to its ancestors. Cycle-guarded (a repeat is returned once with cycle=true and not re-expanded), depth clamped 1-10, node count clamped 1-2000. type/source_type/derivation_method come from metadata. Migration 025 / SMD-1253.';

CREATE OR REPLACE FUNCTION find_derivatives(
  p_thought_id uuid,
  p_limit      int DEFAULT 100
)
RETURNS TABLE (
  id                uuid,
  content           text,
  type              text,
  source_type       text,
  derivation_method text,
  created_at        timestamptz
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_limit int := GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
BEGIN
  IF p_thought_id IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT
    t.id,
    t.content,
    t.metadata->>'type',
    t.metadata->>'source_type',
    t.metadata->>'derivation_method',
    t.created_at
  FROM thoughts t
  WHERE t.derived_from @> jsonb_build_array(p_thought_id::text)
  ORDER BY t.created_at DESC
  LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION find_derivatives(uuid, int) IS
  'Looks DOWN the derived_from chain: the thoughts derived directly from a given one (one level), newest first, count clamped 1-500. Served by idx_thoughts_derived_from (GIN containment). Migration 025 / SMD-1253.';
