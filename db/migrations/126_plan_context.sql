-- =============================================================================
-- Migration 126: the agenda reads named tickets, and query_log records a
--                plan_context call (SMD-2684)
-- =============================================================================
--
-- WHY
--   plan_context (SMD-2684) hands an agent starting a request what the brain
--   holds on it in one read. Its board section lists the tickets its search
--   hits name, and the maintainer chose (2026-11-09) to read them through the
--   agenda, so one ranking serves both reads (SMD-3669's point 4). The agenda
--   reads by scope (source, project, label) and holder alone, and leaves a
--   settled ticket out: a planner needs the named tickets, Done ones too.
--   The maintainer also chose a query_log row of the call's own, the board's
--   tickets with it, so SMD-1719's utilization rate can score the read.
--
-- WHAT
--   * agenda's scope gains `keys`: 1 to 500 ticket keys (068's upper-case
--     form), standing alone: beside a source, project, label or holder it is
--     refused (review pass 2: a named open ticket outside that scope was in no
--     list). With it, the candidates are those tickets alone, no open item,
--     under every other rule of 124's unchanged (the include flags, the claim
--     rule, the order); a candidate past p_limit is counted in total alone. The answer gains `keyed`, null without keys:
--     {others: each named ticket that is no candidate, its head settled or
--     its status type unknown here, with its title, status, status_type and
--     `settled`; waiting: each named ticket a not_before ahead keeps out, with
--     its status and not_before; missing: each named key no thought records
--     whose prefix some ticket here carries (UTF-8 names no ticket)}.
--     So a named key is in items, others, waiting or missing (review pass 1:
--     a waiting one was in none). A named candidate left out by a flag is
--     counted in left_out as before.
--     The signature is 124's, so the function is replaced in place.
--   * query_log's kind gains `plan_context`: the request (query), its limit
--     (match_count), the knowledge hits' ids and scores (result_ids,
--     result_scores) and arm, and the board's tickets in the order shown
--     (result_items, each {kind, key, effective}). A CHECK holds that such a
--     row has its query and its items array.
--
-- WHO READS
--   As 124: the server, through the agenda tool (MCP), GET /v1/agenda, and
--   now plan_context's board section (MCP and REST). query_log is the
--   server's to write, as for the search and agenda rows.
--
-- SAFETY
--   One function replaced, STABLE and 124's signature, so no caller moves
--   (123's eight-argument agenda dropped first, as 124 drops it, should a
--   re-apply have put it back); a call without keys answers as 124's did,
--   `keyed` null beside. No ACL is carried, as 124 carried none.
--   query_log's kind CHECK is swapped only when it lacks plan_context, and
--   the shape CHECK added only when missing (123's catalog checks), so a
--   re-apply neither re-scans the log nor queues its inserts. No row is
--   touched. MINOR under the version rules. test-schema [112], test-upgrade
--   [20bp].
--
-- Prerequisites
--   034 (query_log), 068 (ob1_ticket_head), 115 (work_claims), 122
--   (effective_priority) and 123 (result_items, ob1_item_blockers); 124's
--   agenda is replaced whole. Applied by `bun db/migrate.ts`; re-applied
--   alone, the function is replaced again and the CHECKs found in place.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
BEGIN
  IF to_regprocedure('ob1_item_blockers(text, text)') IS NULL OR to_regprocedure('effective_priority(jsonb, jsonb, timestamp with time zone)') IS NULL
     OR to_regclass('ob1_ticket_head') IS NULL OR to_regclass('work_claims') IS NULL OR to_regclass('query_log') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('query_log') AND attname = 'result_items' AND NOT attisdropped) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 126 needs 034, 068, 115, 122 and 123 (query_log and its result_items, ob1_ticket_head, work_claims, effective_priority, ob1_item_blockers); this schema lacks one',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- 123's eight-argument agenda, dropped as 124 drops it, so a call of up to
-- eight arguments names one function: this file stands alone, as 124's does,
-- whichever of the two ran last.
DROP FUNCTION IF EXISTS agenda(jsonb, jsonb, int, boolean, boolean, boolean, jsonb, timestamptz);

