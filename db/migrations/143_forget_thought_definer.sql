-- =============================================================================
-- Migration 143: forget_thought runs as its owner, a forgotten text is asked
--                for before it is embedded, and the leftovers of a forget are
--                listed (SMD-1723 PR 2)
-- =============================================================================
--
-- WHY
--   139's forget_thought ran as its caller, so a role calling it needed the
--   privileges of every store it reaches: UPDATE on thought_audit (the redact
--   amendment), DELETE on five append-only tables, the query log's writes and
--   INSERT on the ledger — more than a full `migrate.ts --grant` issues
--   (review pass 4 of OB1 PR 776). A role holding all of those can forget by
--   hand, around the function, as 139's header names. The maintainer chose
--   (2026-11-15) to make the function SECURITY DEFINER instead: a role needs
--   EXECUTE on it and nothing else, and the hand forget stays the owner's.
--
--   The server embeds a capture's text, a call to the model provider, before
--   the database refuses it (OB005): a forgotten secret captured again went
--   to the provider first. ob1_text_forgotten_at lets the server ask before.
--
--   A write racing a forget can leave a forgotten id in a store (SMD-4299);
--   a second forget sweeps it. ob1_forget_leftovers lists those ids, so
--   preflight can name them (the ticket's Work 3).
--
-- WHAT
--   1. forget_thought(uuid, jsonb, boolean) is SECURITY DEFINER, with:
--      * its search_path pinned to the schemas this migration runs under
--        (current_schemas(false): the brain's, pgvector's wherever it is),
--        pg_temp last, so a caller's temporary objects shadow nothing;
--      * every ob1.* setting a trigger or function reads at run time pinned
--        empty, but ob1.actor: each grants an exemption (a replay's, an
--        amendment's, the forget's own) that a caller could otherwise set
--        before the call and carry in as the owner — 060's replay check
--        reads current_user, which is the owner inside. The function sets
--        the ones it needs itself, and their values end with the call.
--        ob1.actor stays the caller's: it names who forgot, as on every
--        write, and the function sets it from p_actor when given. A replay's
--        own setting is pinned with the rest, so a forget called inside a
--        replay runs as a live write: 139's REPLAYING answer (rebuild_derived
--        refusing under a replay) now comes only from a brain before 143;
--        nothing that replays calls forget_thought;
--      * EXECUTE revoked from PUBLIC, and granted to every role that may
--        delete a thought (DELETE on thoughts: delete_thought's privilege),
--        and to the `server` grant group in db/config.mjs.
--   2. ob1_text_forgotten_at(text): when the ledger forgot this text, or
--      NULL. NULL also when no thought standing holds that text, a reinstated
--      one or a twin, or ob1.reinstate_forgotten is on: 139's refusal
--      trigger's rule, for the canonical fingerprint. It never refuses a
--      text the trigger would let through, and may pass one the trigger
--      refuses (a raw writer's stale key): the trigger stays the authority.
--   3. ob1_forget_leftovers(): one row per forgotten thought and store still
--      holding its id or text — (thought_id, store, n). The stores are the
--      ones forget_thought reaches. A thought standing again under its id
--      (reinstated) is skipped whole.
--
-- REDEFINING forget_thought
--   A CREATE OR REPLACE resets SECURITY DEFINER and the SET clauses (the
--   ACL stays). A migration that redefines forget_thought must repeat 1, and
--   re-applying 139 by hand drops them until 143 is re-applied: preflight's
--   `forget definer` row says so. test-schema [130] holds the pinned list
--   against every ob1.* setting the migrations read.
--
-- IDEMPOTENT: ALTER, REVOKE and GRANT repeat; the functions are CREATE OR
--   REPLACE. Needs 139 and 142.
--
-- TESTS: test-schema [130], test-upgrade [20ch].
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
BEGIN
  IF to_regprocedure('forget_thought(uuid, jsonb, boolean)') IS NULL OR to_regclass('thought_forgotten') IS NULL
     OR to_regclass('priority_findings') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 143 needs 139 and 142 (forget_thought, thought_forgotten, priority_findings); this schema lacks one',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. forget_thought runs as its owner
-- ---------------------------------------------------------------------------
DO $definer$
DECLARE
  v_path text;
BEGIN
  SELECT string_agg(quote_ident(s), ', ' ORDER BY o) INTO v_path
    FROM unnest(current_schemas(false)) WITH ORDINALITY u(s, o);
  IF v_path IS NULL THEN
    RAISE EXCEPTION 'migration 143: the search_path names no schema, so forget_thought''s could not be pinned';
  END IF;
  EXECUTE format('ALTER FUNCTION forget_thought(uuid, jsonb, boolean) SECURITY DEFINER SET search_path = %s, pg_temp', v_path);
END
$definer$;

ALTER FUNCTION forget_thought(uuid, jsonb, boolean)
  SET ob1.projecting_replay = ''
  SET ob1.projecting = ''
  SET ob1.projecting_thought = ''
  SET ob1.event = ''
  SET ob1.audit_amend = ''
  SET ob1.actor_amend = ''
  SET ob1.forgetting = ''
  SET ob1.reinstate_forgotten = ''
  SET ob1.lapse_clearing = ''
  SET ob1.cited_delete = ''
  SET ob1.citations_detached = ''
  SET ob1.citations_inactive = ''
  SET ob1.thread_mark = '';

REVOKE EXECUTE ON FUNCTION forget_thought(uuid, jsonb, boolean) FROM PUBLIC;

DO $grant$
DECLARE
  v_role record;
BEGIN
  -- The roles that may delete a thought may forget one; the owner and
  -- superusers need no grant, nor the predefined roles.
  FOR v_role IN
    SELECT r.rolname
      FROM pg_roles r
     WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\_%'
       AND r.oid <> (SELECT c.relowner FROM pg_class c WHERE c.oid = 'thoughts'::regclass)
       AND has_table_privilege(r.oid, 'thoughts', 'DELETE')
     ORDER BY r.rolname
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION forget_thought(uuid, jsonb, boolean) TO %I', v_role.rolname);
  END LOOP;
END
$grant$;

COMMENT ON FUNCTION forget_thought(uuid, jsonb, boolean) IS
  'Forget a thought: remove it and everything in the database holding its text, in one transaction, and return the evidence (migration 139 / SMD-1723). Runs as its owner (migration 143): SECURITY DEFINER, its search_path pinned with pg_temp last, every ob1.* setting but ob1.actor pinned empty for the call, EXECUTE granted to the roles that may delete a thought and not to PUBLIC. Takes the supersession lock, then the capture''s fingerprint lock for every text it has had (ob1_forget_fingerprints, in order), then the priority lock (116) of every item whose statements it deletes, in key order, then the row, then tries (never waits for) the lock of any text an edit gave it meanwhile; a write racing the forget on another store may land beside it, and a second call sweeps what it left (FORGOTTEN when nothing; ob1_forget_leftovers lists them). An id the log never held: {ok:false, error:NOT_FOUND, id}. A refusal of rebuild_derived''s (REPLAYING) undoes it and is the answer, with the report. Cited by an active citation: {ok:false, error:CITED, id, cited_by, citations}, as delete_thought, unless p_detach, which deletes the citing rows with the rest (detaching by delete_thought first loses the record it was ingested as). A thought deleted before is forgotten from what remains (gone true): its snapshot vectors and every store below. Else: rebuild_derived(id, ''forget'', true, its fingerprints) (windows, entity links, orphaned entities, snapshot vectors); relation facets targeting it, expired or superseded citations of it and citations detached from it deleted; its id stripped from other thoughts'' derived_from (those listed irreproducible); page sections whose evidence names it deleted through delete_page_section, each page re-rendered, and every page whose own log names it listed in pages (its log and its revisions may keep an earlier render); the query log''s result_ids (with their scores) and result_items cleared of it, its action rows deleted; the row deleted through delete_thought; then the priority statements on it, on open items read from it, or taking a due time from either, deleted and re-projected; 142''s priority findings on it or on those items deleted; those items, their events and close proposals (and proposals whose evidence it is) deleted; every bare orphan entity (no mention, edge, priority statement or merge record; in id order, skipping one a writer holds) deleted; its deliverable''s events deleted; every event of it in thought_audit redacted (the redact amendment); a thought_forgotten row written. Forgotten already with nothing left, and no fingerprint the ledger lacks: FORGOTTEN with forgotten_at (and the bare orphans pruned on the way). Returns {ok:true, id, forgotten_at, gone, orphan_entities, removed{relations, inactive_citations, detached_citations, derived_refs, page_sections, query_log_rows, priority_statements, priority_findings, item_reasons, item_proposals, item_events, items, deliverable_events, audit_events}, rebuild, irreproducible[] (thoughts derived from it, for a person to review), pages[] (pages to review), twins[] (standing thoughts holding the same text), source ({system, identity_sha256}: the record it was ingested as, which every sync and ingest then leaves out until a row stands there again; null when none, as for a thought deleted before), item_ids[] and proposal_ids[] (the items it took and the close proposals citing it, which a later call reaches again), outside[] (copies beyond the brain)}.';

-- ---------------------------------------------------------------------------
-- 2. Whether a text was forgotten, asked before it is embedded
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_text_forgotten_at(p_content text)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  -- 139's refusal trigger's rule, read for the canonical fingerprint: an
  -- empty ledger (asked first: nearly every write meets one), a reinstating
  -- caller, or a text a standing thought holds passes.
  SELECT CASE
    WHEN current_setting('ob1.reinstate_forgotten', true) = 'on' OR NOT EXISTS (SELECT 1 FROM thought_forgotten) THEN NULL
    ELSE (SELECT max(f.forgotten_at)
            FROM thought_forgotten f, (SELECT content_fingerprint_of(p_content) AS fp) x
           WHERE x.fp = ANY(f.fingerprints)
             AND NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.content_fingerprint = x.fp))
  END
$$;
COMMENT ON FUNCTION ob1_text_forgotten_at(text) IS
  'When thought_forgotten forgot this text (by content_fingerprint_of), or NULL: NULL too when a standing thought holds it (reinstated, or a twin) or ob1.reinstate_forgotten is on. The rule of 139''s refusal trigger, for the canonical fingerprint, so a server can refuse a forgotten text before it pays for an embedding; it refuses nothing the trigger would admit, and the trigger stays the authority. Migration 143 / SMD-1723.';

-- ---------------------------------------------------------------------------
-- 3. What a forget left: the ids and texts a store still holds
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_forget_leftovers()
RETURNS TABLE (thought_id uuid, store text, n bigint)
LANGUAGE sql
STABLE
AS $$
  WITH g AS (
    -- Each forgotten thought not standing again (a reinstated one is the
    -- operator's), with every item and fingerprint any of its rows names.
    SELECT f.thought_id AS id,
           array_agg(DISTINCT i) FILTER (WHERE i IS NOT NULL) AS items,
           array_agg(DISTINCT p) FILTER (WHERE p IS NOT NULL) AS fps
      FROM thought_forgotten f
      LEFT JOIN LATERAL (SELECT jsonb_array_elements_text(f.evidence->'item_ids') AS i
                          WHERE jsonb_typeof(f.evidence->'item_ids') = 'array') it ON true
      LEFT JOIN LATERAL unnest(f.fingerprints) p ON true
     WHERE NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = f.thought_id)
     GROUP BY f.thought_id
  ), counts AS (
    SELECT g.id, 'thought_audit'::text AS store,
           (SELECT count(*) FROM thought_audit a WHERE a.thought_id = g.id AND a.redacted_at IS NULL) AS n FROM g
    UNION ALL SELECT g.id, 'derived_from',
           (SELECT count(*) FROM thoughts t WHERE jsonb_typeof(t.derived_from) = 'array' AND t.derived_from @> jsonb_build_array(g.id::text)) FROM g
    UNION ALL SELECT g.id, 'relation_facets',
           (SELECT count(*) FROM thought_facets x WHERE x.kind = 'relation' AND x.payload->>'target' = g.id::text) FROM g
    UNION ALL SELECT g.id, 'citations',
           (SELECT count(*) FROM thought_facets x WHERE x.kind = 'citation'
              AND (x.payload->>'source_id' = g.id::text OR x.payload->>'source_deleted_id' = g.id::text)) FROM g
    UNION ALL SELECT g.id, 'query_log',
           (SELECT count(*) FROM query_log q
             WHERE g.id = ANY(q.result_ids) OR q.target_id = g.id
                OR (jsonb_typeof(q.result_items) = 'array'
                    AND EXISTS (SELECT 1 FROM jsonb_array_elements(q.result_items) e
                                 WHERE e->>'id' = g.id::text OR e->>'key' = g.id::text OR e->>'key' = ANY(COALESCE(g.items, '{}'))))) FROM g
    UNION ALL SELECT g.id, 'page_sections',
           (SELECT count(*) FROM page_sections s
             WHERE g.id = ANY(s.evidence_thought_ids) OR g.id = ANY(COALESCE(s.pending_evidence_thought_ids, '{}'::uuid[]))) FROM g
    UNION ALL SELECT g.id, 'priority_statements',
           (SELECT count(*) FROM priority_assertions pa
             WHERE (pa.item_kind = 'thought' AND pa.item_key = g.id::text)
                OR (pa.due_ref_kind = 'thought' AND pa.due_ref_key = g.id::text)
                OR (pa.item_kind = 'item' AND pa.item_key = ANY(COALESCE(g.items, '{}')))
                OR (pa.due_ref_kind = 'item' AND pa.due_ref_key = ANY(COALESCE(g.items, '{}')))) FROM g
    UNION ALL SELECT g.id, 'priority_findings',
           (SELECT count(*) FROM priority_findings pf
             WHERE (pf.item_kind = 'thought' AND pf.item_key = g.id::text)
                OR (pf.item_kind = 'item' AND pf.item_key = ANY(COALESCE(g.items, '{}')))) FROM g
    UNION ALL SELECT g.id, 'open_items',
           (SELECT count(*) FROM open_items i WHERE i.origin_thought_id = g.id OR i.item_id::text = ANY(COALESCE(g.items, '{}'))) FROM g
    UNION ALL SELECT g.id, 'item_events',
           (SELECT count(*) FROM open_item_events e WHERE e.origin_thought_id = g.id OR e.item_id::text = ANY(COALESCE(g.items, '{}'))) FROM g
    UNION ALL SELECT g.id, 'item_proposals',
           (SELECT count(*) FROM open_item_close_proposals p WHERE p.evidence_thought_id = g.id OR p.item_id::text = ANY(COALESCE(g.items, '{}'))) FROM g
    UNION ALL SELECT g.id, 'deliverable_events',
           (SELECT count(*) FROM deliverable_events d WHERE d.thought_id = g.id) FROM g
    UNION ALL SELECT g.id, 'snapshot_vectors',
           (SELECT count(*) FROM ob1_embedding_snapshot s
             WHERE s.content_fingerprint = ANY(COALESCE(g.fps, '{}'))
               AND NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.content_fingerprint = s.content_fingerprint)) FROM g
  )
  SELECT c.id, c.store, c.n FROM counts c WHERE c.n > 0 ORDER BY c.id, c.store
$$;
COMMENT ON FUNCTION ob1_forget_leftovers() IS
  'One row per forgotten thought (thought_forgotten) and store still holding its id or text: (thought_id, store, n). The stores forget_thought reaches — thought_audit (an event not redacted), derived_from, relation facets, citations, the query log, page sections, priority statements and findings, open items, their events and close proposals (on the thought or on the items its ledger rows took), deliverable events, the snapshot''s vectors at its fingerprints (no standing thought holding them). A thought standing again under its id is skipped. A write that raced the forget leaves these (SMD-4299): forget_thought again sweeps them. Preflight''s forgotten row reads it. Migration 143 / SMD-1723.';
