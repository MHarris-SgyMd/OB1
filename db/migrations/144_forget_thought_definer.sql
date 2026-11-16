-- =============================================================================
-- Migration 144: forget_thought runs as its owner, a forgotten text is asked
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
--   1. forget_thought runs as its owner. 139's function is renamed
--      ob1_forget_thought_body, and forget_thought becomes a SECURITY DEFINER
--      wrapper that calls it, with:
--      * its search_path pinned to the schemas this migration runs under
--        (current_schemas(false): the brain's, pgvector's wherever it is),
--        pg_temp last, so a caller's temporary objects shadow nothing;
--      * every ob1.* setting a trigger or function reads at run time, but
--        ob1.actor, emptied for the call and given back after it: each grants
--        an exemption (a replay's, an amendment's, the forget's own) that a
--        caller could otherwise set before the call and carry in as the
--        owner — 060's replay check reads current_user, which is the owner
--        inside. The body sets the ones it needs itself. ob1.actor stays the
--        caller's: it names who forgot, as on every write, and the body sets
--        it from p_actor when given. A replay's own setting is emptied with
--        the rest, so a forget called inside a replay runs as a live write:
--        139's REPLAYING answer (rebuild_derived refusing under a replay)
--        now comes only from a brain before 144; nothing that replays calls
--        forget_thought. The settings are emptied by set_config, not pinned
--        by SET clauses on the function: PostgreSQL refused a role that owns
--        the brain without being a superuser a custom setting on a function
--        ("permission denied to set parameter", test-upgrade's leg migrating
--        as such a role), and the migrations may run as one;
--      * EXECUTE revoked from PUBLIC, and granted to each role 139's function
--        was granted EXECUTE (the `server` grant group's, db/config.mjs):
--        not to every role that may delete a thought, since a delete can be
--        undone from the log and a forget cannot (review pass 1). A role
--        `--grant`ed before 144 holds no such grant, and needs `--grant`
--        again. Each grant carried is revoked from the body, so a re-apply
--        restores none a hand revoked from the wrapper (review pass 2).
--      The body keeps the rest of 139's ACL (PUBLIC's EXECUTE on a first
--      apply): a role calling it directly runs it as itself and needs every
--      store's privilege, as before 144.
--      One call leaves each emptied setting defined, '' where it was unset,
--      for the rest of a pooled session: a reader must take '' as unset
--      (every reader does; 2 below is the one that raised).
--   2. ob1_forgetting() reads its setting through a cast that cannot raise.
--      139's guarded the cast with a CASE that PostgreSQL may evaluate past:
--      once the setting existed in a session (a forget's own set_config, or
--      the wrapper's), it read '' and every raw DELETE the guards refuse
--      raised 22P02 instead of their own refusal.
--   3. ob1_text_forgotten_at(text): when the ledger forgot this text, or
--      NULL. NULL also when no thought standing holds that text, a reinstated
--      one or a twin, or ob1.reinstate_forgotten is on: 139's refusal
--      trigger's rule, for the canonical fingerprint. It never refuses a
--      text the trigger would let through, and may pass one the trigger
--      refuses (a raw writer's stale key): the trigger stays the authority.
--   4. ob1_forget_leftovers(): one row per forgotten thought and store still
--      holding its id or text — (thought_id, store, n). The stores are the
--      ones forget_thought reaches. A thought standing again under its id
--      (reinstated) is skipped whole. Each store is read once for every
--      forgotten id at a time, by the forms its indexes serve (a first form
--      counted per id took 12 s at 40 ids and 300,000 logged searches:
--      review pass 1). SECURITY DEFINER, as the forget is, so the server's
--      role need not read the query log to run preflight's row; EXECUTE is
--      the `server` group's, granted as forget_thought's is. It answers
--      ids, store names and counts alone.
--
-- RE-APPLYING 139
--   139's CREATE OR REPLACE puts its body back under forget_thought, running
--   as its caller (the ACL 144 set stays). Re-applying 144 then takes that
--   body as ob1_forget_thought_body again, dropping the older one, and puts
--   the wrapper back; until then preflight's `forget definer` row warns. The
--   wrapper is told from 139's body by the marker ob1:forget-definer.
--   test-schema [131] holds the emptied list against every ob1.* setting the
--   migrations read.
--
-- IDEMPOTENT: the rename only of 139's body; the functions are CREATE OR
--   REPLACE; REVOKE and GRANT repeat. Needs 139 and 142.
--
-- TESTS: test-schema [131], test-upgrade [20ci].
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
BEGIN
  IF to_regprocedure('forget_thought(uuid, jsonb, boolean)') IS NULL OR to_regclass('thought_forgotten') IS NULL
     OR to_regclass('priority_findings') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 144 needs 139 and 142 (forget_thought, thought_forgotten, priority_findings); this schema lacks one',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. forget_thought runs as its owner
-- ---------------------------------------------------------------------------
-- 139's body under the public name (a first apply, or 139 re-applied since)
-- becomes ob1_forget_thought_body; the wrapper, carrying its marker, is left.
DO $body$
BEGIN
  IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'forget_thought(uuid, jsonb, boolean)'::regprocedure) NOT LIKE '%ob1:forget-definer%' THEN
    IF to_regprocedure('ob1_forget_thought_body(uuid, jsonb, boolean)') IS NOT NULL THEN
      DROP FUNCTION ob1_forget_thought_body(uuid, jsonb, boolean);
    END IF;
    ALTER FUNCTION forget_thought(uuid, jsonb, boolean) RENAME TO ob1_forget_thought_body;
  END IF;
END
$body$;

COMMENT ON FUNCTION ob1_forget_thought_body(uuid, jsonb, boolean) IS
  'The body of forget_thought (migration 139 / SMD-1723), renamed by 144: forget_thought calls it as its owner, the settings a caller could carry in emptied. Called directly it runs as its caller, who needs every store''s privilege, as forget_thought did before 144. Its answer is forget_thought''s.';

CREATE OR REPLACE FUNCTION forget_thought(p_id uuid, p_actor jsonb DEFAULT NULL, p_detach boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  -- ob1:forget-definer — the marker 144's re-apply tells this wrapper by.
  -- Every ob1.* setting a trigger or function reads at run time but
  -- ob1.actor: emptied for the call, so none a caller set is carried in as
  -- the owner, and given back after it.
  c_emptied CONSTANT text[] := ARRAY['ob1.projecting_replay', 'ob1.projecting', 'ob1.projecting_thought', 'ob1.event',
    'ob1.audit_amend', 'ob1.actor_amend', 'ob1.forgetting', 'ob1.reinstate_forgotten', 'ob1.lapse_clearing',
    'ob1.cited_delete', 'ob1.citations_detached', 'ob1.citations_inactive', 'ob1.thread_mark'];
  v_saved text[] := '{}';
  v_answer jsonb;
  i int;
BEGIN
  FOR i IN 1 .. cardinality(c_emptied) LOOP
    v_saved := v_saved || COALESCE(current_setting(c_emptied[i], true), '');
    PERFORM set_config(c_emptied[i], '', true);
  END LOOP;
  v_answer := ob1_forget_thought_body(p_id, p_actor, p_detach);
  -- A raise undoes the emptying with the rest; an answer gives them back.
  FOR i IN 1 .. cardinality(c_emptied) LOOP
    PERFORM set_config(c_emptied[i], v_saved[i], true);
  END LOOP;
  RETURN v_answer;
END;
$$;

DO $path$
DECLARE
  v_path text;
BEGIN
  SELECT string_agg(quote_ident(s), ', ' ORDER BY o) INTO v_path
    FROM unnest(current_schemas(false)) WITH ORDINALITY u(s, o);
  IF v_path IS NULL THEN
    RAISE EXCEPTION 'migration 144: the search_path names no schema, so forget_thought''s could not be pinned';
  END IF;
  EXECUTE format('ALTER FUNCTION forget_thought(uuid, jsonb, boolean) SET search_path = %s, pg_temp', v_path);
END
$path$;

REVOKE EXECUTE ON FUNCTION forget_thought(uuid, jsonb, boolean) FROM PUBLIC;

-- Each role granted EXECUTE on 139's function, now the body, by name (the
-- server group's grant: a role --grant'ed after this PR, or the wrapper's
-- grantees when a re-applied 139 took its place) keeps it on the wrapper,
-- and loses it on the body: a later re-apply finds none to carry, so a grant
-- revoked from the wrapper by hand stays revoked. PUBLIC's and the owner's
-- are not carried.
DO $grant$
DECLARE
  v_role record;
BEGIN
  FOR v_role IN
    SELECT DISTINCT r.rolname
      FROM pg_proc p, aclexplode(p.proacl) a, pg_roles r
     WHERE p.oid = to_regprocedure('ob1_forget_thought_body(uuid, jsonb, boolean)')
       AND a.privilege_type = 'EXECUTE' AND a.grantee <> 0 AND a.grantee <> p.proowner
       AND r.oid = a.grantee
     ORDER BY r.rolname
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION forget_thought(uuid, jsonb, boolean) TO %I', v_role.rolname);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION ob1_forget_thought_body(uuid, jsonb, boolean) FROM %I', v_role.rolname);
  END LOOP;
END
$grant$;

COMMENT ON FUNCTION forget_thought(uuid, jsonb, boolean) IS
  'Forget a thought: remove it and everything in the database holding its text, in one transaction, and return the evidence (migration 139 / SMD-1723). Runs as its owner (migration 144): SECURITY DEFINER, its search_path pinned with pg_temp last, every runtime ob1.* setting but ob1.actor emptied for the call and given back, EXECUTE the server grant group''s (carried from the grants 139''s function held) and not PUBLIC''s; the body is ob1_forget_thought_body. Takes the supersession lock, then the capture''s fingerprint lock for every text it has had (ob1_forget_fingerprints, in order), then the priority lock (116) of every item whose statements it deletes, in key order, then the row, then tries (never waits for) the lock of any text an edit gave it meanwhile; a write racing the forget on another store may land beside it, and a second call sweeps what it left (FORGOTTEN when nothing; ob1_forget_leftovers lists them). An id the log never held: {ok:false, error:NOT_FOUND, id}. A refusal of rebuild_derived''s (REPLAYING) undoes it and is the answer, with the report. Cited by an active citation: {ok:false, error:CITED, id, cited_by, citations}, as delete_thought, unless p_detach, which deletes the citing rows with the rest (detaching by delete_thought first loses the record it was ingested as). A thought deleted before is forgotten from what remains (gone true): its snapshot vectors and every store below. Else: rebuild_derived(id, ''forget'', true, its fingerprints) (windows, entity links, orphaned entities, snapshot vectors); relation facets targeting it, expired or superseded citations of it and citations detached from it deleted; its id stripped from other thoughts'' derived_from (those listed irreproducible); page sections whose evidence names it deleted through delete_page_section, each page re-rendered, and every page whose own log names it listed in pages (its log and its revisions may keep an earlier render); the query log''s result_ids (with their scores) and result_items cleared of it, its action rows deleted; the row deleted through delete_thought; then the priority statements on it, on open items read from it, or taking a due time from either, deleted and re-projected; 142''s priority findings on it or on those items deleted; those items, their events and close proposals (and proposals whose evidence it is) deleted; every bare orphan entity (no mention, edge, priority statement or merge record; in id order, skipping one a writer holds) deleted; its deliverable''s events deleted; every event of it in thought_audit redacted (the redact amendment); a thought_forgotten row written. Forgotten already with nothing left, and no fingerprint the ledger lacks: FORGOTTEN with forgotten_at (and the bare orphans pruned on the way). Returns {ok:true, id, forgotten_at, gone, orphan_entities, removed{relations, inactive_citations, detached_citations, derived_refs, page_sections, query_log_rows, priority_statements, priority_findings, item_reasons, item_proposals, item_events, items, deliverable_events, audit_events}, rebuild, irreproducible[] (thoughts derived from it, for a person to review), pages[] (pages to review), twins[] (standing thoughts holding the same text), source ({system, identity_sha256}: the record it was ingested as, which every sync and ingest then leaves out until a row stands there again; null when none, as for a thought deleted before), item_ids[] and proposal_ids[] (the items it took and the close proposals citing it, which a later call reaches again), outside[] (copies beyond the brain)}.';

-- ---------------------------------------------------------------------------
-- 2. ob1_forgetting reads its setting through a cast that cannot raise
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_forgetting()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  -- 139's rule — the setting naming a uuid, the thought it names deleted —
  -- with the cast made by pg_input_is_valid's verdict in the same row, never
  -- ahead of it: 139's subquery could be evaluated past its CASE, and a
  -- setting reading '' raised 22P02 in every guard that asks.
  SELECT f.id
    FROM (SELECT CASE WHEN pg_input_is_valid(v, 'uuid') THEN v::uuid END AS id
            FROM (SELECT current_setting('ob1.forgetting', true) AS v) s) f
   WHERE f.id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = f.id)
