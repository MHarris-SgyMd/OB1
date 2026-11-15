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
--       more, stated before the window (60 days), its due time and start not
--       still ahead (one is in force till then), on an item with no
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
--     Idempotent. Run by sleep (db/sleep.ts: at its first idle poll or
--     period, then at most once every six hours), or by hand.
--   * review_priority_finding(id, decision, level, due_at, clear, note,
--     actor): an operator key's (by its agent id, as 132's
--     set_priority_weights) decision on a pending finding. Accepting says
--     the outcome: a level (and a due time) the operator states on the item
--     through assert_priority, the same level re-confirming it (keeping the
--     operator's own statement's due time, start, due reference and, with
--     no note, reason), or clear,
--     which closes the operator's own statement there through
--     clear_priority. Either is the operator's own statement, in the history
--     under the operator's key. Rejecting changes nothing. Both suppress the
--     same finding for the window.
--
--   NOT CHANGED. No priority is changed by a finding; nothing is posted to
--   Linear (SMD-4304); the operations over REST and MCP, brain_info's count
--   and preflight's row are PR 2; the read's "stated N days ago,
--   unreviewed" label is PR 3. Sleep's review at an idle poll delays the
--   poll's stamp, and a one-shot run's exit, by the scan, at most its
--   minute (review pass 5, said). A hand-run re-embed (db/reembed.ts without
--   --follow) marks its writes not background, so they read as activity
--   (review pass 4, said: the marking is reembed.ts's). Clearing closes the operator's own statement
--   only: another maker's stale statement is outranked by the operator
--   stating a level (0 for none), as decision 4's tiers have it.
--
-- SAFETY
--   One new table with its indexes, three new functions, and the priority
--   group's grant on the table (SELECT, INSERT, UPDATE and DELETE: the scan
--   prunes moot findings past the window), carried to the roles holding the
--   group.
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
-- The activity read's: an item's decisions (review pass 5: both other
-- indexes lead with kind).
CREATE INDEX IF NOT EXISTS priority_findings_item
  ON priority_findings (item_kind, item_key, decided_at);
CREATE INDEX IF NOT EXISTS priority_findings_suppressed
  ON priority_findings (kind, item_kind, item_key, suppressed_until) WHERE suppressed_until IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ob1_priority_activity — when an item was last active
-- ---------------------------------------------------------------------------
-- The newest of: a statement on its pool made, or cleared; for a ticket, its head row written
-- or a thought standing on its subject captured; for a thought, its row
-- written; for an open item, its last change; for an entity, its last
-- sighting (a thought captured that mentions it); an operator's decision on a
-- finding about it. NULL when nothing is known. A row written is its newest audit
-- event not marked background (actor_context.background, SMD-2889): a
-- re-embed or another pass of the brain's own rewrites every row it
-- touches, and moves updated_at, without anyone doing anything (review pass
-- 2: read from updated_at, a model switch silenced every stale finding for
-- the window).
CREATE OR REPLACE FUNCTION ob1_priority_activity(p_kind text, p_key text)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_at timestamptz;
BEGIN
  SELECT max(a.asserted_at) INTO v_at FROM ob1_priority_open(p_kind, p_key) a;
  -- A statement on its pool cleared: a maker acting on it, with nothing left
  -- open from it (review pass 4). Not a replace: a maker's new statement
  -- counts as its own, and 136's delete-carry and 141's merge replace at the
  -- move, keeping the old times (review pass 5: a merge read as a review).
  v_at := GREATEST(v_at, (SELECT max(a.closed_at) FROM ob1_priority_pool_items(p_kind, p_key) i
                           JOIN priority_assertions a ON a.item_kind = i.item_kind AND a.item_key = i.item_key
                          WHERE a.close_reason = 'cleared'));
  -- An operator's decision on a finding about it: a re-confirmed level the
  -- writer answered unchanged (the same terms) wrote no statement, and is
  -- a review all the same (review pass 3).
  v_at := GREATEST(v_at, (SELECT max(f.decided_at) FROM priority_findings f WHERE f.item_kind = p_kind AND f.item_key = p_key));
  IF p_kind = 'ticket' THEN
    v_at := GREATEST(v_at,
      (SELECT max(au.created_at) FROM ob1_ticket_head h JOIN thought_audit au ON au.thought_id = h.head_id
        WHERE h.issue_key = md5(p_key)::uuid AND h.issue = p_key AND (au.actor_context->>'background') IS NULL),
      (SELECT max(t.created_at) FROM thought_facets f JOIN thoughts t ON t.id = f.thought_id
        WHERE f.kind = 'subject' AND f.valid_until IS NULL AND f.payload->>'key' = 'ticket:' || p_key));
  ELSIF p_kind = 'thought' AND p_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_at := GREATEST(v_at, (SELECT max(au.created_at) FROM thought_audit au
                             WHERE au.thought_id = p_key::uuid AND (au.actor_context->>'background') IS NULL));
  ELSIF p_kind = 'item' AND p_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_at := GREATEST(v_at, (SELECT i.changed_at FROM open_items i WHERE i.item_id = p_key::uuid));
  ELSIF p_kind = 'entity' AND p_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    -- A thought captured that mentions it, not last_seen_at, which a
    -- re-extraction moves (review pass 3).
    v_at := GREATEST(v_at, (SELECT max(t.created_at) FROM thought_entities m JOIN thoughts t ON t.id = m.thought_id
                             WHERE m.entity_id = p_key::uuid));
  END IF;
  RETURN v_at;
