-- =============================================================================
-- Migration 049: a key that may only add — ob1_agent_keys.scope admits 'capture'
--                (SMD-1298)
-- =============================================================================
--
-- WHY
--   auth.ts gains a third key scope, `capture`: capture_thought and nothing else
--   — no read tool, no update, no delete. It is the key a session-end hook holds
--   (recipes/session-capture-hook), a credential that sits in a config file on
--   every machine that runs the hook; a leak of it can add a thought and cannot
--   read, alter or remove one. The server enforces that at registration, as it
--   does read and write — the database records the scope, it does not gate on it.
--
--   010 declared `ob1_agent_keys.scope TEXT CHECK (scope IN ('read', 'write'))`,
--   a record of "the scope this key was last seen presenting" with a CHECK that
--   named the two scopes of its day. resolve_agent() writes the presented scope
--   into that column on first sight and on every later request; a capture key
--   would fail the CHECK, the registry would answer with an error, and the
--   capture would land unattributed — canonical_agent_id absent from its audit
--   row, the fallback attribution by name — on every write the hook ever made.
--   The column's job is to make a privilege change visible; a scope it cannot
--   hold is the one it would hide.
--
-- WHAT
--   * Refuse up front, by name, when 010's table is not there (a ledger
--     baselined over an older schema) — 043's guard, as 045–047 carry it.
--   * Drop every CHECK on the scope column ALONE — 010's under the name
--     Postgres gives an inline column CHECK, ob1_agent_keys_scope_check, and the
--     same rule under any other name a restore or a hand-written variant left
--     it with (ninth review pass: a drop by name alone would have left a
--     two-value CHECK standing beside the new one, and the registry refusing
--     capture keys still). Any other CHECK on the column alone goes with it —
--     preflight names one before this runs. A CHECK spanning scope and another
--     column is not this rule and stays (tenth review pass: a match on the word `scope` in the
--     definition would have dropped it) — and add the rule back naming the three scopes. The column stays TEXT,
--     NULLable, recorded-not-enforced, as 010 states; resolve_agent() is
--     unchanged — it writes whatever the server presents, and this is what lets it.
--
-- SAFETY
--   Idempotent: every CHECK on the scope column alone is dropped, then ADD
--   CONSTRAINT under the standard name, so a re-run and --reapply
--   (which runs every file in order: 010's CREATE TABLE IF NOT EXISTS leaves
--   the table as it is, then this file re-asserts the wider check) both land here. Widening a CHECK never fails
--   on existing rows — every value the old check admitted, the new one admits.
--   No function, no ACL, no data change; DDL on a fork-owned table, so under
--   the version rules this migration is additive (MINOR), and a fragment that
--   ships it may not claim `bump: patch` (check-fork's checkFragments).
-- =============================================================================

DO $g$
BEGIN
  -- The table AND its scope column: without the column the drop below matches
  -- nothing and ADD CONSTRAINT would fail bare (eleventh review pass).
  -- to_regclass, not ::regclass, so a missing table is NULL here rather than an error.
  IF to_regclass('ob1_agent_keys') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('ob1_agent_keys') AND attname = 'scope' AND NOT attisdropped) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 049 needs 010 (ob1_agent_keys.scope); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$g$;

DO $$
DECLARE
  c record;
BEGIN
  -- The CHECKs whose column list is exactly {scope}: conkey holds the columns a
  -- constraint is on, so a rule spanning scope and another column is left alone.
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'ob1_agent_keys'::regclass AND contype = 'c'
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'ob1_agent_keys'::regclass AND attname = 'scope' AND NOT attisdropped)]
  LOOP
    EXECUTE format('ALTER TABLE ob1_agent_keys DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE ob1_agent_keys
  ADD CONSTRAINT ob1_agent_keys_scope_check
  CHECK (scope IN ('read', 'write', 'capture'));

COMMENT ON COLUMN ob1_agent_keys.scope IS
  'The scope this key was last seen presenting, from auth.ts: read, write, or capture (capture_thought alone, for a hook; SMD-1298). Recorded rather than enforced: the environment decides what a key may do. A read key that starts arriving as a write key is a privilege change worth being able to see.';
