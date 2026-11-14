-- =============================================================================
-- Migration 142: priority findings — a scan proposes a review of stale,
--                overdue, disagreeing and settled priority statements, and an
--                operator accepts or rejects each; nothing changes until then
--                (SMD-3671 PR 1)
-- =============================================================================
--
-- WHY
--   A priority stated once stood for ever. A level an agent stated in March
--   and nobody touched since kept ranking at full weight; a due time passed
--   with the item still open; the operator's level and Linear's could sit
--   two levels apart; an item could settle with a statement still open on
--   it. docs/priority.md decision 6: the brain never sets a priority by
--   itself, and sleep (this ticket) proposes findings; accepting one makes
--   the operator's own statement. Decision 9: sleep reports the operator and
--   Linear disagreeing, and never writes back to Linear.
--
-- WHAT (the maintainer's choices, 2026-11-14)
--   * priority_findings: one row per finding — its kind, its item keyed by
--     its pool (ob1_priority_subject: a ticket and its own rows are one
--     item), the statements it is about, its evidence, and its status:
--     pending, accepted, rejected or moot. At most one pending finding per
--     kind and item.
--   * THE FOUR KINDS:
--     - stale: an open statement made by the brain's own keys (an operator,
--       agent or inferred one; not a source's, whose level is its source's
--       to keep: board-sync's mirror of Linear, decision 9) at level 1 or
--       more, stated before the window (60 days), on an item with no
--       activity within it. Activity: a statement on its pool made within
--       the window; for a ticket, its head row written (board-sync rewrites
--       it on any Linear change) or a thought standing on its subject
--       (`ticket:<key>`) captured; for a thought, its row written; for an
--       open item, its last change; for an entity, its last sighting.
--     - overdue: an unsettled item effective_priority reads as overdue, from
--       any maker's due time.
--     - disagree: an operator's (tier 1) open statement and a source's
--       (tier 2) two or more levels apart, on an unsettled item.
--     - settled: an open statement made by the brain's own keys, at level 1
--       or more, on an item that has settled (a Done ticket, a done or
--       dropped open item, a settled thought). It no longer ranks: the
--       finding is housekeeping. A settled item yields this and not stale.
--     (The ticket's fourth kind, a level inherited from a closed item, does
--     not arise: effective_priority skips a settled source when it inherits.)
--   * ob1_priority_review(window_days, now): the scan. Under one advisory
--     lock it reads the items holding an open statement by the brain's own
--     keys or with a due time, writes a pending finding for each condition
--     newly found, refreshes a pending one's evidence, and marks moot a
--     pending one whose condition no longer holds. A finding decided within
--     the window (accepted or rejected: its suppressed_until) is not raised
--     again for that kind and item until the window passes, so a re-confirmed
--     level that still disagrees is not proposed again the next night. A
--     settled finding decided is not raised again while its statements are
--     those it was decided on (review pass 1: an agent's statement left on a
--     Done item stays open, since the operator can close only its own, and
--     came back every window). Each maker's newest statement in a pool is
--     its stance (ob1_priority_counted's rule): an older one a maker left on
--     a ticket's row is not read (review pass 1).
--     Idempotent. Run by sleep (db/sleep.ts), or by hand.
--   * review_priority_finding(id, decision, level, due_at, clear, note,
--     actor): an operator key's (by its agent id, as 132's
--     set_priority_weights) decision on a pending finding. Accepting says
--     the outcome: a level (and a due time) the operator states on the item
--     through assert_priority, the same level re-confirming it, or clear,
--     which closes the operator's own statement there through
--     clear_priority. Either is the operator's own statement, in the history
--     under the operator's key. Rejecting changes nothing. Both suppress the
--     same finding for the window.
--
--   NOT CHANGED. No priority is changed by a finding; nothing is posted to
--   Linear (SMD-4304); the operations over REST and MCP, brain_info's count
--   and preflight's row are PR 2; the read's "stated N days ago,
--   unreviewed" label is PR 3. Clearing closes the operator's own statement
--   only: another maker's stale statement is outranked by the operator
--   stating a level (0 for none), as decision 4's tiers have it.
--
-- SAFETY
--   One new table with its indexes, three new functions, and the priority
--   group's grant on the table, carried to the roles holding the group.
--   MINOR under FORK.md's version rules. test-schema [128],
--   test-upgrade [20cf].
--
-- Prerequisites
--   046 (ob1_registry_kind), 068 (ob1_ticket_head), 116
--   (priority_assertions, ob1_priority_actor), 117 (open_items), 122
--   (ob1_priority_subject, ob1_item_settled, effective_priority) and 133
--   (assert_priority, clear_priority; 138's bodies). Applied by `bun db/migrate.ts`.
--   Re-applied: the table and indexes stand, the functions are replaced as
--   they were.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
DECLARE
  v_need text[][] := ARRAY[
    ARRAY['ob1_priority_actor(jsonb, text)', '116 (ob1_priority_actor)'],
    ARRAY['ob1_registry_kind(uuid, text)', '046 (ob1_registry_kind)'],
    ARRAY['ob1_priority_subject(text, text)', '122 (ob1_priority_subject)'],
    ARRAY['ob1_item_settled(text, text)', '122 (ob1_item_settled)'],
    ARRAY['effective_priority(jsonb, jsonb, timestamp with time zone)', '122 (effective_priority)'],
    ARRAY['assert_priority(text, text, integer, timestamp with time zone, timestamp with time zone, text, text, text, boolean, jsonb)', '133 (assert_priority)'],
    ARRAY['clear_priority(text, text, jsonb)', '133 (clear_priority)']];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_need, 1) LOOP
    IF to_regprocedure(v_need[i][1]) IS NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = format('migration 142 needs %s; this schema lacks it', v_need[i][2]),
        -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
        HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
        ERRCODE = 'invalid_schema_definition';
    END IF;
  END LOOP;
  IF to_regclass('priority_assertions') IS NULL OR to_regclass('open_items') IS NULL OR to_regclass('ob1_ticket_head') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 142 needs 068, 116 and 117 (ob1_ticket_head, priority_assertions, open_items); this schema lacks one',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- priority_findings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS priority_findings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('stale', 'overdue', 'disagree', 'settled')),
  item_kind        text NOT NULL,
  item_key         text NOT NULL,
  assertion_ids    uuid[] NOT NULL DEFAULT '{}',
  evidence         jsonb NOT NULL DEFAULT '{}'::jsonb,
  window_days      int NOT NULL CHECK (window_days BETWEEN 1 AND 3660),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'moot')),
  found_at         timestamptz NOT NULL DEFAULT now(),
  refreshed_at     timestamptz NOT NULL DEFAULT now(),
  moot_at          timestamptz,
  decided_at       timestamptz,
  decided_by       text,
  decided_by_agent_id uuid,
  decision_note    text,
  outcome          jsonb,
  suppressed_until timestamptz,
  CHECK ((status = 'moot') = (moot_at IS NOT NULL)),
  CHECK ((status IN ('accepted', 'rejected')) = (decided_at IS NOT NULL AND decided_by_agent_id IS NOT NULL AND suppressed_until IS NOT NULL)),
  CHECK (decision_note IS NULL OR length(decision_note) <= 2000)
);
COMMENT ON TABLE priority_findings IS
  'A review the brain proposes of a priority statement (docs/priority.md decision 6): stale (a statement by the brain''s own keys older than its window on an item with no activity within it), overdue (an unsettled item past its due time), disagree (an operator''s and a source''s statements two or more levels apart), settled (a statement by the brain''s own keys left on a settled item). Written by ob1_priority_review(), decided by an operator key through review_priority_finding(); a finding changes no priority. At most one pending per kind and item (keyed by its pool, ob1_priority_subject). Migration 142 / SMD-3671.';

