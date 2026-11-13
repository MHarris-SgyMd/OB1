-- =============================================================================
-- Migration 137: within one level, the agenda puts the item that unblocks
--                more first (SMD-4264)
-- =============================================================================
--
-- WHY
--   122's unblocks term steps at 1 open item blocked (+0.1 since 127) and at
--   unblocks_many_at, 3 (+0.2), and stops: past three the count is reported,
--   to its cap (50 by default), but never ordered on. The agenda (129) breaks a tie on
--   effective priority by the sooner due time, then kind and key, so among
--   items of one level blocking three or more, the order was the key. On the
--   dogfood board of 2026-11-12 eleven Medium tickets tied at 2.2, and the
--   one gating the most work (50 open items within three levels) came last,
--   behind four that each unblocked 3.
--
-- WHAT (the maintainer's choice, 2026-11-12: a tie-break, not a graded term)
--   * The ten-argument agenda's order gains the unblocks count, highest
--     first, after the sooner due time and before kind and key, under both
--     orders: priority (effective, the sooner due time, the count, kind,
--     key) and due (a tie on the due time to the higher effective, then the
--     count, then kind and key).
--   * Every score stays as it was. effective_priority, its weights and
--     search's priority blend are untouched, so nothing moves between levels
--     (127's level first) and no weight is added. Only an exact tie on
--     effective (and the due time) is ordered by the count.
--   * Two items at or past the cap (50 by default) count the same and still
--     fall to kind and key.
--   * The function's comment says the new order. Every filter, term and
--     number is 129's, and so is the nine-argument wrapper, which calls this
--     one and so takes the order too, as plan_context's board section does.
--
-- WHO READS
--   As 129: the server, through the agenda tool (MCP), GET /v1/agenda and
--   plan_context's board section.
--
-- SAFETY
--   One function replaced, its signature, return type, volatility and ACL
--   as 129 left them (CREATE OR REPLACE keeps the grants). No row is touched.
--   A server before this one reads the same answer shape. MINOR under the
--   version rules. test-schema [124], test-upgrade [20cb].
--
-- Prerequisites
--   034 (query_log), 068 (ob1_ticket_head), 115 (work_claims), 122
--   (effective_priority), 123 (result_items, ob1_item_blockers) and 129 (the
--   ten-argument agenda), whose body this replaces. Applied by
--   `bun db/migrate.ts`; re-applied alone, the function is replaced again.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
BEGIN
  IF to_regprocedure('agenda(jsonb, jsonb, integer, boolean, boolean, boolean, jsonb, timestamp with time zone, boolean, text)') IS NULL
     OR to_regprocedure('ob1_item_blockers(text, text)') IS NULL OR to_regprocedure('effective_priority(jsonb, jsonb, timestamp with time zone)') IS NULL
     OR to_regclass('ob1_ticket_head') IS NULL OR to_regclass('work_claims') IS NULL OR to_regclass('query_log') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('query_log') AND attname = 'result_items' AND NOT attisdropped) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 137 needs 034, 068, 115, 122, 123 and 129 (query_log and its result_items, ob1_ticket_head, work_claims, effective_priority, ob1_item_blockers, the ten-argument agenda); this schema lacks one',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- agenda — 129's, the unblocks count before kind and key
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agenda(
  p_scope            jsonb,
  p_holder           jsonb,
  p_limit            int,
  p_include_blocked  boolean,
  p_include_claimed  boolean,
  p_include_proposed boolean,
  p_weights          jsonb,
  p_now              timestamptz,
  p_include_started  boolean,
  p_order            text
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
  -- The order (129, SMD-4192): priority, 126's, or due, the dated items first.
  IF p_order IS NULL OR p_order NOT IN ('priority', 'due') THEN
    RAISE EXCEPTION USING MESSAGE = format('an agenda''s order is priority or due; %s is not', COALESCE(quote_literal(left(p_order, 40)), 'NULL')), ERRCODE = 'invalid_parameter_value';
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
      -- due (129): the dated items first, soonest due first, so the longest overdue leads; then the undated. A stated
      -- None (level 0) counts as undated: 122 gives it no urgency and never calls it overdue, so its date leads
      -- nothing (review pass 3, the maintainer's amendment of 2026-11-10). Under priority both leading keys are NULL
      -- alike, and the order is 126's: effective, the sooner due time, kind, key. Since 137 (SMD-4264) the more open
      -- items it unblocks (122's count, to its cap) comes before kind and key, under either order: within a level the
      -- unblocks term stops at unblocks_many_at, so items blocking 3 and 50 tied, and fell to key order.
      SELECT k.*, row_number() OVER (ORDER BY CASE WHEN p_order = 'due' THEN (k.s->>'due_at') IS NULL OR COALESCE((k.s->>'level')::numeric = 0, false) END,
                                              CASE WHEN p_order = 'due' AND NOT COALESCE((k.s->>'level')::numeric = 0, false) THEN (k.s->>'due_at')::timestamptz END,
                                              (k.s->>'effective')::numeric DESC, (k.s->>'due_at')::timestamptz ASC NULLS LAST,
                                              COALESCE((k.s->>'unblocks')::int, 0) DESC,
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
      'order', p_order,
      'now', p_now)
  );
END;
$$;
COMMENT ON FUNCTION agenda(jsonb, jsonb, int, boolean, boolean, boolean, jsonb, timestamptz, boolean, text) IS
  'What matters now: every ticket whose head has a known, unsettled status type (its status and status_type on its row) and every open item with status open (proposed too with p_include_proposed), in p_scope (source: linear, items or a plugin''s name; project and label, Linear''s on a ticket; keys, 1 to 500 ticket keys: those tickets alone, no open item, refused beside any other scope or a holder), and with p_holder (a key''s {name, agent_id}) only the tickets it holds a live claim on; scored by effective_priority (122) and sorted by p_order: priority by effective, then the sooner due time, then the more open items it unblocks (122''s count, to its cap), then kind and key; due by the due time, the dated items first, soonest first (so the longest overdue leads), the undated after (a stated None, level 0, counted undated), each tie by effective, then the more it unblocks, then kind and key. The order is applied before p_limit. Left out unless asked, and counted: a ticket blocked by an open item (p_include_blocked lists its blockers), a ticket under a live claim (p_include_claimed names the holder), a started ticket no live claim covers (p_include_started lists it; a started ticket under a live claim is a claimed one, listed by p_include_claimed or p_holder), and always an item whose not_before is ahead. A lapsed claim hides nothing, and a listed row names it. Returns {items (the first p_limit, 1 to 100), total, unknown (of total, no counted or inherited level), left_out {blocked, claimed, started, waiting}, board_sync {at, outcome} or null, claims_read (false when this role may not read work_claims: no claim filtered or named, and holder mine refused), claims_live (the live claims this brain records on any ticket, null when claims_read is false: 0 means nothing could be left out for a claim, as on a brain whose board is claimed through another), keyed (null without keys; else {others: each named ticket that is no candidate, its head settled or its status type unknown, with key, title, status, status_type and settled; waiting: each named ticket a not_before ahead keeps out, with key, title, status, status_type and not_before; missing: each named key no thought records whose prefix some ticket carries}), order, now}. Raises 22023 on a bad limit, scope, holder, clock, weight or order, or a NULL include flag; 42501 for holder mine on a role that may not read work_claims. The nine-argument agenda calls this with priority; this one takes no defaults. Migrations 123 (SMD-3669), 124 (SMD-4162), 126 (SMD-2684), 129 (SMD-4192) and 137 (SMD-4264).';
