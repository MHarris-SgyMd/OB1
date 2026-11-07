-- =============================================================================
-- Migration 123: the agenda — open, startable, unclaimed items of every kind,
--                ranked by effective priority, each with why; and query_log's
--                `agenda` kind (SMD-3669)
-- =============================================================================
--
-- WHY
--   "What should I work on next?" is a question about a set, not a text match,
--   and search answers it by how closely the words match. 122's
--   effective_priority scores any item; nothing chose the items to score, left
--   out what can't be started or is held, or said how much of the set carries
--   no priority at all. This is that composition, read by the agenda tool
--   (SMD-3669 PR 1).
--
-- WHAT
--   agenda(p_scope jsonb, p_holder jsonb, p_limit int, p_include_blocked,
--   p_include_claimed, p_include_proposed, p_weights jsonb, p_now) → jsonb:
--   * THE CANDIDATES (the maintainer, 2026-11-07): every ticket whose head
--     (068) has a known, unsettled status type, and every open item with
--     status `open` — `proposed` too only with p_include_proposed, since the
--     extractor proposes thousands nobody confirmed.
--   * THE SCOPE, p_scope's keys, each optional: `source` — `linear` (the
--     tickets), `items` (open items no plugin keeps) or a plugin's name (its
--     open items); `project` and `label` — Linear's, on a ticket's head row,
--     so an open item is out of a scope that names either. p_holder, a key's
--     {name, agent_id} as the server stamps it, is `mine`: the tickets that
--     key holds a live claim on (so claimed work is shown).
--   * THE ORDER: 122's effective_priority, in chunks of its 1000, sorted by
--     effective, then the sooner due time, then kind and key. Every term is
--     named as 122 names it; an overdue item carries its +3 and sorts by its
--     score like any other.
--   * LEFT OUT unless asked, and counted: a ticket blocked by an open item
--     (active blocks / blocked_by links in a gating system, node_dependencies()'
--     reading) unless p_include_blocked, which lists its blockers; a ticket
--     under a LIVE claim (unreleased and unexpired, 115) unless
--     p_include_claimed, which names the holder; an item whose not_before is
--     still ahead (waiting), always. A lapsed claim never released hides
--     nothing: the item names it, so a client checks before starting.
--   * COVERAGE: how many items that passed the filters (total, not the first
--     p_limit) carry no priority — no counted level and none inherited, read as unknown's value, never low (docs/priority.md
--     decision 3) — and board-sync's last heartbeat (its ob1_config row's
--     time and outcome), null on a brain without board-sync.
--   The answer: {items, total, unknown, left_out: {blocked, claimed, waiting},
--   board_sync, claims_read, now}. items is the first p_limit (1 to 100), total every item
--   that passed the filters.
--
--   ob1_item_blockers(kind, key) — the open items blocking a ticket or a
--   thought, as identities (linear's bare, another system's system:key).
--
--   query_log: kind `agenda` beside search and action, and result_items, the
--   typed items an agenda call returned in its order ({kind, key,
--   effective}), so the log can later score what the agenda showed. An
--   agenda row carries its scope in filter and its items in result_items;
--   result_ids stays the search rows' (thought ids).
--
-- WHO READS
--   No actor: the server passes the caller's identity as p_holder, for
--   `mine` — its agent id, or its name alone when the registry gave none
--   (key names are unique, and find a claim made either way). It reads what
--   122 reads, ob1_config (every group's), and work_claims (the claims
--   group's SELECT) only when the role may: that group is soft, so without
--   it the agenda answers unfiltered by claims and says `claims_read` false,
--   and `mine` alone is refused (42501). query_log's INSERT is the server
--   group's, as it was.
--
-- SAFETY
--   Two new functions, STABLE (one snapshot for the read); query_log gains a
--   nullable column and its kind CHECK one value, its rows untouched. MINOR
--   under FORK.md's version rules. test-schema [110], test-upgrade [20bn].
--
-- Prerequisites
--   006 (ob1_config), 034 (query_log), 053, 068, 071 (the links, heads and
--   gate), 115 (work_claims), 117 (open_items), 122 (effective_priority).
--   Applied by `bun db/migrate.ts`. Re-applied: the functions are replaced,
--   the column and both CHECKs kept as they are. Reading the catalog takes a
--   momentary ACCESS SHARE on query_log and nothing more, so the log is
--   neither re-scanned nor held from its inserts (review pass 5: it waits only
--   behind another session's ACCESS EXCLUSIVE).
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
DECLARE
  v_need text[][] := ARRAY[
    ARRAY['effective_priority(jsonb, jsonb, timestamp with time zone)', '122 (effective_priority)'],
    ARRAY['ob1_node_settled(text, text)', '122 (ob1_node_settled)'],
    ARRAY['ob1_system_gates(text)', '071 (ob1_system_gates)'],
    ARRAY['node_settled_types()', '058 (node_settled_types)'],
    ARRAY['node_lifecycle_types()', '058 (node_lifecycle_types)']];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_need, 1) LOOP
    IF to_regprocedure(v_need[i][1]) IS NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = format('migration 123 needs %s; this schema lacks it', v_need[i][2]),
        -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
        HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
        ERRCODE = 'invalid_schema_definition';
    END IF;
  END LOOP;
  IF to_regclass('work_claims') IS NULL OR to_regclass('open_items') IS NULL OR to_regclass('query_log') IS NULL OR to_regclass('ob1_config') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 123 needs 006, 034, 115 and 117 (ob1_config, query_log, work_claims, open_items); this schema lacks one',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- query_log: the agenda's kind and its typed items
-- ---------------------------------------------------------------------------
-- Each change behind a catalog check: ADD COLUMN IF NOT EXISTS takes ACCESS
-- EXCLUSIVE before it looks (review pass 3), and a re-apply must not queue the
-- search log's inserts behind a long reader.
DO $col$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'query_log'::regclass AND attname = 'result_items' AND NOT attisdropped) THEN
    ALTER TABLE query_log ADD COLUMN result_items jsonb;
    COMMENT ON COLUMN query_log.result_items IS
      'An agenda row''s items in the order returned, each {kind, key, effective}: tickets are keys, not thought ids, so result_ids cannot hold them. NULL on search and action rows. Migration 123 / SMD-3669.';
  END IF;