CREATE UNIQUE INDEX IF NOT EXISTS priority_findings_one_pending
  ON priority_findings (kind, item_kind, item_key) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS priority_findings_suppressed
  ON priority_findings (kind, item_kind, item_key, suppressed_until) WHERE suppressed_until IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ob1_priority_activity — when an item was last active
-- ---------------------------------------------------------------------------
-- The newest of: a statement on its pool; for a ticket, its head row written
-- or a thought standing on its subject captured; for a thought, its row
-- written; for an open item, its last change; for an entity, its last
-- sighting. NULL when nothing is known.
CREATE OR REPLACE FUNCTION ob1_priority_activity(p_kind text, p_key text)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_at timestamptz;
BEGIN
  SELECT max(a.asserted_at) INTO v_at FROM ob1_priority_open(p_kind, p_key) a;
  IF p_kind = 'ticket' THEN
    v_at := GREATEST(v_at,
      (SELECT t.updated_at FROM ob1_ticket_head h JOIN thoughts t ON t.id = h.head_id
        WHERE h.issue_key = md5(p_key)::uuid AND h.issue = p_key),
      (SELECT max(t.created_at) FROM thought_facets f JOIN thoughts t ON t.id = f.thought_id
        WHERE f.kind = 'subject' AND f.valid_until IS NULL AND f.payload->>'key' = 'ticket:' || p_key));
  ELSIF p_kind = 'thought' AND p_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_at := GREATEST(v_at, (SELECT t.updated_at FROM thoughts t WHERE t.id = p_key::uuid));
  ELSIF p_kind = 'item' AND p_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_at := GREATEST(v_at, (SELECT i.changed_at FROM open_items i WHERE i.item_id = p_key::uuid));
  ELSIF p_kind = 'entity' AND p_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_at := GREATEST(v_at, (SELECT e.last_seen_at FROM ob1_entities e WHERE e.id = p_key::uuid));
  END IF;
  RETURN v_at;