-- ---------------------------------------------------------------------------
-- agenda — 124's, with the keys scope and `keyed`
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agenda(
  p_scope            jsonb       DEFAULT NULL,
  p_holder           jsonb       DEFAULT NULL,
  p_limit            int         DEFAULT 20,
  p_include_blocked  boolean     DEFAULT false,
  p_include_claimed  boolean     DEFAULT false,
  p_include_proposed boolean     DEFAULT false,
  p_weights          jsonb       DEFAULT NULL,
  p_now              timestamptz DEFAULT now(),
  p_include_started  boolean     DEFAULT false
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
  v_claims_live int;
  v_keys     text[];
  v_keyed    jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION USING MESSAGE = format('an agenda shows 1 to 100 items; %s is not', COALESCE(p_limit::text, 'NULL')), ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_include_blocked IS NULL OR p_include_claimed IS NULL OR p_include_proposed IS NULL OR p_include_started IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'agenda''s include flags are true or false, never NULL', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_scope IS NOT NULL AND jsonb_typeof(p_scope) <> 'object' THEN
    RAISE EXCEPTION USING MESSAGE = 'an agenda''s scope is a JSON object of source, project, label and keys', ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT string_agg(k, ', ' ORDER BY k) INTO v_bad FROM jsonb_object_keys(COALESCE(p_scope, '{}')) k WHERE k NOT IN ('source', 'project', 'label', 'keys');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = format('not an agenda scope: %s (the scopes are keys, label, project and source)', left(v_bad, 200)), ERRCODE = 'invalid_parameter_value';
  END IF;
  -- White space alone: JS trim()'s white space, named code point by code point and not [:space:], whose set is the
  -- collation's (review pass 10: ASCII alone under one, U+0085 among it under PGlite's, which trim() keeps), so
  -- the check refuses exactly what the schema refuses, under any collation.
  SELECT string_agg(k, ', ' ORDER BY k) INTO v_bad FROM jsonb_each(COALESCE(p_scope, '{}')) e(k, v)
   WHERE k <> 'keys' AND (jsonb_typeof(v) <> 'string' OR (v #>> '{}') !~ '[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]' OR length(v #>> '{}') > 200);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = format('an agenda scope is a non-empty string of at most 200 characters: %s', v_bad), ERRCODE = 'invalid_parameter_value';
  END IF;
  v_source := p_scope->>'source'; v_project := p_scope->>'project'; v_label := p_scope->>'label';
  -- keys (126, SMD-2684): the tickets named, 1 to 500 keys in their upper-case form, a duplicate counted once. Tickets
  -- alone: no open item is named by a key a caller holds. It stands alone (review pass 2): beside a source, project,
  -- label or holder, a named open ticket outside that scope would be in no list at all.
  IF p_scope ? 'keys' THEN
    IF jsonb_typeof(p_scope->'keys') <> 'array' OR jsonb_array_length(p_scope->'keys') NOT BETWEEN 1 AND 500
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_scope->'keys') k WHERE jsonb_typeof(k) <> 'string' OR (k #>> '{}') !~ c_key) THEN
      RAISE EXCEPTION USING MESSAGE = 'an agenda''s keys scope is 1 to 500 ticket keys, such as SMD-1234', ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_source IS NOT NULL OR v_project IS NOT NULL OR v_label IS NOT NULL OR v_mine THEN
      RAISE EXCEPTION USING MESSAGE = 'an agenda''s keys scope stands alone: no source, project, label or holder beside it', ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT array_agg(DISTINCT k ORDER BY k) INTO v_keys FROM jsonb_array_elements_text(p_scope->'keys') k;
  END IF;
  IF p_now IS NULL OR NOT isfinite(p_now) THEN
    RAISE EXCEPTION USING MESSAGE = 'agenda''s clock is a moment', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_mine THEN
    IF jsonb_typeof(p_holder) <> 'object' OR COALESCE(btrim(p_holder->>'name'), '') = '' THEN
      RAISE EXCEPTION USING MESSAGE = 'agenda: a holder is the calling key''s {name, agent_id}', ERRCODE = 'invalid_parameter_value';
    END IF;
    v_name := p_holder->>'name';
    v_agent := CASE WHEN p_holder->>'agent_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (p_holder->>'agent_id')::uuid END;
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

  -- The weights checked whatever the scope holds: 122 refuses a bad one, and a
  -- scope matching nothing would otherwise never call it (review pass 7).
  IF p_weights IS NOT NULL THEN
    PERFORM count(*) FROM effective_priority('[]'::jsonb, p_weights, p_now);
  END IF;

  -- The candidates, in the scope.
  SELECT COALESCE(jsonb_agg(c ORDER BY c->>'kind', c->>'key'), '[]') INTO v_cands
    FROM (
      SELECT jsonb_build_object('kind', 'ticket', 'key', h.issue, 'source', 'linear',
                                'title', left(split_part(t.content, E'\n', 1), 200),
                                'project', t.metadata->>'project', 'status', h.status, 'status_type', h.status_type) AS c
        FROM ob1_ticket_head h
        JOIN thoughts t ON t.id = h.head_id
       WHERE h.status_type = ANY(node_lifecycle_types()) AND NOT h.status_type = ANY(node_settled_types())
         AND h.issue ~ c_key
         AND (v_source IS NULL OR v_source = 'linear')
         AND (v_project IS NULL OR t.metadata->>'project' = v_project)
         AND (v_label IS NULL OR (jsonb_typeof(t.metadata->'labels') = 'array' AND t.metadata->'labels' ? v_label))
         AND (NOT v_mine OR h.issue = ANY(v_mine_issues))
         AND (v_keys IS NULL OR h.issue = ANY(v_keys))
      UNION ALL
      SELECT jsonb_build_object('kind', 'item', 'key', i.item_id::text, 'source', COALESCE(i.plugin, 'items'),
                                'title', left(i.text, 200), 'status', i.status, 'owner', i.owner)
        FROM open_items i
       WHERE (i.status = 'open' OR (p_include_proposed AND i.status = 'proposed'))
         AND v_project IS NULL AND v_label IS NULL AND NOT v_mine AND v_keys IS NULL
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
    SELECT count(*) INTO v_claims_live FROM work_claims w WHERE w.released_at IS NULL AND w.expires_at > p_now;
  END IF;

  -- The keys named that are no candidate (126): a ticket whose head is settled, or carries a status type this brain
  -- does not know, with its status; and a key no thought records. A planner's "this was done already" and "the
  -- brain has no such ticket" (SMD-2684). The candidate rule's own test, negated, so the two partition the keys
  -- that have a head.
  IF v_keys IS NOT NULL THEN
    SELECT jsonb_build_object(
             'others', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', h.issue, 'title', left(split_part(t.content, E'\n', 1), 200),
                                                                     'status', h.status, 'status_type', h.status_type,
                                                                     'settled', COALESCE(h.status_type = ANY(node_settled_types()), false))
                                                  ORDER BY h.issue)
                                   FROM ob1_ticket_head h JOIN thoughts t ON t.id = h.head_id
                                  WHERE h.issue = ANY(v_keys)
                                    AND NOT COALESCE(h.status_type = ANY(node_lifecycle_types()) AND NOT h.status_type = ANY(node_settled_types()), false)), '[]'),
             -- A key whose prefix no ticket here carries (UTF-8, SHA-256) is no ticket at all: not missing (review pass 2).
             'missing', COALESCE((SELECT jsonb_agg(k ORDER BY k) FROM unnest(v_keys) k
                                   WHERE NOT EXISTS (SELECT 1 FROM ob1_ticket_head h WHERE h.issue = k)
                                     AND EXISTS (SELECT 1 FROM ob1_ticket_head h WHERE h.issue LIKE split_part(k, '-', 1) || '-%')), '[]'))
      INTO v_keyed;
  END IF;

  RETURN (
    WITH scored AS (
      SELECT c, s
        FROM jsonb_array_elements(v_cands) c
        JOIN jsonb_array_elements(v_scored) s ON s->>'item_kind' = c->>'kind' AND s->>'item_key' = c->>'key'
    ), judged AS (
      -- An absent ticket, or an empty half, reads as SQL NULL: an empty half's
      -- jsonb_agg was NULL, which jsonb_build_object stored as JSON null.
      SELECT sc.c, sc.s, COALESCE((sc.s->>'waiting')::boolean, false) AS waiting,
             CASE WHEN sc.c->>'kind' = 'ticket' THEN NULLIF(v_claims->(sc.c->>'key')->'live', 'null'::jsonb) END AS live,
             CASE WHEN sc.c->>'kind' = 'ticket' THEN NULLIF(v_claims->(sc.c->>'key')->'lapsed', 'null'::jsonb) END AS lapsed,
             CASE WHEN sc.c->>'kind' = 'ticket' THEN ob1_item_blockers('ticket', sc.c->>'key') ELSE '{}'::text[] END AS blockers
        FROM scored sc
    ), kept AS (
      SELECT j.*
        FROM judged j
       WHERE NOT j.waiting
         AND (p_include_blocked OR cardinality(j.blockers) = 0)
         AND (p_include_claimed OR v_mine OR j.live IS NULL)
         AND (p_include_started OR j.live IS NOT NULL OR (j.c->>'status_type') IS DISTINCT FROM 'started')
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
                                                    AND NOT j.waiting),
        'claimed', (SELECT count(*) FROM judged j WHERE NOT (p_include_claimed OR v_mine) AND j.live IS NOT NULL
                                                    AND NOT j.waiting
                                                    AND (p_include_blocked OR cardinality(j.blockers) = 0)),
        'started', (SELECT count(*) FROM judged j WHERE NOT p_include_started AND (j.c->>'status_type') = 'started'
                                                    AND NOT j.waiting
                                                    AND (p_include_blocked OR cardinality(j.blockers) = 0)
                                                    AND j.live IS NULL),
        'waiting', (SELECT count(*) FROM judged j WHERE j.waiting)),
      'board_sync', v_board,
      'claims_read', v_claims_ok,
      'claims_live', v_claims_live,
      -- The named tickets a not_before ahead keeps out (always left out, as 123 leaves them): listed beside, so a named
      -- ticket is in items, others, waiting or missing, never in none (review pass 1).
      'keyed', CASE WHEN v_keyed IS NULL THEN NULL ELSE v_keyed || jsonb_build_object('waiting', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object('key', j.c->>'key', 'title', j.c->>'title', 'status', j.c->'status', 'status_type', j.c->'status_type',
                                                     'not_before', j.s->'not_before') ORDER BY j.c->>'key')
                   FROM judged j WHERE j.waiting), '[]')) END,
      'now', p_now)
  );