$$;
COMMENT ON FUNCTION ob1_forgetting() IS
  'The thought forget_thought is forgetting in this transaction (the setting ob1.forgetting), once that thought is deleted, or NULL: the one test the redact amendment and the relaxed guards of 116, 117 and 134 read, so no setting can reach a living thought''s rows. A setting that is no uuid, empty included, reads as none and never raises. Migrations 139 and 144 / SMD-1723.';

-- ---------------------------------------------------------------------------
-- 3. Whether a text was forgotten, asked before it is embedded
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
           WHERE f.fingerprints @> ARRAY[x.fp]
             AND NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.content_fingerprint = x.fp))
  END
$$;
COMMENT ON FUNCTION ob1_text_forgotten_at(text) IS
  'When thought_forgotten forgot this text (by content_fingerprint_of), or NULL: NULL too when a standing thought holds it (reinstated, or a twin) or ob1.reinstate_forgotten is on. The rule of 139''s refusal trigger, for the canonical fingerprint, so a server can refuse a forgotten text before it pays for an embedding; it refuses nothing the trigger would admit, and the trigger stays the authority. Migration 144 / SMD-1723.';

-- ---------------------------------------------------------------------------
-- 4. What a forget left: the ids and texts a store still holds
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_forget_leftovers()
RETURNS TABLE (thought_id uuid, store text, n bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH g AS (
    -- Each forgotten thought not standing again (a reinstated one is the
    -- operator's).
    SELECT DISTINCT f.thought_id AS id FROM thought_forgotten f
     WHERE NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = f.thought_id)
  ), ids AS (
    SELECT COALESCE(array_agg(g.id), '{}') AS a, COALESCE(array_agg(g.id::text), '{}') AS t FROM g
  ), it AS (
    -- The items its ledger rows took, each with its thought.
    SELECT DISTINCT f.thought_id AS id, i.item
      FROM thought_forgotten f JOIN g ON g.id = f.thought_id,
           jsonb_array_elements_text(CASE WHEN jsonb_typeof(f.evidence->'item_ids') = 'array' THEN f.evidence->'item_ids' ELSE '[]'::jsonb END) i(item)
  ), fp AS (
    SELECT DISTINCT f.thought_id AS id, u.fp
      FROM thought_forgotten f JOIN g ON g.id = f.thought_id, unnest(f.fingerprints) u(fp)
  ), keyed AS (
    -- What an agenda entry may name: a forgotten thought by id or key, or an item its ledger took by key.
    SELECT g.id::text AS k, g.id FROM g UNION SELECT it.item, it.id FROM it
  ), entries AS MATERIALIZED (
    -- The logged agendas' entries, expanded once and only when something was forgotten.
    SELECT q.id AS q, e.v->>'id' AS eid, e.v->>'key' AS ekey
      FROM query_log q,
           jsonb_array_elements(CASE WHEN jsonb_typeof(q.result_items) = 'array' THEN q.result_items ELSE '[]'::jsonb END) e(v)
     WHERE jsonb_typeof(q.result_items) = 'array' AND EXISTS (SELECT 1 FROM g)
  ), hit (id, store, k) AS (
    -- One row per thought, store and row holding it; each store read once.
    SELECT a.thought_id, 'thought_audit', a.id::text FROM thought_audit a, ids
     WHERE a.thought_id = ANY(ids.a) AND a.redacted_at IS NULL
    UNION ALL
    SELECT r.v::uuid, 'derived_from', t.id::text FROM thoughts t, ids,
           jsonb_array_elements_text(CASE WHEN jsonb_typeof(t.derived_from) = 'array' THEN t.derived_from ELSE '[]'::jsonb END) r(v)
     WHERE jsonb_typeof(t.derived_from) = 'array' AND t.derived_from ?| ids.t AND r.v = ANY(ids.t)
    UNION ALL
    SELECT (x.payload->>'target')::uuid, 'relation_facets', x.id::text FROM thought_facets x, ids
     WHERE x.kind = 'relation' AND x.payload->>'target' = ANY(ids.t)
    UNION ALL
    SELECT (x.payload->>'source_id')::uuid, 'citations', x.id::text FROM thought_facets x, ids
     WHERE x.kind = 'citation' AND x.payload->>'source_id' = ANY(ids.t)
    UNION ALL
    SELECT (x.payload->>'source_deleted_id')::uuid, 'citations', x.id::text FROM thought_facets x, ids
     WHERE x.kind = 'citation' AND x.payload->>'source_deleted_id' = ANY(ids.t)
    UNION ALL
    SELECT r.v, 'query_log', q.id::text FROM query_log q, ids, unnest(q.result_ids) r(v)
     WHERE q.result_ids && ids.a AND r.v = ANY(ids.a)
    UNION ALL
    SELECT q.target_id, 'query_log', q.id::text FROM query_log q, ids WHERE q.target_id = ANY(ids.a)
    UNION ALL
    SELECT g.id, 'query_log', x.q::text FROM entries x JOIN g ON g.id::text = x.eid
    UNION ALL
    SELECT kk.id, 'query_log', x.q::text FROM entries x JOIN keyed kk ON kk.k = x.ekey
    UNION ALL
    SELECT u.v, 'page_sections', s.id::text FROM page_sections s, ids,
           unnest(s.evidence_thought_ids || COALESCE(s.pending_evidence_thought_ids, '{}'::uuid[])) u(v)
     WHERE (s.evidence_thought_ids && ids.a OR s.pending_evidence_thought_ids && ids.a) AND u.v = ANY(ids.a)
    UNION ALL
    SELECT pa.item_key::uuid, 'priority_statements', pa.id::text FROM priority_assertions pa, ids
     WHERE pa.item_kind = 'thought' AND pa.item_key = ANY(ids.t)
    UNION ALL
    SELECT pa.due_ref_key::uuid, 'priority_statements', pa.id::text FROM priority_assertions pa, ids
     WHERE pa.due_ref_kind = 'thought' AND pa.due_ref_key = ANY(ids.t)
    UNION ALL
    SELECT it.id, 'priority_statements', pa.id::text FROM priority_assertions pa JOIN it ON pa.item_kind = 'item' AND pa.item_key = it.item
    UNION ALL
    SELECT it.id, 'priority_statements', pa.id::text FROM priority_assertions pa JOIN it ON pa.due_ref_kind = 'item' AND pa.due_ref_key = it.item
    UNION ALL
    SELECT pf.item_key::uuid, 'priority_findings', pf.id::text FROM priority_findings pf, ids
     WHERE pf.item_kind = 'thought' AND pf.item_key = ANY(ids.t)
    UNION ALL
    SELECT it.id, 'priority_findings', pf.id::text FROM priority_findings pf JOIN it ON pf.item_kind = 'item' AND pf.item_key = it.item
    UNION ALL
    SELECT i.origin_thought_id, 'open_items', i.item_id::text FROM open_items i, ids WHERE i.origin_thought_id = ANY(ids.a)
    UNION ALL
    SELECT it.id, 'open_items', i.item_id::text FROM open_items i JOIN it ON i.item_id::text = it.item
    UNION ALL
    SELECT e.origin_thought_id, 'item_events', e.id::text FROM open_item_events e, ids WHERE e.origin_thought_id = ANY(ids.a)
    UNION ALL
    SELECT it.id, 'item_events', e.id::text FROM open_item_events e JOIN it ON e.item_id::text = it.item
    UNION ALL
    SELECT p.evidence_thought_id, 'item_proposals', p.id::text FROM open_item_close_proposals p, ids WHERE p.evidence_thought_id = ANY(ids.a)
    UNION ALL
    SELECT it.id, 'item_proposals', p.id::text FROM open_item_close_proposals p JOIN it ON p.item_id::text = it.item
    UNION ALL
    SELECT d.thought_id, 'deliverable_events', d.id::text FROM deliverable_events d, ids WHERE d.thought_id = ANY(ids.a)
    UNION ALL
    SELECT fp.id, 'snapshot_vectors', s.content_fingerprint || '/' || s.embedding_model FROM ob1_embedding_snapshot s JOIN fp ON s.content_fingerprint = fp.fp
     WHERE NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.content_fingerprint = s.content_fingerprint)
  )
  SELECT h.id, h.store, count(DISTINCT h.k) FROM hit h GROUP BY h.id, h.store ORDER BY h.id, h.store