END;
$$;
COMMENT ON FUNCTION ob1_priority_activity(text, text) IS
  'When a normalised item (ob1_priority_subject) was last active, as the stale finding reads it: the newest of a statement on its pool, and for a ticket its head row written or a thought standing on its subject captured, for a thought its row written, for an open item its last change, for an entity its last sighting. NULL when nothing is known. Migration 142 / SMD-3671.';

-- ---------------------------------------------------------------------------
-- ob1_priority_review — the scan
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_priority_review(p_window_days int DEFAULT 60, p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_cut     timestamptz;
  v_found   int := 0;
  v_fresh   int := 0;
  v_moot    int := 0;
  v_skipped int := 0;
  c         record;
  v_id      uuid;
  v_batch   jsonb;
  v_act     timestamptz;
BEGIN
  IF p_window_days IS NULL OR p_window_days < 1 OR p_window_days > 3660 THEN
    RAISE EXCEPTION USING MESSAGE = format('ob1_priority_review: the window must be 1 to 3660 days, not %s', p_window_days), ERRCODE = '22023';
  END IF;
  IF p_now IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'ob1_priority_review: now must be a time', ERRCODE = '22023';
  END IF;
  -- One scan at a time: two would race on the pending rows.
  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:priority-review', 0));
  v_cut := p_now - make_interval(days => p_window_days);

  CREATE TEMP TABLE IF NOT EXISTS _opr_found (kind text, item_kind text, item_key text, ids uuid[], evidence jsonb) ON COMMIT DROP;
  DELETE FROM _opr_found WHERE true;

  -- The items to read: each pool holding an open statement by the brain's
  -- own keys, or one with a due time or a due reference (overdue's).
  CREATE TEMP TABLE IF NOT EXISTS _opr_items (kind text, key text) ON COMMIT DROP;
  DELETE FROM _opr_items WHERE true;
  INSERT INTO _opr_items
  SELECT DISTINCT s.kind, s.key
    FROM priority_assertions a,
         LATERAL ob1_priority_subject(a.item_kind, a.item_key) s
   WHERE a.closed_at IS NULL
     AND (NOT a.maker_source OR a.due_at IS NOT NULL OR a.due_ref_key IS NOT NULL OR a.tier = 1)
  -- An open item past its own due time (117's), stated on or not.
  UNION
  SELECT 'item', i.item_id::text FROM open_items i
   WHERE i.status = 'open' AND i.due_at IS NOT NULL AND i.due_at < p_now;

  -- Each pool read once (review pass 1): each maker's newest open statement
  -- alone, its stance, as ob1_priority_counted reads it.
  CREATE TEMP TABLE IF NOT EXISTS _opr_pool (LIKE priority_assertions) ON COMMIT DROP;
  FOR c IN SELECT i.kind, i.key, ob1_item_settled(i.kind, i.key) AS settled FROM _opr_items i ORDER BY i.kind, i.key LOOP
    DELETE FROM _opr_pool WHERE true;
    INSERT INTO _opr_pool
    SELECT DISTINCT ON (p.maker_key) p.* FROM ob1_priority_open(c.kind, c.key) p ORDER BY p.maker_key, p.seq DESC;
    -- settled: the brain's own keys' statements left on a settled item.
    IF c.settled THEN
      INSERT INTO _opr_found
      SELECT 'settled', c.kind, c.key, array_agg(a.id ORDER BY a.seq),
             jsonb_build_object('statements', jsonb_agg(jsonb_build_object('id', a.id, 'level', a.level, 'maker', a.maker_name, 'asserted_at', a.asserted_at) ORDER BY a.seq))
        FROM _opr_pool a
       WHERE NOT a.maker_source AND a.level >= 1
      HAVING count(*) > 0;
      CONTINUE;
    END IF;
    -- stale: the brain's own keys' statements from before the window, on an
    -- item with no activity within it (its activity read once, and only for
    -- an item with such a statement).
    IF EXISTS (SELECT 1 FROM _opr_pool a WHERE NOT a.maker_source AND a.level >= 1 AND a.asserted_at < v_cut) THEN
      v_act := ob1_priority_activity(c.kind, c.key);
      IF COALESCE(v_act, '-infinity') < v_cut THEN
        INSERT INTO _opr_found
        SELECT 'stale', c.kind, c.key, array_agg(a.id ORDER BY a.seq),
               jsonb_build_object('last_activity', v_act, 'window_days', p_window_days,
                 'statements', jsonb_agg(jsonb_build_object('id', a.id, 'level', a.level, 'maker', a.maker_name, 'asserted_at', a.asserted_at) ORDER BY a.seq))
          FROM _opr_pool a
         WHERE NOT a.maker_source AND a.level >= 1 AND a.asserted_at < v_cut;
      END IF;
    END IF;
    -- disagree: an operator's statement and a source's two or more levels apart.
    INSERT INTO _opr_found
    SELECT 'disagree', c.kind, c.key, ARRAY[o.id, s.id],
           jsonb_build_object('operator', jsonb_build_object('id', o.id, 'level', o.level, 'maker', o.maker_name),
                              'source',   jsonb_build_object('id', s.id, 'level', s.level, 'maker', s.maker_name))
      FROM _opr_pool o, _opr_pool s
     WHERE o.tier = 1 AND s.tier = 2 AND s.maker_source AND abs(o.level - s.level) >= 2
     ORDER BY o.seq DESC, s.seq DESC
     LIMIT 1;
  END LOOP;

  -- overdue: an unsettled item effective_priority reads as past its due time,
  -- read 1000 items a call (its limit).
  FOR v_batch IN
    SELECT jsonb_agg(jsonb_build_object('kind', b.kind, 'key', b.key) ORDER BY b.kind, b.key)
      FROM (SELECT i.kind, i.key, (row_number() OVER (ORDER BY i.kind, i.key) - 1) / 1000 AS n FROM _opr_items i) b
     GROUP BY b.n
  LOOP
    INSERT INTO _opr_found
    SELECT 'overdue', e.item_kind, e.item_key,
           CASE WHEN e.winner ? 'id' THEN ARRAY[(e.winner->>'id')::uuid] ELSE '{}'::uuid[] END,
           jsonb_build_object('due_at', e.due_at, 'due_from', e.due_from, 'level', e.level)
      FROM effective_priority(v_batch, NULL, p_now) e
     WHERE e.overdue AND NOT e.settled;
  END LOOP;

  -- Pending findings whose condition no longer holds: moot.
  UPDATE priority_findings p SET status = 'moot', moot_at = p_now
   WHERE p.status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM _opr_found f WHERE f.kind = p.kind AND f.item_kind = p.item_kind AND f.item_key = p.item_key);
  GET DIAGNOSTICS v_moot = ROW_COUNT;

  FOR c IN SELECT * FROM _opr_found ORDER BY kind, item_kind, item_key LOOP
    UPDATE priority_findings p SET assertion_ids = c.ids, evidence = c.evidence, refreshed_at = p_now
     WHERE p.status = 'pending' AND p.kind = c.kind AND p.item_kind = c.item_kind AND p.item_key = c.item_key;
    IF FOUND THEN
      v_fresh := v_fresh + 1;
      CONTINUE;
    END IF;
    -- Decided within its window: not raised again until the window passes. A
    -- settled finding decided: not again while its statements are those it
    -- was decided on (review pass 1).
    IF EXISTS (SELECT 1 FROM priority_findings p
                WHERE p.kind = c.kind AND p.item_kind = c.item_kind AND p.item_key = c.item_key
                  AND p.suppressed_until IS NOT NULL
                  AND (p.suppressed_until > p_now OR (p.kind = 'settled' AND c.ids <@ p.assertion_ids))) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    INSERT INTO priority_findings (kind, item_kind, item_key, assertion_ids, evidence, window_days, found_at, refreshed_at)
    VALUES (c.kind, c.item_kind, c.item_key, c.ids, c.evidence, p_window_days, p_now, p_now)
    RETURNING id INTO v_id;
    v_found := v_found + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'found', v_found, 'refreshed', v_fresh, 'moot', v_moot, 'suppressed', v_skipped,
    'pending', (SELECT count(*)::int FROM priority_findings WHERE status = 'pending'), 'window_days', p_window_days, 'at', p_now);
END;
$$;
COMMENT ON FUNCTION ob1_priority_review(int, timestamptz) IS
  'The priority review''s scan (SMD-3671): under one advisory lock, reads every pool holding an open statement by the brain''s own keys, an operator''s, or one with a due time, and finds stale, overdue, disagree and settled conditions (priority_findings'' comment says each); writes a pending finding for each newly found, refreshes a pending one''s statements and evidence, marks moot a pending one whose condition no longer holds, and raises none a decision suppressed within its window (a settled one, none while its statements are those decided on). Each maker''s newest open statement in a pool is its stance. Returns {ok, found, refreshed, moot, suppressed, pending, window_days, at}. Idempotent; changes no priority. Run by sleep, or by hand. Migration 142 / SMD-3671.';

-- ---------------------------------------------------------------------------
-- review_priority_finding — an operator's decision
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION review_priority_finding(
  p_id       uuid,
  p_decision text,
  p_level    int         DEFAULT NULL,
  p_due_at   timestamptz DEFAULT NULL,
  p_clear    boolean     DEFAULT false,
  p_note     text        DEFAULT NULL,
  p_actor    jsonb       DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_who  record;
  v_kind text;
  v_f    priority_findings;
  v_out  jsonb;
  v_now  timestamptz;
BEGIN
  SELECT * INTO v_who FROM ob1_priority_actor(p_actor, 'review_priority_finding');
  -- The operator's kind by its agent id alone, as 132's set_priority_weights.
  v_kind := CASE WHEN v_who.env_agent_id IS NULL THEN NULL ELSE ob1_registry_kind(v_who.env_agent_id, NULL) END;
  IF v_who.env_agent_id IS NULL OR v_kind IS DISTINCT FROM 'operator' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_OPERATOR', 'key', v_who.name, 'kind', v_kind,
      'message', format('only an operator key, named by its agent id, may decide a priority finding; %s is %s', v_who.name,
                        CASE WHEN v_who.env_agent_id IS NULL THEN 'named by its name alone' ELSE COALESCE(v_kind, 'unclassified') END));
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('accept', 'reject') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_DECISION', 'message', format('the decision is accept or reject, not %s', COALESCE(p_decision, 'none')));
  END IF;
  IF p_note IS NOT NULL AND length(p_note) > 2000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_NOTE', 'message', 'a note is at most 2000 characters');
  END IF;
  IF p_decision = 'accept' AND (p_level IS NULL) = NOT COALESCE(p_clear, false) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ACCEPT_NEEDS_OUTCOME',
      'message', 'accepting says what to do: a level to state (the same one re-confirms it), or clear, not both');
  END IF;
  IF (p_decision = 'reject' AND (p_level IS NOT NULL OR p_due_at IS NOT NULL OR COALESCE(p_clear, false)))
     OR (p_due_at IS NOT NULL AND p_level IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_OUTCOME',
      'message', 'a level, a due time and clear go with accepting, and a due time with a level');
  END IF;

  SELECT * INTO v_f FROM priority_findings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND', 'message', format('no priority finding %s', p_id));
  END IF;
  IF v_f.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING', 'status', v_f.status,
      'message', format('finding %s is %s, not pending', p_id, v_f.status));
  END IF;

  IF p_decision = 'accept' THEN
    -- The operator's own statement, through the writers: they lock, check and
    -- refuse as for any call, and the history shows the operator's key.
    IF COALESCE(p_clear, false) THEN
      v_out := clear_priority(v_f.item_kind, v_f.item_key, p_actor);
      IF v_out->>'outcome' = 'nothing_to_clear' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOTHING_TO_CLEAR', 'answer', v_out,
          'message', 'the operator holds no statement here to clear; state a level instead (0 for none) to outrank another maker''s');
      END IF;
    ELSE
      -- The reason within assert_priority's 1000 characters (115's
      -- ob1_work_claim_text): the note is kept whole on the finding (review
      -- pass 1: a longer one raised).
      v_out := assert_priority(v_f.item_kind, v_f.item_key, p_level, p_due_at, NULL, NULL, NULL,
                               left(format('review of a %s finding%s', v_f.kind, COALESCE(': ' || p_note, '')), 1000), false, p_actor);
    END IF;
    -- A writer's refusal (a read-only key, an item gone, an item not the
    -- key's) answers as a value, not a raise: nothing was written, so nothing
    -- is decided (review pass 1: the finding read accepted).
    IF v_out->>'outcome' = 'refused' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'WRITER_REFUSED', 'answer', v_out,
        'message', format('the writer refused the outcome (%s); the finding stays pending', COALESCE(v_out->>'error', v_out->>'reason', 'refused')));
    END IF;
  END IF;

  v_now := clock_timestamp();
  UPDATE priority_findings
     SET status = CASE p_decision WHEN 'accept' THEN 'accepted' ELSE 'rejected' END,
         decided_at = v_now, decided_by = v_who.name, decided_by_agent_id = v_who.env_agent_id,
         decision_note = p_note, outcome = v_out,
         suppressed_until = v_now + make_interval(days => v_f.window_days)
   WHERE id = p_id
   RETURNING * INTO v_f;
  RETURN jsonb_build_object('ok', true, 'id', v_f.id, 'kind', v_f.kind, 'item', jsonb_build_object('kind', v_f.item_kind, 'key', v_f.item_key),
    'status', v_f.status, 'answer', v_out, 'suppressed_until', v_f.suppressed_until);
