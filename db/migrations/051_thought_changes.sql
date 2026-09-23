-- =============================================================================
-- Migration 051: thought_changes — the read over thought_audit a resuming agent
--                asks first: what changed since I was last here (SMD-1296)
-- =============================================================================
--
-- WHY
--   thought_audit (008) records every capture, update and delete with the
--   thought, the action, the acting key's name and agent (010), a diff and
--   the time; 025 put supersession and derivation into the same diff; 046 added
--   who holds the key (actor_kind) and the door (origin). It is the most
--   complete record in the schema, and until this file its only readers were
--   the suites and an operator with psql.
--
--   An agent that returns after a break — a second session, a nightly job, a
--   worker that restarted — could list_thoughts by date, which shows new rows
--   but not edits or deletions and cannot say who made them. With several
--   agents writing under separate scoped keys, "what did the others do since my
--   last run" is the first question, and the schema already held the answer.
--   The board sync (SMD-1954) writes dozens of status changes a day into the
--   dogfood brain; without this read every resumed session re-searched instead
--   of catching up.
--
-- WHAT
--   thought_changes(p_since, p_after, p_agent, p_not_agent, p_actions, p_limit):
--   one page of audit rows, oldest first, each with a bounded rendering of what
--   changed, so both stores (server-portable/store-sql.ts, store-postgrest.ts)
--   call one function and the MCP tool renders one row shape.
--
--   * WHERE THE PAGE STARTS. p_since (a time: rows at or after it) or p_after
--     (a CURSOR: the id of the audit row the previous page ended with — rows
--     strictly after it in (created_at, id) order). Neither: the newest p_limit
--     rows, still returned oldest first — a first call with no checkpoint. Both:
--     refused. A cursor that names no row is refused by name (the log is
--     append-only, so a missing cursor is a typo, never a pruned row).
--   * THE ORDER IS A KEYSET. (created_at, id) is a total order, so a walk by
--     cursor never repeats a row and never skips a committed one across a page
--     boundary, which an OFFSET over a table that is being appended to cannot
--     promise. What it cannot see: created_at is the writing transaction's
--     start (DEFAULT now()), so a transaction that began before the cursor's
--     row and committed after the page was read sorts behind the cursor and is
--     not on any later page of that walk (first review pass) — a window of one
--     write's duration, since every MCP write is its own short transaction; a
--     reader who must not miss it re-reads from a time. Within one
--     transaction created_at ties (it is transaction-fixed) and the id is
--     random, so two rows one transaction wrote — a capture and a raw
--     enhanced-columns write beside it — may read in either order; every MCP
--     call is its own transaction, so the feed is in order for what the server
--     writes. 050 (SMD-1726) added thought_audit.seq, exact for rows written
--     after it; preferring it as the tie-break is the follow-up.
--   * THE PAGE IS CHOSEN FIRST, RENDERED ONCE. The ids are picked by the
--     bound and filters over 008's created_at index — one statement per kind
--     of bound, so each is a plain index condition under any plan — then
--     joined back for the rendering, so the three share one projection.
--   * WHAT IS RENDERED, BOUNDED. `head` is at most 240 characters of the text
--     the row is about: a capture's current content (NULL when the thought has
--     since been deleted), an update's new content when the content moved, a
--     delete's previous content. `changed` names an update's diff keys
--     (content, metadata, embedding_present, supersedes, derived_from);
--     `metadata_keys` the metadata keys whose value moved, when both sides are
--     objects. `supersedes_before`/`supersedes_after` read the pointer from the
--     diff for every action — a capture that superseded, an update that set or
--     cleared the pointer (025's ON DELETE SET NULL included), a delete's prior
--     pointer — cast only when uuid-shaped, so a hand-written row cannot break
--     the feed. `derivation` says derived_from was set or moved. `present` says
--     the thought still exists. The raw diff stays reachable by the audit id.
--   * WHO. p_agent keeps one writer's rows (by key name); p_not_agent drops
--     one writer's — the server passes the caller's own name for "everyone but
--     me", and a row with no actor (a script, a migration) is not the caller,
--     so it stays in. p_actions is a subset of the three; an unknown word is
--     refused by name.
--   * p_limit is clamped to 1..201: the tool asks for one more than it shows to
--     know whether more follow.
--
--   No new index: 008's btree on created_at serves the range and the tail; the
--   id tie-break is a filter over the few rows that share a timestamp. A
--   composite (created_at, id) is a follow-up if the log grows past what that
--   serves.
--
-- SAFETY
--   Additive: one function, STABLE, SECURITY INVOKER (004, 008, 010 and 012 say
--   why no GRANT and no DEFINER — the application role owns the schema; a
--   self-hosted server role needs SELECT on thoughts (the capture group) and
--   on thought_audit (the server group, SMD-1298's row), both of which
--   db/config.mjs ROLE_GRANTS documents and migrate.ts --grant issues). Reads
--   only. Idempotent: CREATE OR REPLACE. A guard first, 047's
--   shape: on a schema without 008's table or 046's columns the body would
--   fail bare at first call rather than at apply, so refuse up front naming the
--   migration and --reapply. MINOR under the version rules.
--
-- Expected outcome
--   SELECT * FROM thought_changes() lists the newest fifty audit rows, oldest
--   first; SELECT * FROM thought_changes(NULL, '<last id>') the page after them.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regclass('thought_audit') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 051 needs 008 (thought_audit); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'thought_audit' AND column_name = 'actor_kind') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 051 needs 046 (thought_audit.actor_kind, origin); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

CREATE OR REPLACE FUNCTION thought_changes(
  p_since     timestamptz DEFAULT NULL,
  p_after     uuid        DEFAULT NULL,
  p_agent     text        DEFAULT NULL,
  p_not_agent text        DEFAULT NULL,
  p_actions   text[]      DEFAULT NULL,
  p_limit     int         DEFAULT 50
)
RETURNS TABLE (
  id                uuid,
  created_at        timestamptz,
  action            text,
  thought_id        uuid,
  actor_name        text,
  actor_kind        text,
  origin            text,
  source            text,
  present           boolean,
  head              text,
  changed           text[],
  metadata_keys     text[],
  supersedes_before uuid,
  supersedes_after  uuid,
  derivation        boolean
)
LANGUAGE plpgsql
STABLE
ROWS 50
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 201);
  v_ts    timestamptz;
  v_id    uuid;
  v_bad   text;
  v_ids   uuid[];