END;
$$;
COMMENT ON FUNCTION agenda(jsonb, jsonb, int, boolean, boolean, boolean, jsonb, timestamptz, boolean) IS
  'What matters now: every ticket whose head has a known, unsettled status type (its status and status_type on its row) and every open item with status open (proposed too with p_include_proposed), in p_scope (source: linear, items or a plugin''s name; project and label, Linear''s on a ticket; keys, 1 to 500 ticket keys: those tickets alone, no open item, refused beside any other scope or a holder), and with p_holder (a key''s {name, agent_id}) only the tickets it holds a live claim on; scored by effective_priority (122) and sorted by effective, then the sooner due time, then kind and key. Left out unless asked, and counted: a ticket blocked by an open item (p_include_blocked lists its blockers), a ticket under a live claim (p_include_claimed names the holder), a started ticket no live claim covers (p_include_started lists it; a started ticket under a live claim is a claimed one, listed by p_include_claimed or p_holder), and always an item whose not_before is ahead. A lapsed claim hides nothing, and a listed row names it. Returns {items (the first p_limit, 1 to 100), total, unknown (of total, no counted or inherited level), left_out {blocked, claimed, started, waiting}, board_sync {at, outcome} or null, claims_read (false when this role may not read work_claims: no claim filtered or named, and holder mine refused), claims_live (the live claims this brain records on any ticket, null when claims_read is false: 0 means nothing could be left out for a claim, as on a brain whose board is claimed through another), keyed (null without keys; else {others: each named ticket that is no candidate, its head settled or its status type unknown, with key, title, status, status_type and settled; waiting: each named ticket a not_before ahead keeps out, with key, title, status, status_type and not_before; missing: each named key no thought records whose prefix some ticket carries}), now}. Raises 22023 on a bad limit, scope, holder, clock or weight, or a NULL include flag; 42501 for holder mine on a role that may not read work_claims. Migrations 123 (SMD-3669), 124 (SMD-4162) and 126 (SMD-2684).';

