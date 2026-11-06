-- =============================================================================
-- Migration 120: effective priority — one read that orders any item by its
--                stated level, the urgency of its due time, overdue, the open
--                items it blocks and the level it inherits from what it
--                serves, every term named (SMD-3667)
-- =============================================================================
--
-- WHY
--   116 keeps who said an item matters and at what level; priority_of answers
--   that and nothing more. A declared level alone doesn't order work: a
--   Medium bill due tomorrow outranks a High project with no date, an item
--   blocking three open items matters more than its label says, and a to-do
--   under an Urgent ticket inherits some of its weight. docs/priority.md
--   decision 5 composes those terms; this is that composition as a read.
--
--   The maintainer chose (SMD-3667, 2026-11-05) a read of its own beside
--   priority_of, not new columns on node_state: node_state covers thoughts
--   alone, and reshaping it would drop and recreate it under
--   search_thoughts_current, ticket_status_inputs and a pinned test. Every
--   term is computed at read time; urgency and overdue move with the clock in
--   any case. A projection of unblocks and inheritance follows only if the
--   timing asks for one.
--
-- WHAT
--   effective_priority(p_items jsonb, p_weights jsonb, p_now timestamptz):
--   for a JSON array of {kind, key} (at most 1000, as priority_of), one row
--   per item in the order asked, an item asked twice answered once:
--   * level — the counted winner's level: 116's rule (tier, then the newest),
--     tier 4 left out unless the weights say count_inferred (decision 5:
--     inferred assertions count only once SMD-3670's agreement clears its
--     bar). NULL is unknown.
--   * A TICKET'S OWN ROW (its linear source row, or a pre-053 row claiming
--     metadata.issue), asked as a thought, reads as its ticket — level, due
--     time, settledness, links, inheritance — and its first term names the
--     ticket (`as`). The maintainer's call, review pass 1: search over
--     thoughts must not rank a ticket's row below it. A served item or a
--     due reference that is a ticket's row is read as the ticket too.
--   * inherited_from — with no level of its own: the highest effective level
--     among the items it serves, less `hop` a hop, at most `hops` hops,
--     counted only above unknown's value, so a link never lowers an item. A
--     served item's effective level is its stated one when it states one, so
--     the walk goes past it only when it states none; a settled served item
--     passes nothing down and is not walked through (review pass 1). It
--     serves: a ticket, its parent (an active Linear child_of link); a
--     thought, the ticket it is about (metadata ticket, else issue, as
--     node_state reads them; else its standing ticket: subject, 111); an open
--     item, its origin thought. The spec it names waits for SMD-2683.
--   * due_at — the counted winner's due_at; else its due_ref's, one hop (the
--     referenced item's counted winner's due_at, its pool's for a ticket's
--     row, else an open item's own); else an open item's own due_at. due_from
--     says which. A referenced item since settled keeps its date (the
--     maintainer, review pass 2): an item that took a release's due time
--     reads overdue until it is restated.
--   * A ticket and its own rows are ONE item: the statements on each compete
--     by 116's rule as one pool (the maintainer, review pass 2).
--   * urgency — in CALENDAR DAYS in UTC (SMD-3778's review pass 2: a bare
--     date is due by the end of that day, so "tomorrow" is 24 to 48 hours
--     away and hours would miss it): `soon` (2) when due by the end of
--     tomorrow, `week` (1) by the end of the seventh day; `overdue` (3) in
--     their place once the due time has come, shown as overdue. Never for an
--     item at a stated level 0, nor a settled one.
--   * unblocks — the open items it blocks through active blocks / blocked_by
--     links in a gating system (node_dependencies()' reading), transitively to
--     `depth` hops, at most `cap` counted: `unblocks_one` (0.5) for at least
--     one, `unblocks_many` (1) for at least `unblocks_many_at` (3). A settled
--     item blocks nothing; a settled blocked item is not counted, nor walked
--     through.
--   * effective — the level (else the inherited value, else `unknown`, 2)
--     plus urgency plus the unblocks term.
--   * settled — a ticket whose status type node_settled_types() names
--     (completed, canceled, duplicate), a thought whose lifecycle is
--     (node_lifecycle), an open item done or dropped.
--   * not_before and waiting — the counted winner's not_before, and whether
--     it is still ahead: the agenda (SMD-3669) leaves a waiting item out.
--   * terms — each term that made the number, named, with what it read.
--   * winner and passed_over — the counted assertion, and every other open
--     one (decision 4: a read lists the assertions it didn't pick).
--   The weights are settings with defaults (docs/priority.md's table): a
--   jsonb of overrides, an unknown name or a value out of range refused
--   (22023). p_now is the clock, now() unless a caller (an eval, a test)
--   pins it.
--
--   Helpers: ob1_priority_counted (the counted winner), ob1_item_settled,
--   ob1_item_serves (one hop of what an item serves), ob1_node_settled (a
--   source identity's settledness), ob1_ticket_row_of (the ticket a thought
--   is the row of), ob1_ticket_rows (a ticket's rows), ob1_priority_subject
--   (what an item is read as), ob1_priority_open (its pool of open
--   statements) and ob1_item_unblocks (the walk, one frontier a hop).
--
-- WHO READS
--   No actor, as priority_of: any role with EXECUTE reads every item's terms.
--   It reads priority_assertions and open_items (the priority group grants
--   both), thoughts and ob1_ticket_head (the capture group's), and
--   thought_sources and thought_facets (the server group's, which the
--   structure group grants too), and ob1_source_gate through
--   ob1_system_gates (the capture group's). The server's role holds all of them. A role
--   short of one gets 42501 naming the table: one without thought_sources on
--   any ticket or thought, since a thought is asked whether it is a ticket's
--   row (review pass 2: this said the reverse). No grant changes.
--
-- SAFETY
--   Ten new functions; no table, and nothing existing changed. Every function
--   is STABLE: one snapshot for the whole read. MINOR under FORK.md's version
--   rules. test-schema [108], test-upgrade [20bl].
--
-- Prerequisites
--   053 (thought_sources, link facets), 058 (node_settled_types), 068
--   (ob1_ticket_head, node_lifecycle), 071 (ob1_system_gates), 116
--   (priority_assertions, ob1_priority_item, ob1_priority_json), 117
--   (open_items). Applied by `bun db/migrate.ts`. Re-applied: the functions
--   are replaced as they were.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
DECLARE
  v_need text[][] := ARRAY[
    ARRAY['node_settled_types()', '058 (node_settled_types)'],
    ARRAY['node_lifecycle()', '068 (node_lifecycle)'],
    ARRAY['ob1_system_gates(text)', '071 (ob1_system_gates)'],
    ARRAY['ob1_priority_item(text, text)', '116 (ob1_priority_item)'],
    ARRAY['ob1_priority_json(priority_assertions)', '116 (ob1_priority_json)']];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_need, 1) LOOP
    IF to_regprocedure(v_need[i][1]) IS NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = format('migration 120 needs %s; this schema lacks it', v_need[i][2]),
        -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
        HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
        ERRCODE = 'invalid_schema_definition';
    END IF;
  END LOOP;
  IF to_regclass('open_items') IS NULL OR to_regclass('ob1_ticket_head') IS NULL OR to_regclass('thought_sources') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 120 needs 053, 068 and 117 (thought_sources, ob1_ticket_head, open_items); this schema lacks one',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- ob1_ticket_row_of — the ticket a thought is the row of
-- ---------------------------------------------------------------------------
-- A ticket's own row: its linear source row (053), else, on a brain board-sync
-- filled before 053, the row claiming metadata.issue with source linear
-- (source_thought's fallback). An observation filed under a ticket carries
-- `ticket`, not `issue`, and is not its row.
CREATE OR REPLACE FUNCTION ob1_ticket_row_of(p_thought uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  -- A ticket key as 115 normalises it, upper-case: ob1_ticket_rows matches
  -- these exactly, so a row is mapped only when it would be found in its
  -- ticket's pool (review pass 3: a lower-case row mapped to the upper-case
  -- ticket and lost its own statements).
  c_key CONSTANT text := '^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,9}$';
  v text;
BEGIN
  SELECT s.identity INTO v FROM thought_sources s WHERE s.thought_id = p_thought AND s.system = 'linear';
  -- A source identity that is no ticket key falls through to metadata.issue,
  -- as ob1_ticket_rows reads both (review pass 3).
  IF v IS NULL OR v !~ c_key THEN
    SELECT t.metadata->>'issue' INTO v FROM thoughts t WHERE t.id = p_thought AND t.metadata->'source' = '"linear"'::jsonb;
  END IF;
  IF v ~ c_key THEN
    RETURN v;
  END IF;
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION ob1_ticket_row_of(uuid) IS
  'The ticket key a thought is the own row of — its linear source row''s identity when that is a ticket key, else metadata.issue on a row whose source is linear — only in 115''s upper-case form, as ob1_ticket_rows matches it; NULL for any other thought (an observation filed under a ticket carries `ticket`, not `issue`). effective_priority reads such a row as its ticket. Migration 120 / SMD-3667.';

-- ---------------------------------------------------------------------------
-- ob1_ticket_rows — a ticket's own rows
-- ---------------------------------------------------------------------------
-- ROWS 2: a ticket has a row or two, and the default estimate of 1000 led
-- the planner to hash every open thought statement for each ticket read
-- (review pass 3: 1,000 tickets in 6 s at 20,000 thought statements).
CREATE OR REPLACE FUNCTION ob1_ticket_rows(p_issue text)
RETURNS SETOF text
LANGUAGE plpgsql
STABLE
ROWS 2
AS $$
BEGIN
  -- Its linear source row (053), and any row claiming metadata.issue with
  -- source linear (a pre-053 row, a twin), by 068's issue index.
  RETURN QUERY
    SELECT s.thought_id::text FROM thought_sources s WHERE s.system = 'linear' AND s.identity = p_issue
    UNION
    SELECT t.id::text FROM thoughts t
     WHERE t.metadata ? 'issue' AND md5(t.metadata->>'issue')::uuid = md5(p_issue)::uuid
       AND t.metadata->'issue' = to_jsonb(p_issue) AND t.metadata->'source' = '"linear"'::jsonb
       -- Not the row of another ticket: ob1_ticket_row_of reads a linear
       -- source identity that is a ticket key first (review pass 4: one
       -- statement won two tickets' pools).
       AND NOT EXISTS (SELECT 1 FROM thought_sources o WHERE o.thought_id = t.id AND o.system = 'linear'
                         AND o.identity ~ '^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,9}$' AND o.identity <> p_issue);
END;
$$;
COMMENT ON FUNCTION ob1_ticket_rows(text) IS
  'A ticket''s own rows, as thought ids: its linear source row (053), and every row claiming metadata.issue with source linear (by 068''s issue index) that is not another ticket''s row by its linear source identity. The thoughts whose statements count as the ticket''s in effective_priority. Migration 120 / SMD-3667.';

-- ---------------------------------------------------------------------------
-- ob1_priority_subject — what an item is read as
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_priority_subject(p_kind text, p_key text, OUT kind text, OUT key text)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v text;
BEGIN
  kind := p_kind; key := p_key;
  IF p_kind = 'thought' THEN
    v := ob1_ticket_row_of(p_key::uuid);
    IF v IS NOT NULL THEN
      kind := 'ticket'; key := v;
    END IF;
  END IF;
END;
$$;
COMMENT ON FUNCTION ob1_priority_subject(text, text) IS
  'What a normalised item is read as: a ticket''s own row (ob1_ticket_row_of) as its ticket, any other item as itself. Migration 120 / SMD-3667.';

-- ---------------------------------------------------------------------------
-- ob1_priority_open — an item's open statements, its ticket's pool for a ticket
-- ---------------------------------------------------------------------------
-- A ticket and its own rows are one item (the maintainer, review pass 2):
-- the statements on the ticket and on each of its rows compete by 116's rule
-- as one pool, so a tier-4 statement on the row never outranks a tier-1 one on
-- the ticket. Any other item's are its own.
CREATE OR REPLACE FUNCTION ob1_priority_open(p_kind text, p_key text)
RETURNS SETOF priority_assertions
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  s record;
BEGIN
  s := ob1_priority_subject(p_kind, p_key);
  IF s.kind = 'ticket' THEN
    RETURN QUERY
      SELECT a.* FROM priority_assertions a
       WHERE a.closed_at IS NULL AND a.item_kind = 'ticket' AND a.item_key = s.key
      UNION ALL
      -- Probed by key (priority_assertions_item), the rows read first as an
      -- array; the asked thought itself always counts.
      SELECT a.* FROM priority_assertions a
       WHERE a.closed_at IS NULL AND a.item_kind = 'thought'
         AND a.item_key = ANY(ARRAY(SELECT r FROM ob1_ticket_rows(s.key) r) || CASE WHEN p_kind = 'thought' THEN ARRAY[p_key] ELSE '{}'::text[] END);
  ELSE
    RETURN QUERY
      SELECT a.* FROM priority_assertions a WHERE a.closed_at IS NULL AND a.item_kind = p_kind AND a.item_key = p_key;
  END IF;
END;
$$;
COMMENT ON FUNCTION ob1_priority_open(text, text) IS
  'A normalised item''s open assertions: for a ticket or a ticket''s own row, the pool of the ticket''s and every row''s (one item, review pass 2); for any other item, its own. Migration 120 / SMD-3667.';

-- ---------------------------------------------------------------------------
-- ob1_priority_counted — the winner a composed read counts
-- ---------------------------------------------------------------------------
-- 116's rule (ob1_priority_winner: the lowest tier, then the later written)
-- over the item's pool (ob1_priority_open), each maker's newest statement
-- alone, with tier 4 left out unless p_inferred: decision 5 counts inferred
-- assertions only once SMD-3670's agreement clears its bar. All NULL for none.
--
-- Each maker's newest: 116 keeps one open statement per maker on one (kind,
-- key), and a maker's new statement replaces its old whatever the tier of
-- either. The pool joins a ticket and its rows, where one maker may hold one
-- open on each; its newest is its stance (the maintainer, review pass 5). A
-- clear still reaches only the item it names, so a maker's older statement on
-- the row stands again once its newer one on the ticket is cleared: 116's
-- writers closing across a ticket and its rows is SMD-4127.
CREATE OR REPLACE FUNCTION ob1_priority_counted(p_kind text, p_key text, p_inferred boolean)
RETURNS priority_assertions
LANGUAGE sql
STABLE
AS $$
  SELECT o.* FROM (SELECT DISTINCT ON (p.maker_key) p.* FROM ob1_priority_open(p_kind, p_key) p ORDER BY p.maker_key, p.seq DESC) o
   WHERE p_inferred OR o.tier < 4
   ORDER BY o.tier, o.seq DESC
   LIMIT 1
$$;
COMMENT ON FUNCTION ob1_priority_counted(text, text, boolean) IS
  'The open assertion a composed read counts for a normalised item: 116''s rule (the lowest tier, then the later written) over its pool (ob1_priority_open: a ticket and its rows as one), each maker''s newest statement alone, tier 4 (inferred) left out unless p_inferred (docs/priority.md decision 5). All NULL for none. Migration 120 / SMD-3667.';

-- ---------------------------------------------------------------------------
-- ob1_item_settled — whether an item is done with
-- ---------------------------------------------------------------------------
-- plpgsql, one branch per kind, so each kind's table is read, and its
-- privilege checked, only for that kind (a SQL function's CASE checks every
-- branch's table on every call: 117's review pass 2).
CREATE OR REPLACE FUNCTION ob1_item_settled(p_kind text, p_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_kind = 'ticket' THEN
    RETURN COALESCE((SELECT h.status_type = ANY(node_settled_types()) FROM ob1_ticket_head h
                      WHERE h.issue_key = md5(p_key)::uuid AND h.issue = p_key), false);
  ELSIF p_kind = 'thought' THEN
    RETURN COALESCE((SELECT l.status_type = ANY(node_settled_types()) FROM node_lifecycle() l WHERE l.thought_id = p_key::uuid), false);
  ELSIF p_kind = 'item' THEN
    RETURN COALESCE((SELECT i.status IN ('done', 'dropped') FROM open_items i WHERE i.item_id = p_key::uuid), false);
  END IF;
  RETURN false;
END;
$$;
COMMENT ON FUNCTION ob1_item_settled(text, text) IS
  'Whether a normalised item is settled: a ticket whose head (068) has a settled status type (node_settled_types: completed, canceled, duplicate), a thought whose lifecycle is (node_lifecycle: its ticket''s head, else its own status), an open item done or dropped. An entity, and an item the brain does not hold, is not. Migration 120 / SMD-3667.';

-- ---------------------------------------------------------------------------
-- ob1_node_settled — whether a source identity is settled
-- ---------------------------------------------------------------------------
-- A blocked end of a link is a (system, identity): a Linear ticket by its
-- head, any other by the thought source_thought resolves it to. Unknown
-- status is open, as 071 counts a blocker with no known status.
CREATE OR REPLACE FUNCTION ob1_node_settled(p_system text, p_identity text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_system = 'linear' THEN
    RETURN COALESCE((SELECT h.status_type = ANY(node_settled_types()) FROM ob1_ticket_head h
                      WHERE h.issue_key = md5(p_identity)::uuid AND h.issue = p_identity), false);
  END IF;
  RETURN COALESCE((SELECT l.status_type = ANY(node_settled_types()) FROM node_lifecycle() l
                    WHERE l.thought_id = source_thought(p_system, p_identity)), false);
END;
$$;
COMMENT ON FUNCTION ob1_node_settled(text, text) IS
  'Whether a source identity is settled: a linear one by its ticket head (068), any other by the lifecycle of the thought source_thought resolves it to. Unknown is open. Migration 120 / SMD-3667.';

-- ---------------------------------------------------------------------------
-- ob1_item_serves — one hop of what an item serves
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_item_serves(p_kind text, p_key text)
RETURNS TABLE (kind text, key text)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_ticket text;
BEGIN
  IF p_kind = 'ticket' THEN
    -- Its parent: an active Linear child_of link its linear source row holds
    -- (links count through thought_sources alone, as 071 reads them).
    RETURN QUERY
      SELECT DISTINCT 'ticket'::text, upper(f.payload->>'target')
        FROM thought_sources h
        JOIN thought_facets f ON f.thought_id = h.thought_id AND f.kind = 'link' AND f.valid_until IS NULL
                             AND f.payload->>'system' = 'linear' AND f.payload->>'relation' = 'child_of'
       WHERE h.system = 'linear' AND h.identity = p_key
         AND f.payload->>'target' ~ '^[A-Za-z][A-Za-z0-9]{1,15}-[1-9][0-9]{0,9}$'
         AND upper(f.payload->>'target') <> p_key;
  ELSIF p_kind = 'thought' THEN
    -- The ticket it is about: metadata ticket, else issue (node_state's
    -- reading); else its standing ticket: subject (111).
    -- Each in turn, the first that is a ticket key (review pass 2: a
    -- malformed metadata.ticket hid a valid issue and the subject).
    SELECT CASE WHEN t.metadata->>'ticket' ~ '^[A-Za-z][A-Za-z0-9]{1,15}-[1-9][0-9]{0,9}$' THEN t.metadata->>'ticket'
                WHEN t.metadata->>'issue' ~ '^[A-Za-z][A-Za-z0-9]{1,15}-[1-9][0-9]{0,9}$' THEN t.metadata->>'issue' END
      INTO v_ticket FROM thoughts t WHERE t.id = p_key::uuid;
    IF v_ticket IS NULL THEN
      SELECT substr(f.payload->>'key', 8) INTO v_ticket
        FROM thought_facets f
       WHERE f.thought_id = p_key::uuid AND f.kind = 'subject' AND f.valid_until IS NULL AND f.payload->>'key' LIKE 'ticket:%'
         AND substr(f.payload->>'key', 8) ~ '^[A-Za-z][A-Za-z0-9]{1,15}-[1-9][0-9]{0,9}$'
       LIMIT 1;
    END IF;
    IF v_ticket ~ '^[A-Za-z][A-Za-z0-9]{1,15}-[1-9][0-9]{0,9}$' THEN
      kind := 'ticket'; key := upper(v_ticket);
      RETURN NEXT;
    END IF;
  ELSIF p_kind = 'item' THEN
    -- Its origin thought.
    RETURN QUERY
      SELECT 'thought'::text, i.origin_thought_id::text FROM open_items i
       WHERE i.item_id = p_key::uuid AND i.origin_thought_id IS NOT NULL;
  END IF;
END;
$$;
COMMENT ON FUNCTION ob1_item_serves(text, text) IS
  'One hop of what a normalised item serves, for inheritance (docs/priority.md''s weights table): a ticket, its parent (an active Linear child_of link its linear source row holds); a thought, the ticket it is about (metadata ticket, else issue, as node_state reads them; else its standing ticket: subject, 111); an open item, its origin thought. An entity serves nothing yet; the spec an item names waits for SMD-2683. Migration 120 / SMD-3667.';

-- ---------------------------------------------------------------------------
-- ob1_item_unblocks — the open items an item blocks, walked
-- ---------------------------------------------------------------------------
-- From the item's source identities (a ticket: linear and its key; a thought:
-- its thought_sources row), along active blocks / blocked_by links in a
-- gating system (node_dependencies()' reading: a blocks facet names its holder
-- the blocker, a blocked_by facet its target), to p_depth hops, never through
-- a settled item; distinct blocked identities, at most p_cap. An open item and
-- an entity hold no links.
--
-- One frontier a hop, every identity seen kept: a node is reached once,
-- however many paths lead to it. A recursive query carrying each path read
-- every path instead — a ticket blocking 20 that each block the same 20,
-- four layers deep, took 120 ms at depth 3 and 2.4 s at depth 4 (review
-- pass 1). A key is system:identity; a system holds no colon (053's CHECK),
-- so the first colon splits it.
CREATE OR REPLACE FUNCTION ob1_item_unblocks(p_kind text, p_key text, p_depth int, p_cap int)
RETURNS int
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_count    int := 0;
  v_seen     text[];
  v_sys      text[];
  v_id       text[];
  v_next_sys text[];
  v_next_id  text[];
  d          int;
BEGIN
  IF p_kind NOT IN ('ticket', 'thought') OR p_depth < 1 OR p_cap < 1 THEN
    RETURN 0;
  END IF;
  IF p_kind = 'ticket' THEN
    v_sys := ARRAY['linear']; v_id := ARRAY[p_key];
  ELSE
    SELECT array_agg(s.system), array_agg(s.identity) INTO v_sys, v_id FROM thought_sources s WHERE s.thought_id = p_key::uuid;
  END IF;
  IF v_sys IS NULL THEN
    RETURN 0;
  END IF;
  SELECT array_agg(f.system || ':' || f.identity) INTO v_seen FROM unnest(v_sys, v_id) AS f(system, identity);
  FOR d IN 1 .. p_depth LOOP
    SELECT array_agg(n.system), array_agg(n.blocked) INTO v_next_sys, v_next_id
      FROM (SELECT DISTINCT b.system, b.blocked
              FROM unnest(v_sys, v_id) AS w(system, identity)
              CROSS JOIN LATERAL (
                -- A blocks link w's own row holds: its target is blocked.
                SELECT h.system, f.payload->>'target' AS blocked
                  FROM thought_sources h
                  JOIN thought_facets f ON f.thought_id = h.thought_id AND f.kind = 'link' AND f.valid_until IS NULL
                                       AND f.payload->>'system' = h.system AND f.payload->>'relation' = 'blocks'
                 WHERE h.system = w.system AND h.identity = w.identity
                UNION
                -- A blocked_by link naming w: its holder is blocked.
                SELECT s.system, s.identity
                  FROM thought_facets f
                  JOIN thought_sources s ON s.thought_id = f.thought_id AND s.system = f.payload->>'system'
                 WHERE f.kind = 'link' AND f.valid_until IS NULL AND f.payload->>'relation' = 'blocked_by'
                   AND f.payload->>'system' = w.system AND f.payload->>'target' = w.identity) b
             WHERE NOT (b.system || ':' || b.blocked) = ANY(v_seen)) n
      -- A Linear blocked item's head joined here, not asked a call apiece.
      LEFT JOIN ob1_ticket_head th ON n.system = 'linear' AND th.issue_key = md5(n.blocked)::uuid AND th.issue = n.blocked
     WHERE ob1_system_gates(n.system)
       AND NOT CASE WHEN n.system = 'linear' THEN COALESCE(th.status_type = ANY(node_settled_types()), false)
                    ELSE ob1_node_settled(n.system, n.blocked) END;
    EXIT WHEN v_next_sys IS NULL;
    v_count := v_count + cardinality(v_next_sys);
    EXIT WHEN v_count >= p_cap;
    SELECT v_seen || array_agg(f.system || ':' || f.identity) INTO v_seen FROM unnest(v_next_sys, v_next_id) AS f(system, identity);
    v_sys := v_next_sys; v_id := v_next_id;
  END LOOP;
  RETURN least(v_count, p_cap);
END;
$$;
COMMENT ON FUNCTION ob1_item_unblocks(text, text, int, int) IS
  'How many open items a normalised item blocks: from its source identities (a ticket''s linear key, a thought''s thought_sources row), along active blocks / blocked_by links in a gating system (node_dependencies()'' reading), transitively to p_depth hops, never through a settled item (ob1_node_settled); each identity counted once, however many paths reach it, at most p_cap. 0 for an open item or an entity, which hold no links. Migration 120 / SMD-3667.';

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
  -- docs/priority.md's starting weights.
  c_defaults CONSTANT jsonb := '{"unknown": 2, "hop": 1, "hops": 2, "soon": 2, "soon_days": 1, "week": 1, "week_days": 7, "overdue": 3,
                                 "unblocks_one": 0.5, "unblocks_many": 1, "unblocks_many_at": 3, "depth": 3, "cap": 50, "count_inferred": false}';
  -- cap 50: the term is decided at unblocks_many_at, and the count past it is
  -- only shown; the walk stops at the frontier that reaches the cap (review
  -- pass 4: a board whose tickets each block ten took 6.5 s for 1,000 items
  -- counting to a thousand).
  v_w        jsonb;
  v_bad      text;
  w_unknown numeric; w_hop numeric; w_hops int; w_soon numeric; w_soon_days int; w_week numeric; w_week_days int; w_overdue numeric;
  w_one numeric; w_many numeric; w_many_at int; w_depth int; w_cap int; w_inferred boolean;
  v_today    date;
  v_soon_by  timestamptz;
  v_week_by  timestamptz;
  q          record;
  v_win      priority_assertions;
  v_ref      priority_assertions;
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
    IF ((c_defaults || COALESCE(p_weights, '{}'))->>'cap')::numeric < ((c_defaults || COALESCE(p_weights, '{}'))->>'unblocks_many_at')::numeric THEN
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

    -- The level, else the inherited level, else unknown's value.
    IF v_win.id IS NOT NULL THEN
      v_base := v_win.level;
      v_terms := v_terms || jsonb_build_object('term', 'level', 'value', v_base, 'level', v_win.level, 'tier', v_win.tier, 'maker', v_win.maker_name);
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
          CONTINUE WHEN (h1.kind = s_kind AND h1.key = s_key) OR ob1_item_settled(h1.kind, h1.key);
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
            CONTINUE WHEN (h.kind = s_kind AND h.key = s_key) OR ob1_item_settled(h.kind, h.key);
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
    -- maintainer, review pass 1), else an open item's own.
    due_at := v_win.due_at;
    due_from := CASE WHEN due_at IS NOT NULL THEN 'stated' END;
    IF due_at IS NULL AND v_win.due_ref_kind IS NOT NULL THEN
      v_ref := ob1_priority_counted(v_win.due_ref_kind, v_win.due_ref_key, w_inferred);
      due_at := v_ref.due_at;
      IF due_at IS NULL AND v_win.due_ref_kind = 'item' THEN
        SELECT i.due_at INTO due_at FROM open_items i WHERE i.item_id = v_win.due_ref_key::uuid;
      END IF;
      due_from := CASE WHEN due_at IS NOT NULL THEN 'due_ref' END;
    END IF;
    IF due_at IS NULL AND s_kind = 'item' THEN
      SELECT i.due_at INTO due_at FROM open_items i WHERE i.item_id = s_key::uuid;
      due_from := CASE WHEN due_at IS NOT NULL THEN 'item' END;
    END IF;

    -- Urgency, in calendar days in UTC; overdue in its place. None for a
    -- stated level 0 or a settled item.
    urgency := 0;
    overdue := false;
    IF due_at IS NOT NULL AND NOT settled AND v_win.level IS DISTINCT FROM 0 THEN
      IF due_at <= p_now THEN
        overdue := true;
        urgency := w_overdue;
        v_terms := v_terms || jsonb_build_object('term', 'overdue', 'value', urgency, 'due_at', due_at, 'due_from', due_from);
      ELSIF due_at <= v_soon_by THEN
        urgency := w_soon;
        v_terms := v_terms || jsonb_build_object('term', 'urgency', 'value', urgency, 'window', 'soon', 'due_at', due_at, 'due_from', due_from);
      ELSIF due_at <= v_week_by THEN
        urgency := w_week;
        v_terms := v_terms || jsonb_build_object('term', 'urgency', 'value', urgency, 'window', 'week', 'due_at', due_at, 'due_from', due_from);
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
  'For a JSON array of {kind, key} (at most 1000; an item asked twice answered once, at its first place), one row per item in the order asked: effective — the counted level (116''s rule, tier 4 left out unless count_inferred), else the level inherited from what it serves (less hop a hop, at most hops hops, only above unknown''s value), else unknown''s value; plus urgency from its due time in calendar days in UTC (soon by the end of tomorrow, week by the end of the seventh day, overdue in their place once due; none at a stated level 0 or once settled); plus the unblocks term (open items it blocks through active blocks / blocked_by links, transitively to depth). Each term is named in terms; winner is the counted assertion and passed_over every other open one; due_from says where the due time came from (stated, due_ref, item). p_weights overrides docs/priority.md''s weights by name (an unknown name or a value out of range raises 22023); p_now is the clock. Raises on a malformed item. Migration 120 / SMD-3667.';