END
$col$;
-- Changed only when it lacks the agenda kind, and the items CHECK added only
-- when missing, so a re-apply neither re-scans the log nor holds it from its
-- inserts: reading the constraint takes a momentary ACCESS SHARE (review
-- passes 1 and 5).
DO $kind$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'query_log_kind_check' AND conrelid = 'query_log'::regclass
                    AND pg_get_constraintdef(oid) LIKE '%agenda%') THEN
    ALTER TABLE query_log DROP CONSTRAINT IF EXISTS query_log_kind_check;
    ALTER TABLE query_log ADD CONSTRAINT query_log_kind_check CHECK (kind IN ('search', 'action', 'agenda'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'query_log_agenda_has_items' AND conrelid = 'query_log'::regclass) THEN
    ALTER TABLE query_log ADD CONSTRAINT query_log_agenda_has_items CHECK (kind <> 'agenda' OR (result_items IS NOT NULL AND jsonb_typeof(result_items) = 'array'));
  END IF;
END
$kind$;

-- ---------------------------------------------------------------------------
-- ob1_item_blockers — the open items blocking a ticket or a thought
-- ---------------------------------------------------------------------------
-- node_dependencies()' reading, from the blocked side: a blocked_by facet the
-- item's own source row holds names its blocker; a blocks facet another row
-- holds, naming the item, makes that row's identity its blocker. Active
-- links in a gating system only, the blocker not settled (ob1_node_settled).
CREATE OR REPLACE FUNCTION ob1_item_blockers(p_kind text, p_key text)
RETURNS text[]
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v text[];
BEGIN
  IF p_kind NOT IN ('ticket', 'thought') THEN
    RETURN '{}';
  END IF;
  WITH me AS (
    SELECT 'linear'::text AS system, p_key AS identity WHERE p_kind = 'ticket'
    UNION
    SELECT s.system, s.identity FROM thought_sources s WHERE p_kind = 'thought' AND s.thought_id = p_key::uuid
  ), b AS (
    SELECT h.system, f.payload->>'target' AS blocker
      FROM me
      JOIN thought_sources h ON h.system = me.system AND h.identity = me.identity
      JOIN thought_facets f ON f.thought_id = h.thought_id AND f.kind = 'link' AND f.valid_until IS NULL
                           AND f.payload->>'system' = h.system AND f.payload->>'relation' = 'blocked_by'
    UNION
    SELECT s.system, s.identity
      FROM me
      JOIN thought_facets f ON f.kind = 'link' AND f.valid_until IS NULL AND f.payload->>'relation' = 'blocks'
                           AND f.payload->>'system' = me.system AND f.payload->>'target' = me.identity
      JOIN thought_sources s ON s.thought_id = f.thought_id AND s.system = f.payload->>'system'
  )
  SELECT COALESCE(array_agg(CASE WHEN b.system = 'linear' THEN b.blocker ELSE b.system || ':' || b.blocker END
                            ORDER BY b.system, b.blocker), '{}')
    INTO v
    FROM b
   WHERE ob1_system_gates(b.system) AND NOT ob1_node_settled(b.system, b.blocker)
     AND NOT EXISTS (SELECT 1 FROM me WHERE me.system = b.system AND me.identity = b.blocker);
  RETURN v;
END;
$$;
COMMENT ON FUNCTION ob1_item_blockers(text, text) IS
  'The open items blocking a normalised ticket or thought, sorted, a linear one bare and another system''s as system:key: active blocks / blocked_by links in a gating system (node_dependencies()'' reading, from the blocked side), the blocker not settled (ob1_node_settled). Empty for an open item or an entity, which hold no links. Migration 123 / SMD-3669.';

-- ---------------------------------------------------------------------------
-- agenda — the composed list
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agenda(
  p_scope            jsonb       DEFAULT NULL,
  p_holder           jsonb       DEFAULT NULL,
  p_limit            int         DEFAULT 20,
  p_include_blocked  boolean     DEFAULT false,
  p_include_claimed  boolean     DEFAULT false,
  p_include_proposed boolean     DEFAULT false,
  p_weights          jsonb       DEFAULT NULL,
  p_now              timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  c_key CONSTANT text := '^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,9}$';
  v_bad      text;
  v_source   text;
  v_project  text;
  v_label    text;
  v_mine     boolean := p_holder IS NOT NULL;
  v_name     text;
  v_agent    uuid;
  v_cands    jsonb;
  v_n        int;
  v_scored   jsonb := '[]';
  v_off      int := 0;
  v_rows     jsonb;
  v_board    jsonb;
  v_claims_ok boolean := has_table_privilege('work_claims', 'SELECT');
  v_claims   jsonb := '{}';
  v_mine_issues text[] := '{}';
  v_beat_at  timestamptz;
  v_beat     text;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION USING MESSAGE = format('an agenda shows 1 to 100 items; %s is not', COALESCE(p_limit::text, 'NULL')), ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_include_blocked IS NULL OR p_include_claimed IS NULL OR p_include_proposed IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'agenda''s include flags are true or false, never NULL', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_scope IS NOT NULL AND jsonb_typeof(p_scope) <> 'object' THEN
    RAISE EXCEPTION USING MESSAGE = 'an agenda''s scope is a JSON object of source, project and label', ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT string_agg(k, ', ' ORDER BY k) INTO v_bad FROM jsonb_object_keys(COALESCE(p_scope, '{}')) k WHERE k NOT IN ('source', 'project', 'label');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = format('not an agenda scope: %s (the scopes are label, project and source)', left(v_bad, 200)), ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT string_agg(k, ', ' ORDER BY k) INTO v_bad FROM jsonb_each(COALESCE(p_scope, '{}')) e(k, v)
   WHERE jsonb_typeof(v) <> 'string' OR (v #>> '{}') !~ '[^[:space:]]' OR length(v #>> '{}') > 200;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = format('an agenda scope is a non-empty string of at most 200 characters: %s', v_bad), ERRCODE = 'invalid_parameter_value';
  END IF;
  v_source := p_scope->>'source'; v_project := p_scope->>'project'; v_label := p_scope->>'label';
  IF v_mine THEN
    IF jsonb_typeof(p_holder) <> 'object' OR COALESCE(btrim(p_holder->>'name'), '') = '' THEN
      RAISE EXCEPTION USING MESSAGE = 'agenda: a holder is the calling key''s {name, agent_id}', ERRCODE = 'invalid_parameter_value';
    END IF;
    v_name := p_holder->>'name';
    v_agent := CASE WHEN p_holder->>'agent_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (p_holder->>'agent_id')::uuid END;
  END IF;
  IF p_now IS NULL OR NOT isfinite(p_now) THEN
    RAISE EXCEPTION USING MESSAGE = 'agenda''s clock is a moment', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_mine THEN
    IF NOT v_claims_ok THEN
      RAISE EXCEPTION USING MESSAGE = 'agenda: holder mine reads work_claims, which this role may not (the claims group)', ERRCODE = 'insufficient_privilege';
    END IF;
    -- 115's holder rule: a claim made under an agent id is that id's, one made by name alone that name's. With no
    -- agent id to hand (the registry away), the key's name finds both: key names are unique.
    SELECT COALESCE(array_agg(DISTINCT w.issue), '{}') INTO v_mine_issues
      FROM work_claims w
     WHERE w.released_at IS NULL AND w.expires_at > p_now
       AND CASE WHEN v_agent IS NOT NULL THEN w.holder_agent_id = v_agent OR (w.holder_agent_id IS NULL AND w.holder_name = v_name)
                ELSE w.holder_name = v_name END;
  END IF;

  -- The candidates, in the scope.
  SELECT COALESCE(jsonb_agg(c ORDER BY c->>'kind', c->>'key'), '[]') INTO v_cands
    FROM (
      SELECT jsonb_build_object('kind', 'ticket', 'key', h.issue, 'source', 'linear',
                                'title', left(split_part(t.content, E'\n', 1), 200),
                                'project', t.metadata->>'project') AS c
        FROM ob1_ticket_head h
        JOIN thoughts t ON t.id = h.head_id
       WHERE h.status_type = ANY(node_lifecycle_types()) AND NOT h.status_type = ANY(node_settled_types())
         AND h.issue ~ c_key
         AND (v_source IS NULL OR v_source = 'linear')
         AND (v_project IS NULL OR t.metadata->>'project' = v_project)
         AND (v_label IS NULL OR (jsonb_typeof(t.metadata->'labels') = 'array' AND t.metadata->'labels' ? v_label))
         AND (NOT v_mine OR h.issue = ANY(v_mine_issues))
      UNION ALL
      SELECT jsonb_build_object('kind', 'item', 'key', i.item_id::text, 'source', COALESCE(i.plugin, 'items'),
                                'title', left(i.text, 200), 'status', i.status, 'owner', i.owner)
        FROM open_items i
       WHERE (i.status = 'open' OR (p_include_proposed AND i.status = 'proposed'))
         AND v_project IS NULL AND v_label IS NULL AND NOT v_mine
         AND (v_source IS NULL OR (v_source = 'items' AND i.plugin IS NULL) OR (v_source NOT IN ('linear', 'items') AND i.plugin = v_source))
    ) x;
  v_n := jsonb_array_length(v_cands);

  -- Scored by 122, a thousand at a time (its bound).
  WHILE v_off < v_n LOOP
    SELECT COALESCE(jsonb_agg(to_jsonb(e)), '[]') INTO v_rows
      FROM effective_priority(
             (SELECT jsonb_agg(jsonb_build_object('kind', c->>'kind', 'key', c->>'key'))
                FROM jsonb_array_elements(v_cands) WITH ORDINALITY AS a(c, n) WHERE a.n > v_off AND a.n <= v_off + 1000),
             p_weights, p_now) e;
    v_scored := v_scored || v_rows;
    v_off := v_off + 1000;
  END LOOP;

  -- Board-sync's last heartbeat (db/pass-stamp.ts writes its value as JSON); a
  -- value jsonb cannot take (no JSON, a \u0000, a number past numeric: any
  -- data exception) names no outcome, and never fails the read.
  SELECT o.updated_at, o.value INTO v_beat_at, v_beat FROM ob1_config o WHERE o.key = 'heartbeat:board-sync';
  IF v_beat_at IS NOT NULL THEN
    BEGIN
      v_board := jsonb_build_object('at', v_beat_at, 'outcome', (v_beat::jsonb)->'outcome');
    EXCEPTION WHEN data_exception THEN
      v_board := jsonb_build_object('at', v_beat_at, 'outcome', NULL);
    END;
  END IF;

  -- The claims on the candidate tickets, read only when this role may (the
  -- claims group is soft: without it every read's claim label says the claims
  -- could not be read, and so does this one, `claims_read` false).
  IF v_claims_ok THEN
    SELECT COALESCE(jsonb_object_agg(x.issue, jsonb_build_object('live', x.live, 'lapsed', x.lapsed)), '{}') INTO v_claims
      FROM (SELECT w.issue,
                   jsonb_agg(jsonb_build_object('holder', w.holder_name, 'piece', w.piece, 'label', w.label, 'expires_at', w.expires_at)
                             ORDER BY w.claimed_at) FILTER (WHERE w.expires_at > p_now) AS live,
                   jsonb_agg(jsonb_build_object('holder', w.holder_name, 'piece', w.piece, 'expired_at', w.expires_at)
                             ORDER BY w.claimed_at) FILTER (WHERE w.expires_at <= p_now) AS lapsed
              FROM work_claims w
             WHERE w.released_at IS NULL
               AND w.issue IN (SELECT c->>'key' FROM jsonb_array_elements(v_cands) c WHERE c->>'kind' = 'ticket')
             GROUP BY w.issue) x;
  END IF;

  RETURN (
    WITH scored AS (
      SELECT c, s
        FROM jsonb_array_elements(v_cands) c
        JOIN jsonb_array_elements(v_scored) s ON s->>'item_kind' = c->>'kind' AND s->>'item_key' = c->>'key'
    ), judged AS (
      -- An absent ticket, or an empty half, reads as SQL NULL: jsonb_agg over
      -- no rows built a JSON null.
      SELECT sc.c, sc.s,
             CASE WHEN sc.c->>'kind' = 'ticket' THEN NULLIF(v_claims->(sc.c->>'key')->'live', 'null'::jsonb) END AS live,
             CASE WHEN sc.c->>'kind' = 'ticket' THEN NULLIF(v_claims->(sc.c->>'key')->'lapsed', 'null'::jsonb) END AS lapsed,
             CASE WHEN sc.c->>'kind' = 'ticket' THEN ob1_item_blockers('ticket', sc.c->>'key') ELSE '{}'::text[] END AS blockers
        FROM scored sc
    ), kept AS (
      SELECT j.*
        FROM judged j
       WHERE NOT COALESCE((j.s->>'waiting')::boolean, false)
         AND (p_include_blocked OR cardinality(j.blockers) = 0)
         AND (p_include_claimed OR v_mine OR j.live IS NULL)
    ), ranked AS (
      SELECT k.*, row_number() OVER (ORDER BY (k.s->>'effective')::numeric DESC, (k.s->>'due_at')::timestamptz ASC NULLS LAST,
                                              k.c->>'kind', k.c->>'key') AS rank
        FROM kept k
    )
    SELECT jsonb_build_object(
      'items', COALESCE((SELECT jsonb_agg(
                 r.c || jsonb_build_object(
                   'rank', r.rank,
                   'effective', (r.s->>'effective')::numeric,
                   'level', r.s->'level',
                   'inherited_from', r.s->'inherited_from',
                   'due_at', r.s->'due_at',
                   'due_from', r.s->'due_from',
                   'urgency', (r.s->>'urgency')::numeric,
                   'overdue', (r.s->>'overdue')::boolean,
                   'unblocks', (r.s->>'unblocks')::int,
                   'terms', r.s->'terms',
                   'winner', r.s->'winner',
                   'claimed', r.live,
                   'lapsed_claim', r.lapsed,
                   'blockers', to_jsonb(r.blockers))
                 ORDER BY r.rank) FROM ranked r WHERE r.rank <= p_limit), '[]'),
      'total', (SELECT count(*) FROM ranked),
      'unknown', (SELECT count(*) FROM ranked r WHERE r.s->'level' = 'null'::jsonb AND r.s->'inherited_from' = 'null'::jsonb),
      'left_out', jsonb_build_object(
        'blocked', (SELECT count(*) FROM judged j WHERE NOT p_include_blocked AND cardinality(j.blockers) > 0
                                                    AND NOT COALESCE((j.s->>'waiting')::boolean, false)),
        'claimed', (SELECT count(*) FROM judged j WHERE NOT (p_include_claimed OR v_mine) AND j.live IS NOT NULL
                                                    AND NOT COALESCE((j.s->>'waiting')::boolean, false)
                                                    AND (p_include_blocked OR cardinality(j.blockers) = 0)),
        'waiting', (SELECT count(*) FROM judged j WHERE COALESCE((j.s->>'waiting')::boolean, false))),
      'board_sync', v_board,
      'claims_read', v_claims_ok,
      'now', p_now)
  );
END;
$$;
COMMENT ON FUNCTION agenda(jsonb, jsonb, int, boolean, boolean, boolean, jsonb, timestamptz) IS
  'What matters now: every ticket whose head has a known, unsettled status type and every open item with status open (proposed too with p_include_proposed), in p_scope (source: linear, items or a plugin''s name; project and label, Linear''s on a ticket), or the tickets p_holder (a key''s {name, agent_id}) holds a live claim on; scored by effective_priority (122) and sorted by effective, then the sooner due time, then kind and key. Left out unless asked, and counted: a ticket blocked by an open item (p_include_blocked lists its blockers), a ticket under a live claim (p_include_claimed names the holder), and always an item whose not_before is ahead. A lapsed claim hides nothing and is named. Returns {items (the first p_limit, 1 to 100), total, unknown (of total, no counted or inherited level), left_out {blocked, claimed, waiting}, board_sync {at, outcome} or null, claims_read (false when this role may not read work_claims: no claim filtered or named, and holder mine refused), now}. Raises 22023 on a bad limit, scope, holder or clock. Migration 123 / SMD-3669.';