END;
$$;
COMMENT ON FUNCTION ob1_priority_activity(text, text) IS
  'When a normalised item (ob1_priority_subject) was last active, as the stale finding reads it: the newest of a statement on its pool, and for a ticket its head row written or a thought standing on its subject captured, for a thought its row written (a row written: its newest audit event not marked background), for an open item its last change, for an entity its last sighting. NULL when nothing is known. Migration 142 / SMD-3671.';

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
  v_batch   jsonb;
  v_act     timestamptz;
  v_stale   uuid[];
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
    -- The candidates, once (review pass 4: the rule was written twice). A
    -- statement whose due time or start is still ahead is in force, not
    -- stale (review pass 2).
    v_stale := ARRAY(SELECT a.id FROM _opr_pool a
                      WHERE NOT a.maker_source AND a.level >= 1 AND a.asserted_at < v_cut
                        AND (a.not_before IS NULL OR a.not_before <= p_now)
                        -- Its due time as the read resolves it, a due reference's included:
                        -- ahead, it is in force (review passes 2, 5 and 6; a reference
                        -- resolving to no due time is no deadline).
                        AND COALESCE((ob1_priority_due((SELECT p FROM priority_assertions p WHERE p.id = a.id), c.kind, c.key, true)).due_at, '-infinity') <= p_now
                      ORDER BY a.seq);
    IF cardinality(v_stale) > 0 THEN
      v_act := ob1_priority_activity(c.kind, c.key);
      IF COALESCE(v_act, '-infinity') < v_cut THEN
        INSERT INTO _opr_found
        SELECT 'stale', c.kind, c.key, v_stale,
               jsonb_build_object('last_activity', v_act, 'window_days', p_window_days,
                 'statements', jsonb_agg(jsonb_build_object('id', a.id, 'level', a.level, 'maker', a.maker_name, 'asserted_at', a.asserted_at) ORDER BY a.seq))
          FROM _opr_pool a WHERE a.id = ANY(v_stale);
      END IF;
    END IF;
    -- disagree: an operator's statement and a source's two or more levels apart.
    -- The operator's stance is tier 1's newest, as the read counts it, not an
    -- older operator key's (review pass 6); the source's its newest.
    INSERT INTO _opr_found
    SELECT 'disagree', c.kind, c.key, ARRAY[o.id, s.id],
           jsonb_build_object('operator', jsonb_build_object('id', o.id, 'level', o.level, 'maker', o.maker_name),
                              'source',   jsonb_build_object('id', s.id, 'level', s.level, 'maker', s.maker_name))
      FROM (SELECT * FROM _opr_pool WHERE tier = 1 ORDER BY seq DESC LIMIT 1) o,
           (SELECT * FROM _opr_pool WHERE tier = 2 AND maker_source ORDER BY seq DESC LIMIT 1) s
     WHERE abs(o.level - s.level) >= 2;
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
     WHERE e.overdue AND NOT e.settled
       -- A due time a thought takes from its open items is the item's own
       -- finding (review pass 3: one due time raised two).
       AND e.due_from IS DISTINCT FROM 'from_items';
  END LOOP;
  -- One taken through a due reference is the referenced item's, where that
  -- item has an overdue finding of its own; where it has none (settled, or
  -- at level 0), the referring item's stands (review passes 4 and 5).
  DELETE FROM _opr_found f
   WHERE f.kind = 'overdue' AND f.evidence->>'due_from' = 'due_ref'
     AND EXISTS (SELECT 1 FROM priority_assertions a, LATERAL ob1_priority_subject(a.due_ref_kind, a.due_ref_key) r, _opr_found g
                  WHERE a.id = ANY(f.ids) AND a.due_ref_key IS NOT NULL
                    AND g.kind = 'overdue' AND g.item_kind = r.kind AND g.item_key = r.key);

  -- Moot findings past the window go: a condition that flaps would add a row
  -- each cycle (the maintainer, review pass 6). Decided ones stay, the record
  -- of who decided what.
  DELETE FROM priority_findings p WHERE p.status = 'moot' AND p.moot_at < v_cut;

  -- Pending findings whose condition no longer holds: moot.
  UPDATE priority_findings p SET status = 'moot', moot_at = p_now
   WHERE p.status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM _opr_found f WHERE f.kind = p.kind AND f.item_kind = p.item_kind AND f.item_key = p.item_key);
  GET DIAGNOSTICS v_moot = ROW_COUNT;

  FOR c IN SELECT * FROM _opr_found ORDER BY kind, item_kind, item_key LOOP
    -- Rewritten only when its statements, evidence or window moved (review
    -- pass 2: every scan rewrote every pending row).
    IF EXISTS (SELECT 1 FROM priority_findings p
                WHERE p.status = 'pending' AND p.kind = c.kind AND p.item_kind = c.item_kind AND p.item_key = c.item_key) THEN
      UPDATE priority_findings p SET assertion_ids = c.ids, evidence = c.evidence, window_days = p_window_days, refreshed_at = p_now
       WHERE p.status = 'pending' AND p.kind = c.kind AND p.item_kind = c.item_kind AND p.item_key = c.item_key
         AND (p.assertion_ids, p.evidence, p.window_days) IS DISTINCT FROM (c.ids, c.evidence, p_window_days);
      v_fresh := v_fresh + 1;
      CONTINUE;
    END IF;
    -- Decided, and its statements those decided on (the decision's own
    -- statement among them): not raised again within the window, or for a
    -- settled finding at all (review pass 1). A statement new since (a moved
    -- deadline, the source's new level) raises it at once (the maintainer,
    -- review pass 6).
    IF EXISTS (SELECT 1 FROM priority_findings p
                WHERE p.kind = c.kind AND p.item_kind = c.item_kind AND p.item_key = c.item_key
                  AND p.suppressed_until IS NOT NULL AND c.ids <@ p.assertion_ids
                  AND (p.suppressed_until > p_now OR p.kind = 'settled')) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    INSERT INTO priority_findings (kind, item_kind, item_key, assertion_ids, evidence, window_days, found_at, refreshed_at)
    VALUES (c.kind, c.item_kind, c.item_key, c.ids, c.evidence, p_window_days, p_now, p_now);
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
  v_prev priority_assertions;
