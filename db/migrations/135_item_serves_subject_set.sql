-- =============================================================================
-- Migration 135: a thought serves every ticket of its subject set — 122's
--                ob1_item_serves read one ticket subject (LIMIT 1, no order),
--                and since 130 a thought's subjects are a set
--                (SMD-3306 PR 7a-3b-1)
-- =============================================================================
--
-- WHY
--   122's ob1_item_serves gives what a thought serves for priority inheritance:
--   the ticket it is filed under, else its standing ticket subject — read
--   with LIMIT 1 and no order, the one standing subject 111 allowed. Since 130
--   a thought's own subjects are a set (one standing per thought and key, at
--   most three), so a multi-ticket session holding two ticket subjects would
--   serve whichever the scan met first. The maintainer chose (2026-11-10) that
--   a thought serves every ticket of its set, as it stands in each ticket's
--   work thread.
--
-- WHAT
--   ob1_item_serves(kind, key) — 122's body verbatim but the thought arm's
--   subject read: with no filed ticket (metadata ticket, else issue, as
--   before), it returns one row for each ticket subject standing on the
--   thought, distinct, in key order. A filed ticket still serves alone: the
--   ticket a thought is filed under is its subject by the metadata rule, which
--   writes one key. The ticket and item arms are 122's.
--
-- WHO READS
--   effective_priority (122, replaced by 125, 127 and 128), which walks every
--   row ob1_item_serves returns, two hops (DISTINCT over the served items), and
--   so inherits from each ticket of a set.
--
-- SAFETY
--   One function redefined, its signature, volatility and every other arm
--   122's; its comment restated. No table, row or grant touched. While no
--   thought holds a set (nothing writes one before SMD-3306 PR 7a-3b-2) it
--   answers as 122's did.
--
-- Prerequisites
--   122 (ob1_item_serves), 130 (record_thought_subjects: subject sets).
--   Applied by `bun db/migrate.ts`. Idempotent: CREATE OR REPLACE.
-- =============================================================================

DO $qc$
DECLARE
  v_missing text;
BEGIN
  -- The first prerequisite missing, in file order, named.
  v_missing := CASE
    WHEN to_regprocedure('ob1_item_serves(text, text)') IS NULL THEN '122 (ob1_item_serves)'
    WHEN to_regprocedure('record_thought_subjects(uuid, text[], text, text, uuid, text, jsonb)') IS NULL THEN '130 (record_thought_subjects)'
  END;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('migration 135 needs %s; this schema lacks it', v_missing),
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url ... --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- ob1_item_serves — one hop of what an item serves; a thought every ticket of
-- its subject set
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
    -- reading); else each standing ticket subject (111; a set since 130).
    -- Each in turn, the first that is a ticket key (review pass 2: a
    -- malformed metadata.ticket hid a valid issue and the subject).
    SELECT CASE WHEN t.metadata->>'ticket' ~ '^[A-Za-z][A-Za-z0-9]{1,15}-[1-9][0-9]{0,9}$' THEN t.metadata->>'ticket'
                WHEN t.metadata->>'issue' ~ '^[A-Za-z][A-Za-z0-9]{1,15}-[1-9][0-9]{0,9}$' THEN t.metadata->>'issue' END
      INTO v_ticket FROM thoughts t WHERE t.id = p_key::uuid;
    IF v_ticket IS NOT NULL THEN
      kind := 'ticket'; key := upper(v_ticket);
      RETURN NEXT;
    ELSE
      -- ob1:serves-subject-set — a CONTRACT SENTINEL, not prose: every ticket
      -- of the set, not one of them (SMD-3306 PR 7a-3b-1).
      RETURN QUERY
        SELECT DISTINCT 'ticket'::text, upper(substr(f.payload->>'key', 8))
          FROM thought_facets f
         WHERE f.thought_id = p_key::uuid AND f.kind = 'subject' AND f.valid_until IS NULL AND f.payload->>'key' LIKE 'ticket:%'
           AND substr(f.payload->>'key', 8) ~ '^[A-Za-z][A-Za-z0-9]{1,15}-[1-9][0-9]{0,9}$'
         ORDER BY 2;
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
  'One hop of what a normalised item serves, for inheritance (docs/priority.md''s weights table): a ticket, its parent (an active Linear child_of link its linear source row holds); a thought, the ticket it is about (metadata ticket, else issue, as node_state reads them; else every standing ticket subject, distinct, in key order — 111''s subject, a set since 130); an open item, its origin thought. An entity serves nothing yet; the spec an item names waits for SMD-2683. Migrations 122, 135 / SMD-3667, SMD-3306.';
