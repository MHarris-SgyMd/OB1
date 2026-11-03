-- =============================================================================
-- Migration 117: open items — a to-do, a commitment or a plugin's task gets an
--                id, a status and a history, the maker stamped from the key,
--                and a close a judge proposes waits for another key to accept
--                (SMD-3665 PR 1)
-- =============================================================================
--
-- WHY
--   Outside Linear the brain's open work is `metadata.action_items`, a list of
--   strings the extractor writes on capture: no id, no owner, no due time, no
--   status. Nothing closes one, so a to-do captured in March reads as open as
--   one captured today, and nothing can carry a priority, because there is no
--   item to name. docs/priority.md decision 1 made the open item the fourth
--   kind of item (`item`), which 116 refused until this table existed. This is
--   the store. The operations over REST and MCP are SMD-3665's PR 2, the
--   sources (the extractor, the backfill, the plugins) its PR 3, and a judge's
--   proposed closes its PR 4, after SMD-3340. node_state's open-item kind is
--   SMD-3667's (docs/priority.md, "What this reverses or amends").
--
-- WHAT
--   1. AN OPEN ITEM is one row of open_items, the projection, made of the
--      events in open_item_events:
--      * its id; its text (at most 1000 characters, cleaned as 115 cleans a
--        label); an optional owner (free text, at most 200: who is to do it,
--        not a key); an optional due time;
--      * its STATUS: proposed, open, done or dropped. `proposed` is a start
--        state alone: an item the extractor read from a thought starts there
--        (the maintainer, 2026-11-03), and reads as not yet open until a key
--        confirms it (open) or dismisses it (dropped);
--      * where it came from, fixed at the open: the thought it was read from
--        (origin_thought_id), and the plugin row it stands for (plugin,
--        plugin_row) — decision 8: a plugin keeps its own table, and its row
--        enters the brain as the open item that names it;
--      * noted_at, when it was first said: its thought's capture time when it
--        came from a thought, so an item backfilled from an old thought reads
--        as old (the ticket's Work item 4), else the open's own time;
--      * who opened it (name, agent id, trust, scope) and when.
--
--   2. AN EVENT is one row of open_item_events: opened, updated or status.
--      Each carries the item's whole state after it (status, text, owner, due
--      time), so the projection is the last event's state beside the opening
--      event's fixed fields, and a reader needs no fold. Each names its maker,
--      stamped from the call's actor envelope as 116 stamps a priority's (the
--      key's name, agent id, the registry's kind and its trust ceiling, the
--      envelope's scope: ob1_item_actor, 116's ob1_priority_actor without the
--      priority source it reads), and a reason. A status event
--      that accepted a proposal names it. Events never change: a trigger
--      refuses every UPDATE, DELETE and TRUNCATE, for the owner too (046's
--      rule for thought_audit).
--
--   3. A PROPOSED CLOSE is one row of open_item_close_proposals: an item, the
--      status it would close to (done or dropped), the thought that shows it
--      (evidence_thought_id: the later "called the dentist, booked for
--      Tuesday"), a label (SMD-3116's settling labels, resolves or implements,
--      as data), a reason, and its proposer. It never closes the item by
--      itself: a key other than its proposer accepts it, which closes the
--      item with an event naming the proposal, or rejects it. A proposal
--      still pending when its item settles another way is `moot`. A row
--      changes only to be decided, once: a trigger refuses any other UPDATE,
--      every DELETE and TRUNCATE. SMD-3665's PR 4 is its producer (the
--      consolidation pass, once SMD-3340 records the labels); any key that
--      may close an item may propose a close today.
--
--   4. WHO MAY WRITE, failing closed as 116:
--      * the envelope must state its scope: `write` for any item, `capture`
--        for a capture-only key; any other scope, a read key's or none at
--        all, is refused (READ_ONLY_KEY);
--      * a capture-only key may open an item, from a thought only if its agent
--        captured the thought and nobody has taken it (116's
--        ob1_priority_owns, by the envelope's own agent id), and change only
--        an item it opened under its envelope's agent id that no other key
--        has written an event on since (082's "taken", for items) —
--        ob1_item_owns. Asked before any existence answer, and refused alike
--        for an item that is not there (ITEM_NOT_YOURS);
--      * a plugin row is the plugin's: the plugin is read from the envelope
--        (`plugin`, which the server's ctx.call stamps, SMD-3665 PR 2), never
--        from an argument, so no caller names a plugin's row by hand.
--      The refusals are outcomes; a malformed argument, an envelope naming
--      nobody and a transaction above READ COMMITTED raise.
--
--   5. THE SAME ITEM AGAIN. An open naming a thought and text an item was
--      already opened with (origin_key: the thought and the text lower-cased),
--      or a plugin row an item already stands for, is answered `unchanged`
--      with the item that is there, and writes nothing: the extractor's pass,
--      the backfill re-run and a plugin's re-sync add no items. A capture key
--      is shown such an item only if it is its own. Every write that changes
--      nothing is `unchanged`.
--
--   6. THE FUNCTIONS (SECURITY INVOKER, PUBLIC's EXECUTE as every core
--      function), each jsonb {outcome, code, message, …}:
--      * open_item(p_text, p_owner, p_due_at, p_origin_thought, p_plugin_row,
--        p_proposed, p_actor): {outcome: opened | unchanged | refused, item,
--        event}.
--      * update_item(p_item, p_changes, p_actor): text, owner and due_at from
--        a JSON object, a JSON null clearing owner or due_at: {outcome:
--        updated | unchanged | refused, item, event}.
--      * set_item_status(p_item, p_status, p_reason, p_actor): open (confirm a
--        proposed item, or reopen a settled one), done or dropped — never back
--        to proposed: {outcome: changed | unchanged | refused, item, event,
--        mooted}. Settling an item moots its pending proposals.
--      * propose_item_close(p_item, p_status, p_evidence_thought, p_label,
--        p_reason, p_actor): {outcome: proposed | unchanged | refused,
--        proposal, item}. Refused ITEM_SETTLED on a done or dropped item.
--      * decide_item_close(p_proposal, p_accept, p_reason, p_actor): {outcome:
--        accepted | rejected | refused, proposal, item, event}. Refused
--        PROPOSAL_YOURS for the proposer accepting its own, PROPOSAL_DECIDED
--        for one decided already.
--      * open_item_history(p_item): {item, events, proposals}, every event and
--        proposal in the order written; item NULL for an id the brain does not
--        hold. STABLE, no actor: which keys may read is the operations layer's
--        (a capture-only key is given no read tool).
--      * ob1_item_projection_drift() and ob1_rebuild_item_projection(): 068's
--        pattern, the drift check's formula its own.
--
--   7. 116, FOR THE FOURTH KIND. ob1_priority_item_exists answers kind `item`
--      from open_items, and assert_priority lets a capture-only key state a
--      priority on an open item it owns (ob1_priority_owns_item), as on a
--      thought it captured. Both are replaced here whole, every other rule as
--      116 wrote it.
--
--   8. CONCURRENCY. Each writer raises (0A000) above READ COMMITTED, takes a
--      transaction advisory lock on the item (ob1:item:<id>), then locks its
--      projection row before it reads anything else, so a capture key's
--      ownership check (assert_priority's FOR SHARE on the row) waits for a
--      take in flight. open_item locks the thought-and-text or plugin-row key
--      it would be unique by first. One item per transaction, or take items
--      in id order: two transactions locking two items in opposite orders
--      deadlock (40P01).
--
--   9. NOT THE EVENT LOG, DELETING AND FORGETTING. An item is not a thought:
--      thought_audit is the thoughts' log, and the table keeps its own
--      history. A thought deleted leaves the items read from it as they were.
--      An item's text, owner and reasons may hold personal data: forget_thought
--      (SMD-1723) has to reach the items WHERE origin_thought_id = <id> and
--      the proposals whose evidence it is; the refusing triggers are what that
--      ticket relaxes.
--
--   ob1:item-maker-from-the-envelope, ob1:item-proposal-never-alone and
--   ob1:item-one-per-origin — CONTRACT SENTINELS, not prose (the 014
--   convention).
--
-- PRIVILEGES
--   The `items` group (db/config.mjs ROLE_GRANTS): SELECT and INSERT on
--   open_item_events (the trigger refuses the rest); SELECT, INSERT, UPDATE
--   and DELETE on open_items (a projection row is replaced, and a rebuild
--   removes one no event made); SELECT, INSERT and UPDATE on
--   open_item_close_proposals (UPDATE to decide one, the trigger refusing any
--   other). The thoughts' existence and capturer are the capture group's
--   SELECT. The `priority` group gains SELECT on open_items and
--   open_item_events: assert_priority now checks an open item exists and whose
--   it is. Soft: a role without the group gets a permission error (42501)
--   naming the table on the item calls, and nothing else; the server first
--   calls them in SMD-3665's PR 2, whose preflight checks the group.
--
-- SAFETY
--   Three new tables, their indexes, four refusing triggers; twenty-three
--   new functions (six calls, a drift check, a rebuild, the two triggers'
--   functions and thirteen helpers), two of 116's replaced
--   (ob1_priority_item_exists and assert_priority) with one rule widened; no
--   row is changed. MINOR under
--   FORK.md's version rules. test-schema [105], test-upgrade [20bi].
--
-- Prerequisites
--   008 (ob1_current_actor), 046 (ob1_registry_kind, ob1_trust_ceiling), 061
--   (ob1_actor_agent_id), 116 (ob1_priority_isolation, ob1_priority_owns,
--   ob1_priority_item, ob1_priority_lock, ob1_priority_tier,
--   ob1_priority_is_maker, ob1_priority_json, ob1_priority_winner,
--   ob1_priority_project, priority_assertions), 115 (ob1_work_claim_text).
--   Applied by `bun db/migrate.ts`. Re-applied: the tables and their rows are
--   kept, and the functions and the triggers are replaced as they were.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
DECLARE
  v_need text[][] := ARRAY[
    ARRAY['ob1_current_actor()', '008 (ob1_current_actor)'],
    ARRAY['ob1_registry_kind(uuid, text)', '046 (ob1_registry_kind)'],
    ARRAY['ob1_trust_ceiling(text, text)', '046 (ob1_trust_ceiling)'],
    ARRAY['ob1_actor_agent_id()', '061 (ob1_actor_agent_id)'],
    ARRAY['ob1_work_claim_text(text, integer, text)', '115 (ob1_work_claim_text)'],
    ARRAY['ob1_priority_isolation(text)', '116 (ob1_priority_isolation)'],
    ARRAY['ob1_priority_owns(text, uuid)', '116 (ob1_priority_owns)'],
    ARRAY['ob1_priority_item(text, text)', '116 (ob1_priority_item)'],
    ARRAY['ob1_priority_project(text, text)', '116 (ob1_priority_project)']];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_need, 1) LOOP
    IF to_regprocedure(v_need[i][1]) IS NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = format('migration 117 needs %s; this schema lacks it', v_need[i][2]),
        -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
        HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
        ERRCODE = 'invalid_schema_definition';
    END IF;
  END LOOP;
END
$qc$;

-- ---------------------------------------------------------------------------
-- The tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS open_item_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq               bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  item_id           uuid        NOT NULL,
  event             text        NOT NULL,
  status            text        NOT NULL,
  text              text        NOT NULL,
  owner             text,
  due_at            timestamptz,
  origin_thought_id uuid,
  plugin            text,
  plugin_row        text,
  noted_at          timestamptz,
  reason            text,
  proposal_id       uuid,
  actor_name        text        NOT NULL,
  actor_agent_id    uuid,
  actor_key         text        GENERATED ALWAYS AS (COALESCE(actor_agent_id::text, 'name:' || actor_name)) STORED,
  actor_proved      boolean     NOT NULL,
  actor_kind        text,
  actor_trust       text,
  actor_scope       text,
  at                timestamptz NOT NULL,
  CONSTRAINT open_item_events_event   CHECK (event IN ('opened', 'updated', 'status')),
  CONSTRAINT open_item_events_status  CHECK (status IN ('proposed', 'open', 'done', 'dropped')),
  CONSTRAINT open_item_events_text    CHECK (text <> '' AND length(text) <= 1000 AND text !~ '[[:cntrl:]]'),
  CONSTRAINT open_item_events_owner   CHECK (owner IS NULL OR (owner <> '' AND length(owner) <= 200 AND owner !~ '[[:cntrl:]]')),
  CONSTRAINT open_item_events_reason  CHECK (reason IS NULL OR (reason <> '' AND length(reason) <= 1000 AND reason !~ '[[:cntrl:]]')),
  CONSTRAINT open_item_events_plugin  CHECK ((plugin IS NULL) = (plugin_row IS NULL)
                                             AND (plugin IS NULL OR (plugin ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(plugin) <= 64))
                                             AND (plugin_row IS NULL OR (plugin_row <> '' AND length(plugin_row) <= 200 AND plugin_row !~ '[[:cntrl:]]'))),
  -- Where it came from and when it was first said are the opening's alone.
  CONSTRAINT open_item_events_opening CHECK ((event = 'opened') = (noted_at IS NOT NULL)
                                             AND (event = 'opened' OR (origin_thought_id IS NULL AND plugin IS NULL))),
  -- Only an opening starts proposed; only a status event accepts a proposal.
  CONSTRAINT open_item_events_start   CHECK (status <> 'proposed' OR event <> 'status'),
  CONSTRAINT open_item_events_accept  CHECK (proposal_id IS NULL OR event = 'status'),
  CONSTRAINT open_item_events_actor   CHECK (actor_name <> '' AND length(actor_name) <= 200),
  CONSTRAINT open_item_events_kind    CHECK (actor_kind IS NULL OR actor_kind IN ('operator', 'agent', 'ingested')),
  CONSTRAINT open_item_events_trust   CHECK (actor_trust IS NULL OR actor_trust IN ('operator', 'agent', 'ingested')),
  CONSTRAINT open_item_events_scope   CHECK (actor_scope IS NULL OR (actor_scope <> '' AND length(actor_scope) <= 40))
);
COMMENT ON TABLE open_item_events IS
  'Every change to an open item, in the order written (seq): opened, updated or status, each carrying the item''s whole state after it (status, text, owner, due_at), its maker stamped from the call''s actor envelope (never an argument) and a reason. The opening alone carries where the item came from (origin_thought_id; plugin and plugin_row) and when it was first said (noted_at). Never changed: a trigger refuses UPDATE, DELETE and TRUNCATE. Written through open_item, update_item, set_item_status and decide_item_close; open_items is its projection. Migration 117 / SMD-3665.';
COMMENT ON COLUMN open_item_events.actor_proved IS
  'Whether the maker''s agent id came from the envelope itself (061''s ob1_actor_agent_id), not the registry''s for its name: what proves a capture-only key''s item is its own (116''s rule for thoughts). Migration 117 / SMD-3665.';
COMMENT ON COLUMN open_item_events.noted_at IS
  'On the opening alone: when the item was first said — its origin thought''s capture time, so an item read from an old thought reads as old, else the opening''s own time. Migration 117 / SMD-3665.';
COMMENT ON COLUMN open_item_events.text IS
  'The item''s text after this event: control characters made spaces, at most 1000 characters. May hold personal data, so forget_thought (SMD-1723) must reach the items read from a forgotten thought. Migration 117 / SMD-3665.';

CREATE INDEX IF NOT EXISTS open_item_events_item ON open_item_events (item_id, seq);
COMMENT ON INDEX open_item_events_item IS
  'An item''s events in the order written: its history, its projection, and whether another key has written on it since its opening. Migration 117 / SMD-3665.';
CREATE UNIQUE INDEX IF NOT EXISTS open_item_events_one_opening ON open_item_events (item_id) WHERE event = 'opened';
COMMENT ON INDEX open_item_events_one_opening IS
  'One opening per item. Migration 117 / SMD-3665.';

CREATE TABLE IF NOT EXISTS open_items (
  item_id            uuid        PRIMARY KEY,
  status             text        NOT NULL,
  text               text        NOT NULL,
  owner              text,
  due_at             timestamptz,
  origin_thought_id  uuid,
  origin_key         text,
  plugin             text,
  plugin_row         text,
  noted_at           timestamptz NOT NULL,
  opened_at          timestamptz NOT NULL,
  opened_by_name     text        NOT NULL,
  opened_by_agent_id uuid,
  opened_by_trust    text,
  opened_by_scope    text,
  changed_at         timestamptz NOT NULL,
  closed_at          timestamptz,
  last_seq           bigint      NOT NULL,
  CONSTRAINT open_items_status CHECK (status IN ('proposed', 'open', 'done', 'dropped')),
  CONSTRAINT open_items_closed CHECK ((closed_at IS NOT NULL) = (status IN ('done', 'dropped')))
);
COMMENT ON TABLE open_items IS
  'The projection of open_item_events: one row per open item — its status (proposed, open, done or dropped), text, owner and due time as its last event left them; where it came from, when it was first said and who opened it, as its opening says; when it last changed and when it settled. Kept current by the writers in their own transaction; ob1_item_projection_drift checks it and ob1_rebuild_item_projection repairs it. The id is the key of an item of kind item (docs/priority.md decision 1). Migration 117 / SMD-3665.';
COMMENT ON COLUMN open_items.origin_key IS
  'For an item read from a thought: md5 of the thought''s id and the opening''s text lower-cased — what makes the same item from the same thought one item. NULL for an item from no thought. Migration 117 / SMD-3665.';

-- ob1:item-one-per-origin
CREATE UNIQUE INDEX IF NOT EXISTS open_items_one_per_origin ON open_items (origin_key) WHERE origin_key IS NOT NULL;
COMMENT ON INDEX open_items_one_per_origin IS
  'One item per thought and text: the extractor''s pass and a backfill re-run open nothing twice. Migration 117 / SMD-3665.';
CREATE UNIQUE INDEX IF NOT EXISTS open_items_one_per_plugin_row ON open_items (plugin, plugin_row) WHERE plugin IS NOT NULL;
COMMENT ON INDEX open_items_one_per_plugin_row IS
  'One item per plugin row (decision 8: the row enters the brain as the open item that names it). Migration 117 / SMD-3665.';
CREATE INDEX IF NOT EXISTS open_items_by_status_due ON open_items (status, due_at);
COMMENT ON INDEX open_items_by_status_due IS
  'Open items by status and due time: what is open, and what is overdue. Migration 117 / SMD-3665.';
CREATE INDEX IF NOT EXISTS open_items_by_origin_thought ON open_items (origin_thought_id) WHERE origin_thought_id IS NOT NULL;
COMMENT ON INDEX open_items_by_origin_thought IS
  'The items read from one thought. Migration 117 / SMD-3665.';

CREATE TABLE IF NOT EXISTS open_item_close_proposals (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                 bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  item_id             uuid        NOT NULL,
  status              text        NOT NULL,
  evidence_thought_id uuid,
  label               text,
  reason              text,
  proposer_name       text        NOT NULL,
  proposer_agent_id   uuid,
  proposer_key        text        GENERATED ALWAYS AS (COALESCE(proposer_agent_id::text, 'name:' || proposer_name)) STORED,
  proposer_trust      text,
  proposer_scope      text,
  proposed_at         timestamptz NOT NULL,
  decision            text,
  decided_at          timestamptz,
  decider_name        text,
  decider_agent_id    uuid,
  decision_reason     text,
  CONSTRAINT open_item_close_proposals_status   CHECK (status IN ('done', 'dropped')),
  CONSTRAINT open_item_close_proposals_label    CHECK (label IS NULL OR (label ~ '^[a-z][a-z_]*$' AND length(label) <= 40)),
  CONSTRAINT open_item_close_proposals_reason   CHECK (reason IS NULL OR (reason <> '' AND length(reason) <= 1000 AND reason !~ '[[:cntrl:]]')),
  CONSTRAINT open_item_close_proposals_dreason  CHECK (decision_reason IS NULL OR (decision_reason <> '' AND length(decision_reason) <= 1000 AND decision_reason !~ '[[:cntrl:]]')),
  CONSTRAINT open_item_close_proposals_proposer CHECK (proposer_name <> '' AND length(proposer_name) <= 200),
  CONSTRAINT open_item_close_proposals_trust    CHECK (proposer_trust IS NULL OR proposer_trust IN ('operator', 'agent', 'ingested')),
  CONSTRAINT open_item_close_proposals_scope    CHECK (proposer_scope IS NULL OR (proposer_scope <> '' AND length(proposer_scope) <= 40)),
  -- A moot proposal names no decider: nobody decided it, its item settled.
  CONSTRAINT open_item_close_proposals_decided  CHECK ((decision IS NULL) = (decided_at IS NULL)
                                                       AND (decision IS NULL OR decision IN ('accepted', 'rejected', 'moot'))
                                                       AND ((decider_name IS NOT NULL) = (decision IN ('accepted', 'rejected')))
                                                       AND (decider_agent_id IS NULL OR decider_name IS NOT NULL)
                                                       AND (decision_reason IS NULL OR decision IS NOT NULL))
);
COMMENT ON TABLE open_item_close_proposals IS
  'A close proposed for an open item: the status it would close to (done or dropped), the thought that shows it (evidence_thought_id), a label (resolves, implements: SMD-3116''s settling labels, as data), a reason and its proposer. Never closes the item by itself: a key other than its proposer accepts it (decide_item_close), closing the item with an event naming it, or rejects it; a proposal pending when its item settles another way is moot. A row changes only to be decided, once. Migration 117 / SMD-3665.';

CREATE UNIQUE INDEX IF NOT EXISTS open_item_close_proposals_one_pending
  ON open_item_close_proposals (item_id, proposer_key, COALESCE(evidence_thought_id::text, '')) WHERE decision IS NULL;
COMMENT ON INDEX open_item_close_proposals_one_pending IS
  'One pending proposal per item, proposer and evidence: a judge re-reading a pair proposes nothing twice. Migration 117 / SMD-3665.';
CREATE INDEX IF NOT EXISTS open_item_close_proposals_item ON open_item_close_proposals (item_id, seq);
COMMENT ON INDEX open_item_close_proposals_item IS
  'An item''s proposals in the order made. Migration 117 / SMD-3665.';
CREATE INDEX IF NOT EXISTS open_item_close_proposals_pending ON open_item_close_proposals (seq) WHERE decision IS NULL;
COMMENT ON INDEX open_item_close_proposals_pending IS
  'The proposals waiting for a decision, oldest first. Migration 117 / SMD-3665.';

-- ---------------------------------------------------------------------------
-- Never changed, and decided once
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_item_events_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    MESSAGE = format('open_item_events is append-only: %s refused (an item changes by a new event: update_item or set_item_status)', TG_OP),
    ERRCODE = 'restrict_violation';
END;
$$;
COMMENT ON FUNCTION ob1_item_events_guard() IS
  'Refuses every UPDATE and DELETE of open_item_events, and every TRUNCATE — for the owner too. SMD-1723 relaxes it for forgetting. Migration 117 / SMD-3665.';

DROP TRIGGER IF EXISTS open_item_events_append_only ON open_item_events;
CREATE TRIGGER open_item_events_append_only
  BEFORE UPDATE OR DELETE ON open_item_events
  FOR EACH ROW EXECUTE FUNCTION ob1_item_events_guard();
DROP TRIGGER IF EXISTS open_item_events_no_truncate ON open_item_events;
CREATE TRIGGER open_item_events_no_truncate
  BEFORE TRUNCATE ON open_item_events
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_item_events_guard();

CREATE OR REPLACE FUNCTION ob1_item_proposals_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Only a pending row decided, once: every other column as it was. The
    -- whole row but the deciding columns and the generated proposer_key (not
    -- yet computed in a BEFORE trigger's NEW; its columns are compared), as
    -- 116's guard reads it.
    IF OLD.decision IS NULL AND NEW.decision IS NOT NULL
       AND to_jsonb(NEW) - ARRAY['decision', 'decided_at', 'decider_name', 'decider_agent_id', 'decision_reason', 'proposer_key']
           = to_jsonb(OLD) - ARRAY['decision', 'decided_at', 'decider_name', 'decider_agent_id', 'decision_reason', 'proposer_key'] THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING
      MESSAGE = 'open_item_close_proposals: a row changes only to be decided, once',
      ERRCODE = 'restrict_violation';
  END IF;
  RAISE EXCEPTION USING
    MESSAGE = format('open_item_close_proposals keeps every proposal: %s refused (reject it instead)', TG_OP),
    ERRCODE = 'restrict_violation';
END;
$$;
COMMENT ON FUNCTION ob1_item_proposals_guard() IS
  'Refuses an UPDATE of open_item_close_proposals other than a pending row being decided once (decision, decided_at, decider_name, decider_agent_id, decision_reason), every DELETE and TRUNCATE — for the owner too. Migration 117 / SMD-3665.';

DROP TRIGGER IF EXISTS open_item_close_proposals_decided_once ON open_item_close_proposals;
CREATE TRIGGER open_item_close_proposals_decided_once
  BEFORE UPDATE OR DELETE ON open_item_close_proposals
  FOR EACH ROW EXECUTE FUNCTION ob1_item_proposals_guard();
DROP TRIGGER IF EXISTS open_item_close_proposals_no_truncate ON open_item_close_proposals;
CREATE TRIGGER open_item_close_proposals_no_truncate
  BEFORE TRUNCATE ON open_item_close_proposals
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_item_proposals_guard();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- One item's projection row as the functions return it.
CREATE OR REPLACE FUNCTION ob1_item_json(i open_items)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT CASE WHEN i.item_id IS NOT NULL THEN jsonb_build_object(
    'id', i.item_id, 'status', i.status, 'text', i.text, 'owner', i.owner, 'due_at', i.due_at,
    'origin_thought_id', i.origin_thought_id,
    'plugin', CASE WHEN i.plugin IS NOT NULL THEN jsonb_build_object('name', i.plugin, 'row', i.plugin_row) END,
    'noted_at', i.noted_at, 'opened_at', i.opened_at,
    'opened_by', jsonb_build_object('name', i.opened_by_name, 'agent_id', i.opened_by_agent_id, 'trust', i.opened_by_trust, 'scope', i.opened_by_scope),
    'changed_at', i.changed_at, 'closed_at', i.closed_at) END
$$;
COMMENT ON FUNCTION ob1_item_json(open_items) IS
  'One open item as jsonb: id, status, text, owner, due_at, origin_thought_id, plugin {name, row}, noted_at, opened_at, opened_by {name, agent_id, trust, scope}, changed_at, closed_at; NULL for no row. Migration 117 / SMD-3665.';

CREATE OR REPLACE FUNCTION ob1_item_event_json(e open_item_events)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT CASE WHEN e.id IS NOT NULL THEN jsonb_build_object(
    'id', e.id, 'item_id', e.item_id, 'event', e.event, 'status', e.status, 'text', e.text, 'owner', e.owner, 'due_at', e.due_at,
    'reason', e.reason, 'proposal_id', e.proposal_id,
    'maker', jsonb_build_object('name', e.actor_name, 'agent_id', e.actor_agent_id, 'kind', e.actor_kind, 'trust', e.actor_trust, 'scope', e.actor_scope),
    'at', e.at) END
$$;
COMMENT ON FUNCTION ob1_item_event_json(open_item_events) IS
  'One open-item event as jsonb: id, item_id, event, the state after it (status, text, owner, due_at), reason, proposal_id, maker {name, agent_id, kind, trust, scope}, at; NULL for no row. Migration 117 / SMD-3665.';

CREATE OR REPLACE FUNCTION ob1_item_proposal_json(p open_item_close_proposals)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT CASE WHEN p.id IS NOT NULL THEN jsonb_build_object(
    'id', p.id, 'item_id', p.item_id, 'status', p.status, 'evidence_thought_id', p.evidence_thought_id, 'label', p.label, 'reason', p.reason,
    'proposer', jsonb_build_object('name', p.proposer_name, 'agent_id', p.proposer_agent_id, 'trust', p.proposer_trust, 'scope', p.proposer_scope),
    'proposed_at', p.proposed_at, 'decision', p.decision, 'decided_at', p.decided_at,
    'decider', CASE WHEN p.decider_name IS NOT NULL THEN jsonb_build_object('name', p.decider_name, 'agent_id', p.decider_agent_id) END,
    'decision_reason', p.decision_reason) END
$$;
COMMENT ON FUNCTION ob1_item_proposal_json(open_item_close_proposals) IS
  'One proposed close as jsonb: id, item_id, status, evidence_thought_id, label, reason, proposer {name, agent_id, trust, scope}, proposed_at, decision, decided_at, decider {name, agent_id}, decision_reason; NULL for no row. Migration 117 / SMD-3665.';

CREATE OR REPLACE FUNCTION ob1_item_lock(p_item uuid)
RETURNS void
LANGUAGE sql
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('ob1:item:' || p_item::text, 0))
$$;
COMMENT ON FUNCTION ob1_item_lock(uuid) IS
  'Takes the transaction advisory lock on one open item. Migration 117 / SMD-3665.';

-- Whether a capture-only key's agent opened this item, proved by the envelope's
-- own agent id at the opening, and no other key has written an event on it
-- since (082's "taken", for items). By id: a renamed key keeps its items, and
-- a key that once held the name gains none. No id, no item. Never NULL.
CREATE OR REPLACE FUNCTION ob1_item_owns(p_item uuid, p_agent uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(p_agent IS NOT NULL
    AND EXISTS (SELECT 1 FROM open_item_events e
                 WHERE e.item_id = p_item AND e.event = 'opened' AND e.actor_proved AND e.actor_agent_id = p_agent)
    AND NOT EXISTS (SELECT 1 FROM open_item_events e
                     WHERE e.item_id = p_item AND e.actor_agent_id IS DISTINCT FROM p_agent), false)
$$;
COMMENT ON FUNCTION ob1_item_owns(uuid, uuid) IS
  'Whether the agent p_agent opened the item p_item, its id proved by the envelope at the opening, and no event since is another key''s: a capture-only key''s own item. False, never NULL, for a NULL agent or an item that is not there. Migration 117 / SMD-3665.';

-- An item as the writers name it: a uuid, lower-cased, or a raise naming it.
CREATE OR REPLACE FUNCTION ob1_item_id(p_item text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v text := lower(btrim(COALESCE(p_item, '')));
BEGIN
  IF v !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION USING
      MESSAGE = format('not an open item''s id: %L (a uuid)', left(COALESCE(p_item, ''), 80)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v::uuid;
END;
$$;
COMMENT ON FUNCTION ob1_item_id(text) IS
  'An open item''s id from text: a uuid, trimmed and lower-cased; raises naming the input on anything else. Migration 117 / SMD-3665.';

-- The writers' common start: READ COMMITTED, the maker from the envelope, and
-- the scope rule (116's, failing closed). Returns the maker, or a refusal.
-- ob1:item-maker-from-the-envelope
CREATE OR REPLACE FUNCTION ob1_item_actor(p_actor jsonb, p_what text,
  OUT name text, OUT agent_id uuid, OUT env_agent_id uuid, OUT kind text, OUT trust text, OUT scope text, OUT plugin text, OUT refusal jsonb)
LANGUAGE plpgsql
AS $$
DECLARE
  v_env jsonb;
BEGIN
  PERFORM ob1_priority_isolation(p_what);
  -- 116's ob1_priority_actor, but for the priority source it reads (a table of
  -- the priority group's, which a role holding the items group alone lacks).
  IF p_actor IS NOT NULL THEN
    IF jsonb_typeof(p_actor) <> 'object' THEN
      RAISE EXCEPTION USING MESSAGE = format('%s: p_actor must be a JSON object, not a %s', p_what, jsonb_typeof(p_actor)), ERRCODE = 'invalid_parameter_value';
    END IF;
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;
  v_env := ob1_current_actor();
  name := NULLIF(btrim(COALESCE(v_env->>'name', '')), '');
  IF name IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('%s needs a maker: no actor envelope names one', p_what),
      HINT = 'Call it through the server, which passes the key as p_actor, or pass p_actor => ''{"name": "<key name>"}''.',
      ERRCODE = 'insufficient_privilege';
  END IF;
  IF length(name) > 200 THEN
    RAISE EXCEPTION USING MESSAGE = format('%s: a maker''s key name is at most 200 characters; this one has %s', p_what, length(name)), ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The envelope's agent id, else the registry's for the name: one key is one
  -- maker either way. env_agent_id is the envelope's alone, what proves a
  -- capture key's item or thought: an id read by name proves nothing.
  env_agent_id := ob1_actor_agent_id();
  agent_id := COALESCE(env_agent_id, (SELECT a.canonical_agent_id FROM ob1_agents a WHERE a.label = name));
  -- The registry's word for the key, never the envelope's (050's rule).
  kind := ob1_registry_kind(agent_id, name);
  trust := ob1_trust_ceiling(kind, NULL);
  scope := left(NULLIF(btrim(COALESCE(v_env->>'scope', '')), ''), 40);
  -- The plugin a call came through: the server's ctx.call stamps it (SMD-3665
  -- PR 2). Read here, never from an argument; a malformed one raises.
  plugin := NULLIF(btrim(COALESCE(v_env->>'plugin', '')), '');
  IF plugin IS NOT NULL AND (plugin !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' OR length(plugin) > 64) THEN
    RAISE EXCEPTION USING MESSAGE = format('%s: the envelope''s plugin %L is not a plugin''s name', p_what, left(plugin, 80)), ERRCODE = 'invalid_parameter_value';
  END IF;
  IF scope IS DISTINCT FROM 'write' AND scope IS DISTINCT FROM 'capture' THEN
    refusal := jsonb_build_object('outcome', 'refused', 'code', 'READ_ONLY_KEY',
      'message', format('%s states no write or capture scope, so it may not change an open item', name));
  END IF;
END;
$$;
COMMENT ON FUNCTION ob1_item_actor(jsonb, text) IS
  'The item writers'' start: raises above READ COMMITTED (116''s ob1_priority_isolation), sets ob1.actor from p_actor (an object, or a raise) and reads the maker as 116''s ob1_priority_actor does but for the priority source — name, agent id (the envelope''s, else the registry''s for the name), the envelope''s own id alone, 046''s registry kind and its trust ceiling, the envelope''s scope — the envelope''s plugin (validated, never an argument), and refusal: a READ_ONLY_KEY outcome for an envelope stating neither write nor capture scope, else NULL. Raises naming p_what when the envelope names nobody. Migration 117 / SMD-3665.';

-- A refusal as every writer returns it.
CREATE OR REPLACE FUNCTION ob1_item_refused(p_code text, p_message text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object('outcome', 'refused', 'code', p_code, 'message', p_message)
$$;
COMMENT ON FUNCTION ob1_item_refused(text, text) IS
  'A writer''s refusal: {outcome: refused, code, message}. Migration 117 / SMD-3665.';

-- One event written: the item's state after it and its maker. The writers'
-- one INSERT, so every event is stamped alike.
CREATE OR REPLACE FUNCTION ob1_item_event(p_item uuid, p_event text, p_status text, p_text text, p_owner text, p_due_at timestamptz,
  p_reason text, p_proposal uuid, p_who record, p_at timestamptz,
  p_origin uuid DEFAULT NULL, p_plugin text DEFAULT NULL, p_plugin_row text DEFAULT NULL, p_noted_at timestamptz DEFAULT NULL)
RETURNS open_item_events
LANGUAGE plpgsql
AS $$
DECLARE
  r open_item_events;
BEGIN
  INSERT INTO open_item_events (item_id, event, status, text, owner, due_at, origin_thought_id, plugin, plugin_row, noted_at, reason, proposal_id,
                                actor_name, actor_agent_id, actor_proved, actor_kind, actor_trust, actor_scope, at)
  VALUES (p_item, p_event, p_status, p_text, p_owner, p_due_at, p_origin, p_plugin, p_plugin_row, p_noted_at, p_reason, p_proposal,
          p_who.name, p_who.agent_id, p_who.env_agent_id IS NOT NULL, p_who.kind, p_who.trust, p_who.scope, p_at)
  RETURNING * INTO r;
  RETURN r;
END;
$$;
COMMENT ON FUNCTION ob1_item_event(uuid, text, text, text, text, timestamptz, text, uuid, record, timestamptz, uuid, text, text, timestamptz) IS
  'Writes one open-item event — the item''s state after it, a reason, the proposal it accepted, and its maker (p_who: ob1_item_actor''s row) — and returns it. The opening alone passes where the item came from and noted_at. Migration 117 / SMD-3665.';

-- The item's projection row made current from its events: the opening's fixed
-- fields, the last event's state, the settling status event's time. Removed
-- when no event names it. The rule; the drift check has its own copy.
CREATE OR REPLACE FUNCTION ob1_item_project(p_item uuid)
RETURNS open_items
LANGUAGE plpgsql
AS $$
DECLARE
  o open_item_events;
  l open_item_events;
  v_closed timestamptz;
  r open_items;
BEGIN
  SELECT * INTO o FROM open_item_events WHERE item_id = p_item AND event = 'opened';
  SELECT * INTO l FROM open_item_events WHERE item_id = p_item ORDER BY seq DESC LIMIT 1;
  IF o.id IS NULL THEN
    DELETE FROM open_items WHERE item_id = p_item;
    RETURN NULL;
  END IF;
  IF l.status IN ('done', 'dropped') THEN
    SELECT e.at INTO v_closed FROM open_item_events e WHERE e.item_id = p_item AND e.event = 'status' ORDER BY e.seq DESC LIMIT 1;
  END IF;
  INSERT INTO open_items (item_id, status, text, owner, due_at, origin_thought_id, origin_key, plugin, plugin_row, noted_at, opened_at,
                          opened_by_name, opened_by_agent_id, opened_by_trust, opened_by_scope, changed_at, closed_at, last_seq)
  VALUES (p_item, l.status, l.text, l.owner, l.due_at, o.origin_thought_id,
          CASE WHEN o.origin_thought_id IS NOT NULL THEN md5(o.origin_thought_id::text || ':' || lower(o.text)) END,
          o.plugin, o.plugin_row, o.noted_at, o.at, o.actor_name, o.actor_agent_id, o.actor_trust, o.actor_scope, l.at, v_closed, l.seq)
  ON CONFLICT (item_id) DO UPDATE
     SET status = EXCLUDED.status, text = EXCLUDED.text, owner = EXCLUDED.owner, due_at = EXCLUDED.due_at,
         origin_thought_id = EXCLUDED.origin_thought_id, origin_key = EXCLUDED.origin_key, plugin = EXCLUDED.plugin, plugin_row = EXCLUDED.plugin_row,
         noted_at = EXCLUDED.noted_at, opened_at = EXCLUDED.opened_at, opened_by_name = EXCLUDED.opened_by_name,
         opened_by_agent_id = EXCLUDED.opened_by_agent_id, opened_by_trust = EXCLUDED.opened_by_trust, opened_by_scope = EXCLUDED.opened_by_scope,
         changed_at = EXCLUDED.changed_at, closed_at = EXCLUDED.closed_at, last_seq = EXCLUDED.last_seq
  RETURNING * INTO r;
  RETURN r;
END;
$$;
COMMENT ON FUNCTION ob1_item_project(uuid) IS
  'Makes one item''s open_items row current from its events — the opening''s origin, plugin row, noted_at and opener, the last event''s status, text, owner and due time, the settling status event''s time — or removes it when no opening names the item; returns the row (NULL for none). Called by the writers under the item''s lock. Migration 117 / SMD-3665.';

-- Pending proposals on an item made moot: it settled another way.
CREATE OR REPLACE FUNCTION ob1_item_moot(p_item uuid, p_at timestamptz, p_except uuid DEFAULT NULL)
RETURNS int
LANGUAGE sql
AS $$
  WITH m AS (
    UPDATE open_item_close_proposals SET decision = 'moot', decided_at = p_at
     WHERE item_id = p_item AND decision IS NULL AND id IS DISTINCT FROM p_except
    RETURNING 1)
  SELECT count(*)::int FROM m
$$;
COMMENT ON FUNCTION ob1_item_moot(uuid, timestamptz, uuid) IS
  'Marks every pending proposal on an item moot (but p_except), as of p_at, and returns how many: the item settled another way. Migration 117 / SMD-3665.';

-- ---------------------------------------------------------------------------
-- open_item
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION open_item(
  p_text           text,
  p_owner          text        DEFAULT NULL,
  p_due_at         timestamptz DEFAULT NULL,
  p_origin_thought uuid        DEFAULT NULL,
  p_plugin_row     text        DEFAULT NULL,
  p_proposed       boolean     DEFAULT false,
  p_actor          jsonb       DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_text  text := ob1_work_claim_text(p_text, 1000, 'an item''s text');
  v_owner text := ob1_work_claim_text(p_owner, 200, 'an owner');
  v_row   text := ob1_work_claim_text(p_plugin_row, 200, 'a plugin row');
  v_who   record;
  v_key   text;
  v_noted timestamptz;
  v_now   timestamptz;
  v_id    uuid := gen_random_uuid();
  v_have  open_items;
  v_ev    open_item_events;
  v_item  open_items;
BEGIN
  IF v_text IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'an open item needs its text', ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_who FROM ob1_item_actor(p_actor, 'open_item');
  IF v_who.refusal IS NOT NULL THEN
    RETURN v_who.refusal || jsonb_build_object('item', NULL, 'event', NULL);
  END IF;
  IF v_row IS NOT NULL AND v_who.plugin IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'open_item: a plugin row needs the call to come through its plugin (the envelope''s plugin), and this one names none',
      ERRCODE = 'invalid_parameter_value';
  END IF;

  -- A capture-only key opens an item from a thought only if its agent captured
  -- the thought and nobody took it (116's rule, by the envelope's own id), asked
  -- under a share lock on the thought and before any existence answer.
  IF p_origin_thought IS NOT NULL THEN
    IF v_who.scope = 'capture' THEN
      PERFORM 1 FROM thoughts t WHERE t.id = p_origin_thought FOR SHARE;
      IF NOT ob1_priority_owns(p_origin_thought::text, v_who.env_agent_id) THEN
        RETURN ob1_item_refused('ITEM_NOT_YOURS',
          format('%s is a capture-only key: it may open an item only from a thought it captured', v_who.name)) || jsonb_build_object('item', NULL, 'event', NULL);
      END IF;
    END IF;
    SELECT t.created_at INTO v_noted FROM thoughts t WHERE t.id = p_origin_thought;
    IF NOT FOUND THEN
      RETURN ob1_item_refused('ITEM_NOT_FOUND', format('no thought %s in this brain', p_origin_thought)) || jsonb_build_object('item', NULL, 'event', NULL);
    END IF;
    v_key := md5(p_origin_thought::text || ':' || lower(v_text));
  END IF;

  -- The same item again is the item that is there: by its thought and text, or
  -- its plugin row, each under its own lock.
  IF v_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('ob1:item-origin:' || v_key, 0));
    SELECT * INTO v_have FROM open_items WHERE origin_key = v_key;
  END IF;
  IF v_have.item_id IS NULL AND v_row IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('ob1:item-plugin:' || v_who.plugin || ':' || v_row, 0));
    SELECT * INTO v_have FROM open_items WHERE plugin = v_who.plugin AND plugin_row = v_row;
  END IF;
  IF v_have.item_id IS NOT NULL THEN
    -- A capture key is shown it only if it is its own: another key's item
    -- would tell it that key's owner, due time and status.
    RETURN jsonb_build_object('outcome', 'unchanged', 'code', NULL,
      'message', CASE WHEN v_who.scope = 'write' OR ob1_item_owns(v_have.item_id, v_who.env_agent_id) THEN NULL
                      ELSE 'an item for this is already open' END,
      'item', CASE WHEN v_who.scope = 'write' OR ob1_item_owns(v_have.item_id, v_who.env_agent_id) THEN ob1_item_json(v_have) END,
      'event', NULL);
  END IF;

  PERFORM ob1_item_lock(v_id);
  v_now := clock_timestamp();
  v_ev := ob1_item_event(v_id, 'opened', CASE WHEN COALESCE(p_proposed, false) THEN 'proposed' ELSE 'open' END, v_text, v_owner, p_due_at,
                         NULL, NULL, v_who, v_now, p_origin_thought,
                         CASE WHEN v_row IS NOT NULL THEN v_who.plugin END, v_row, COALESCE(v_noted, v_now));
  v_item := ob1_item_project(v_id);
  RETURN jsonb_build_object('outcome', 'opened', 'code', NULL, 'message', NULL,
    'item', ob1_item_json(v_item), 'event', ob1_item_event_json(v_ev));
END;
$$;
COMMENT ON FUNCTION open_item(text, text, timestamptz, uuid, text, boolean, jsonb) IS
  'Opens an item: p_text (at most 1000 characters), an optional p_owner (free text: who is to do it) and p_due_at, read from the thought p_origin_thought (its capture time the item''s noted_at), standing for the plugin row p_plugin_row of the plugin the envelope names (never an argument), and starting proposed (p_proposed: the extractor''s, not yet open until confirmed) or open. The maker is the key p_actor names. The same thought and text, or the same plugin row, again is unchanged: the item that is there, nothing written — shown to a capture key only if it is its own. Returns jsonb {outcome: opened | unchanged | refused, code, message, item, event}: refused READ_ONLY_KEY (an envelope stating no write or capture scope), ITEM_NOT_YOURS (a capture-only key opening from a thought it did not capture, or one taken since — asked before existence), ITEM_NOT_FOUND (no such thought). Raises for no text, no maker, a plugin row with no plugin in the envelope, a malformed argument, or a transaction above READ COMMITTED. Migration 117 / SMD-3665.';

-- ---------------------------------------------------------------------------
-- The writers on an item that is there: their common gate
-- ---------------------------------------------------------------------------

-- Locks the item and its projection row, and answers whether the caller may
-- change it: NULL when it may (v_item set), else the refusal. A capture key is
-- asked first, alike for an item that is not there.
CREATE OR REPLACE FUNCTION ob1_item_gate(p_item uuid, p_who record, p_what text, OUT item open_items, OUT refusal jsonb)
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM ob1_item_lock(p_item);
  SELECT * INTO item FROM open_items WHERE item_id = p_item FOR UPDATE;
  IF p_who.scope = 'capture' AND NOT ob1_item_owns(p_item, p_who.env_agent_id) THEN
    item := NULL;
    refusal := ob1_item_refused('ITEM_NOT_YOURS',
      format('%s is a capture-only key: it may %s only an item it opened, and nobody else has changed since', p_who.name, p_what));
  ELSIF item.item_id IS NULL THEN
    refusal := ob1_item_refused('ITEM_NOT_FOUND', format('no open item %s in this brain', p_item));
  END IF;
END;
$$;
COMMENT ON FUNCTION ob1_item_gate(uuid, record, text) IS
  'The item writers'' gate: takes the item''s lock and its projection row''s, then returns the row, or a refusal — ITEM_NOT_YOURS for a capture-only key on an item it does not own (asked first, alike for an item that is not there), ITEM_NOT_FOUND for an id the brain does not hold. Migration 117 / SMD-3665.';

-- ---------------------------------------------------------------------------
-- update_item
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_item(
  p_item    text,
  p_changes jsonb,
  p_actor   jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_id    uuid := ob1_item_id(p_item);
  v_who   record;
  v_gate  record;
  v_text  text;
  v_owner text;
  v_due   timestamptz;
  v_ev    open_item_events;
  v_item  open_items;
  v_bad   text;
BEGIN
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN
    RAISE EXCEPTION USING MESSAGE = 'update_item takes its changes as a JSON object: text, owner, due_at', ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT k INTO v_bad FROM jsonb_object_keys(p_changes) k WHERE k NOT IN ('text', 'owner', 'due_at') LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = format('update_item changes text, owner and due_at; not %L', left(v_bad, 40)), ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_changes = '{}'::jsonb THEN
    RAISE EXCEPTION USING MESSAGE = 'update_item takes at least one of text, owner and due_at', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_changes ? 'text' AND jsonb_typeof(p_changes->'text') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION USING MESSAGE = 'an item''s text is a string, and may not be cleared', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_changes ? 'owner' AND jsonb_typeof(p_changes->'owner') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION USING MESSAGE = 'an owner is a string, or null to clear it', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_changes ? 'due_at' AND jsonb_typeof(p_changes->'due_at') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION USING MESSAGE = 'a due time is a string, or null to clear it', ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_who FROM ob1_item_actor(p_actor, 'update_item');
  IF v_who.refusal IS NOT NULL THEN
    RETURN v_who.refusal || jsonb_build_object('item', NULL, 'event', NULL);
  END IF;
  SELECT * INTO v_gate FROM ob1_item_gate(v_id, v_who, 'change');
  IF v_gate.refusal IS NOT NULL THEN
    RETURN v_gate.refusal || jsonb_build_object('item', NULL, 'event', NULL);
  END IF;
  v_text  := CASE WHEN p_changes ? 'text' THEN ob1_work_claim_text(p_changes->>'text', 1000, 'an item''s text') ELSE (v_gate.item).text END;
  v_owner := CASE WHEN p_changes ? 'owner' THEN ob1_work_claim_text(p_changes->>'owner', 200, 'an owner') ELSE (v_gate.item).owner END;
  v_due   := CASE WHEN p_changes ? 'due_at' THEN (p_changes->>'due_at')::timestamptz ELSE (v_gate.item).due_at END;
  IF v_text IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'an item''s text may not be empty', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (v_text, v_owner, v_due) IS NOT DISTINCT FROM ((v_gate.item).text, (v_gate.item).owner, (v_gate.item).due_at) THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'code', NULL, 'message', NULL, 'item', ob1_item_json(v_gate.item), 'event', NULL);
  END IF;
  v_ev := ob1_item_event(v_id, 'updated', (v_gate.item).status, v_text, v_owner, v_due, NULL, NULL, v_who, clock_timestamp());
  v_item := ob1_item_project(v_id);
  RETURN jsonb_build_object('outcome', 'updated', 'code', NULL, 'message', NULL, 'item', ob1_item_json(v_item), 'event', ob1_item_event_json(v_ev));
END;
$$;
COMMENT ON FUNCTION update_item(text, jsonb, jsonb) IS
  'Changes an open item''s text, owner or due time, from the JSON object p_changes (a JSON null clears owner or due_at; text may not be cleared), whatever its status. Returns jsonb {outcome: updated | unchanged | refused, code, message, item, event}: refused READ_ONLY_KEY, ITEM_NOT_YOURS (a capture-only key on an item it did not open or another key has changed since — asked before existence), ITEM_NOT_FOUND. The same values again are unchanged, nothing written. Raises for a malformed item or change, no maker, or a transaction above READ COMMITTED. Migration 117 / SMD-3665.';

-- ---------------------------------------------------------------------------
-- set_item_status
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_item_status(
  p_item   text,
  p_status text,
  p_reason text  DEFAULT NULL,
  p_actor  jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_id     uuid := ob1_item_id(p_item);
  v_status text := lower(btrim(COALESCE(p_status, '')));
  v_reason text := ob1_work_claim_text(p_reason, 1000, 'a reason');
  v_who    record;
  v_gate   record;
  v_now    timestamptz;
  v_ev     open_item_events;
  v_item   open_items;
  v_moot   int := 0;
BEGIN
  IF v_status NOT IN ('open', 'done', 'dropped') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('an item''s status is set to open, done or dropped; not %L (proposed is a start state alone)', left(COALESCE(p_status, ''), 40)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_who FROM ob1_item_actor(p_actor, 'set_item_status');
  IF v_who.refusal IS NOT NULL THEN
    RETURN v_who.refusal || jsonb_build_object('item', NULL, 'event', NULL, 'mooted', 0);
  END IF;
  SELECT * INTO v_gate FROM ob1_item_gate(v_id, v_who, 'set the status of');
  IF v_gate.refusal IS NOT NULL THEN
    RETURN v_gate.refusal || jsonb_build_object('item', NULL, 'event', NULL, 'mooted', 0);
  END IF;
  IF (v_gate.item).status = v_status THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'code', NULL, 'message', NULL, 'item', ob1_item_json(v_gate.item), 'event', NULL, 'mooted', 0);
  END IF;
  v_now := clock_timestamp();
  v_ev := ob1_item_event(v_id, 'status', v_status, (v_gate.item).text, (v_gate.item).owner, (v_gate.item).due_at, v_reason, NULL, v_who, v_now);
  IF v_status IN ('done', 'dropped') THEN
    v_moot := ob1_item_moot(v_id, v_now);
  END IF;
  v_item := ob1_item_project(v_id);
  RETURN jsonb_build_object('outcome', 'changed', 'code', NULL, 'message', NULL, 'item', ob1_item_json(v_item), 'event', ob1_item_event_json(v_ev), 'mooted', v_moot);
END;
$$;
COMMENT ON FUNCTION set_item_status(text, text, text, jsonb) IS
  'Sets an open item''s status: open (confirming a proposed item, or reopening a settled one), done or dropped (dismissing a proposed one, or settling an open one) — never back to proposed, a start state alone. Settling moots the item''s pending proposals. Returns jsonb {outcome: changed | unchanged | refused, code, message, item, event, mooted}: refused READ_ONLY_KEY, ITEM_NOT_YOURS (a capture-only key on an item it did not open or another key has changed since — asked before existence), ITEM_NOT_FOUND. The status it has already is unchanged. Raises for a malformed item or status, no maker, or a transaction above READ COMMITTED. Migration 117 / SMD-3665.';

-- ---------------------------------------------------------------------------
-- propose_item_close / decide_item_close
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION propose_item_close(
  p_item             text,
  p_status           text  DEFAULT 'done',
  p_evidence_thought uuid  DEFAULT NULL,
  p_label            text  DEFAULT NULL,
  p_reason           text  DEFAULT NULL,
  p_actor            jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_id     uuid := ob1_item_id(p_item);
  v_status text := lower(btrim(COALESCE(p_status, '')));
  v_label  text := NULLIF(lower(btrim(COALESCE(p_label, ''))), '');
  v_reason text := ob1_work_claim_text(p_reason, 1000, 'a reason');
  v_who    record;
  v_gate   record;
  v_have   open_item_close_proposals;
  v_row    open_item_close_proposals;
BEGIN
  IF v_status NOT IN ('done', 'dropped') THEN
    RAISE EXCEPTION USING MESSAGE = format('a proposed close is to done or dropped; not %L', left(COALESCE(p_status, ''), 40)), ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_label IS NOT NULL AND (v_label !~ '^[a-z][a-z_]*$' OR length(v_label) > 40) THEN
    RAISE EXCEPTION USING MESSAGE = format('a proposal''s label is one lower-case word (resolves, implements); not %L', left(p_label, 40)), ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_who FROM ob1_item_actor(p_actor, 'propose_item_close');
  IF v_who.refusal IS NOT NULL THEN
    RETURN v_who.refusal || jsonb_build_object('proposal', NULL, 'item', NULL);
  END IF;
  SELECT * INTO v_gate FROM ob1_item_gate(v_id, v_who, 'propose closing');
  IF v_gate.refusal IS NOT NULL THEN
    RETURN v_gate.refusal || jsonb_build_object('proposal', NULL, 'item', NULL);
  END IF;
  IF p_evidence_thought IS NOT NULL THEN
    IF v_who.scope = 'capture' THEN
      PERFORM 1 FROM thoughts t WHERE t.id = p_evidence_thought FOR SHARE;
      IF NOT ob1_priority_owns(p_evidence_thought::text, v_who.env_agent_id) THEN
        RETURN ob1_item_refused('ITEM_NOT_YOURS',
          format('%s is a capture-only key: its evidence may be only a thought it captured', v_who.name)) || jsonb_build_object('proposal', NULL, 'item', NULL);
      END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = p_evidence_thought) THEN
      RETURN ob1_item_refused('EVIDENCE_NOT_FOUND', format('no thought %s in this brain', p_evidence_thought)) || jsonb_build_object('proposal', NULL, 'item', NULL);
    END IF;
  END IF;
  IF (v_gate.item).status IN ('done', 'dropped') THEN
    RETURN ob1_item_refused('ITEM_SETTLED', format('the item is %s already', (v_gate.item).status))
           || jsonb_build_object('proposal', NULL, 'item', ob1_item_json(v_gate.item));
  END IF;
  -- The same proposer and evidence, pending, is the proposal that is there.
  SELECT * INTO v_have FROM open_item_close_proposals p
   WHERE p.item_id = v_id AND p.decision IS NULL
     AND p.proposer_key = COALESCE(v_who.agent_id::text, 'name:' || v_who.name)
     AND p.evidence_thought_id IS NOT DISTINCT FROM p_evidence_thought;
  IF v_have.id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'code', NULL, 'message', NULL, 'proposal', ob1_item_proposal_json(v_have), 'item', ob1_item_json(v_gate.item));
  END IF;
  INSERT INTO open_item_close_proposals (item_id, status, evidence_thought_id, label, reason, proposer_name, proposer_agent_id, proposer_trust, proposer_scope, proposed_at)
  VALUES (v_id, v_status, p_evidence_thought, v_label, v_reason, v_who.name, v_who.agent_id, v_who.trust, v_who.scope, clock_timestamp())
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('outcome', 'proposed', 'code', NULL, 'message', NULL, 'proposal', ob1_item_proposal_json(v_row), 'item', ob1_item_json(v_gate.item));
END;
$$;
COMMENT ON FUNCTION propose_item_close(text, text, uuid, text, text, jsonb) IS
  'Proposes closing an open item to p_status (done, the default, or dropped), shown by the thought p_evidence_thought, labelled p_label (one lower-case word: resolves, implements), with p_reason. Never changes the item: another key decides (decide_item_close). The same proposer and evidence pending already is unchanged. Returns jsonb {outcome: proposed | unchanged | refused, code, message, proposal, item}: refused READ_ONLY_KEY, ITEM_NOT_YOURS (a capture-only key on an item it does not own, or with evidence it did not capture), ITEM_NOT_FOUND, EVIDENCE_NOT_FOUND, ITEM_SETTLED (done or dropped already). Raises for a malformed argument, no maker, or a transaction above READ COMMITTED. Migration 117 / SMD-3665.';

CREATE OR REPLACE FUNCTION decide_item_close(
  p_proposal uuid,
  p_accept   boolean,
  p_reason   text  DEFAULT NULL,
  p_actor    jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_reason text := ob1_work_claim_text(p_reason, 1000, 'a reason');
  v_who    record;
  v_gate   record;
  v_prop   open_item_close_proposals;
  v_now    timestamptz;
  v_ev     open_item_events;
  v_item   open_items;
BEGIN
  IF p_proposal IS NULL OR p_accept IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'decide_item_close takes a proposal and whether it is accepted', ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_who FROM ob1_item_actor(p_actor, 'decide_item_close');
  IF v_who.refusal IS NOT NULL THEN
    RETURN v_who.refusal || jsonb_build_object('proposal', NULL, 'item', NULL, 'event', NULL);
  END IF;
  SELECT * INTO v_prop FROM open_item_close_proposals WHERE id = p_proposal;
  IF v_prop.id IS NULL THEN
    -- A capture key is told the same as for a proposal on another key's item.
    RETURN ob1_item_refused(CASE WHEN v_who.scope = 'capture' THEN 'ITEM_NOT_YOURS' ELSE 'PROPOSAL_NOT_FOUND' END,
      CASE WHEN v_who.scope = 'capture' THEN format('%s is a capture-only key: it may decide only a proposal on an item it opened', v_who.name)
           ELSE format('no proposed close %s in this brain', p_proposal) END)
      || jsonb_build_object('proposal', NULL, 'item', NULL, 'event', NULL);
  END IF;
  SELECT * INTO v_gate FROM ob1_item_gate(v_prop.item_id, v_who, 'decide a proposal on');
  IF v_gate.refusal IS NOT NULL THEN
    RETURN v_gate.refusal || jsonb_build_object('proposal', NULL, 'item', NULL, 'event', NULL);
  END IF;
  SELECT * INTO v_prop FROM open_item_close_proposals WHERE id = p_proposal FOR UPDATE;
  IF v_prop.decision IS NOT NULL THEN
    RETURN ob1_item_refused('PROPOSAL_DECIDED', format('the proposal is %s already', v_prop.decision))
           || jsonb_build_object('proposal', ob1_item_proposal_json(v_prop), 'item', ob1_item_json(v_gate.item), 'event', NULL);
  END IF;
  -- ob1:item-proposal-never-alone — a proposal never closes an item by the
  -- proposer's word alone: its proposer may withdraw it (reject), never accept.
  IF p_accept AND v_prop.proposer_key = COALESCE(v_who.agent_id::text, 'name:' || v_who.name) THEN
    RETURN ob1_item_refused('PROPOSAL_YOURS', 'a proposal is accepted by a key other than its proposer; close the item yourself, or let another key decide')
           || jsonb_build_object('proposal', ob1_item_proposal_json(v_prop), 'item', ob1_item_json(v_gate.item), 'event', NULL);
  END IF;
  v_now := clock_timestamp();
  UPDATE open_item_close_proposals
     SET decision = CASE WHEN p_accept THEN 'accepted' ELSE 'rejected' END, decided_at = v_now,
         decider_name = v_who.name, decider_agent_id = v_who.agent_id, decision_reason = v_reason
   WHERE id = p_proposal
  RETURNING * INTO v_prop;
  IF NOT p_accept THEN
    RETURN jsonb_build_object('outcome', 'rejected', 'code', NULL, 'message', NULL,
      'proposal', ob1_item_proposal_json(v_prop), 'item', ob1_item_json(v_gate.item), 'event', NULL);
  END IF;
  -- A pending proposal's item is not settled: settling moots them. Held here
  -- for a raw write that settled it without.
  IF (v_gate.item).status IN ('done', 'dropped') THEN
    RAISE EXCEPTION USING MESSAGE = format('decide_item_close: proposal %s was pending on an item %s already', p_proposal, (v_gate.item).status), ERRCODE = 'invalid_parameter_value';
  END IF;
  v_ev := ob1_item_event(v_prop.item_id, 'status', v_prop.status, (v_gate.item).text, (v_gate.item).owner, (v_gate.item).due_at,
                         COALESCE(v_reason, v_prop.reason), v_prop.id, v_who, v_now);
  PERFORM ob1_item_moot(v_prop.item_id, v_now, v_prop.id);
  v_item := ob1_item_project(v_prop.item_id);
  RETURN jsonb_build_object('outcome', 'accepted', 'code', NULL, 'message', NULL,
    'proposal', ob1_item_proposal_json(v_prop), 'item', ob1_item_json(v_item), 'event', ob1_item_event_json(v_ev));
END;
$$;
COMMENT ON FUNCTION decide_item_close(uuid, boolean, text, jsonb) IS
  'Decides a proposed close: p_accept true closes its item to the proposal''s status with an event naming the proposal (and moots the item''s other pending proposals); false rejects it, the item untouched. A proposal is accepted by a key other than its proposer, which may only withdraw it (reject). Returns jsonb {outcome: accepted | rejected | refused, code, message, proposal, item, event}: refused READ_ONLY_KEY, ITEM_NOT_YOURS (a capture-only key on a proposal for an item it does not own, or one that is not there), PROPOSAL_NOT_FOUND, PROPOSAL_DECIDED (decided or moot already), PROPOSAL_YOURS (its proposer accepting). Raises for a missing argument, no maker, or a transaction above READ COMMITTED. Migration 117 / SMD-3665.';

-- ---------------------------------------------------------------------------
-- open_item_history
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION open_item_history(p_item text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'item', (SELECT ob1_item_json(i) FROM open_items i WHERE i.item_id = q.id),
    'events', (SELECT COALESCE(jsonb_agg(ob1_item_event_json(e) ORDER BY e.seq), '[]'::jsonb) FROM open_item_events e WHERE e.item_id = q.id),
    'proposals', (SELECT COALESCE(jsonb_agg(ob1_item_proposal_json(p) ORDER BY p.seq), '[]'::jsonb) FROM open_item_close_proposals p WHERE p.item_id = q.id))
    FROM (SELECT ob1_item_id(p_item) AS id) q
$$;
COMMENT ON FUNCTION open_item_history(text) IS
  'One open item''s record: {item, events, proposals} — the item as it stands (NULL for an id the brain does not hold), every event and every proposed close in the order written. Raises on a malformed id. Migration 117 / SMD-3665.';

-- ---------------------------------------------------------------------------
-- The drift check and the rebuild (068's pattern)
-- ---------------------------------------------------------------------------

-- The projection's formula written again, independent of ob1_item_project:
-- what a verifier must not share with the thing it verifies.
CREATE OR REPLACE FUNCTION ob1_item_projection_drift()
RETURNS TABLE (item_id uuid, stored text, fresh text)
LANGUAGE sql
STABLE
AS $$
  WITH ranked AS (
         SELECT e.*,
                row_number() OVER (PARTITION BY e.item_id ORDER BY e.seq DESC) AS from_last,
                max(e.seq) FILTER (WHERE e.event = 'status') OVER (PARTITION BY e.item_id) AS last_status_seq
           FROM open_item_events e),
       fresh AS (
         SELECT l.item_id, l.status, l.text, l.owner, l.due_at, o.origin_thought_id,
                CASE WHEN o.origin_thought_id IS NOT NULL THEN md5(o.origin_thought_id::text || ':' || lower(o.text)) END AS origin_key,
                o.plugin, o.plugin_row, o.noted_at, o.at AS opened_at, o.actor_name, o.actor_agent_id, o.actor_trust, o.actor_scope,
                l.at AS changed_at,
                CASE WHEN l.status IN ('done', 'dropped')
                     THEN (SELECT s.at FROM open_item_events s WHERE s.item_id = l.item_id AND s.seq = l.last_status_seq) END AS closed_at,
                l.seq
           FROM ranked l
           JOIN open_item_events o ON o.item_id = l.item_id AND o.event = 'opened'
          WHERE l.from_last = 1)
  SELECT COALESCE(f.item_id, c.item_id),
         CASE WHEN c.item_id IS NOT NULL THEN row(c.status, c.text, c.owner, c.due_at, c.origin_thought_id, c.origin_key, c.plugin, c.plugin_row, c.noted_at,
                                                  c.opened_at, c.opened_by_name, c.opened_by_agent_id, c.opened_by_trust, c.opened_by_scope, c.changed_at, c.closed_at, c.last_seq)::text END,
         CASE WHEN f.item_id IS NOT NULL THEN row(f.status, f.text, f.owner, f.due_at, f.origin_thought_id, f.origin_key, f.plugin, f.plugin_row, f.noted_at,
                                                  f.opened_at, f.actor_name, f.actor_agent_id, f.actor_trust, f.actor_scope, f.changed_at, f.closed_at, f.seq)::text END
    FROM fresh f FULL JOIN open_items c ON c.item_id = f.item_id
   WHERE (c.status, c.text, c.owner, c.due_at, c.origin_thought_id, c.origin_key, c.plugin, c.plugin_row, c.noted_at,
          c.opened_at, c.opened_by_name, c.opened_by_agent_id, c.opened_by_trust, c.opened_by_scope, c.changed_at, c.closed_at, c.last_seq)
         IS DISTINCT FROM
         (f.status, f.text, f.owner, f.due_at, f.origin_thought_id, f.origin_key, f.plugin, f.plugin_row, f.noted_at,
          f.opened_at, f.actor_name, f.actor_agent_id, f.actor_trust, f.actor_scope, f.changed_at, f.closed_at, f.seq)
$$;
COMMENT ON FUNCTION ob1_item_projection_drift() IS
  'Every item where open_items differs from the projection computed fresh from open_item_events — the item, the stored row and the fresh one as text, NULL where one side has none. Zero rows when exact. Its own copy of the projection''s rule, not ob1_item_project''s. Computes every item: a check, not a read path. Migration 117 / SMD-3665.';

CREATE OR REPLACE FUNCTION ob1_rebuild_item_projection()
RETURNS TABLE (written int, deleted int)
LANGUAGE plpgsql
AS $$
DECLARE
  r        record;
  w        open_items;
  v_before text;
  v_after  text;
BEGIN
  PERFORM ob1_priority_isolation('ob1_rebuild_item_projection()');
  written := 0;
  deleted := 0;
  -- Item by item under each item's own lock, in id order: never a lock the
  -- writers would wait on in another order.
  FOR r IN SELECT DISTINCT d.item_id FROM ob1_item_projection_drift() d ORDER BY 1 LOOP
    PERFORM ob1_item_lock(r.item_id);
    -- Counted only if still wrong under the lock: a writer may have fixed it
    -- since the drift was read.
    SELECT row(c.*)::text INTO v_before FROM open_items c WHERE c.item_id = r.item_id;
    w := ob1_item_project(r.item_id);
    SELECT row(c.*)::text INTO v_after FROM open_items c WHERE c.item_id = r.item_id;
    IF v_before IS DISTINCT FROM v_after THEN
      IF w.item_id IS NOT NULL THEN written := written + 1; ELSE deleted := deleted + 1; END IF;
    END IF;
  END LOOP;
  RETURN NEXT;
END
$$;
COMMENT ON FUNCTION ob1_rebuild_item_projection() IS
  'Reconciles every item the drift check names, each under its own lock, and returns how many rows it wrote and deleted — zeros when the projection was exact. Refuses to run outside READ COMMITTED. The repair after a raw write to open_item_events or open_items. Migration 117 / SMD-3665.';

-- ---------------------------------------------------------------------------
-- 116, for the fourth kind
-- ---------------------------------------------------------------------------

-- Whether an item exists, by its kind: an open item now by its projection row.
CREATE OR REPLACE FUNCTION ob1_priority_item_exists(p_kind text, p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT CASE p_kind
    WHEN 'thought' THEN EXISTS (SELECT 1 FROM thoughts WHERE id = p_key::uuid)
    WHEN 'ticket'  THEN EXISTS (SELECT 1 FROM ob1_ticket_head WHERE issue_key = md5(p_key)::uuid AND issue = p_key)
    WHEN 'entity'  THEN EXISTS (SELECT 1 FROM ob1_entities WHERE id = p_key::uuid)
    WHEN 'item'    THEN EXISTS (SELECT 1 FROM open_items WHERE item_id = p_key::uuid)
    ELSE false
  END
$$;
COMMENT ON FUNCTION ob1_priority_item_exists(text, text) IS
  'Whether a normalised item exists: a thought or an entity by id, a ticket by its head row (068''s ob1_ticket_head), an open item by its open_items row (117), whatever its status. Migration 116 / SMD-3663; open items, migration 117 / SMD-3665.';

-- Whether a capture-only key owns an item: a thought it captured (116), an open
-- item it opened (117). Never a ticket or an entity. Never NULL.
CREATE OR REPLACE FUNCTION ob1_priority_owns_item(p_kind text, p_key text, p_agent uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT CASE p_kind
    WHEN 'thought' THEN ob1_priority_owns(p_key, p_agent)
    WHEN 'item'    THEN ob1_item_owns(p_key::uuid, p_agent)
    ELSE false
  END
$$;
COMMENT ON FUNCTION ob1_priority_owns_item(text, text, uuid) IS
  'Whether a capture-only key''s agent p_agent owns a normalised item: a thought it captured and nobody took (116''s ob1_priority_owns), an open item it opened and nobody else changed (117''s ob1_item_owns); false for a ticket, an entity, a NULL agent or an item that is not there — never NULL. Migration 117 / SMD-3665.';

-- assert_priority, as 116 wrote it but for the capture rule's kinds: an open
-- item a capture-only key owns is its own to state a priority on.
CREATE OR REPLACE FUNCTION assert_priority(
  p_kind         text,
  p_key          text,
  p_level        int,
  p_due_at       timestamptz DEFAULT NULL,
  p_not_before   timestamptz DEFAULT NULL,
  p_due_ref_kind text        DEFAULT NULL,
  p_due_ref_key  text        DEFAULT NULL,
  p_reason       text        DEFAULT NULL,
  p_inferred     boolean     DEFAULT false,
  p_actor        jsonb       DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_item     record := ob1_priority_item(p_kind, p_key);
  v_ref_kind text;
  v_ref_key  text;
  v_reason   text   := ob1_work_claim_text(p_reason, 1000, 'a reason');
  v_who      record;
  v_now      timestamptz;
  v_id       uuid   := gen_random_uuid();
  v_mine     boolean;
  v_tier     smallint;
  v_own      int;
  v_old      priority_assertions;
  v_row      priority_assertions;
  v_win      priority_assertions;
BEGIN
  IF p_level IS NULL OR p_level < 0 OR p_level > 5 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('a priority level is 0 (none) to 5 (critical); %s is not', COALESCE(p_level::text, 'NULL')),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_due_at IS NOT NULL AND p_not_before IS NOT NULL AND p_not_before > p_due_at THEN
    RAISE EXCEPTION USING MESSAGE = 'not_before is after due_at: the item could not start before it is due', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_due_ref_kind IS NULL) <> (p_due_ref_key IS NULL) THEN
    RAISE EXCEPTION USING MESSAGE = 'a due reference takes both a kind and a key, or neither', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_due_ref_kind IS NOT NULL THEN
    SELECT r.kind, r.key INTO v_ref_kind, v_ref_key FROM ob1_priority_item(p_due_ref_kind, p_due_ref_key) r;
    IF v_ref_kind = v_item.kind AND v_ref_key = v_item.key THEN
      RAISE EXCEPTION USING MESSAGE = 'an item''s due reference may not name itself', ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;
  PERFORM ob1_priority_isolation('assert_priority');
  SELECT * INTO v_who FROM ob1_priority_actor(p_actor, 'assert_priority');
  v_tier := ob1_priority_tier(p_inferred, v_who.source, v_who.trust);

  -- Fail closed: the envelope states a scope that may write, write or capture
  -- (116's review pass 1).
  IF v_who.scope IS DISTINCT FROM 'write' AND v_who.scope IS DISTINCT FROM 'capture' THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'READ_ONLY_KEY',
      'message', format('%s states no write or capture scope, so it may not state a priority', v_who.name),
      'assertion', NULL, 'replaced', NULL, 'winner', NULL);
  END IF;

  PERFORM ob1_priority_lock(v_item.kind, v_item.key);
  -- A capture-only key states a priority only on a thought its agent captured
  -- and nobody has taken (082), or an open item it opened and nobody else has
  -- changed (117), and takes its due time only from another such item. Asked
  -- once, under the item's lock and a share lock on the thoughts' and open
  -- items' rows (a take in flight is seen or waited for: an item writer locks
  -- its row first), and before any existence answer, refused alike for an item
  -- that is not there (116's review passes 1, 2 and 5). A ticket or an entity
  -- is refused first: its key is no thought's or open item's id.
  IF v_who.scope = 'capture' THEN
    IF v_item.kind NOT IN ('thought', 'item') OR (v_ref_kind IS NOT NULL AND v_ref_kind NOT IN ('thought', 'item')) THEN
      v_mine := false;
    ELSE
      PERFORM 1 FROM thoughts t
       WHERE t.id IN (CASE WHEN v_item.kind = 'thought' THEN v_item.key::uuid END, CASE WHEN v_ref_kind = 'thought' THEN v_ref_key::uuid END)
       FOR SHARE;
      PERFORM 1 FROM open_items i
       WHERE i.item_id IN (CASE WHEN v_item.kind = 'item' THEN v_item.key::uuid END, CASE WHEN v_ref_kind = 'item' THEN v_ref_key::uuid END)
       FOR SHARE;
      v_mine := ob1_priority_owns_item(v_item.kind, v_item.key, v_who.env_agent_id)
                AND (v_ref_kind IS NULL OR ob1_priority_owns_item(v_ref_kind, v_ref_key, v_who.env_agent_id));
    END IF;
    IF NOT v_mine THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'ITEM_NOT_YOURS',
        'message', format('%s is a capture-only key: it may state a priority only on a thought it captured or an open item it opened, and take a due time only from another', v_who.name),
        'assertion', NULL, 'replaced', NULL, 'winner', NULL);
    END IF;
  END IF;
  v_now := clock_timestamp();

  IF NOT ob1_priority_item_exists(v_item.kind, v_item.key) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'ITEM_NOT_FOUND',
      'message', format('no %s %s in this brain', CASE WHEN v_item.kind = 'item' THEN 'open item' ELSE v_item.kind END, v_item.key),
      'assertion', NULL, 'replaced', NULL, 'winner', NULL);
  END IF;
  IF v_ref_kind IS NOT NULL AND NOT ob1_priority_item_exists(v_ref_kind, v_ref_key) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'ITEM_NOT_FOUND',
      'message', format('the due reference names no %s %s in this brain', CASE WHEN v_ref_kind = 'item' THEN 'open item' ELSE v_ref_kind END, v_ref_key),
      'assertion', NULL, 'replaced', NULL, 'winner', NULL);
  END IF;

  -- The maker's open statements: one, but two where one was made by name before
  -- the key had an id and one after (both close below). The newest is v_old.
  SELECT count(*)::int INTO v_own FROM priority_assertions a
   WHERE a.item_kind = v_item.kind AND a.item_key = v_item.key AND a.closed_at IS NULL
     AND ob1_priority_is_maker(a, v_who.name, v_who.agent_id);
  SELECT * INTO v_old FROM priority_assertions a
   WHERE a.item_kind = v_item.kind AND a.item_key = v_item.key AND a.closed_at IS NULL
     AND ob1_priority_is_maker(a, v_who.name, v_who.agent_id)
   ORDER BY a.seq DESC LIMIT 1
   FOR UPDATE;

  -- The same statement again is no change (116's review passes 1 and 4).
  IF v_own = 1
     AND (v_old.level, v_old.due_at, v_old.not_before, v_old.due_ref_kind, v_old.due_ref_key, v_old.reason, v_old.inferred, v_old.tier,
          v_old.maker_name, v_old.maker_agent_id, v_old.maker_kind, v_old.maker_trust, v_old.maker_scope, v_old.maker_source)
         IS NOT DISTINCT FROM (p_level::smallint, p_due_at, p_not_before, v_ref_kind, v_ref_key, v_reason, COALESCE(p_inferred, false), v_tier,
                               v_who.name, v_who.agent_id, v_who.kind, v_who.trust, v_who.scope, v_who.source) THEN
    v_win := ob1_priority_winner(v_item.kind, v_item.key);
    RETURN jsonb_build_object('outcome', 'unchanged', 'code', NULL, 'message', NULL,
      'assertion', ob1_priority_json(v_old), 'replaced', NULL,
      'winner', CASE WHEN v_win.id IS NOT NULL AND v_who.scope = 'write' THEN ob1_priority_json(v_win) END);
  END IF;

  IF v_old.id IS NOT NULL THEN
    UPDATE priority_assertions a SET closed_at = v_now, close_reason = 'replaced', closed_by = v_id
     WHERE a.item_kind = v_item.kind AND a.item_key = v_item.key AND a.closed_at IS NULL
       AND ob1_priority_is_maker(a, v_who.name, v_who.agent_id);
    SELECT * INTO v_old FROM priority_assertions WHERE id = v_old.id;
  END IF;
  INSERT INTO priority_assertions (id, item_kind, item_key, level, due_at, not_before, due_ref_kind, due_ref_key, reason, inferred,
                                   maker_name, maker_agent_id, maker_kind, maker_trust, maker_scope, maker_source, tier, asserted_at)
  VALUES (v_id, v_item.kind, v_item.key, p_level, p_due_at, p_not_before, v_ref_kind, v_ref_key, v_reason, COALESCE(p_inferred, false),
          v_who.name, v_who.agent_id, v_who.kind, v_who.trust, v_who.scope, v_who.source, v_tier, v_now)
  RETURNING * INTO v_row;

  v_win := ob1_priority_project(v_item.kind, v_item.key);
  RETURN jsonb_build_object('outcome', 'asserted', 'code', NULL, 'message', NULL,
    'assertion', ob1_priority_json(v_row),
    'replaced', CASE WHEN v_old.id IS NOT NULL THEN ob1_priority_json(v_old) END,
    'winner', CASE WHEN v_win.id IS NOT NULL AND v_who.scope = 'write' THEN ob1_priority_json(v_win) END);
END;
$$;
COMMENT ON FUNCTION assert_priority(text, text, int, timestamptz, timestamptz, text, text, text, boolean, jsonb) IS
  'States that an item (p_kind thought, ticket, entity or item; p_key) matters at p_level (0 none to 5 critical), optionally due at p_due_at, not startable before p_not_before (never after p_due_at), or taking the due time of another item (p_due_ref_kind, p_due_ref_key), with p_reason; p_inferred lowers the maker''s tier to 4. The maker is the key p_actor names, its kind, trust, scope and source declaration the registry''s at the write, never an argument''s; its tier follows decision 4. The maker''s open assertion on the item, if any, closes as replaced; the same statement again is unchanged, nothing written. Returns jsonb {outcome: asserted | unchanged | refused, code, message, assertion, replaced, winner}: refused READ_ONLY_KEY (an envelope stating no write or capture scope), ITEM_NOT_YOURS (a capture-only key on anything but a thought its agent captured and nobody took or an open item it opened and nobody else changed, or a due reference to one — asked before existence, and answered alike for an item that is not there), or ITEM_NOT_FOUND (the item, or the due reference). The winner is shown to a write key alone. With both p_due_at and a due reference, p_due_at is the item''s due time (decision 5). Raises for no maker, a malformed argument, or a transaction above READ COMMITTED. Migration 116 / SMD-3663; open items, migration 117 / SMD-3665.';