BEGIN
  SELECT * INTO v_who FROM ob1_priority_actor(p_actor, 'review_priority_finding');
  -- The operator's kind by its agent id alone, as 132's set_priority_weights.
  v_kind := CASE WHEN v_who.env_agent_id IS NULL THEN NULL ELSE ob1_registry_kind(v_who.env_agent_id, NULL) END;
  IF v_who.env_agent_id IS NULL OR v_kind IS DISTINCT FROM 'operator' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_OPERATOR', 'key', v_who.name, 'kind', v_kind,
      'message', format('only an operator key, named by its agent id, may decide a priority finding; %s is %s', v_who.name,
                        CASE WHEN v_who.env_agent_id IS NULL THEN 'named by its name alone' ELSE COALESCE(v_kind, 'unclassified') END));
  END IF;
  -- A decision is a write on any item: write scope alone (review passes 3
  -- and 5: a read-scoped key rejected, and a capture key, which the writers
  -- hold to its own items, could reject any finding).
  IF v_who.scope IS DISTINCT FROM 'write' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_WRITE_SCOPE', 'message', format('%s states no write scope; a decision is a write on any item', v_who.name));
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
     OR (p_due_at IS NOT NULL AND p_level IS NULL) OR p_level NOT BETWEEN 0 AND 5 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_OUTCOME',
      'message', 'a level (0 none to 5 critical), a due time and clear go with accepting, and a due time with a level');
  END IF;

  SELECT * INTO v_f FROM priority_findings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND', 'message', format('no priority finding %s', p_id));
  END IF;
  -- A settled item ranks for nothing: its finding is accepted by clearing or
  -- stating none, not by a level that would be the next settled finding
  -- (review pass 5).
  IF v_f.kind = 'settled' AND p_decision = 'accept' AND COALESCE(p_level, 0) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_OUTCOME', 'message', 'a settled item''s finding is accepted by clearing, or by stating 0 (none)');
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
      -- The operator's own open statement on the item, if any, keeps its
      -- terms: re-confirming a level keeps its due time (unless one is
      -- given), its start, its due reference and, with no note, its reason
      -- (review pass 2: they were dropped).
      -- Read from the pool (review pass 3: a finding is keyed by its pool, and
      -- the operator's statement may stand on a ticket's own row), and kept
      -- only when re-confirming its level: a new level is a new statement,
      -- its due time the one given (review pass 3).
      SELECT a.* INTO v_prev FROM ob1_priority_open(v_f.item_kind, v_f.item_key) a
       WHERE ob1_priority_is_maker(a, v_who.name, v_who.env_agent_id)
       ORDER BY a.seq DESC LIMIT 1;
      IF v_prev.level IS DISTINCT FROM p_level THEN
        v_prev := NULL;
      END IF;
      -- An overdue finding's deadline is what was reviewed: its due reference
      -- is not carried either (review pass 6: a passed reference kept it
      -- overdue).
      IF v_f.kind = 'overdue' THEN
        v_prev.due_ref_kind := NULL;
        v_prev.due_ref_key := NULL;
      END IF;
      -- A due time given replaces the kept due reference, and a kept start
      -- after it (review pass 4: assert_priority refused the pair, raising).
      IF p_due_at IS NOT NULL THEN
        v_prev.due_ref_kind := NULL;
        v_prev.due_ref_key := NULL;
        IF v_prev.not_before > p_due_at THEN
          v_prev.not_before := NULL;
        END IF;
      END IF;
      -- The reason within assert_priority's 1000 characters (115's
      -- ob1_work_claim_text): the note is kept whole on the finding (review
      -- pass 1: a longer one raised).
      -- A passed due time is not carried (review pass 5: re-confirming an
      -- overdue item kept it overdue, the writer answering unchanged).
      v_out := assert_priority(v_f.item_kind, v_f.item_key, p_level,
                               COALESCE(p_due_at, CASE WHEN v_prev.due_at > clock_timestamp() THEN v_prev.due_at END), v_prev.not_before,
                               v_prev.due_ref_kind, v_prev.due_ref_key,
                               CASE WHEN p_note IS NULL AND v_prev.reason IS NOT NULL THEN v_prev.reason
                                    ELSE left(format('review of a %s finding%s', v_f.kind, COALESCE(': ' || p_note, '')), 1000) END,
                               false, p_actor);
    END IF;
    -- A writer's refusal (a read-only key, an item gone, an item not the
    -- key's) answers as a value, not a raise: nothing was written, so nothing
    -- is decided (review pass 1: the finding read accepted).
    IF v_out->>'outcome' = 'refused' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'WRITER_REFUSED', 'answer', v_out,
        'message', format('the writer refused the outcome (%s); the finding stays pending', COALESCE(v_out->>'code', v_out->>'error', 'refused')));
    END IF;
  END IF;

  v_now := clock_timestamp();
  UPDATE priority_findings
     SET status = CASE p_decision WHEN 'accept' THEN 'accepted' ELSE 'rejected' END,
         decided_at = v_now, decided_by = v_who.name, decided_by_agent_id = v_who.env_agent_id,
         decision_note = p_note, outcome = v_out,
         -- The statement the decision wrote, so a re-scan finding it holds the
         -- suppression (a level kept that still disagrees), and a later one
         -- does not (review pass 6). Not an overdue finding's: the deadline it
         -- wrote, once passed, is a new one to raise.
         assertion_ids = assertion_ids || CASE WHEN v_out->'assertion'->>'id' IS NOT NULL AND v_f.kind <> 'overdue'
                                               AND v_out->>'outcome' = 'asserted' THEN ARRAY[(v_out->'assertion'->>'id')::uuid] ELSE '{}'::uuid[] END,
         suppressed_until = v_now + make_interval(days => v_f.window_days)
   WHERE id = p_id
   RETURNING * INTO v_f;
  RETURN jsonb_build_object('ok', true, 'id', v_f.id, 'kind', v_f.kind, 'item', jsonb_build_object('kind', v_f.item_kind, 'key', v_f.item_key),
    'status', v_f.status, 'answer', v_out, 'suppressed_until', v_f.suppressed_until);
