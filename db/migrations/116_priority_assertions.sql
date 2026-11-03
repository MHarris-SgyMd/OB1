-- =============================================================================
-- Migration 116: priority assertions — a key states how much an item matters,
--                by when and why, the maker and its trust stamped from the
--                key, every statement kept, and one winner per item by tier
--                (SMD-3663)
-- =============================================================================
--
-- WHY
--   No table held a priority. `metadata.priority` and `metadata.importance`
--   are free keys on a thought: whoever writes the row writes them, nothing
--   records who said so, and a capture-only key can set them on its own
--   captures to steer a shared read (SMD-2653). An item that is not a thought
--   — a ticket, an entity, an open item — had nowhere to put one.
--   docs/priority.md (SMD-3661) decided the model; this is its decisions 1, 2,
--   4 and 10 as tables and functions. The operations over REST and MCP are
--   SMD-3664's, the sources SMD-3666's, and the composed order SMD-3667's.
--
-- WHAT
--   1. AN ITEM is a typed reference, (item_kind, item_key) — decision 1:
--      * thought — a thought's id, lower-case;
--      * ticket  — an issue key, normalised as work_claims.issue is (115's
--                  ob1_work_claim_issue: upper-cased, SMD-3379's shape);
--      * entity  — an ob1_entities id;
--      * item    — an open item's id (SMD-3665). Refused until that kind's
--                  table exists: the write function checks that every item
--                  exists, and there is nothing yet to check this one against.
--      No registry table and no foreign key: an item may be a ticket nobody
--      synced yet as a row, and a projection must not hold a reference to a
--      row it does not own. The write function checks existence at the write
--      (a thought by id, a ticket by 068's ob1_ticket_head, an entity by id).
--
--   2. AN ASSERTION is one row of priority_assertions — decision 2:
--      * the item; the level, 0 none to 5 critical (decision 3: 1 low, 2
--        medium, 3 high, 4 urgent); due_at; not_before; due_ref (another item
--        whose due time it takes, never itself); a reason (free text, at most
--        1000 characters, cleaned as 115 cleans a label); `inferred`, the
--        maker lowering its own tier;
--      * THE MAKER, stamped from the call's actor envelope (ob1.actor, set
--        from p_actor, which the server passes for the key: 029's shape) and
--        never from an argument: the key's name and 061's agent id; its kind
--        from the registry (046's ob1_registry_kind — never the envelope's
--        own word for a kind or a trust); its trust, 046's
--        ob1_trust_ceiling of that kind (an unclassified key has none); its
--        scope as the envelope carries it (`capture` for a capture-only key,
--        082's reading); and whether the operator had declared it a priority
--        source. All as they stood at the write: a key reclassified since
--        keeps the tier its earlier statements were made at.
--      * THE TIER (decision 4), from the maker at the write:
--          1 operator  — operator trust, declared a source or not;
--          2 source    — a key the operator declared a priority source;
--          3 agent     — agent trust;
--          4 inferred  — flagged `inferred`, or ingested trust from an
--                        undeclared key, or a key with no trust at all.
--        A maker may lower its own tier (`inferred`), never raise it: the flag
--        is checked first, then operator trust, then the declaration, then
--        agent trust — so a declaration only raises a key, and an operator's
--        key declared a source (a default install's one key, serving board-sync
--        too) stays at tier 1 (review pass 3; decision 4's list orders it so,
--        where docs/priority.md's "A statement over MCP" puts the source first).
--      * TWO DUE TIMES: an assertion may carry due_at and a due reference
--        both; its own due_at wins, the reference's is read only where it has
--        none (decision 5: "the winning due_at, or else due_ref's").
--      * THE ORDER: seq, the order rows were written under the item's lock —
--        the history's order and what "newest" means; asserted_at is the
--        clock's, for display.
--      * THE WINDOW: asserted_at, and closed_at with close_reason — replaced
--        (closed_by names the assertion that replaced it) or cleared. A new
--        assertion by the same maker on the same item closes that maker's
--        open one, whatever tier either was made at (a key reclassified since
--        can still replace its own statement); clear_priority closes it with
--        none after. The maker is the key: its agent id, else its name
--        (maker_key). Rows never change but to close their window: a trigger
--        refuses any other UPDATE, a DELETE and a TRUNCATE, for the owner too
--        (046's rule for thought_audit). SMD-2011's pattern.
--
--   3. THE PROJECTION, priority_current: one row per item with an open
--      assertion — its winner (lowest tier, then newest within the tier, then
--      the later written), the winner's level, tier and maker, and the number of
--      open assertions. Kept current in the write's own transaction by the
--      write functions. ob1_priority_projection_drift() computes it fresh from
--      a formula of its own — not the rule function, which a verifier must not
--      share with the thing it verifies (068's rule) — and returns every row
--      that differs; ob1_rebuild_priority_projection() reconciles it. A raw
--      write to priority_assertions leaves the projection behind until a
--      rebuild: the functions are the write path.
--
--   4. THE SOURCES, priority_sources: the keys the operator declared priority
--      sources, beside set_agent_kind — declare_priority_source(label,
--      declared). One row per declaration, never rewritten; matched by the
--      agent's id (by label only where declared before the registry knew it). Server roles read the table and cannot write it, so
--      only a role the operator holds can declare one (decision 10, as 046's
--      ob1_agents UPDATE). A withdrawn declaration is kept with when; the
--      assertions made under it keep their tier.
--
--   5. WHO MAY ASSERT (decision 10), failing closed:
--      * the envelope must state its scope: `write` for any item, `capture`
--        for a capture-only key; any other scope, a read key's or none at
--        all, is refused (READ_ONLY_KEY). The server's envelopes carry a
--        scope only for a capture key today, so its operations (SMD-3664)
--        state `write` for a write key;
--      * a capture-only key only on a thought its agent captured and nobody
--        has taken since (082's ob1_capturer_of and ob1_thought_taken, by the
--        agent id the envelope itself carries — never one read by name — and
--        asked again under a share lock on the thoughts), and a due time only from another such
--        thought — never a ticket, an entity or another key's thought
--        (SMD-2617: it may not state a ticket's status either). Asked before
--        any existence answer and refused alike for an item that is not there
--        (ITEM_NOT_YOURS), so the refusal tells it nothing about what exists.
--        Its assertion takes its own trust's tier;
--      * an ingested key at tier 4 unless declared a source.
--      The refusals are outcomes, as an unknown item is (ITEM_NOT_FOUND); a
--      malformed argument, an envelope naming nobody and a transaction above
--      READ COMMITTED raise.
--   THE MAKER is the key: the envelope's agent id, else the registry's for
--   its name, else its name — so a key seen with its id and without it is one
--   maker, and a statement it made by name before it had an id is still its
--   own to replace or clear (115's is_holder rule). clear_priority never shows
--   a capture key the item's winner. THE SAME STATEMENT AGAIN (level, times, reference, reason, flag and
--   tier as the maker's open one) is answered `unchanged` and writes nothing,
--   so a source restating every pass adds no rows.
--
--   6. THE FUNCTIONS (SECURITY INVOKER, PUBLIC's EXECUTE as every core
--      function):
--      * assert_priority(p_kind, p_key, p_level, p_due_at, p_not_before,
--        p_due_ref_kind, p_due_ref_key, p_reason, p_inferred, p_actor):
--        jsonb {outcome: asserted | refused, code, message, assertion,
--        replaced, winner}.
--      * clear_priority(p_kind, p_key, p_actor): {outcome: cleared |
--        nothing_to_clear | refused, code, message, assertion, winner}.
--      * priority_of(p_items jsonb): for a JSON array of {kind, key}, one row
--        per item — the winner, every open assertion (the winner first, then
--        tier and newest), and the projection's level — in one query. An item
--        with none returns a row with a NULL winner: unknown, not low
--        (decision 3). STABLE.
--      * priority_history(p_kind, p_key): every assertion on the item, closed
--        ones included, oldest first. STABLE.
--      * declare_priority_source(p_label, p_declared): the operator's.
--      The assertion jsonb never carries anything that proves a key: its
--      maker's name, agent id, kind, trust, scope and source flag, as data.
--      WHO READS: priority_of and priority_history take no actor; any role
--      with EXECUTE reads every item's statements, reasons included. Which
--      keys may call them is the operations layer's (SMD-3664: read tools,
--      which a capture-only key is never given, as it is given no read tool
--      today). The writers keep their own replies to it: a capture key is
--      shown its own statement and never the winner, which may be another
--      key's (review passes 2 and 3).
--
--   7. CONCURRENCY. Each writer raises (0A000) above READ COMMITTED, then
--      takes a transaction advisory lock on its item
--      (hashtextextended('ob1:priority:' || kind || ':' || key, 0)) before it
--      reads, so two statements on one item never both stay open for one
--      maker (the partial unique index priority_assertions_one_open holds
--      that for a write made without the lock) and the projection is
--      reconciled after every write it saw. One writer call per transaction,
--      or take items in key order: two transactions locking two items in
--      opposite orders deadlock (40P01).
--
--   8. NOT THE EVENT LOG, DELETING AND FORGETTING. An item deleted (a
--      thought by delete_thought, an entity merged away) leaves its
--      assertions as they were, open ones included, and priority_of still
--      answers for it: closing them is SMD-3711, and removing a reason
--      SMD-1723's. An assertion is not a thought:
--      thought_audit is the thoughts' log. The table keeps its own history.
--      A reason is text and may hold personal data: forget_thought (SMD-1723)
--      has to reach the assertions on a forgotten item — they are the rows
--      WHERE (item_kind, item_key) = ('thought', <id>), and those whose
--      due_ref names it. The refusing trigger is what that ticket relaxes.
--
--   ob1:priority-maker-from-the-envelope, ob1:priority-tier and
--   ob1:priority-one-open-per-maker — CONTRACT SENTINELS, not prose (the 014
--   convention).
--
-- PRIVILEGES
--   The `priority` group (db/config.mjs ROLE_GRANTS): SELECT, INSERT and
--   UPDATE on priority_assertions (UPDATE to close a window, the trigger
--   refusing any other); SELECT, INSERT, UPDATE and DELETE on
--   priority_current (a projection row is replaced and removed); SELECT on
--   priority_sources, and nothing more, so a server role cannot declare a
--   source; SELECT on ob1_entities (an entity's existence), which otherwise
--   only the extraction group grants. The maker's kind is read from
--   ob1_agents, and a thought's and a ticket's existence from thoughts and
--   ob1_ticket_head — the capture group's SELECT. Soft: a role without the group gets a
--   permission error (42501) naming the table on the priority calls, and
--   nothing else. The server first calls them in SMD-3664, whose preflight
--   will check the group, as 115 left its group's to SMD-3598.
--
-- SAFETY
--   Three new tables, their indexes, two refusing triggers on the first;
--   nineteen functions (five calls, a drift check, a rebuild, the triggers'
--   function and eleven helpers);
--   nothing existing is changed. MINOR under FORK.md's version rules.
--   test-schema [104] (the rules), test-upgrade [20bh].
--
-- Prerequisites
--   008 (ob1_current_actor), 046 (ob1_registry_kind, ob1_trust_ceiling), 061
--   (ob1_actor_agent_id), 068 (ob1_ticket_head), 082 (ob1_capturer_of,
--   ob1_thought_taken), 115 (ob1_work_claim_text, ob1_work_claim_issue). Applied by `bun db/migrate.ts`. Re-applied: the
--   tables and their rows are kept, and the functions and trigger are
--   replaced as they were.
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
    ARRAY['ob1_work_claim_issue(text)', '115 (ob1_work_claim_issue)'],
    ARRAY['ob1_capturer_of(uuid)', '082 (ob1_capturer_of)'],
    ARRAY['ob1_thought_taken(uuid)', '082 (ob1_thought_taken)']];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_need, 1) LOOP
    IF to_regprocedure(v_need[i][1]) IS NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = format('migration 116 needs %s; this schema lacks it', v_need[i][2]),
        -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
        HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
        ERRCODE = 'invalid_schema_definition';
    END IF;
  END LOOP;
  IF to_regclass('ob1_ticket_head') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 116 needs 068 (ob1_ticket_head); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- The tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS priority_assertions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  item_kind       text        NOT NULL,
  item_key        text        NOT NULL,
  level           smallint    NOT NULL,
  due_at          timestamptz,
  not_before      timestamptz,
  due_ref_kind    text,
  due_ref_key     text,
  reason          text,
  inferred        boolean     NOT NULL DEFAULT false,
  maker_name      text        NOT NULL,
  maker_agent_id  uuid,
  maker_key       text        GENERATED ALWAYS AS (COALESCE(maker_agent_id::text, 'name:' || maker_name)) STORED,
  maker_kind      text,
  maker_trust     text,
  maker_scope     text,
  maker_source    boolean     NOT NULL,
  tier            smallint    NOT NULL,
  asserted_at     timestamptz NOT NULL,
  closed_at       timestamptz,
  close_reason    text,
  closed_by       uuid,
  CONSTRAINT priority_assertions_item_kind CHECK (item_kind IN ('thought', 'ticket', 'entity', 'item')),
  CONSTRAINT priority_assertions_item_key  CHECK (item_key <> '' AND length(item_key) <= 200),
  CONSTRAINT priority_assertions_level     CHECK (level BETWEEN 0 AND 5),
  CONSTRAINT priority_assertions_due_ref   CHECK ((due_ref_kind IS NULL) = (due_ref_key IS NULL)
                                                  AND (due_ref_kind IS NULL OR due_ref_kind IN ('thought', 'ticket', 'entity', 'item'))
                                                  AND NOT (due_ref_kind IS NOT DISTINCT FROM item_kind AND due_ref_key IS NOT DISTINCT FROM item_key)),
  CONSTRAINT priority_assertions_window    CHECK (due_at IS NULL OR not_before IS NULL OR not_before <= due_at),
  CONSTRAINT priority_assertions_reason    CHECK (reason IS NULL OR (reason <> '' AND length(reason) <= 1000 AND reason !~ '[[:cntrl:]]')),
  CONSTRAINT priority_assertions_maker     CHECK (maker_name <> '' AND length(maker_name) <= 200),
  CONSTRAINT priority_assertions_kind      CHECK (maker_kind IS NULL OR maker_kind IN ('operator', 'agent', 'ingested')),
  CONSTRAINT priority_assertions_trust     CHECK (maker_trust IS NULL OR maker_trust IN ('operator', 'agent', 'ingested')),
  CONSTRAINT priority_assertions_scope     CHECK (maker_scope IS NULL OR (maker_scope <> '' AND length(maker_scope) <= 40)),
  CONSTRAINT priority_assertions_tier      CHECK (tier BETWEEN 1 AND 4),
  CONSTRAINT priority_assertions_closed    CHECK ((closed_at IS NULL) = (close_reason IS NULL)
                                                  AND (close_reason IS NULL OR close_reason IN ('replaced', 'cleared'))
                                                  AND (closed_by IS NULL OR close_reason = 'replaced'))
);

COMMENT ON TABLE priority_assertions IS
  'One statement that an item matters at a level (0 none to 5 critical), optionally by a due time, from a start time, or by another item''s due time, with a reason, made by one key at one time (docs/priority.md decision 2). Append-only: a row changes only to close its window, when its maker replaces or clears it. The item is (item_kind, item_key): thought, ticket, entity or item. Written through assert_priority and clear_priority; read through priority_of and priority_history. Migration 116 / SMD-3663.';
COMMENT ON COLUMN priority_assertions.maker_name IS
  'The name the asserting call''s actor envelope (ob1.actor) carried: the key''s name. Stamped by assert_priority, never from an argument; the kind, trust and tier beside it are the registry''s at the write. Migration 116 / SMD-3663.';
COMMENT ON COLUMN priority_assertions.maker_key IS
  'The maker as one value: its agent id, else ''name:'' and its name. One key has at most one open assertion per item. Migration 116 / SMD-3663.';
COMMENT ON COLUMN priority_assertions.seq IS
  'The order rows were written, under each item''s lock: the history''s order, and what "newest" means — a clock''s resolution and its steps are not an order. Migration 116 / SMD-3663.';
COMMENT ON COLUMN priority_assertions.tier IS
  'Whose statement wins (decision 4): 1 operator (operator trust), 2 source (a key the operator declared a priority source), 3 agent (agent trust), 4 inferred (flagged inferred, ingested trust from an undeclared key, or no trust). Lower wins, then the newest within a tier (seq). Stamped at the write. Migration 116 / SMD-3663.';
COMMENT ON COLUMN priority_assertions.reason IS
  'Free text the maker gives, control characters made spaces, at most 1000 characters. Shown as data, trusted for nothing; may hold personal data, so forget_thought (SMD-1723) must reach the rows on a forgotten item. Migration 116 / SMD-3663.';

-- ob1:priority-one-open-per-maker
CREATE UNIQUE INDEX IF NOT EXISTS priority_assertions_one_open ON priority_assertions (item_kind, item_key, maker_key) WHERE closed_at IS NULL;
COMMENT ON INDEX priority_assertions_one_open IS
  'One open assertion per item and maker: what assert_priority''s replace keeps, held for a write made without its lock. Migration 116 / SMD-3663.';
CREATE INDEX IF NOT EXISTS priority_assertions_item ON priority_assertions (item_kind, item_key, seq);
COMMENT ON INDEX priority_assertions_item IS
  'An item''s assertions in the order they were made: priority_history, and the open ones priority_of reads. Migration 116 / SMD-3663.';

CREATE TABLE IF NOT EXISTS priority_current (
  item_kind     text        NOT NULL,
  item_key      text        NOT NULL,
  winner_id     uuid        NOT NULL,
  level         smallint    NOT NULL,
  tier          smallint    NOT NULL,
  maker_name    text        NOT NULL,
  asserted_at   timestamptz NOT NULL,
  open_count    int         NOT NULL,
  PRIMARY KEY (item_kind, item_key),
  CONSTRAINT priority_current_open CHECK (open_count >= 1)
);
COMMENT ON TABLE priority_current IS
  'The projection of priority_assertions: one row per item with an open assertion — its winner (lowest tier, then newest, then the later written), the winner''s level, tier and maker, and how many are open. Kept current by assert_priority and clear_priority in their own transaction; ob1_priority_projection_drift checks it and ob1_rebuild_priority_projection repairs it. Migration 116 / SMD-3663.';

CREATE TABLE IF NOT EXISTS priority_sources (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  label           text        NOT NULL,
  source_agent_id uuid,
  declared_at     timestamptz NOT NULL,
  withdrawn_at    timestamptz,
  CONSTRAINT priority_sources_label  CHECK (label <> '' AND length(label) <= 200 AND label = btrim(label)),
  CONSTRAINT priority_sources_window CHECK (withdrawn_at IS NULL OR withdrawn_at >= declared_at)
);
COMMENT ON TABLE priority_sources IS
  'The keys the operator declared priority sources (decision 4''s tier 2): board-sync for Linear, a plugin''s key. One row per declaration, closed by its withdrawal and never rewritten, so the history says when each key was a source. A declaration names the key''s label and, when the registry knows it, its agent id, which is what a maker is matched by — a renamed key stays a source, and a new key given the old name is not. Written only through declare_priority_source, which server roles cannot (they hold SELECT alone). The assertions made under a declaration keep their tier. Migration 116 / SMD-3663.';
CREATE UNIQUE INDEX IF NOT EXISTS priority_sources_one_standing ON priority_sources ((COALESCE(source_agent_id::text, 'label:' || label))) WHERE withdrawn_at IS NULL;
COMMENT ON INDEX priority_sources_one_standing IS
  'One standing declaration per key: by its agent id, by its label where declared before the registry knew it. The label is the name it had when declared. Migration 116 / SMD-3663.';

-- ---------------------------------------------------------------------------
-- Append-only, but for closing a window
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_priority_assertions_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Only an open row closing, once: every other column as it was.
    IF OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL
       AND (NEW.id, NEW.seq, NEW.item_kind, NEW.item_key, NEW.level, NEW.due_at, NEW.not_before, NEW.due_ref_kind, NEW.due_ref_key,
            NEW.reason, NEW.inferred, NEW.maker_name, NEW.maker_agent_id, NEW.maker_kind, NEW.maker_trust, NEW.maker_scope,
            NEW.maker_source, NEW.tier, NEW.asserted_at)
           IS NOT DISTINCT FROM
           (OLD.id, OLD.seq, OLD.item_kind, OLD.item_key, OLD.level, OLD.due_at, OLD.not_before, OLD.due_ref_kind, OLD.due_ref_key,
            OLD.reason, OLD.inferred, OLD.maker_name, OLD.maker_agent_id, OLD.maker_kind, OLD.maker_trust, OLD.maker_scope,
            OLD.maker_source, OLD.tier, OLD.asserted_at) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING
      MESSAGE = 'priority_assertions is append-only: a row changes only to close its window, once',
      ERRCODE = 'restrict_violation';
  END IF;
  RAISE EXCEPTION USING
    MESSAGE = format('priority_assertions is append-only: %s refused (a statement stays in the history; replace or clear it instead)', TG_OP),
    ERRCODE = 'restrict_violation';
END;
$$;
COMMENT ON FUNCTION ob1_priority_assertions_guard() IS
  'Refuses an UPDATE of priority_assertions other than an open row closing its window once (closed_at, close_reason, closed_by), every DELETE and TRUNCATE — for the owner too. SMD-1723 relaxes it for forgetting. Migration 116 / SMD-3663.';

DROP TRIGGER IF EXISTS priority_assertions_append_only ON priority_assertions;
CREATE TRIGGER priority_assertions_append_only
  BEFORE UPDATE OR DELETE ON priority_assertions
  FOR EACH ROW EXECUTE FUNCTION ob1_priority_assertions_guard();
DROP TRIGGER IF EXISTS priority_assertions_no_truncate ON priority_assertions;
CREATE TRIGGER priority_assertions_no_truncate
  BEFORE TRUNCATE ON priority_assertions
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_priority_assertions_guard();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- An item normalised, or a raise naming the input.
CREATE OR REPLACE FUNCTION ob1_priority_item(p_kind text, p_key text, OUT kind text, OUT key text)
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  kind := lower(btrim(COALESCE(p_kind, '')));
  IF kind NOT IN ('thought', 'ticket', 'entity', 'item') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('not an item kind: %L (thought, ticket, entity or item)', left(COALESCE(p_kind, ''), 40)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF kind = 'ticket' THEN
    key := ob1_work_claim_issue(p_key);
  ELSE
    key := lower(btrim(COALESCE(p_key, '')));
    IF key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION USING
        MESSAGE = format('not a %s id: %L (a uuid)', kind, left(COALESCE(p_key, ''), 80)),
        ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;
END;
$$;
COMMENT ON FUNCTION ob1_priority_item(text, text) IS
  'An item as (kind, key): kind thought, ticket, entity or item, lower-cased; a ticket''s key by ob1_work_claim_issue (115), any other a uuid lower-cased. Raises on anything else. Migration 116 / SMD-3663.';

-- Whether an item exists, by its kind. An open item (SMD-3665) has no table
-- yet, so none exists.
CREATE OR REPLACE FUNCTION ob1_priority_item_exists(p_kind text, p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT CASE p_kind
    WHEN 'thought' THEN EXISTS (SELECT 1 FROM thoughts WHERE id = p_key::uuid)
    WHEN 'ticket'  THEN EXISTS (SELECT 1 FROM ob1_ticket_head WHERE issue_key = md5(p_key)::uuid AND issue = p_key)
    WHEN 'entity'  THEN EXISTS (SELECT 1 FROM ob1_entities WHERE id = p_key::uuid)
    ELSE false
  END
$$;
COMMENT ON FUNCTION ob1_priority_item_exists(text, text) IS
  'Whether a normalised item exists: a thought or an entity by id, a ticket by its head row (068''s ob1_ticket_head). An open item (kind item) is false until SMD-3665 adds its table. Migration 116 / SMD-3663.';

-- The caller's envelope, set from p_actor when given (029's shape), and the
-- maker it names. Raises when it names nobody.
-- ob1:priority-maker-from-the-envelope
CREATE OR REPLACE FUNCTION ob1_priority_actor(p_actor jsonb, p_what text,
  OUT name text, OUT agent_id uuid, OUT env_agent_id uuid, OUT kind text, OUT trust text, OUT scope text, OUT source boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_env jsonb;
BEGIN
  IF p_actor IS NOT NULL THEN
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
  -- The envelope's agent id, else the registry's for the key's name: one key is
  -- one maker whether or not the server had resolved its id (review pass 1: a
  -- key seen once with its id and once without held two open statements).
  -- env_agent_id is the envelope's alone, what proves a capture key's thought:
  -- an id read by name proves nothing (review pass 2).
  env_agent_id := ob1_actor_agent_id();
  agent_id := COALESCE(env_agent_id, (SELECT a.canonical_agent_id FROM ob1_agents a WHERE a.label = name));
  -- The registry's word for the key, never the envelope's: an envelope that
  -- says "kind" or "trust" says nothing here (050's rule).
  kind := ob1_registry_kind(agent_id, name);
  trust := ob1_trust_ceiling(kind, NULL);
  scope := left(NULLIF(btrim(COALESCE(v_env->>'scope', '')), ''), 40);
  -- A standing declaration of this agent by its id; by the label only where
  -- the declaration was made before the registry knew the key (review pass 2:
  -- by label, a renamed source lost its tier and a new key given the old name
  -- gained it).
  source := EXISTS (
    SELECT 1 FROM priority_sources s
     WHERE s.withdrawn_at IS NULL
       AND CASE WHEN s.source_agent_id IS NOT NULL THEN s.source_agent_id = agent_id ELSE s.label = name END);
END;
$$;
COMMENT ON FUNCTION ob1_priority_actor(jsonb, text) IS
  'Sets ob1.actor from p_actor when given, then returns the envelope''s maker: name, its agent id (061''s from the envelope, else the registry''s for the name), the envelope''s own id alone (env_agent_id, what proves a capture key''s thought), 046''s registry kind and its trust ceiling, the envelope''s scope, and whether a standing declaration names it a priority source (by its agent id; by label where declared before the registry knew it). Raises naming p_what when the envelope names nobody or a name past 200 characters. Migration 116 / SMD-3663.';

-- Whether a capture-only key's agent captured this thought and nobody has
-- taken it since (082's reading: the capturer by agent id on the first capture
-- row, a take by another agent's update). By id, as the maker is: a renamed key
-- keeps its thoughts, and a key that once held the name gains none. No id, no
-- thought: refused, never guessed from a name.
CREATE OR REPLACE FUNCTION ob1_priority_owns(p_key text, p_agent uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  -- Never NULL: a thought that is not there has no capturer, and a NULL here
  -- read as "not refused" in assert_priority's NOT(...), which then answered
  -- ITEM_NOT_FOUND — the existence oracle this rule is asked first to close.
  SELECT COALESCE(p_agent IS NOT NULL AND ob1_capturer_of(p_key::uuid) = p_agent AND NOT ob1_thought_taken(p_key::uuid), false)
$$;
COMMENT ON FUNCTION ob1_priority_owns(text, uuid) IS
  'Whether the agent p_agent captured the thought p_key and no other agent has taken it since (082''s ob1_capturer_of and ob1_thought_taken): a capture-only key''s own thought. False, never NULL, for a NULL agent or a thought that is not there. Migration 116 / SMD-3663.';

-- Whether an assertion is this maker's own: made under its agent id, or by
-- its name alone before the key had an id (115's ob1_work_claim_is_holder
-- rule, review pass 2: a key whose id resolved after it asserted could no
-- longer replace or clear what it said). Never NULL.
CREATE OR REPLACE FUNCTION ob1_priority_is_maker(a priority_assertions, p_name text, p_agent uuid)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(CASE WHEN a.maker_agent_id IS NOT NULL THEN a.maker_agent_id = p_agent
                       ELSE a.maker_name = p_name END, false)
$$;
COMMENT ON FUNCTION ob1_priority_is_maker(priority_assertions, text, uuid) IS
  'True when the assertion is the maker''s own: one made under an agent id by that id, one made by name alone (no id then) by the name; false otherwise, never NULL. Migration 116 / SMD-3663.';

-- ob1:priority-tier
CREATE OR REPLACE FUNCTION ob1_priority_tier(p_inferred boolean, p_source boolean, p_trust text)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (CASE
    WHEN COALESCE(p_inferred, false) THEN 4   -- the maker lowers its own tier
    WHEN p_trust = 'operator'        THEN 1   -- before a declaration, which only raises (review pass 3)
    WHEN COALESCE(p_source, false)   THEN 2   -- declared by the operator
    WHEN p_trust = 'agent'           THEN 3
    ELSE 4                                    -- ingested and undeclared, or no trust at all
  END)::smallint
$$;
COMMENT ON FUNCTION ob1_priority_tier(boolean, boolean, text) IS
  'Decision 4''s tier at the write: 4 when the maker flags its assertion inferred (a maker may lower its tier, never raise it), 1 for operator trust, 2 for a declared priority source below that, 3 for agent trust, 4 otherwise (ingested trust from an undeclared key, or none). A declaration only raises: an operator-trust key declared a source stays at 1. Migration 116 / SMD-3663.';

-- One assertion as the functions return it.
CREATE OR REPLACE FUNCTION ob1_priority_json(a priority_assertions)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'id', a.id, 'item', jsonb_build_object('kind', a.item_kind, 'key', a.item_key),
    'level', a.level, 'due_at', a.due_at, 'not_before', a.not_before,
    'due_ref', CASE WHEN a.due_ref_kind IS NOT NULL THEN jsonb_build_object('kind', a.due_ref_kind, 'key', a.due_ref_key) END,
    'reason', a.reason, 'inferred', a.inferred,
    'maker', jsonb_build_object('name', a.maker_name, 'agent_id', a.maker_agent_id, 'kind', a.maker_kind,
                                'trust', a.maker_trust, 'scope', a.maker_scope, 'source', a.maker_source),
    'tier', a.tier, 'tier_name', (ARRAY['operator', 'source', 'agent', 'inferred'])[a.tier],
    'asserted_at', a.asserted_at, 'closed_at', a.closed_at, 'close_reason', a.close_reason, 'closed_by', a.closed_by)
$$;
COMMENT ON FUNCTION ob1_priority_json(priority_assertions) IS
  'One priority assertion as jsonb: id, item {kind, key}, level, due_at, not_before, due_ref, reason, inferred, maker {name, agent_id, kind, trust, scope, source}, tier and tier_name, asserted_at, closed_at, close_reason, closed_by. Migration 116 / SMD-3663.';

-- READ COMMITTED alone, checked before a writer reads anything (068's rule).
CREATE OR REPLACE FUNCTION ob1_priority_isolation(p_what text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('%s must run under READ COMMITTED; this transaction is %s', p_what, upper(current_setting('transaction_isolation'))),
      HINT = 'Under REPEATABLE READ or SERIALIZABLE its read of the assertions would predate its lock. BEGIN ISOLATION LEVEL READ COMMITTED; then call it.',
      ERRCODE = 'feature_not_supported';
  END IF;
END;
$$;
COMMENT ON FUNCTION ob1_priority_isolation(text) IS
  'Raises, naming p_what, in a transaction above READ COMMITTED: a priority write''s reads must postdate its lock. Migration 116 / SMD-3663.';

CREATE OR REPLACE FUNCTION ob1_priority_lock(p_kind text, p_key text)
RETURNS void
LANGUAGE sql
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('ob1:priority:' || p_kind || ':' || p_key, 0))
$$;
COMMENT ON FUNCTION ob1_priority_lock(text, text) IS
  'Takes the transaction advisory lock on one item''s assertions. Migration 116 / SMD-3663.';

-- The winner among an item's open assertions: lowest tier, then the newest —
-- the later written (seq), the order the writers took the item's lock in; a
-- clock that steps back moves asserted_at and nothing here. The rule; the
-- drift check has its own copy.
CREATE OR REPLACE FUNCTION ob1_priority_winner(p_kind text, p_key text)
RETURNS priority_assertions
LANGUAGE sql
STABLE
AS $$
  SELECT a.* FROM priority_assertions a
   WHERE a.item_kind = p_kind AND a.item_key = p_key AND a.closed_at IS NULL
   ORDER BY a.tier, a.seq DESC
   LIMIT 1
$$;
COMMENT ON FUNCTION ob1_priority_winner(text, text) IS
  'The winning open assertion on one item (decision 4): the lowest tier, then the newest within it — the later written (seq), the order the writers took the item''s lock in; NULL when none is open. Migration 116 / SMD-3663.';

-- The item's projection row made current: written, replaced or removed.
CREATE OR REPLACE FUNCTION ob1_priority_project(p_kind text, p_key text)
RETURNS priority_assertions
LANGUAGE plpgsql
AS $$
DECLARE
  w priority_assertions := ob1_priority_winner(p_kind, p_key);
  n int;
BEGIN
  IF w.id IS NULL THEN
    DELETE FROM priority_current WHERE item_kind = p_kind AND item_key = p_key;
    RETURN NULL;
  END IF;
  SELECT count(*)::int INTO n FROM priority_assertions WHERE item_kind = p_kind AND item_key = p_key AND closed_at IS NULL;
  INSERT INTO priority_current (item_kind, item_key, winner_id, level, tier, maker_name, asserted_at, open_count)
  VALUES (p_kind, p_key, w.id, w.level, w.tier, w.maker_name, w.asserted_at, n)
  ON CONFLICT (item_kind, item_key) DO UPDATE
     SET winner_id = EXCLUDED.winner_id, level = EXCLUDED.level, tier = EXCLUDED.tier,
         maker_name = EXCLUDED.maker_name, asserted_at = EXCLUDED.asserted_at, open_count = EXCLUDED.open_count;
  RETURN w;
END;
$$;
COMMENT ON FUNCTION ob1_priority_project(text, text) IS
  'Makes one item''s priority_current row current — its winner and open count, or no row when none is open — and returns the winner (NULL for none). Called by the writers under the item''s lock. Migration 116 / SMD-3663.';

-- ---------------------------------------------------------------------------
-- assert_priority
-- ---------------------------------------------------------------------------
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

  -- Fail closed: the envelope states a scope that may write, write or capture
  -- (review pass 1: a scope read from its absence let an envelope without one
  -- write anything — the server's own envelopes carry none for a write key,
  -- so its operations, SMD-3664, state it).
  IF v_who.scope IS DISTINCT FROM 'write' AND v_who.scope IS DISTINCT FROM 'capture' THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'READ_ONLY_KEY',
      'message', format('%s states no write or capture scope, so it may not state a priority', v_who.name),
      'assertion', NULL, 'replaced', NULL, 'winner', NULL);
  END IF;

  -- A capture-only key states a priority only on a thought its agent captured
  -- and nobody has taken (082), and takes its due time only from another such
  -- thought. Asked before any existence answer, and refused alike for an item
  -- that is not there, so the refusal tells it nothing about what exists
  -- (review pass 1).
  IF v_who.scope = 'capture' AND NOT (
       v_item.kind = 'thought' AND ob1_priority_owns(v_item.key, v_who.env_agent_id)
       AND (v_ref_kind IS NULL OR (v_ref_kind = 'thought' AND ob1_priority_owns(v_ref_key, v_who.env_agent_id)))) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'ITEM_NOT_YOURS',
      'message', format('%s is a capture-only key: it may state a priority only on a thought it captured, and take a due time only from another', v_who.name),
      'assertion', NULL, 'replaced', NULL, 'winner', NULL);
  END IF;

  PERFORM ob1_priority_lock(v_item.kind, v_item.key);
  -- Asked again under a share lock on the thoughts, so a take committing
  -- between the first reading and the write is seen, or waits (082's rule
  -- re-reads "taken" under a lock; review pass 2).
  IF v_who.scope = 'capture' THEN
    PERFORM 1 FROM thoughts t WHERE t.id IN (v_item.key::uuid, v_ref_key::uuid) FOR SHARE;
    IF NOT (ob1_priority_owns(v_item.key, v_who.env_agent_id)
            AND (v_ref_kind IS NULL OR ob1_priority_owns(v_ref_key, v_who.env_agent_id))) THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'ITEM_NOT_YOURS',
        'message', format('%s is a capture-only key: it may state a priority only on a thought it captured, and take a due time only from another', v_who.name),
        'assertion', NULL, 'replaced', NULL, 'winner', NULL);
    END IF;
  END IF;
  v_now := clock_timestamp();

  IF NOT ob1_priority_item_exists(v_item.kind, v_item.key) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'ITEM_NOT_FOUND',
      'message', CASE WHEN v_item.kind = 'item' THEN 'open items arrive with SMD-3665; none exists yet'
                      ELSE format('no %s %s in this brain', v_item.kind, v_item.key) END,
      'assertion', NULL, 'replaced', NULL, 'winner', NULL);
  END IF;
  IF v_ref_kind IS NOT NULL AND NOT ob1_priority_item_exists(v_ref_kind, v_ref_key) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'ITEM_NOT_FOUND',
      'message', format('the due reference names no %s %s in this brain', v_ref_kind, v_ref_key),
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

  -- The same statement again — level, times, reference, reason, flag and tier
  -- as the open one says — is no change: answered unchanged, nothing written,
  -- so a source restating its priority every pass (board-sync) adds no row
  -- and moves no "newest" (review pass 1).
  IF v_own = 1
     AND (v_old.level, v_old.due_at, v_old.not_before, v_old.due_ref_kind, v_old.due_ref_key, v_old.reason, v_old.inferred, v_old.tier)
         IS NOT DISTINCT FROM (p_level::smallint, p_due_at, p_not_before, v_ref_kind, v_ref_key, v_reason, COALESCE(p_inferred, false),
                               ob1_priority_tier(p_inferred, v_who.source, v_who.trust)) THEN
    -- The winner from the rule, as clear_priority reads it: never a stale or
    -- missing projection row's nulls (review pass 2).
    v_win := ob1_priority_winner(v_item.kind, v_item.key);
    RETURN jsonb_build_object('outcome', 'unchanged', 'code', NULL, 'message', NULL,
      'assertion', ob1_priority_json(v_old), 'replaced', NULL,
      'winner', CASE WHEN v_win.id IS NOT NULL AND v_who.scope = 'write' THEN ob1_priority_json(v_win) END);
  END IF;

  -- The maker's open one closes first, naming the id the new one is about to
  -- take: the unique index allows one open per maker at every moment.
  IF v_old.id IS NOT NULL THEN
    UPDATE priority_assertions a SET closed_at = v_now, close_reason = 'replaced', closed_by = v_id
     WHERE a.item_kind = v_item.kind AND a.item_key = v_item.key AND a.closed_at IS NULL
       AND ob1_priority_is_maker(a, v_who.name, v_who.agent_id);
    SELECT * INTO v_old FROM priority_assertions WHERE id = v_old.id;
  END IF;
  INSERT INTO priority_assertions (id, item_kind, item_key, level, due_at, not_before, due_ref_kind, due_ref_key, reason, inferred,
                                   maker_name, maker_agent_id, maker_kind, maker_trust, maker_scope, maker_source, tier, asserted_at)
  VALUES (v_id, v_item.kind, v_item.key, p_level, p_due_at, p_not_before, v_ref_kind, v_ref_key, v_reason, COALESCE(p_inferred, false),
          v_who.name, v_who.agent_id, v_who.kind, v_who.trust, v_who.scope, v_who.source,
          ob1_priority_tier(p_inferred, v_who.source, v_who.trust), v_now)
  RETURNING * INTO v_row;

  v_win := ob1_priority_project(v_item.kind, v_item.key);
  RETURN jsonb_build_object('outcome', 'asserted', 'code', NULL, 'message', NULL,
    'assertion', ob1_priority_json(v_row),
    'replaced', CASE WHEN v_old.id IS NOT NULL THEN ob1_priority_json(v_old) END,
    -- A capture key is shown no winner, as clear_priority shows it none: the
    -- winner may be another key's statement (review pass 3).
    'winner', CASE WHEN v_win.id IS NOT NULL AND v_who.scope = 'write' THEN ob1_priority_json(v_win) END);
END;
$$;
COMMENT ON FUNCTION assert_priority(text, text, int, timestamptz, timestamptz, text, text, text, boolean, jsonb) IS
  'States that an item (p_kind thought, ticket, entity or item; p_key) matters at p_level (0 none to 5 critical), optionally due at p_due_at, not startable before p_not_before (never after p_due_at), or taking the due time of another item (p_due_ref_kind, p_due_ref_key), with p_reason; p_inferred lowers the maker''s tier to 4. The maker is the key p_actor names, its kind, trust, scope and source declaration the registry''s at the write, never an argument''s; its tier follows decision 4. The maker''s open assertion on the item, if any, closes as replaced; the same statement again is unchanged, nothing written. Returns jsonb {outcome: asserted | unchanged | refused, code, message, assertion, replaced, winner}: refused READ_ONLY_KEY (an envelope stating no write or capture scope), ITEM_NOT_YOURS (a capture-only key on anything but a thought its agent captured and nobody took, or a due reference to one — asked before existence, and answered alike for an item that is not there), or ITEM_NOT_FOUND (the item, or the due reference). The winner is shown to a write key alone. With both p_due_at and a due reference, p_due_at is the item''s due time (decision 5). Raises for no maker, a malformed argument, or a transaction above READ COMMITTED. Migration 116 / SMD-3663.';

-- ---------------------------------------------------------------------------
-- clear_priority
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION clear_priority(
  p_kind  text,
  p_key   text,
  p_actor jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_item record := ob1_priority_item(p_kind, p_key);
  v_who  record;
  v_now  timestamptz;
  v_row  priority_assertions;
  v_win  priority_assertions;
BEGIN
  PERFORM ob1_priority_isolation('clear_priority');
  SELECT * INTO v_who FROM ob1_priority_actor(p_actor, 'clear_priority');
  IF v_who.scope IS DISTINCT FROM 'write' AND v_who.scope IS DISTINCT FROM 'capture' THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'READ_ONLY_KEY',
      'message', format('%s states no write or capture scope, so it may not clear a priority', v_who.name), 'assertion', NULL, 'winner', NULL);
  END IF;
  PERFORM ob1_priority_lock(v_item.kind, v_item.key);
  v_now := clock_timestamp();
  -- Only the caller's own: a maker clears what it stated, and nothing another
  -- key did — every open one, by id or by its name from before it had one.
  WITH closed AS (
    UPDATE priority_assertions a SET closed_at = v_now, close_reason = 'cleared'
     WHERE a.item_kind = v_item.kind AND a.item_key = v_item.key AND a.closed_at IS NULL
       AND ob1_priority_is_maker(a, v_who.name, v_who.agent_id)
    RETURNING a.*)
  SELECT * INTO v_row FROM closed ORDER BY seq DESC LIMIT 1;
  IF v_row.id IS NULL THEN
    v_win := ob1_priority_winner(v_item.kind, v_item.key);
  ELSE
    v_win := ob1_priority_project(v_item.kind, v_item.key);
  END IF;
  -- A capture key is shown no winner: its reply would otherwise read another
  -- key's statement — its reason, its maker — on any item, and say the item
  -- exists, which assert_priority's refusal keeps from it (review pass 2).
  RETURN jsonb_build_object('outcome', CASE WHEN v_row.id IS NULL THEN 'nothing_to_clear' ELSE 'cleared' END,
    'code', NULL, 'message', NULL,
    'assertion', CASE WHEN v_row.id IS NOT NULL THEN ob1_priority_json(v_row) END,
    'winner', CASE WHEN v_win.id IS NOT NULL AND v_who.scope = 'write' THEN ob1_priority_json(v_win) END);
END;
$$;
COMMENT ON FUNCTION clear_priority(text, text, jsonb) IS
  'Closes the caller''s own open assertion on an item as cleared, with none after; another key''s are untouched. Returns jsonb {outcome: cleared | nothing_to_clear | refused, code, message, assertion, winner}: refused READ_ONLY_KEY (an envelope stating no write or capture scope). The winner is shown to a write key alone, never to a capture key. The item need not exist (a statement on a thought since removed can still be cleared). Raises for no maker, a malformed item, or a transaction above READ COMMITTED. Migration 116 / SMD-3663.';

-- ---------------------------------------------------------------------------
-- priority_of / priority_history
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION priority_of(p_items jsonb)
RETURNS TABLE (item_kind text, item_key text, level smallint, winner jsonb, assertions jsonb)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION USING MESSAGE = 'priority_of takes a JSON array of {kind, key}', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_items) > 1000 THEN
    RAISE EXCEPTION USING MESSAGE = format('priority_of reads at most 1000 items at once; %s were given', jsonb_array_length(p_items)), ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  WITH asked AS (
    SELECT DISTINCT ON (n.kind, n.key) n.kind, n.key, e.ord
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS e(v, ord)
      CROSS JOIN LATERAL ob1_priority_item(e.v->>'kind', e.v->>'key') AS n
     ORDER BY n.kind, n.key, e.ord)
  SELECT q.kind, q.key, c.level,
         (SELECT ob1_priority_json(a) FROM priority_assertions a WHERE a.id = c.winner_id),
         COALESCE((SELECT jsonb_agg(ob1_priority_json(a) ORDER BY (a.id = c.winner_id) DESC, a.tier, a.seq DESC)
                     FROM priority_assertions a
                    WHERE a.item_kind = q.kind AND a.item_key = q.key AND a.closed_at IS NULL), '[]'::jsonb)
    FROM asked q
    LEFT JOIN priority_current c ON c.item_kind = q.kind AND c.item_key = q.key
   ORDER BY q.ord;
END;
$$;
COMMENT ON FUNCTION priority_of(jsonb) IS
  'For a JSON array of {kind, key} (at most 1000; an item asked twice answered once, at its first place), one row per item in the order asked: its kind and key normalised, the winning level, the winner, and every open assertion — the winner first, then by tier and newest. An item nobody stated a priority on has a NULL level and winner: unknown, not low (decision 3). The winner is the projection''s (priority_current). Raises on a malformed item. Migration 116 / SMD-3663.';

CREATE OR REPLACE FUNCTION priority_history(p_kind text, p_key text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(ob1_priority_json(a) ORDER BY a.seq), '[]'::jsonb)
    FROM ob1_priority_item(p_kind, p_key) i
    JOIN priority_assertions a ON a.item_kind = i.kind AND a.item_key = i.key
$$;
COMMENT ON FUNCTION priority_history(text, text) IS
  'Every assertion on one item, closed ones included, in the order written (seq), as a jsonb array: the record of who said it mattered and when that stopped. Raises on a malformed item. Migration 116 / SMD-3663.';

-- ---------------------------------------------------------------------------
-- declare_priority_source — the operator's, beside set_agent_kind
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION declare_priority_source(p_label text, p_declared boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_label    text := btrim(COALESCE(p_label, ''));
  v_agent    uuid;
  v_standing priority_sources;
  v_now      timestamptz := clock_timestamp();
BEGIN
  IF v_label = '' OR length(v_label) > 200 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_LABEL');
  END IF;
  -- The key the label names now, and its standing declaration by that key's
  -- id, as makers are matched — not by the label a declaration was made under
  -- (review pass 3: after a rename, withdrawing by the new name found nothing,
  -- and declaring a new key given the old name found the renamed key's row).
  v_agent := (SELECT a.canonical_agent_id FROM ob1_agents a WHERE a.label = v_label);
  SELECT * INTO v_standing FROM priority_sources s
   WHERE s.withdrawn_at IS NULL
     AND CASE WHEN v_agent IS NOT NULL THEN s.source_agent_id = v_agent OR (s.source_agent_id IS NULL AND s.label = v_label)
              ELSE s.source_agent_id IS NULL AND s.label = v_label END
   ORDER BY s.declared_at DESC LIMIT 1
   FOR UPDATE;
  IF COALESCE(p_declared, true) THEN
    -- A new declaration is a new row: a withdrawn one keeps its window (review pass 2).
    IF v_standing.id IS NULL THEN
      INSERT INTO priority_sources (label, source_agent_id, declared_at) VALUES (v_label, v_agent, v_now);
    END IF;
  ELSIF v_standing.id IS NOT NULL THEN
    UPDATE priority_sources SET withdrawn_at = v_now WHERE id = v_standing.id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'label', v_label, 'declared', COALESCE(p_declared, true),
    'was_declared', v_standing.id IS NOT NULL);
END;
$$;
COMMENT ON FUNCTION declare_priority_source(text, boolean) IS
  'The operator declares the key named label a priority source (p_declared true, the default) — a new row naming the label and, when the registry knows it, the agent''s id — or withdraws its standing declaration (false), which keeps its row with when. A declared key''s assertions take tier 2, between the operator''s and an agent''s. Server roles hold SELECT alone on priority_sources, so only a role the operator holds can call it — as set_agent_kind. Returns {ok, label, declared, was_declared}, or {ok: false, error: BAD_LABEL}. Migration 116 / SMD-3663.';

-- ---------------------------------------------------------------------------
-- The drift check and the rebuild (068's pattern)
-- ---------------------------------------------------------------------------

-- The winner's formula written again, independent of ob1_priority_winner:
-- what a verifier must not share with the thing it verifies.
CREATE OR REPLACE FUNCTION ob1_priority_projection_drift()
RETURNS TABLE (item_kind text, item_key text, stored text, fresh text)
LANGUAGE sql
STABLE
AS $$
  WITH open AS (
         SELECT a.item_kind, a.item_key, a.id, a.level, a.tier, a.maker_name, a.asserted_at,
                count(*) OVER (PARTITION BY a.item_kind, a.item_key) AS n,
                row_number() OVER (PARTITION BY a.item_kind, a.item_key ORDER BY a.tier ASC, a.seq DESC) AS rn
           FROM priority_assertions a WHERE a.closed_at IS NULL),
       fresh AS (SELECT * FROM open WHERE rn = 1)
  SELECT COALESCE(f.item_kind, c.item_kind), COALESCE(f.item_key, c.item_key),
         CASE WHEN c.item_kind IS NOT NULL THEN row(c.winner_id, c.level, c.tier, c.maker_name, c.asserted_at, c.open_count)::text END,
         CASE WHEN f.item_kind IS NOT NULL THEN row(f.id, f.level, f.tier, f.maker_name, f.asserted_at, f.n)::text END
    FROM fresh f FULL JOIN priority_current c ON c.item_kind = f.item_kind AND c.item_key = f.item_key
   WHERE (c.winner_id, c.level, c.tier, c.maker_name, c.asserted_at, c.open_count)
         IS DISTINCT FROM (f.id, f.level, f.tier, f.maker_name, f.asserted_at, f.n::int)
$$;
COMMENT ON FUNCTION ob1_priority_projection_drift() IS
  'Every item where priority_current differs from the winner computed fresh from priority_assertions — the item, the stored row and the fresh one as text, NULL where one side has none. Zero rows when exact. Its own copy of the winner''s rule, not ob1_priority_winner''s. Computes every item: a check, not a read path. Migration 116 / SMD-3663.';

CREATE OR REPLACE FUNCTION ob1_rebuild_priority_projection()
RETURNS TABLE (written int, deleted int)
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
BEGIN
  PERFORM ob1_priority_isolation('ob1_rebuild_priority_projection()');
  written := 0;
  deleted := 0;
  -- Item by item under each item's own lock, the writers' order: never a lock
  -- they would wait on in another order.
  FOR r IN SELECT DISTINCT d.item_kind, d.item_key FROM ob1_priority_projection_drift() d ORDER BY 1, 2 LOOP
    PERFORM ob1_priority_lock(r.item_kind, r.item_key);
    IF EXISTS (SELECT 1 FROM priority_assertions a WHERE a.item_kind = r.item_kind AND a.item_key = r.item_key AND a.closed_at IS NULL) THEN
      written := written + 1;
    ELSE
      deleted := deleted + 1;
    END IF;
    PERFORM ob1_priority_project(r.item_kind, r.item_key);
  END LOOP;
  RETURN NEXT;
END
$$;
COMMENT ON FUNCTION ob1_rebuild_priority_projection() IS
  'Reconciles every item the drift check names, each under its own lock, and returns how many rows it wrote and deleted — zeros when the projection was exact. Refuses to run outside READ COMMITTED. The repair after a raw write to priority_assertions. Migration 116 / SMD-3663.';
