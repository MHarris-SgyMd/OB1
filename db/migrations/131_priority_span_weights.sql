-- =============================================================================
-- Migration 131: the largest effective priority under a read's own weights
--                (SMD-4193 PR 1)
-- =============================================================================
--
-- WHY
--   docs/priority.md calls each weight "a setting a read overrides by name",
--   but no client could: the agenda's SQL took weights and the server passed
--   NULL, and search's priority_weight read the defaults alone (SMD-4193).
--   The maintainer chose (2026-11-10) that a call passes them, the agenda and
--   search_thoughts alike. Search's blend divides an effective priority by
--   the largest the weights allow (128's ob1_priority_span(), so its two
--   halves share a 0-1 scale); under a call's own weights that largest is
--   theirs, not the defaults'. An overdue term of 3 under a span of 5.8
--   would cap at 1 an item the weights put far apart.
--
-- WHAT
--   * ob1_priority_span(jsonb): 128's span under ob1_priority_defaults() with
--     the weights given laid over them: the larger of a critical level (5)
--     and unknown's value, plus the largest urgency term (soon, week or
--     overdue), plus the largest unblocks term. The weights are checked by
--     effective_priority itself, so a name it does not know or a value out of
--     its range is refused 22023 in its words, naming the weight, as any read
--     taking them refuses it. NULL weights: the defaults' span, as
--     ob1_priority_span() answers. No default on the argument, so a call
--     without one still names 128's function alone.
--   * query_log.filter's comment names the agenda row's weights: the server
--     logs the overrides an agenda call passed beside its scope and flags.
--   128's ob1_priority_span() and every read are unchanged.
--
-- WHO READS
--   The server, on a search_thoughts call with priority_weight above 0 and
--   weights. No actor, any role with EXECUTE (PUBLIC's, as for every function
--   here). No grant changes.
--
-- SAFETY
--   One new function, STABLE, reading no table but through effective_priority
--   over no items. The comment is re-issued only when it differs, so a
--   re-apply writes nothing. No row is touched. A server from this change on
--   reads ob1_priority_span(jsonb) only for a weighted, blended search, so a
--   brain before 131 refuses only that, with a hint naming the migration.
--   MINOR under FORK.md's version rules. test-schema [118], test-upgrade
--   [20bv].
--
-- Prerequisites
--   034 (query_log), 128 (ob1_priority_defaults, ob1_priority_span,
--   effective_priority reading them). Applied by `bun db/migrate.ts`.
--   Re-applied: the function is replaced as it was.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
BEGIN
  IF to_regprocedure('ob1_priority_defaults()') IS NULL OR to_regprocedure('ob1_priority_span()') IS NULL
     OR to_regprocedure('effective_priority(jsonb, jsonb, timestamp with time zone)') IS NULL OR to_regclass('query_log') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 131 needs 034 and 128 (query_log, ob1_priority_defaults, ob1_priority_span and effective_priority); this schema lacks one',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- ob1_priority_span(jsonb) — the span under a read's own weights
-- ---------------------------------------------------------------------------
-- 128's composition, over the defaults with the weights laid over them. It
-- mirrors effective_priority's composition as 128's does: a migration that
-- changes how the terms combine replaces both.
CREATE OR REPLACE FUNCTION ob1_priority_span(p_weights jsonb)
RETURNS numeric
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_w jsonb;
BEGIN
  -- effective_priority checks the weights by its own rule (122's names and
  -- ranges, cap against unblocks_many_at), over no items: one source for
  -- what a weight may be.
  IF p_weights IS NOT NULL THEN
    PERFORM count(*) FROM effective_priority('[]'::jsonb, p_weights, now());
  END IF;
  v_w := ob1_priority_defaults() || COALESCE(p_weights, '{}');
  -- NULL when a weight it reads is missing, as 128's: the server refuses a
  -- span that is no number.
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['unknown', 'soon', 'week', 'overdue', 'unblocks_one', 'unblocks_many']) k
              WHERE v_w->k IS NULL OR v_w->k = 'null'::jsonb) THEN
    RETURN NULL;
  END IF;
  RETURN greatest(5, (v_w->>'unknown')::numeric) + greatest((v_w->>'soon')::numeric, (v_w->>'week')::numeric, (v_w->>'overdue')::numeric)
         + greatest((v_w->>'unblocks_one')::numeric, (v_w->>'unblocks_many')::numeric);
END
$$;
COMMENT ON FUNCTION ob1_priority_span(jsonb) IS
  'The largest effective priority under ob1_priority_defaults() with these weights laid over them: the larger of a critical level (5) and unknown''s value, plus the largest urgency term (soon, week or overdue) plus the largest unblocks term. The weights are checked by effective_priority (22023 naming the weight); NULL answers the defaults'' span, as ob1_priority_span(). Search''s priority_weight divides by it under a call''s weights. Migration 131 / SMD-4193.';

-- ---------------------------------------------------------------------------
-- query_log.filter: the agenda row's weights
-- ---------------------------------------------------------------------------
-- Re-issued only when it differs (124's shape, so a re-apply writes nothing).
DO $qc2$
DECLARE
  v_filter text := 'The metadata containment filter a search ran with (jsonb; the search applies metadata @> filter). Populated from the search tools'' filter argument (SMD-1490); {} is unfiltered, and an absent or empty argument normalises to {} at the tool boundary. The argument is a shallow object — top-level keys mapping to a scalar or an array of scalars — so the containment stays GIN-indexable (SMD-1625 is the row-level-security cost of exposing it). NULL on an action row. On an agenda row, no containment filter: the call''s scope (source, project, label), its holder, its four include flags (blocked, claimed, proposed, started; migrations 123 and 124), its order (priority or due; migration 129) and the weights it overrode, when it passed any (migration 131). On a plan_context row, {} when its board was read, else {board: deadline, failed or no_keys_scope} (migration 126).';
BEGIN
  IF col_description('query_log'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'query_log'::regclass AND attname = 'filter' AND NOT attisdropped)) IS DISTINCT FROM v_filter THEN
    EXECUTE format('COMMENT ON COLUMN query_log.filter IS %L', v_filter);
  END IF;
END
$qc2$;
