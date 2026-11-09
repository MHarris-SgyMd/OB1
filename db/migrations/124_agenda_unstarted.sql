-- =============================================================================
-- Migration 124: the agenda says each ticket's status, leaves started work
--                out unless asked, and says how many live claims it read
--                (SMD-4162)
-- =============================================================================
--
-- WHY
--   Asked for the highest-value unstarted issue on 2026-11-09, the canary's
--   agenda (123) ranked SMD-3379, In Progress, among Backlog tickets as
--   startable and unclaimed. Three gaps:
--   * a ticket row carried no status (123 put status on an open item alone),
--     so Backlog, Todo and In Progress read the same;
--   * nothing could leave started work out: 123 takes every unsettled ticket
--     (the maintainer, 2026-11-07), and no scope or flag narrowed it;
--   * the canary records none of the board's claims (this repo claims on
--     stable, CLAUDE.md), so its claim filter left nothing out while saying
--     `claims_read` true.
--   Decided 2026-11-09 (the maintainer, on SMD-4162): started tickets are
--   left out by default; the agenda is unreleased until v2.1.0, so no caller
--   leans on 123's default.
--
-- WHAT
--   agenda(..., p_now, p_include_started boolean DEFAULT false) replaces 123's
--   eight-argument agenda; the flag is appended, so a positional call of
--   123's arguments reads as it did. Beside 123:
--   * a ticket row carries its head's `status` and `status_type` (068);
--   * a ticket whose status type is `started` is left out unless
--     p_include_started, or unless p_holder (`mine` shows the key's own
--     claimed work, started or not), and counted in left_out.started after
--     the filters before it (waiting, blocked, claimed), as claimed is
--     counted after blocked;
--   * `claims_live`: the live claims (unreleased, unexpired, 115) this brain
--     records on any ticket, null when claims_read is false. 0 says no claim
--     could leave anything out, as on a brain whose board is claimed through
--     another brain.
--   Every other rule, refusal and term is 123's, unchanged.
--
-- WHO READS
--   As 123: the server, through the agenda tool (MCP) and GET /v1/agenda;
--   work_claims only when the role may (the claims group).
--
-- SAFETY
--   One function replaced (123's dropped first, so no call is ambiguous
--   between the two), STABLE as it was; no table, column or row touched.
--   MINOR under the version rules. test-schema [111], test-upgrade [20bo].
--
-- Prerequisites
--   068 (ob1_ticket_head), 115 (work_claims), 123 (the agenda, its helpers).
--   Applied by `bun db/migrate.ts`. Re-applied: the drop finds no eight-
--   argument agenda and the function is replaced.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
BEGIN
  IF to_regprocedure('ob1_item_blockers(text, text)') IS NULL OR to_regprocedure('effective_priority(jsonb, jsonb, timestamp with time zone)') IS NULL
     OR to_regclass('ob1_ticket_head') IS NULL OR to_regclass('work_claims') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 124 needs 068, 115, 122 and 123 (ob1_ticket_head, work_claims, effective_priority, ob1_item_blockers); this schema lacks one',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- 123's eight-argument agenda, dropped so a call of up to eight arguments
-- names one function.
DROP FUNCTION IF EXISTS agenda(jsonb, jsonb, int, boolean, boolean, boolean, jsonb, timestamptz);

-- ---------------------------------------------------------------------------
-- agenda — 123's, with the status, the started filter and the live claims
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
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION USING MESSAGE = format('an agenda shows 1 to 100 items; %s is not', COALESCE(p_limit::text, 'NULL')), ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_include_blocked IS NULL OR p_include_claimed IS NULL OR p_include_proposed IS NULL OR p_include_started IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'agenda''s include flags are true or false, never NULL', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_scope IS NOT NULL AND jsonb_typeof(p_scope) <> 'object' THEN
    RAISE EXCEPTION USING MESSAGE = 'an agenda''s scope is a JSON object of source, project and label', ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT string_agg(k, ', ' ORDER BY k) INTO v_bad FROM jsonb_object_keys(COALESCE(p_scope, '{}')) k WHERE k NOT IN ('source', 'project', 'label');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = format('not an agenda scope: %s (the scopes are label, project and source)', left(v_bad, 200)), ERRCODE = 'invalid_parameter_value';
  END IF;
  -- White space alone: JS trim()'s white space, named code point by code point and not [:space:], whose set is the
  -- collation's (review pass 10: ASCII alone under one, U+0085 among it under PGlite's, which trim() keeps), so
  -- the check refuses exactly what the schema refuses, under any collation.
  SELECT string_agg(k, ', ' ORDER BY k) INTO v_bad FROM jsonb_each(COALESCE(p_scope, '{}')) e(k, v)
   WHERE jsonb_typeof(v) <> 'string' OR (v #>> '{}') !~ '[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]' OR length(v #>> '{}') > 200;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = format('an agenda scope is a non-empty string of at most 200 characters: %s', v_bad), ERRCODE = 'invalid_parameter_value';
  END IF;
  v_source := p_scope->>'source'; v_project := p_scope->>'project'; v_label := p_scope->>'label';
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
    SELECT count(*) INTO v_claims_live FROM work_claims w WHERE w.released_at IS NULL AND w.expires_at > p_now;
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
         AND (p_include_started OR v_mine OR (j.c->>'status_type') IS DISTINCT FROM 'started')
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
        'started', (SELECT count(*) FROM judged j WHERE NOT (p_include_started OR v_mine) AND (j.c->>'status_type') = 'started'
                                                    AND NOT j.waiting
                                                    AND (p_include_blocked OR cardinality(j.blockers) = 0)
                                                    AND (p_include_claimed OR j.live IS NULL)),
        'waiting', (SELECT count(*) FROM judged j WHERE j.waiting)),
      'board_sync', v_board,
      'claims_read', v_claims_ok,
      'claims_live', v_claims_live,
      'now', p_now)
  );
END;
$$;
COMMENT ON FUNCTION agenda(jsonb, jsonb, int, boolean, boolean, boolean, jsonb, timestamptz, boolean) IS
  'What matters now: every ticket whose head has a known, unsettled status type (its status and status_type on its row) and every open item with status open (proposed too with p_include_proposed), in p_scope (source: linear, items or a plugin''s name; project and label, Linear''s on a ticket), and with p_holder (a key''s {name, agent_id}) only the tickets it holds a live claim on; scored by effective_priority (122) and sorted by effective, then the sooner due time, then kind and key. Left out unless asked, and counted: a ticket blocked by an open item (p_include_blocked lists its blockers), a ticket under a live claim (p_include_claimed names the holder), a started ticket (p_include_started lists it; p_holder shows its own started or not), and always an item whose not_before is ahead. A lapsed claim hides nothing and is named. Returns {items (the first p_limit, 1 to 100), total, unknown (of total, no counted or inherited level), left_out {blocked, claimed, started, waiting}, board_sync {at, outcome} or null, claims_read (false when this role may not read work_claims: no claim filtered or named, and holder mine refused), claims_live (the live claims this brain records on any ticket, null when claims_read is false: 0 means nothing could be left out for a claim, as on a brain whose board is claimed through another), now}. Raises 22023 on a bad limit, scope, holder, clock or weight, or a NULL include flag; 42501 for holder mine on a role that may not read work_claims. Migrations 123 (SMD-3669) and 124 (SMD-4162).';
