-- 065_identifier_allowlist.sql — the entity name gate, widened to a good-shape
-- allowlist (SMD-2300).
--
-- SMD-1935's entity_type_gate (056) corrects a shape only when the model typed a
-- name `person` or `place`; for any other type it passes the model's guess
-- through. The 2026-09-27 decider-vs-live-graph run measured the cost: the
-- generative extractor typed `SMD-1549` and `worker_status` a `topic`, and a
-- typed-decision model is a coin-flip on those shapes — so an identifier the
-- extractor mis-typed as topic or project never reached the person/place scope
-- and was stored wrong (or dropped).
--
-- This migration redefines entity_type_gate so a HIGH-PRECISION identifier shape
-- overrides whatever type the model gave: a three-or-more-digit ticket id is a
-- `project` (a one-digit `GPT-4` is a model, left alone), a package/path or a
-- host:port is a `tool`, and snake_case is a `tool` for every type but a person
-- (whose handle takes it). The looser ticket id, the URL and the dotted host
-- keep SMD-1935's person/place scope, since a `GPT-4` or a `Nature.com` the
-- model called a tool or an organization is left as it typed it. Then it re-runs
-- apply_entity_type_gate() over the rows written before it — the same
-- lock/curated-skip/merge logic, now reading the widened rule.
--
-- server-portable/entity-gate.ts is the twin; test-schema [52] holds the two to
-- one answer over a probe list and to the same shapes spelled in both.

DO $g$
BEGIN
  IF to_regclass('ob1_entities') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 065 needs 016 (ob1_entities) and 056 (entity_type_gate, apply_entity_type_gate); this schema lacks 016',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply';
  END IF;
  IF to_regprocedure('apply_entity_type_gate()') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 065 needs 056 (entity_type_gate, apply_entity_type_gate); this schema lacks them',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply';
  END IF;
END
$g$;

-- ---------------------------------------------------------------------------
-- entity_type_gate — SMD-1935's rule, widened to the good-shape allowlist
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION entity_type_gate(p_name text, p_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT
AS $$
  SELECT CASE
    WHEN s.n IS NULL OR s.n = '' THEN NULL
    WHEN s.n ~ '^[0-9][0-9 .:]*$' THEN NULL
    WHEN s.n IN ('person', 'persons', 'people', 'organization', 'organizations', 'organisation', 'organisations',
                 'project', 'projects', 'tool', 'tools', 'topic', 'topics', 'place', 'places', 'entity', 'entities') THEN NULL
    -- SMD-2300: a high-precision identifier shape overrides the type the model
    -- gave, whatever it was. A three-or-more-digit ticket id is a project (a one- or
    -- two-digit hyphen-number like GPT-4 is a model or a standard, left below
    -- for a person or place only); a package, a path or a host:port is a tool.
    -- None is a shape a real person, organization, place or topic takes.
    WHEN s.r ~ '^[A-Za-z]{2,}-[0-9]{3,}$' THEN 'project'
    WHEN s.r ~ '^@?[A-Za-z0-9_.-]+/[A-Za-z0-9_.*/-]*$'
      OR s.r ~ '^[^ \t\n\r\f\v]+:[0-9]+$' THEN 'tool'
    -- snake_case or a glob is a tool for every type but a person, whose handle
    -- takes it (@john_doe).
    WHEN p_type <> 'person' AND s.r ~ '^[^ \t\n\r\f\v]*[_*][^ \t\n\r\f\v]*$' THEN 'tool'
    -- Any other type keeps the type the model gave. A person or place reads the
    -- looser shapes SMD-1935 named for the two of them.
    WHEN p_type NOT IN ('person', 'place') THEN p_type
    WHEN s.r ~ '^[A-Za-z]+-[0-9]+$' THEN 'project'
    WHEN s.r ~ '^[A-Za-z][A-Za-z0-9+.-]*://' THEN 'tool'
    -- The handle of a person and the name of a real organization take the
    -- dotted shape (john.smith, Nature.com), so it retypes a place only.
    WHEN p_type = 'place' AND (s.r ~ '^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$') THEN 'tool'
    ELSE p_type
  END
  -- The shapes read the name trimmed of ASCII whitespace, and spell that class
  -- out, never the \S metaclass: Postgres reads \s by locale and btrim() strips
  -- spaces alone, so a trailing tab parted SMD-1804 from the twin (SMD-1935,
  -- first review pass). No apostrophe in these comments: test-schema [52] reads
  -- the quoted literals of this body.
  FROM (SELECT btrim(normalize_entity_name(p_name)) AS n, regexp_replace(p_name, '^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$', '', 'g') AS r) s
$$;

COMMENT ON FUNCTION entity_type_gate(text, text) IS
  'The entity name gate (056, widened by 065/SMD-2300): the type the graph stores a name under, or NULL to refuse it. Refused: a name that normalises to digits, dots, colons and spaces (a migration number, port, address, CIDR) or to a type-vocabulary word. Retyped whatever the model''s type: a three-or-more-digit ticket id to project; a package, path or host:port to tool; snake_case to tool for every type but a person. Retyped a person or place only: the looser ticket id to project, a URL to tool; a place only: a host, domain or file (a handle or a real organisation takes that shape) to tool. Otherwise the type given. server-portable/entity-gate.ts is its twin. SMD-1935, SMD-2300.';

-- The rows written before the widened rule, once — apply_entity_type_gate()
-- reads entity_type_gate() by name, so it now re-types by 065's rule (the
-- SMD-1935 person/place corrections it already made stand; the new work is the
-- identifiers the extractor typed topic/project). Idempotent, so --reapply is
-- safe; the first run's counts are kept, a second run finds nothing.
INSERT INTO ob1_config (key, value)
VALUES ('identifier_allowlist_065', apply_entity_type_gate()::text)
ON CONFLICT (key) DO NOTHING;