END;
$$;
COMMENT ON FUNCTION review_priority_finding(uuid, text, int, timestamptz, boolean, text, jsonb) IS
  'An operator key''s decision on a pending priority finding (SMD-3671): only a key the registry classifies operator, named by its agent id in p_actor (NOT_OPERATOR otherwise). accept says the outcome: p_level (with p_due_at, optionally) stated on the item through assert_priority — the same level re-confirms it, keeping the operator''s own statement''s due time, start, due reference and, with no note, reason — or p_clear, closing the operator''s own statement there through clear_priority (NOTHING_TO_CLEAR when it holds none: state 0 to outrank another maker''s); reject changes nothing. Both record who decided, the note and the writer''s answer, and suppress the same kind and item for the finding''s window. Refused: NOT_WRITE_SCOPE, BAD_DECISION, BAD_NOTE, ACCEPT_NEEDS_OUTCOME, BAD_OUTCOME (a level outside 0 to 5 included), NOT_FOUND, NOT_PENDING, and WRITER_REFUSED when the writer refused the outcome (its answer carried); a writer''s raise decides nothing either. Migration 142 / SMD-3671.';

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
                   CASE v_item.privilege_type WHEN 'SELECT' THEN 'SELECT' ELSE 'INSERT, UPDATE, DELETE' END,
                   CASE WHEN v_item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_item.grantee)) END);
  END LOOP;
END
$grant$;