END;
$$;
COMMENT ON FUNCTION review_priority_finding(uuid, text, int, timestamptz, boolean, text, jsonb) IS
  'An operator key''s decision on a pending priority finding (SMD-3671): only a key the registry classifies operator, named by its agent id in p_actor (NOT_OPERATOR otherwise). accept says the outcome: p_level (with p_due_at, optionally) stated on the item through assert_priority — the same level re-confirms it — or p_clear, closing the operator''s own statement there through clear_priority (NOTHING_TO_CLEAR when it holds none: state 0 to outrank another maker''s); reject changes nothing. Both record who decided, the note and the writer''s answer, and suppress the same kind and item for the finding''s window. Refused: BAD_DECISION, BAD_NOTE, ACCEPT_NEEDS_OUTCOME, BAD_OUTCOME, NOT_FOUND, NOT_PENDING, and WRITER_REFUSED when the writer refused the outcome (its answer carried); a writer''s raise decides nothing either. Migration 142 / SMD-3671.';

-- ---------------------------------------------------------------------------
-- The priority group's grant, carried
-- ---------------------------------------------------------------------------
-- The roles holding the group already (SELECT, or INSERT, on
-- priority_assertions) gain the findings table as 132 carried its own: the
-- scan and the review are the group's. The owner holds every privilege
-- already; a re-apply grants what is held, which changes nothing.
DO $grant$
DECLARE
  v_item record;
BEGIN
  FOR v_item IN
    SELECT DISTINCT a.grantee, a.privilege_type
      FROM pg_class c, aclexplode(c.relacl) AS a
     WHERE c.oid = 'priority_assertions'::regclass AND a.grantee <> c.relowner AND a.privilege_type IN ('SELECT', 'INSERT')
  LOOP
    EXECUTE format('GRANT %s ON priority_findings TO %s',
                   CASE v_item.privilege_type WHEN 'SELECT' THEN 'SELECT' ELSE 'INSERT, UPDATE' END,
                   CASE WHEN v_item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_item.grantee)) END);
  END LOOP;
END
$grant$;