-- ---------------------------------------------------------------------------
-- query_log: plan_context's kind
-- ---------------------------------------------------------------------------
-- The kind CHECK swapped only when it lacks plan_context, the shape CHECK
-- added only when missing (123's reasons: a catalog read takes a momentary
-- ACCESS SHARE, an ALTER an ACCESS EXCLUSIVE and a scan).
DO $kind$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'query_log_kind_check' AND conrelid = 'query_log'::regclass
                    AND pg_get_constraintdef(oid) LIKE '%plan_context%') THEN
    ALTER TABLE query_log DROP CONSTRAINT IF EXISTS query_log_kind_check;
    ALTER TABLE query_log ADD CONSTRAINT query_log_kind_check CHECK (kind IN ('search', 'action', 'agenda', 'plan_context'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'query_log_plan_context_shape' AND conrelid = 'query_log'::regclass) THEN
    ALTER TABLE query_log ADD CONSTRAINT query_log_plan_context_shape
      CHECK (kind <> 'plan_context' OR (query IS NOT NULL AND result_items IS NOT NULL AND jsonb_typeof(result_items) = 'array'));
  END IF;
END
$kind$;

-- The comments naming the kinds, re-issued with plan_context's row when they
-- differ (124's shape, so a re-apply writes nothing).
DO $qc2$
DECLARE
  v_table text := 'Opt-in (OB1_QUERY_LOG=on), off by default: one row per search call (the query, its arguments, and the ids returned in rank order with scores) and one per follow-up fetch/edit/delete of a returned id, or a write that cited a returned id as its source (the target; the tool is <writer>/<pointer> on a cite, and the tool column''s comment has both shapes, SMD-1719); one per agenda call (kind agenda: the caller, its scope and flags in filter, its limit in match_count, and the tickets and items shown, in order, in result_items; migration 123, SMD-3669); and one per plan_context call (kind plan_context: the request in query, its limit in match_count, the knowledge hits'' ids and scores in result_ids and result_scores, and the board''s tickets, in order, in result_items; migration 126, SMD-2684). Personal data at rest — every query typed. Nothing reads it on the hot path; the write is best-effort and never fails a search. An action is linked to its search at export time by (agent_id, target_id, time window), not at write time — there is no request/session token in the handlers. Pruned by prune_query_log(); default retention 30 days (OB1_QUERY_LOG_RETENTION_DAYS).';
  v_items text := 'An agenda row''s items in the order returned, each {kind, key, effective}: tickets are keys, not thought ids, so result_ids cannot hold them; a plan_context row''s board tickets, the same shape. NULL on search and action rows. Migrations 123 (SMD-3669) and 126 (SMD-2684).';
  v_filter text := 'The metadata containment filter a search ran with (jsonb; the search applies metadata @> filter). Populated from the search tools'' filter argument (SMD-1490); {} is unfiltered, and an absent or empty argument normalises to {} at the tool boundary. The argument is a shallow object — top-level keys mapping to a scalar or an array of scalars — so the containment stays GIN-indexable (SMD-1625 is the row-level-security cost of exposing it). NULL on an action row. On an agenda row, no containment filter: the call''s scope (source, project, label), its holder and its four include flags (blocked, claimed, proposed, started; migrations 123 and 124). On a plan_context row, {} when its board was read, else {board: deadline, failed or no_keys_scope} (migration 126).';
BEGIN
  IF obj_description('query_log'::regclass, 'pg_class') IS DISTINCT FROM v_table THEN
    EXECUTE format('COMMENT ON TABLE query_log IS %L', v_table);
  END IF;
  IF col_description('query_log'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'query_log'::regclass AND attname = 'result_items' AND NOT attisdropped)) IS DISTINCT FROM v_items THEN
    EXECUTE format('COMMENT ON COLUMN query_log.result_items IS %L', v_items);
  END IF;
  IF col_description('query_log'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'query_log'::regclass AND attname = 'filter' AND NOT attisdropped)) IS DISTINCT FROM v_filter THEN
    EXECUTE format('COMMENT ON COLUMN query_log.filter IS %L', v_filter);
  END IF;
END
$qc2$;
