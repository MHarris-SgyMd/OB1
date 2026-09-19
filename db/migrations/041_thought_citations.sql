-- ============================================================================
-- 041 — a thought cited as a source cannot be deleted from under the citation:
--        thought_facets with one registered kind, `citation`; a statement-level
--        guard on thoughts that refuses with its own SQLSTATE; delete_thought
--        answering that refusal as a value, with the citing rows named, and a
--        detach opt-in (SMD-1712)
--
-- Why
--   Nothing on the fork records that one thought is the SOURCE of a statement
--   made in another. 025 records what a thought was derived from and which
--   thought it replaces — facts about the thought as a whole. A citation is
--   finer: "this statement in thought C rests on thought S". Without it,
--   delete_thought(S) removes a source a later note leans on, silently, and the
--   note reads the same afterwards with nothing behind it. The proposal bundle
--   of 2026-09-12 drafted the fix as a facet table with a claim kind, a guard
--   trigger raising foreign_key_violation, and delete_thought catching it. The
--   idea lands here on the fork's own terms (the ticket lists what changed):
--   the name is citation, not claim (015 already spends "claims" on work
--   leases); the guard raises its OWN SQLSTATE so a real FK failure on a delete
--   is never reported as "cited"; the function is 036's body — the supersession
--   advisory lock before the DELETE stays, or the accept-versus-delete deadlock
--   PR 68 closed comes back; and every statement is idempotent under
--   migrate.ts --reapply (SMD-1193).
--
-- What
--   1. thought_facets — a sidecar of typed rows on a thought: kind, a jsonb
--      payload the validate trigger checks BY KIND, valid_until (NULL = open),
--      superseded_by (a later facet row that replaces this one; the row stays,
--      as 025's supersedes keeps the superseded thought). One kind is registered,
--      `citation`, payload {text, stance, source_id}: the statement, whether it
--      was stated / retrieved / inferred, and the thought it rests on. A row
--      whose kind is not registered is refused (check_violation); a later
--      migration registers a kind by extending the validate function, not by
--      a registry table (the proposal's vocabulary registry is not built).
--      A citation is ACTIVE while valid_until is NULL or in the future and no
--      facet that still exists supersedes it (thought_facet_active, the one
--      spelling). Only active citations gate a delete; expired and superseded
--      ones are history and never block, though they are marked when their
--      source goes (below), so no row names a thought that is gone.
--   2. thoughts_guard_citation_sources — AFTER DELETE ON thoughts, FOR EACH
--      STATEMENT, the deleted rows as a transition table. It counts the active
--      citations whose source is a deleted row AND whose own thought SURVIVES
--      the statement — a citation on a thought deleted by the same statement is
--      gone with it (thought_id's cascade) and would leave nothing resting on
--      nothing. If any survive and the transaction-local setting
--      ob1.cited_delete is not 'detach', it RAISES SQLSTATE 'OB001' and the
--      whole DELETE fails. Otherwise it DETACHES: every surviving citing row
--      (active or not) keeps its text and stance, loses source_id (set to JSON
--      null, the key kept) and records source_deleted_id / source_deleted_at —
--      the citation survives as "rested on a thought that was deleted at T",
--      which is what a reader of the citing thought needs to know. It totals
--      what it did in two transaction-local settings (ob1.citations_detached,
--      ob1.citations_inactive), summed across statements, which delete_thought
--      reads back.
--      Statement-level rather than the proposal's row-level BEFORE trigger for
--      one reason: a row-level guard sees one row at a time, so "delete the
--      note and its source together" would be refused or not by the order the
--      rows came in, and a reset (DELETE FROM thoughts) would be refused the
--      moment any citation existed — order-dependent behaviour, the class this
--      fork treats as a defect. The statement is the unit a deletion is judged
--      by; the price is the transition table, the deleted rows held once for
--      the statement (a bulk delete of N rows materialises N rows, vectors
--      included — the cost a reset of a large corpus pays; a single delete
--      pays nothing that shows).
--      The guard fires on EVERY delete of thoughts rows — a bulk DELETE, a
--      vendored script, psql — not only through delete_thought: the refusal is
--      the table's, the way 008's append-only rule is thought_audit's, and the
--      way through is the setting, which only a caller who names it takes.
--   3. delete_thought(uuid, jsonb, boolean) — 036's body with p_detach added.
--      Actor and mode set first (outside the block: a caught exception rolls
--      back its subtransaction, set_config included, and 008's audit trigger
--      must still see the actor); the supersession advisory lock, THEN the
--      DELETE inside a BEGIN … EXCEPTION block that catches exactly SQLSTATE
--      'OB001' and returns {ok:false, error:'CITED', id, cited_by, citations}
--      — the count and up to ten citing rows, newest first, read after the
--      subtransaction rolled back and in the same transaction, so they describe
--      the state the guard saw. Any other error — a real 23503, a permission
--      failure — propagates as the fault it is. Success carries detached:n and,
--      when non-zero, inactive:m. The two-argument overload is DROPPED first:
--      with a DEFAULT on the third parameter, leaving it would make every
--      two-argument call "function delete_thought(uuid, jsonb) is not unique".
--      Two-argument callers keep working — the default is the old behaviour,
--      which now includes the refusal.
--   4. record_citation(uuid, uuid, text, text) — the one writer of a citation
--      row, so the write joins the lock order every writer of a contended row
--      takes since 033/036: the supersession advisory lock first, then the
--      rows. Refusals are values in 009's envelope: NOT_FOUND (the citing
--      thought), SOURCE_NOT_FOUND, SELF_CITATION, BAD_STANCE, EMPTY_TEXT. No
--      MCP tool calls it yet — the write side of citations is SMD-1730/1733's;
--      this migration is the guard and the writer the guard is tested through.
--
-- The check is NOT a SELECT-then-DELETE. The guard fires inside the DELETE
--   statement, so a citation committed between a precheck and the delete would
--   still be seen; and the validate trigger takes FOR KEY SHARE on the source
--   row when a citation is written, so a delete of that row waits for the
--   citation's transaction and then sees it (READ COMMITTED: each statement in
--   the guard takes a fresh snapshot, and an AFTER trigger runs after the
--   statement's own waits) — the same lock an FK would take. This is the
--   not-a-precheck rule 009 set for if_unchanged_since.
--
-- Lock order, stated
--   delete_thought:  supersession advisory lock → the thought's row (DELETE) →
--                    the surviving citing facet rows (the guard's UPDATE).
--   record_citation: supersession advisory lock → KEY SHARE on the citing and
--                    the source thought (its prechecks; the validate trigger
--                    re-locks the source) → the facet row (INSERT).
--   A raw INSERT INTO thought_facets skips the advisory lock and takes only
--   KEY SHARE; it cannot deadlock delete_thought unless its own transaction goes
--   on to take the advisory lock — the residue every raw writer on this fork
--   has, stated as 036's header states the delete's.
--
-- Callers that delete around delete_thought
--   Three vendored servers issue a raw `.delete()` on thoughts —
--   integrations/rest-api's dedup merge (after it has already rewritten the
--   survivor's metadata and logged the merge), integrations/delete-thought-mcp
--   and integrations/open-brain-rest. Each now meets the guard as a bare OB001
--   message with no detach path, the way every raw writer met 008's rule.
--   Routing them through delete_thought is SMD-1793 (as SMD-1228 and SMD-1524
--   did for the writers of content); nothing here changes them.
--
-- Cost
--   Every delete of a thought now reads thought_facets by the partial expression
--   index on (payload->>'source_id') WHERE kind = 'citation' — one index probe
--   on an empty table for every brain that has written no citation. The
--   BEGIN … EXCEPTION block is a savepoint per delete; a delete is not a hot path.
--   The guard runs as the calling role (SECURITY INVOKER, like every function
--   here), so a self-hosted server role needs SELECT and UPDATE on
--   thought_facets to delete ANY thought — db/config.mjs ROLE_GRANTS.capture
--   carries it and preflight's `write privileges` refuses a role without it.
--
-- Idempotent under --reapply: IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF
--   EXISTS before CREATE TRIGGER, DROP FUNCTION IF EXISTS for the overload.
--   Under a re-run 009 and 036 re-create the two-argument delete_thought in
--   their turn and this file drops it again in its.
--
-- Dependencies: 001 (thoughts), 008 (audit + ob1.actor), 009/036 (delete_thought),
--   033/036 (the supersession advisory lock as the writers' order).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- thought_facets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS thought_facets (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The thought the facet is about: the CITING thought for a citation. Goes
  -- with it — a facet is part of the thought's record, not a record of its own.
  thought_id    uuid        NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  -- The registered kind; the validate trigger refuses any other. One today.
  kind          text        NOT NULL,
  -- Shaped by kind, checked by the validate trigger. A citation carries
  -- {text, stance, source_id}; after its source is deleted, source_id is null
  -- and source_deleted_id / source_deleted_at say which thought and when.
  payload       jsonb       NOT NULL,
  -- NULL = open-ended. A citation past its valid_until is history: it never
  -- blocks a delete, and a read should LABEL it expired, never hide it (the
  -- fork measured exclusion for supersession and chose labels, 025 / change 46).
  valid_until   timestamptz,
  -- A later facet row that replaces this one. The row stays, as a superseded
  -- thought stays. SET NULL: deleting the replacement revives the old row's
  -- status, and that is visible in the column rather than silent.
  superseded_by uuid        REFERENCES thought_facets(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (superseded_by IS NULL OR superseded_by <> id)
);

COMMENT ON TABLE thought_facets IS
  'Typed rows on a thought, one kind registered: citation, payload {text, stance, source_id} — a statement in thought_id that rests on thought source_id. Validated by kind in thought_facets_validate (check_violation for an unregistered kind or a malformed payload). Active while superseded_by IS NULL and valid_until is NULL or future; only active citations make thoughts_guard_citation_sources refuse a delete of their source. Written through record_citation. Migration 041 / SMD-1712.';
COMMENT ON COLUMN thought_facets.kind IS
  'The registered kind; citation is the only one (041). A later migration registers another by extending thought_facets_validate, not by a registry table.';
COMMENT ON COLUMN thought_facets.payload IS
  'Shaped by kind. citation: text (non-empty), stance (stated | retrieved | inferred), source_id (an existing thought, not thought_id itself). After the source is deleted: source_id null, source_deleted_id and source_deleted_at set by the guard.';
COMMENT ON COLUMN thought_facets.valid_until IS
  'NULL = open-ended. Past it the facet is expired: still a row, never a bar to deleting its source, to be labelled and not hidden by a read.';
COMMENT ON COLUMN thought_facets.superseded_by IS
  'A later facet that replaces this one; the row stays. A superseded citation never bars a delete of its source.';

CREATE INDEX IF NOT EXISTS thought_facets_thought_kind_idx
  ON thought_facets (thought_id, kind);

-- The guard's lookup: which citations rest on the thought being deleted. A
-- partial expression index, so it is one probe on an empty table.
CREATE INDEX IF NOT EXISTS thought_facets_citation_source_idx
  ON thought_facets ((payload->>'source_id'))
  WHERE kind = 'citation';

-- ---------------------------------------------------------------------------
-- thought_facets_validate — the payload contract, by kind
--
-- check_violation (23514) for every refusal here: the row fails the table's
-- rule, as a CHECK would say if a CHECK could hold a subquery (it cannot; 025
-- departure 3). The source-exists check takes FOR KEY SHARE on the source row
-- — the lock an FK takes — so a concurrent delete of the source waits for this
-- transaction and then sees the citation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thought_facets_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source  text;
  v_deleted text;
  v_text    text;
  v_stance  text;
BEGIN
  IF jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('thought_facets.payload must be a JSON object, got %s', COALESCE(jsonb_typeof(NEW.payload), 'null'));
  END IF;
  IF NEW.kind IS DISTINCT FROM 'citation' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('thought_facets.kind %L is not a registered facet kind', NEW.kind),
      HINT = 'The registered kinds are: citation (migration 041). A new kind is registered by a migration that extends thought_facets_validate.';
  END IF;

  v_text    := NEW.payload->>'text';
  v_stance  := NEW.payload->>'stance';
  v_source  := NEW.payload->>'source_id';
  v_deleted := NEW.payload->>'source_deleted_id';

  IF jsonb_typeof(NEW.payload->'text') IS DISTINCT FROM 'string' OR btrim(v_text) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'a citation needs a non-empty text: the statement that rests on the source';
  END IF;
  IF v_stance IS NULL OR v_stance NOT IN ('stated', 'retrieved', 'inferred') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('a citation''s stance must be stated, retrieved or inferred, got %L', v_stance);
  END IF;

  IF v_source IS NULL THEN
    -- Only the detached shape may carry no source: the guard wrote which
    -- thought was deleted and when. A citation written without a source is not
    -- a citation.
    IF TG_OP = 'INSERT' OR v_deleted IS NULL
       OR v_deleted !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NEW.payload->>'source_deleted_at' IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a citation names its source: payload.source_id must be a thought id (null only after the guard detached it, with source_deleted_id and source_deleted_at set)';
    END IF;
    RETURN NEW;
  END IF;

  IF v_source !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('a citation''s source_id must be a thought id, got %L', left(v_source, 60));
  END IF;
  IF v_source::uuid = NEW.thought_id THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'a thought cannot cite itself as a source';
  END IF;
  -- The source must exist, and is locked KEY SHARE while this transaction
  -- runs — re-checked only when the pointer is new or moved, as an FK is.
  IF TG_OP = 'INSERT' OR v_source IS DISTINCT FROM (OLD.payload->>'source_id') THEN
    PERFORM 1 FROM thoughts WHERE id = v_source::uuid FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a citation''s source_id %s is not a thought', v_source);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION thought_facets_validate() IS
  'BEFORE INSERT OR UPDATE on thought_facets: refuses an unregistered kind and, for a citation, a missing text, a stance outside stated | retrieved | inferred, a source_id that is not an existing thought or is the citing thought itself — all as check_violation — and locks the source row FOR KEY SHARE so a concurrent delete of it waits and then sees the citation. source_id may be null only in the detached shape the guard writes. Migration 041.';

DROP TRIGGER IF EXISTS thought_facets_validate ON thought_facets;
CREATE TRIGGER thought_facets_validate
  BEFORE INSERT OR UPDATE ON thought_facets
  FOR EACH ROW EXECUTE FUNCTION thought_facets_validate();

-- ---------------------------------------------------------------------------
-- thought_facet_active — the one spelling of "this facet still counts"
-- ---------------------------------------------------------------------------
-- A superseder that no longer exists counts as none: superseded_by's SET NULL
-- is a nested referential action and fires AFTER the statement-level guard
-- (measured — first review pass), so when the thought carrying a replacing
-- citation is deleted in the same statement as the source, the replaced
-- citation still points at the replacement the cascade has already removed.
-- The guard would judge it superseded, mark it, and the SET NULL would then
-- revive it — detached, under refuse mode. Reading the pointer's target instead
-- says what the SET NULL is about to say, whatever the phase order.
CREATE OR REPLACE FUNCTION thought_facet_active(f thought_facets)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT (f.valid_until IS NULL OR f.valid_until > now())
     AND (f.superseded_by IS NULL OR NOT EXISTS (SELECT 1 FROM thought_facets x WHERE x.id = f.superseded_by))
$$;

COMMENT ON FUNCTION thought_facet_active(thought_facets) IS
  'Whether a facet row still counts: not past valid_until, and not superseded by a later facet that still exists (a superseder already deleted in the statement counts as none, since its SET NULL fires after the guard). The guard, delete_thought''s sample and any reader that labels a citation share this one spelling, so a later definition of "active" changes in one place. Migration 041.';

-- ---------------------------------------------------------------------------
-- thoughts_guard_citation_sources — the refusal is the table's
--
-- Statement-level, over the deleted rows (REFERENCING OLD TABLE AS deleted):
-- a citation counts only while its own thought survives the statement. That
-- is every row the join finds: the cascade on thought_id is a row-level AFTER
-- trigger, and Postgres fires every row-level AFTER trigger of a statement —
-- the referential actions among them — before its statement-level ones, so
-- the citations on thoughts this statement deletes are gone when this runs.
-- An explicit `f.thought_id NOT IN (SELECT id FROM deleted)` was written to
-- say so and removed: its mutant passed every check, which makes it a clause
-- that is not a mechanism (test-schema [39] holds the together-delete case).
--
-- The guard judges the state the statement LEAVES. Deleting the thought that
-- carries a replacing citation in the same statement as the source revives the
-- replaced citation on a note that survives (superseded_by's SET NULL), and
-- the statement is refused — after it, that note would rest on nothing, which
-- is the question the guard asks. That SET NULL fires AFTER this trigger, so
-- thought_facet_active reads whether the superseder still exists rather than
-- whether the pointer is null ([39] holds the case both ways).
--
-- The count and the detach are ONE statement, an UPDATE … RETURNING over the
-- citing rows: each row is locked and its status read from the version the
-- lock won, so a citation revived under a concurrent writer — valid_until or
-- superseded_by cleared between a look and a write — is seen as active, where
-- a count followed by an UPDATE would have counted the old version and
-- rewritten the new one (first review pass; db/test-live.ts [6i] arm 4). In
-- refuse mode with an active row the RAISE below aborts the DELETE statement
-- and this UPDATE with it, so a refusal rewrites nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thoughts_guard_citation_sources()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_mode     text := COALESCE(NULLIF(current_setting('ob1.cited_delete', true), ''), 'refuse');
  v_active   int;
  v_inactive int;
  v_sources  int;
  v_first    uuid;
BEGIN
  IF v_mode NOT IN ('refuse', 'detach') THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = format('ob1.cited_delete must be refuse or detach, got %L', v_mode);
  END IF;

  -- Every surviving citing row, active or not, marked with the source it lost
  -- (source_id null, source_deleted_id / source_deleted_at) — through
  -- thought_facets_validate, which accepts this shape — and its status read
  -- back from the locked version. Rolled back with the statement on a refusal.
  WITH marked AS (
    UPDATE thought_facets f
       SET payload = f.payload || jsonb_build_object('source_id', NULL, 'source_deleted_id', d.id, 'source_deleted_at', now())
      FROM deleted d
     WHERE f.kind = 'citation' AND f.payload->>'source_id' = d.id::text
     RETURNING thought_facet_active(f) AS active, d.id AS source
  )
  SELECT count(*) FILTER (WHERE active)::int,
         count(*) FILTER (WHERE NOT active)::int,
         count(DISTINCT source) FILTER (WHERE active)::int,
         min(source::text) FILTER (WHERE active)::uuid
    INTO v_active, v_inactive, v_sources, v_first
    FROM marked;

  IF v_active > 0 AND v_mode = 'refuse' THEN
    RAISE EXCEPTION USING ERRCODE = 'OB001',
      MESSAGE = CASE WHEN v_sources = 1
                     THEN format('thought %s is cited as a source by %s active citation(s) on thoughts this delete leaves standing', v_first, v_active)
                     ELSE format('%s of the thoughts this delete removes are cited as sources by %s active citation(s) on thoughts it leaves standing (%s among them)', v_sources, v_active, v_first) END,
      DETAIL = 'Deleting them would leave those statements resting on nothing. delete_thought returns this as {ok:false, error:CITED, cited_by, citations}.',
      HINT = 'delete_thought(id, actor, true) detaches them: each keeps its text and stance, loses source_id and records source_deleted_id and source_deleted_at. A raw DELETE does the same under set_config(''ob1.cited_delete'', ''detach'', true).';
  END IF;

  -- Totals for the caller, summed across the statements of a transaction.
  -- delete_thought zeroes them first and reads them after its one statement.
  PERFORM set_config('ob1.citations_detached',
                     (COALESCE(NULLIF(current_setting('ob1.citations_detached', true), ''), '0')::int + v_active)::text, true);
  PERFORM set_config('ob1.citations_inactive',
                     (COALESCE(NULLIF(current_setting('ob1.citations_inactive', true), ''), '0')::int + v_inactive)::text, true);
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION thoughts_guard_citation_sources() IS
  'AFTER DELETE on thoughts, per statement over the deleted rows: with active citations resting on a deleted row from thoughts the statement leaves standing, and ob1.cited_delete not ''detach'' (the transaction-local default is refuse), raises SQLSTATE OB001 and the whole DELETE fails — for every deleter, not only delete_thought. Otherwise detaches every surviving citation that named a deleted row (source_id null, source_deleted_id / source_deleted_at set) and adds what it did to ob1.citations_detached (active) and ob1.citations_inactive (expired or superseded). A citation on a thought the same statement deletes goes with it and never counts. Migration 041 / SMD-1712.';

DROP TRIGGER IF EXISTS thoughts_guard_citation_sources ON thoughts;
CREATE TRIGGER thoughts_guard_citation_sources
  AFTER DELETE ON thoughts
  REFERENCING OLD TABLE AS deleted
  FOR EACH STATEMENT EXECUTE FUNCTION thoughts_guard_citation_sources();

-- ---------------------------------------------------------------------------
-- delete_thought(uuid, jsonb, boolean) — 036's body, the refusal answered as a
-- value, p_detach the named way through. The two-argument form goes first.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS delete_thought(uuid, jsonb);

CREATE OR REPLACE FUNCTION delete_thought(
  p_id     uuid,
  p_actor  jsonb   DEFAULT NULL,
  p_detach boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted   uuid;
  -- The mode as the caller's transaction had it, put back after the DELETE:
  -- p_detach is this call's, not the transaction's, so a raw DELETE later in
  -- the same transaction meets the guard's default (or the caller's own
  -- setting) and not this call's choice (first review pass; [39] holds it).
  v_prev_mode text := current_setting('ob1.cited_delete', true);
  v_refused   boolean := false;
  v_cited     int;
  v_citations jsonb;
  v_detached  int;
  v_inactive  int;
BEGIN
  -- Every setting OUTSIDE the block below: a caught exception rolls back its
  -- subtransaction, set_config included, and the audit trigger (008) must still
  -- see the actor on the DELETE that follows a refusal-free path.
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;
  PERFORM set_config('ob1.cited_delete', CASE WHEN COALESCE(p_detach, false) THEN 'detach' ELSE 'refuse' END, true);
  PERFORM set_config('ob1.citations_detached', '0', true);
  PERFORM set_config('ob1.citations_inactive', '0', true);

  -- 036: the supersession advisory lock before the DELETE — the key
  -- review_supersession_proposal, update_thought and upsert_thought take
  -- (029/032/033) — so a delete of a superseded thought serialises with an
  -- acceptance writing that pointer instead of deadlocking against it through
  -- 029's cascade. Unconditional, held to the end of the transaction. Taken
  -- outside the block: a savepoint's rollback releases the advisory locks it
  -- acquired, and this one must outlive a refusal.
  PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));

  BEGIN
    DELETE FROM thoughts WHERE id = p_id RETURNING id INTO v_deleted;
  EXCEPTION WHEN SQLSTATE 'OB001' THEN
    -- The guard refused (041). Only this SQLSTATE is caught: a real
    -- foreign_key_violation, a permission failure, anything else is the fault
    -- it is and propagates.
    v_refused := true;
  END;
  PERFORM set_config('ob1.cited_delete', COALESCE(v_prev_mode, ''), true);

  IF v_refused THEN
    -- Answer with what cites the row, not the message: the count and up to ten
    -- citing rows, newest first, read after the subtransaction rolled back, in
    -- the same transaction — the state the guard saw.
    SELECT count(*)::int,
           COALESCE(jsonb_agg(jsonb_build_object('id', f.id, 'thought_id', f.thought_id,
                                                 'stance', f.payload->>'stance', 'text', f.payload->>'text',
                                                 'created_at', f.created_at)
                              ORDER BY f.created_at DESC, f.id) FILTER (WHERE f.rn <= 10), '[]'::jsonb)
      INTO v_cited, v_citations
      FROM (SELECT f.*, row_number() OVER (ORDER BY f.created_at DESC, f.id) AS rn
              FROM thought_facets f
             WHERE f.kind = 'citation' AND f.payload->>'source_id' = p_id::text
               AND thought_facet_active(f)) f;
    RETURN jsonb_build_object('ok', false, 'error', 'CITED', 'id', p_id,
                              'cited_by', COALESCE(v_cited, 0), 'citations', v_citations);
  END IF;

  IF v_deleted IS NULL THEN
    -- A distinct outcome, not a silent success. The caller asked to remove a
    -- specific thing; not finding it is information.
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;

  -- What the guard did on the way: the active citations it detached (only with
  -- p_detach — refuse mode never reaches here with any), and the expired or
  -- superseded ones it marked with the deleted source in either mode.
  v_detached := COALESCE(NULLIF(current_setting('ob1.citations_detached', true), ''), '0')::int;
  v_inactive := COALESCE(NULLIF(current_setting('ob1.citations_inactive', true), ''), '0')::int;
  RETURN jsonb_build_object('ok', true, 'id', v_deleted, 'detached', v_detached)
         || CASE WHEN v_inactive > 0 THEN jsonb_build_object('inactive', v_inactive) ELSE '{}'::jsonb END;
END;
$$;

COMMENT ON FUNCTION delete_thought(uuid, jsonb, boolean) IS
  'Hard-delete a thought by id. Chunks go by cascade; migration 008 audits the delete with previous_content preserved, which is what makes a hard delete recoverable. Takes the supersession advisory lock before the DELETE (036) — the one review_supersession_proposal and update_thought take — so a delete of a superseded thought serialises with an acceptance writing that pointer rather than deadlocking against 029''s ON DELETE CASCADE. Returns {ok:false, error:NOT_FOUND} rather than succeeding silently, and since 041 {ok:false, error:CITED, id, cited_by, citations[≤10]} when active citations rest on the row and p_detach is false; p_detach = true detaches them (each keeps text and stance, source_id → null, source_deleted_id/at recorded) and success carries detached:n, plus inactive:m when expired or superseded citations were marked the same way. Two-argument calls resolve through the default. Migration 009 / 036 / 041.';

-- ---------------------------------------------------------------------------
-- record_citation — the writer, in the writers' lock order
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_citation(
  p_thought_id uuid,
  p_source_id  uuid,
  p_text       text,
  p_stance     text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_stance IS NULL OR p_stance NOT IN ('stated', 'retrieved', 'inferred') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_STANCE', 'stance', p_stance);
  END IF;
  IF p_text IS NULL OR btrim(p_text) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'EMPTY_TEXT');
  END IF;
  IF p_thought_id = p_source_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SELF_CITATION', 'id', p_thought_id);
  END IF;
  -- The writers' order (033/036): the supersession advisory lock before any
  -- row, so a citation written in the same transaction as a supersedes write
  -- or a delete cannot close a cycle with delete_thought, which takes the same
  -- lock before the row this write locks KEY SHARE.
  PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));
  -- Both rows locked KEY SHARE here, not merely looked at: a delete of either
  -- in flight is waited out, so a source that vanishes answers
  -- SOURCE_NOT_FOUND as a value rather than the validate trigger's
  -- check_violation an instant later (first review pass; db/test-live.ts [6i]
  -- arm 5), and the trigger's own lock on the source is a re-lock.
  PERFORM 1 FROM thoughts WHERE id = p_thought_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND', 'id', p_thought_id);
  END IF;
  PERFORM 1 FROM thoughts WHERE id = p_source_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SOURCE_NOT_FOUND', 'source_id', p_source_id);
  END IF;
  -- The INSERT runs the validate trigger, which re-locks the source KEY SHARE.
  INSERT INTO thought_facets (thought_id, kind, payload)
  VALUES (p_thought_id, 'citation', jsonb_build_object('text', p_text, 'stance', p_stance, 'source_id', p_source_id))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'thought_id', p_thought_id, 'source_id', p_source_id);
END;
$$;

COMMENT ON FUNCTION record_citation(uuid, uuid, text, text) IS
  'Writes one citation facet: thought p_thought_id rests on p_source_id for the statement p_text, with stance stated | retrieved | inferred. Takes the supersession advisory lock first (the writers'' order, 033/036), then the INSERT locks the source KEY SHARE through thought_facets_validate. Refusals as values: BAD_STANCE, EMPTY_TEXT, SELF_CITATION, NOT_FOUND (the citing thought), SOURCE_NOT_FOUND. No MCP tool calls it yet. Migration 041 / SMD-1712.';