BEGIN
  -- Every column reference below is qualified: the RETURNS TABLE names are
  -- variables in this scope, and a bare `id` or `created_at` is ambiguous.
  IF p_since IS NOT NULL AND p_after IS NOT NULL THEN
    RAISE EXCEPTION 'thought_changes: pass a time (p_since) or a cursor (p_after), not both'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_actions IS NOT NULL THEN
    SELECT u.x INTO v_bad FROM unnest(p_actions) AS u(x)
     WHERE u.x IS NULL OR u.x NOT IN ('capture', 'update', 'delete') LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'thought_changes: unknown action %; the actions are capture, update and delete', COALESCE(v_bad, 'NULL')
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  IF p_after IS NOT NULL THEN
    SELECT a.created_at, a.id INTO v_ts, v_id FROM thought_audit a WHERE a.id = p_after;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'thought_changes: no audit row %; a cursor is the id the previous page ended with', p_after
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  -- The page: ids only, by the bound and the three filters — one statement per
  -- kind of bound (none, a cursor, a time), so the bound is a plain index
  -- condition on 008's created_at btree under ANY plan. One statement with
  -- `(p_since IS NULL OR …) AND (v_ts IS NULL OR …)` keeps the condition only
  -- while the plan cache picks custom plans (it did, over seven calls at 2k
  -- and 100k audit rows — the generic estimate priced far above); under a
  -- generic plan (plan_cache_mode = force_generic_plan, or a data shape that
  -- prices one below the custom plans) it walks the index from the oldest row
  -- and filters: measured 98 ms against 0.03 ms for these shapes at 100k
  -- rows (second review pass; measured in the third). The three filters are
  -- spelled three times; the projection below is the one copy that matters.
  IF p_since IS NULL AND p_after IS NULL THEN
    SELECT array_agg(p.aid) INTO v_ids FROM (
      SELECT a.id AS aid FROM thought_audit a
       WHERE (p_agent IS NULL OR a.actor_name = p_agent)
         AND (p_not_agent IS NULL OR a.actor_name IS DISTINCT FROM p_not_agent)
         AND (p_actions IS NULL OR a.action = ANY (p_actions))
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT v_limit) p;
  ELSIF p_after IS NOT NULL THEN
    SELECT array_agg(p.aid) INTO v_ids FROM (
      SELECT a.id AS aid FROM thought_audit a
       WHERE (p_agent IS NULL OR a.actor_name = p_agent)
         AND (p_not_agent IS NULL OR a.actor_name IS DISTINCT FROM p_not_agent)
         AND (p_actions IS NULL OR a.action = ANY (p_actions))
         AND (a.created_at, a.id) > (v_ts, v_id)
       ORDER BY a.created_at, a.id
       LIMIT v_limit) p;
  ELSE
    SELECT array_agg(p.aid) INTO v_ids FROM (
      SELECT a.id AS aid FROM thought_audit a
       WHERE (p_agent IS NULL OR a.actor_name = p_agent)
         AND (p_not_agent IS NULL OR a.actor_name IS DISTINCT FROM p_not_agent)
         AND (p_actions IS NULL OR a.action = ANY (p_actions))
         AND a.created_at >= p_since
       ORDER BY a.created_at, a.id
       LIMIT v_limit) p;
  END IF;

  RETURN QUERY
    SELECT a.id, a.created_at, a.action, a.thought_id, a.actor_name, a.actor_kind, a.origin, a.source,
           t.id IS NOT NULL,
           left(CASE a.action
                  WHEN 'capture' THEN t.content
                  WHEN 'update'  THEN a.diff->'content'->>'after'
                  ELSE                a.diff->>'previous_content'
                END, 240),
           CASE WHEN a.action = 'update' AND jsonb_typeof(a.diff) = 'object'
                THEN (SELECT array_agg(k.k ORDER BY k.k) FROM jsonb_object_keys(a.diff) AS k(k)) END,
           CASE WHEN a.action = 'update'
                 AND jsonb_typeof(a.diff->'metadata'->'before') = 'object'
                 AND jsonb_typeof(a.diff->'metadata'->'after')  = 'object'
                THEN (SELECT array_agg(ks.k ORDER BY ks.k)
                        FROM (SELECT jsonb_object_keys(a.diff->'metadata'->'before') AS k
                              UNION
                              SELECT jsonb_object_keys(a.diff->'metadata'->'after')) ks
                       WHERE (a.diff->'metadata'->'before'->ks.k) IS DISTINCT FROM (a.diff->'metadata'->'after'->ks.k)) END,
           CASE WHEN s.sb ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN s.sb::uuid END,
           CASE WHEN s.sa ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN s.sa::uuid END,
           COALESCE(a.action <> 'delete' AND a.diff ? 'derived_from', false)
      FROM unnest(v_ids) AS u(aid)
      JOIN thought_audit a ON a.id = u.aid
      LEFT JOIN thoughts t ON t.id = a.thought_id
      CROSS JOIN LATERAL (SELECT
          CASE a.action WHEN 'update' THEN a.diff->'supersedes'->>'before' WHEN 'delete' THEN a.diff->>'previous_supersedes' END AS sb,
          CASE a.action WHEN 'capture' THEN a.diff->>'supersedes'          WHEN 'update' THEN a.diff->'supersedes'->>'after'  END AS sa) s
     ORDER BY a.created_at, a.id;
END;
$$;

COMMENT ON FUNCTION thought_changes(timestamptz, uuid, text, text, text[], int) IS
  'One page of thought_audit, oldest first, from a time (p_since, at or after) or a cursor (p_after, the audit id a page ended with; strictly after in (created_at, id)) — neither is the newest p_limit rows; both is refused. p_agent keeps one key''s rows, p_not_agent drops one key''s (rows with no actor stay), p_actions a subset of capture/update/delete. Each row carries a bounded head (240 chars: a capture''s current text, an update''s new text, a delete''s previous), an update''s changed keys and moved metadata keys, the supersedes pointer before and after, whether derived_from moved, and whether the thought still exists. p_limit clamped to 1..201. Migration 051 / SMD-1296.';
