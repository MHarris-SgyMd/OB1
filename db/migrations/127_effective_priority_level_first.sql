-- =============================================================================
-- Migration 127: effective priority orders by level first — urgency, overdue
--                and what an item unblocks order items of one level and never
--                lift one past the next (SMD-4177)
-- =============================================================================
--
-- WHY
--   122's weights (docs/priority.md decision 5, 2026-11-02) added urgency at
--   full levels: +2 due by the end of tomorrow, +1 within the week, +3
--   overdue, +0.5 or +1 for what an item unblocks. So an overdue note with no
--   stated level (unknown 2 + overdue 3 = 5) outranked an Urgent ticket that
--   unblocks another (4 + 0.5), and an open item left overdue and never
--   closed outranked every stated level below Critical for good. On SMD-3662's
--   seeded set the operator's gold puts the Urgent ticket first on four
--   prompts where the weights put the overdue gutters, and both priority reads
--   stopped at top-1 on 2 of 7 (SMD-3669's agenda, SMD-3668's priority_weight
--   after SMD-4149).
--
-- WHAT
--   The rule, decided by the maintainer on 2026-11-09 (SMD-4177, option C),
--   before the build and the run: an item's level (stated, read from its open
--   items, inherited, or unknown's 2) decides its place; urgency, overdue and
--   what it unblocks order items of one level. Built as 125's effective_priority
--   with its default weights scaled by 0.2, so the terms after the level add
--   at most 0.8 and never reach the next level:
--     soon 2 -> 0.4, week 1 -> 0.2, overdue 3 -> 0.6,
--     unblocks_one 0.5 -> 0.1, unblocks_many 1 -> 0.2.
--   Their ratios are 122's, so items of one level keep 122's order. Every
--   other weight, rule, term, refusal and column is 125's. A caller who wants
--   the old order passes the old weights to effective_priority by name (SQL,
--   or the store's effectivePriority; no REST or MCP tool takes weights, so
--   the agenda and search always read the defaults).
--
-- WHO READS
--   As 125: no actor, any role with EXECUTE. No grant changes.
--
-- SAFETY
--   One function replaced with the same signature and columns; no table, and
--   nothing stored changed. STABLE, as 125's. Every effective priority with a
--   due time or an unblocks term reads a smaller number from this migration on
--   (a High due tomorrow is 3.4, not 5), so the agenda's order and search's
--   priority_weight and min_priority move with it; the agenda is unreleased
--   until v2.1.0. MINOR under FORK.md's version rules. test-schema [114],
--   test-upgrade [20br].
--
-- Prerequisites
--   125 (effective_priority's from_items helpers: ob1_priority_due,
--   ob1_thought_items). Applied by `bun db/migrate.ts`. Re-applied: the
--   function is replaced as it was.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
BEGIN
  IF to_regprocedure('ob1_thought_items(uuid, boolean)') IS NULL OR to_regprocedure('ob1_priority_due(priority_assertions, text, text, boolean)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 127 needs 125 (effective_priority''s from_items helpers); this schema lacks them',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- effective_priority — the composed read
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION effective_priority(p_items jsonb, p_weights jsonb DEFAULT NULL, p_now timestamptz DEFAULT now())
RETURNS TABLE (item_kind text, item_key text, effective numeric, level smallint, inherited_from jsonb, due_at timestamptz,
               due_from text, urgency numeric, overdue boolean, unblocks int, settled boolean, not_before timestamptz,
               waiting boolean, terms jsonb, winner jsonb, passed_over jsonb)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  -- docs/priority.md's weights, level first (SMD-4177, the maintainer,
  -- 2026-11-09): 122's urgency and unblocks terms scaled by 0.2, so together
  -- they add at most 0.8 (overdue 0.6 + unblocks_many 0.2) and never lift an
  -- item past the next level; items of one level keep 122's order.
  c_defaults CONSTANT jsonb := '{"unknown": 2, "hop": 1, "hops": 2, "soon": 0.4, "soon_days": 1, "week": 0.2, "week_days": 7, "overdue": 0.6,
                                 "unblocks_one": 0.1, "unblocks_many": 0.2, "unblocks_many_at": 3, "depth": 3, "cap": 50, "count_inferred": false}';
  -- cap 50: the term is decided at unblocks_many_at, and the count past it is
  -- only shown; the walk stops at the frontier that reaches the cap (review
  -- pass 4: a board whose tickets each block ten took 6.5 s for 1,000 items
  -- counting to a thousand). The cap counts open items: a hub whose blocked
  -- items are settled is still read through for each item reaching it
  -- (review pass 7: 1,000 items through a hub of 3,000 settled ones, 4.9 s),
  -- the case a stored projection would answer.
  v_w        jsonb;
  v_bad      text;
  w_unknown numeric; w_hop numeric; w_hops int; w_soon numeric; w_soon_days int; w_week numeric; w_week_days int; w_overdue numeric;
  w_one numeric; w_many numeric; w_many_at int; w_depth int; w_cap int; w_inferred boolean;
  v_today    date;
  v_soon_by  timestamptz;
  v_week_by  timestamptz;
  q          record;
  v_win      priority_assertions;
  v_due      record;
  v_item     record;
  v_due_item uuid;
  v_zero     boolean;
  v_has_item boolean;
  v_base     numeric;
  h1         record;
  h          record;
  v_lvl      smallint;
  v_inh_kind text; v_inh_key text; v_inh_level smallint; v_inh_hops int; v_inh_value numeric;
  v_subj     record;
  s_kind     text;
  s_key      text;
  v_as       text;
  v_term     numeric;
  v_terms    jsonb;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION USING MESSAGE = 'effective_priority takes a JSON array of {kind, key}', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_items) > 1000 THEN
    RAISE EXCEPTION USING MESSAGE = format('effective_priority reads at most 1000 items at once; %s were given', jsonb_array_length(p_items)), ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_weights IS NOT NULL AND jsonb_typeof(p_weights) <> 'object' THEN
    RAISE EXCEPTION USING MESSAGE = 'effective_priority''s weights are a JSON object of overrides', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_now IS NULL OR NOT isfinite(p_now) THEN
    RAISE EXCEPTION USING MESSAGE = 'effective_priority''s clock is a moment', ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The weights: an unknown name is refused (a misspelt weight would be
  -- silently ignored), and each value is checked for its type and range.
  SELECT string_agg(k, ', ' ORDER BY k) INTO v_bad FROM jsonb_object_keys(COALESCE(p_weights, '{}')) k WHERE NOT c_defaults ? k;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = format('not a weight: %s (the weights are %s)', left(v_bad, 200),
                                           (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(c_defaults) k)),
                          ERRCODE = 'invalid_parameter_value';
  END IF;
  v_w := c_defaults || COALESCE(p_weights, '{}');
  SELECT string_agg(k, ', ' ORDER BY k) INTO v_bad
    FROM jsonb_each(v_w) e(k, v)
   WHERE CASE
           WHEN k = 'count_inferred' THEN jsonb_typeof(v) <> 'boolean'
           WHEN jsonb_typeof(v) <> 'number' THEN true
           WHEN k IN ('hops', 'soon_days', 'week_days', 'unblocks_many_at', 'depth', 'cap') THEN
             v::numeric <> trunc(v::numeric) OR v::numeric < CASE WHEN k IN ('cap', 'unblocks_many_at') THEN 1 ELSE 0 END
             OR v::numeric > CASE k WHEN 'cap' THEN 1000 WHEN 'depth' THEN 5 WHEN 'hops' THEN 2 ELSE 366 END
           ELSE v::numeric < 0 OR v::numeric > 10
         END;
  -- A cap below unblocks_many_at would leave the larger unblocks term
  -- unreachable (review pass 5).
  -- Nested, so the casts run only once both values are known numbers.
  IF v_bad IS NULL THEN
    IF (v_w->>'cap')::numeric < (v_w->>'unblocks_many_at')::numeric THEN
      RAISE EXCEPTION USING MESSAGE = 'a weight out of range: cap is below unblocks_many_at, so the larger unblocks term could never be reached',
                            ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = format('a weight out of range: %s (count_inferred a boolean; hops a whole number 0 to 2, depth 0 to 5, cap 1 to 1000, soon_days, week_days and unblocks_many_at whole numbers to 366; every other a number 0 to 10)', v_bad),
                          ERRCODE = 'invalid_parameter_value';
  END IF;
  -- A whole number read through numeric: JSON's 3.0 passes the check above,
  -- and '3.0'::int raises 22P02 (review pass 1).
  w_unknown := (v_w->>'unknown')::numeric;  w_hop := (v_w->>'hop')::numeric;            w_hops := (v_w->>'hops')::numeric::int;
  w_soon := (v_w->>'soon')::numeric;        w_soon_days := (v_w->>'soon_days')::numeric::int; w_week := (v_w->>'week')::numeric;
  w_week_days := (v_w->>'week_days')::numeric::int; w_overdue := (v_w->>'overdue')::numeric; w_one := (v_w->>'unblocks_one')::numeric;
  w_many := (v_w->>'unblocks_many')::numeric; w_many_at := (v_w->>'unblocks_many_at')::numeric::int; w_depth := (v_w->>'depth')::numeric::int;
  w_cap := (v_w->>'cap')::numeric::int;     w_inferred := (v_w->>'count_inferred')::boolean;

  -- Calendar days in UTC (SMD-3778): "by the end of tomorrow" is the start of
  -- the day after it.
  v_today   := (p_now AT TIME ZONE 'UTC')::date;
  v_soon_by := (v_today + w_soon_days + 1)::timestamp AT TIME ZONE 'UTC';
  v_week_by := (v_today + w_week_days + 1)::timestamp AT TIME ZONE 'UTC';

  FOR q IN
    SELECT a.kind, a.key FROM (
      SELECT DISTINCT ON (n.kind, n.key) n.kind, n.key, e.ord
        FROM jsonb_array_elements(p_items) WITH ORDINALITY AS e(v, ord)
        CROSS JOIN LATERAL ob1_priority_item(e.v->>'kind', e.v->>'key') AS n
       ORDER BY n.kind, n.key, e.ord) a
     ORDER BY a.ord
  LOOP
    item_kind := q.kind;
    item_key := q.key;
    v_terms := '[]'::jsonb;
    -- A ticket's own row reads as its ticket — its level, due time,
    -- settledness, structure — and the read names the ticket (the
    -- maintainer, review pass 1); the statements on the ticket and its rows
    -- are one pool (review pass 2).
    v_subj := ob1_priority_subject(q.kind, q.key);
    s_kind := v_subj.kind; s_key := v_subj.key;
    v_as := CASE WHEN q.kind = 'thought' AND s_kind = 'ticket' THEN s_key END;
    v_win := ob1_priority_counted(q.kind, q.key, w_inferred);
    winner := CASE WHEN v_win.id IS NOT NULL THEN ob1_priority_json(v_win) END;
    SELECT COALESCE(jsonb_agg(ob1_priority_json(a) ORDER BY a.tier, a.seq DESC), '[]'::jsonb) INTO passed_over
      FROM ob1_priority_open(q.kind, q.key) a
     WHERE a.id IS DISTINCT FROM v_win.id;
    settled := ob1_item_settled(s_kind, s_key);
    level := v_win.level;
    inherited_from := NULL;

    -- The level, else the highest counted on a plain thought's open items
    -- (125), else the inherited level, else unknown's value. v_zero: a level
    -- 0 so read takes no urgency.
    v_zero := COALESCE(v_win.level = 0, false);
    v_has_item := false;
    IF v_win.id IS NULL AND s_kind = 'thought' THEN
      -- A thought that is no ticket's row (a row reads as its ticket, so
      -- s_kind is ticket): of its open items' counted levels the highest,
      -- with no hop discount, the item being the note's own to-do; at one
      -- level, the one due soonest, then by id (the maintainer, SMD-4149).
      SELECT * INTO v_item FROM ob1_thought_items(s_key::uuid, w_inferred) t WHERE t.item_level IS NOT NULL
       ORDER BY t.item_level DESC, t.item_due_at NULLS LAST, t.item_id LIMIT 1;
      v_has_item := FOUND;
    END IF;
    IF v_win.id IS NOT NULL THEN
      v_base := v_win.level;
      v_terms := v_terms || jsonb_build_object('term', 'level', 'value', v_base, 'level', v_win.level, 'tier', v_win.tier, 'maker', v_win.maker_name);
    ELSIF v_has_item THEN
      v_base := v_item.item_level;
      v_zero := v_item.item_level = 0;
      v_terms := v_terms || jsonb_build_object('term', 'from_items', 'value', v_base, 'level', v_item.item_level, 'tier', v_item.item_tier,
                                               'maker', v_item.item_maker, 'item', v_item.item_id);
    ELSE
      -- Walked in loops, one hop at a time: written as one query over the
      -- set-returning helpers, the planner took 200 ms an item (SMD-3667's
      -- timing on a seeded board) for what is a handful of index probes.
      -- A served item's effective level is its own stated one when it has
      -- one, so the walk goes on past it only when it states none (review
      -- pass 1: a Low parent passed its Critical parent's level down). A
      -- settled item passes nothing down and is not walked through (the
      -- maintainer, review pass 1). The best: the highest value, then the
      -- fewer hops, then kind and key.
      v_inh_kind := NULL;
      IF w_hops >= 1 THEN
        -- Each served item read as its subject: an origin thought that is a
        -- ticket's own row is that ticket, one hop off (review pass 2).
        FOR h1 IN SELECT DISTINCT m.kind, m.key FROM ob1_item_serves(s_kind, s_key) x CROSS JOIN LATERAL ob1_priority_subject(x.kind, x.key) m ORDER BY 1, 2 LOOP
          -- The item itself, reached round a cycle, has no counted level
          -- here and so passes nothing: no test for it is needed.
          CONTINUE WHEN ob1_item_settled(h1.kind, h1.key);
          v_lvl := (ob1_priority_counted(h1.kind, h1.key, w_inferred)).level;
          IF v_lvl IS NOT NULL THEN
            IF v_lvl - w_hop > w_unknown
               AND (v_inh_kind IS NULL OR v_lvl - w_hop > v_inh_value
                    OR (v_lvl - w_hop = v_inh_value AND (1, h1.kind, h1.key) < (v_inh_hops, v_inh_kind, v_inh_key))) THEN
              v_inh_kind := h1.kind; v_inh_key := h1.key; v_inh_level := v_lvl; v_inh_hops := 1; v_inh_value := v_lvl - w_hop;
            END IF;
            CONTINUE;
          END IF;
          CONTINUE WHEN w_hops < 2;
          FOR h IN SELECT DISTINCT m.kind, m.key FROM ob1_item_serves(h1.kind, h1.key) x CROSS JOIN LATERAL ob1_priority_subject(x.kind, x.key) m ORDER BY 1, 2 LOOP
            CONTINUE WHEN ob1_item_settled(h.kind, h.key);
            v_lvl := (ob1_priority_counted(h.kind, h.key, w_inferred)).level;
            CONTINUE WHEN v_lvl IS NULL OR v_lvl - 2 * w_hop <= w_unknown;
            IF v_inh_kind IS NULL OR v_lvl - 2 * w_hop > v_inh_value
               OR (v_lvl - 2 * w_hop = v_inh_value AND (2, h.kind, h.key) < (v_inh_hops, v_inh_kind, v_inh_key)) THEN
              v_inh_kind := h.kind; v_inh_key := h.key; v_inh_level := v_lvl; v_inh_hops := 2; v_inh_value := v_lvl - 2 * w_hop;
            END IF;
          END LOOP;
        END LOOP;
      END IF;
      IF v_inh_kind IS NOT NULL THEN
        v_base := v_inh_value;
        inherited_from := jsonb_build_object('kind', v_inh_kind, 'key', v_inh_key, 'level', v_inh_level, 'hops', v_inh_hops);
        v_terms := v_terms || jsonb_build_object('term', 'inherited', 'value', v_base, 'from', inherited_from);
      ELSE
        v_base := w_unknown;
        v_terms := v_terms || jsonb_build_object('term', 'unknown', 'value', v_base);
      END IF;
    END IF;
    IF v_as IS NOT NULL THEN
      v_terms := jsonb_set(v_terms, '{0,as}', jsonb_build_object('kind', 'ticket', 'key', v_as));
    END IF;

    -- The due time: the counted winner's, else its due_ref's (one hop: the
    -- referenced item's counted winner's, else an open item's own — the
    -- maintainer, review pass 1), else an open item's own (ob1_priority_due);
    -- else, for a plain thought, the soonest among its open items, an item at
    -- a counted level 0 passing none (125).
    SELECT * INTO v_due FROM ob1_priority_due(v_win, s_kind, s_key, w_inferred);
    due_at := v_due.due_at;
    due_from := v_due.due_from;
    v_due_item := NULL;
    IF due_at IS NULL AND s_kind = 'thought' THEN
      SELECT t.item_id, t.item_due_at INTO v_due_item, due_at FROM ob1_thought_items(s_key::uuid, w_inferred) t
       WHERE t.item_due_at IS NOT NULL AND t.item_level IS DISTINCT FROM 0
       ORDER BY t.item_due_at, t.item_id LIMIT 1;
      due_from := CASE WHEN due_at IS NOT NULL THEN 'from_items' END;
    END IF;

    -- Urgency, in calendar days in UTC; overdue in its place. None for a
    -- level 0 (stated, or read from its items) or a settled item. A due time
    -- read from an open item names it.
    urgency := 0;
    overdue := false;
    IF due_at IS NOT NULL AND NOT settled AND NOT v_zero THEN
      IF due_at <= p_now THEN
        overdue := true;
        urgency := w_overdue;
        v_terms := v_terms || (jsonb_build_object('term', 'overdue', 'value', urgency, 'due_at', due_at, 'due_from', due_from)
                               || CASE WHEN v_due_item IS NOT NULL THEN jsonb_build_object('item', v_due_item) ELSE '{}'::jsonb END);
      ELSIF due_at <= v_soon_by THEN
        urgency := w_soon;
        v_terms := v_terms || (jsonb_build_object('term', 'urgency', 'value', urgency, 'window', 'soon', 'due_at', due_at, 'due_from', due_from)
                               || CASE WHEN v_due_item IS NOT NULL THEN jsonb_build_object('item', v_due_item) ELSE '{}'::jsonb END);
      ELSIF due_at <= v_week_by THEN
        urgency := w_week;
        v_terms := v_terms || (jsonb_build_object('term', 'urgency', 'value', urgency, 'window', 'week', 'due_at', due_at, 'due_from', due_from)
                               || CASE WHEN v_due_item IS NOT NULL THEN jsonb_build_object('item', v_due_item) ELSE '{}'::jsonb END);
      END IF;
    END IF;

    -- Unblocks: none for a settled item.
    unblocks := CASE WHEN settled THEN 0 ELSE ob1_item_unblocks(s_kind, s_key, w_depth, w_cap) END;
    v_term := CASE WHEN unblocks >= w_many_at THEN w_many WHEN unblocks >= 1 THEN w_one ELSE 0 END;
    IF unblocks >= 1 THEN
      v_terms := v_terms || jsonb_build_object('term', 'unblocks', 'value', v_term, 'count', unblocks);
    END IF;

    not_before := v_win.not_before;
    waiting := not_before IS NOT NULL AND not_before > p_now;
    effective := v_base + urgency + v_term;
    terms := v_terms;
    RETURN NEXT;
  END LOOP;
END;
$$;
COMMENT ON FUNCTION effective_priority(jsonb, jsonb, timestamptz) IS
  'For a JSON array of {kind, key} (at most 1000; an item asked twice answered once, at its first place), one row per item in the order asked: effective — the level first: the counted level (116''s rule, tier 4 left out unless count_inferred), else, for a thought that is no ticket''s row, the highest level counted on its open items (from_items, no hop discount), else the level inherited from what it serves (less hop a hop, at most hops hops, only above unknown''s value), else unknown''s value; then, within that level, urgency from its due time — its own (stated, by due_ref, or an open item''s own), else such a thought''s open items'' soonest (from_items; an item at level 0 passes none) — in calendar days in UTC (soon 0.4 by the end of tomorrow, week 0.2 by the end of the seventh day, overdue 0.6 in their place once due; none at a level 0, stated or from its items, or once settled); plus the unblocks term (0.1, or 0.2 for unblocks_many_at or more open items it blocks through active blocks / blocked_by links, transitively to depth). By default the terms after the level add at most 0.8, so they order items of one level and never lift one past the next (SMD-4177). Only an item whose status is open gives a from_items term, and only its own counted level and due time. Each term is named in terms; winner is the counted assertion and passed_over every other open one; due_from says where the due time came from (stated, due_ref, item, from_items). p_weights overrides docs/priority.md''s weights by name (an unknown name or a value out of range raises 22023), the old full-level weights among them; p_now is the clock. Raises on a malformed item. Migration 122 / SMD-3667; from_items, migration 125 / SMD-4149; level first, migration 127 / SMD-4177.';