$$;

DO $leftovers$
DECLARE
  v_path text;
  v_role record;
BEGIN
  SELECT string_agg(quote_ident(s), ', ' ORDER BY o) INTO v_path
    FROM unnest(current_schemas(false)) WITH ORDINALITY u(s, o);
  EXECUTE format('ALTER FUNCTION ob1_forget_leftovers() SET search_path = %s, pg_temp', v_path);
  EXECUTE 'REVOKE EXECUTE ON FUNCTION ob1_forget_leftovers() FROM PUBLIC';
  -- forget_thought's grantees, as the server group grants both.
  FOR v_role IN
    SELECT DISTINCT r.rolname
      FROM pg_proc p, aclexplode(p.proacl) a, pg_roles r
     WHERE p.oid = to_regprocedure('forget_thought(uuid, jsonb, boolean)')
       AND a.privilege_type = 'EXECUTE' AND a.grantee <> 0 AND a.grantee <> p.proowner
       AND r.oid = a.grantee
     ORDER BY r.rolname
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION ob1_forget_leftovers() TO %I', v_role.rolname);
  END LOOP;
END
$leftovers$;

COMMENT ON FUNCTION ob1_forget_leftovers() IS
  'One row per forgotten thought (thought_forgotten) and store still holding its id or text: (thought_id, store, n). The stores forget_thought reaches — thought_audit (an event not redacted), derived_from, relation facets, citations, the query log, page sections, priority statements and findings, open items, their events and close proposals (on the thought or on the items its ledger rows took), deliverable events, the snapshot''s vectors at its fingerprints (no standing thought holding them). A thought standing again under its id is skipped. Each store read once for every forgotten id. SECURITY DEFINER, its search_path pinned; EXECUTE the server group''s. A write that raced the forget leaves these (SMD-4299): forget_thought again sweeps them. Preflight''s forgotten row reads it. Migration 144 / SMD-1723.';
