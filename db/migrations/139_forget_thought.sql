-- =============================================================================
-- Migration 139: forget a thought — forget_thought removes it from every store
--                in the brain that holds its text, redacts its events in the
--                log, and records the forgetting in a ledger (SMD-1723 PR 1)
-- =============================================================================
--
-- WHY
--   delete_thought removes the row, but the brain keeps what it said: the
--   log's events carry the text in full (008, 055: the capture's content,
--   each update's before and after, the tombstone's previous_content and
--   previous_metadata), and the extraction's entities, the snapshot's
--   vectors, other thoughts' derived_from, the proposals, the relation and
--   citation facets, the page sections built on it, the priority statements
--   and open items read from it, its deliverables and the query log's
--   results all keep the text or the id. A captured secret has no removal
--   path at all: thought_audit refuses every DELETE, and admits an UPDATE
--   only under its two named amendments, backfill (046) and payload (055).
--   Nothing can answer "is this gone" with evidence.
--
-- WHAT (the maintainer's choices, 2026-11-13)
--   * forget_thought(p_id, p_actor) removes a thought and everything in the
--     database that holds its text, in one transaction, and returns the
--     evidence. In order:
--     - the supersession lock, the capture's fingerprint lock for every text
--       it has had (so a capture of one waits, then meets the ledger), then
--       the row; an id the log never held is NOT_FOUND. A thought deleted
--       before is forgotten from what remains, the brain's orphaned entities
--       pruned (review passes 1 and 2); forgotten already with nothing left,
--       FORGOTTEN;
--     - a thought another cites (an active citation) is refused CITED, as
--       delete_thought refuses it: the operator detaches first, deleting it
--       with delete_thought(id, actor, true), then forgets it; the citations
--       so detached are deleted;
--     - every fingerprint its text has had, read from the log before the
--       redaction, less any a standing thought holds (a twin keeps its text);
--     - rebuild_derived(p_id, 'forget', p_input_gone => true) with those
--       fingerprints (063/067): its windows, entity links and the entities
--       left with none, and the snapshot's vectors;
--     - the relation facets on other thoughts that target it (084, 120), and
--       the expired or superseded citations of it, whose text may quote it;
--     - its id stripped from other thoughts' derived_from (a raw update, which
--       the audit trigger records); those thoughts are listed as
--       `irreproducible`: prose absorbed from it can't be removed
--       mechanically, so a person reviews them — the limit, named;
--     - the page sections whose evidence (or pending evidence) names it,
--       through delete_page_section (064): their revisions and lineage go and
--       the page is re-rendered; its own log keeps the earlier render, so the
--       page is listed for review; its next pass writes the section again;
--       every other page whose own log names it is listed too;
--     - the query log's references: the id leaves result_ids, each score
--       with its id, and result_items, the other items kept, the query text
--       staying, being what a caller typed; an action row on it, which must
--       name its target, is deleted;
--     - the row, through delete_thought (its tombstone, the cascades: chunks,
--       sources, its own facets, proposals, claims);
--     - then, the row gone: the priority statements on it, on the open items
--       read from it, or taking a due time from either (116), each item
--       re-projected; those items with their events, and the close proposals
--       whose evidence it is (117); its deliverable's events (134);
--     - every event in the log for it redacted (below);
--     - the ledger row.
--   * thought_audit's third named amendment, `redact`, beside backfill and
--     payload: under ob1.audit_amend = 'redact' and ob1.forgetting naming
--     the row's thought, once that thought is deleted, an UPDATE may replace the row's diff with
--     ob1_audit_redacted_diff(diff, action) — every text a marker,
--     '[forgotten]', every metadata object {"forgotten": true}, ids,
--     fingerprints and times kept — and stamp redacted_at with now(), once,
--     every other column byte-equal. A capture row always gains the marker as
--     its content, so the payload amendment, which never changes a content
--     once set (055), can never fill it again.
--   * thought_forgotten, the ledger: one row per thought forgotten, with when,
--     by whom, its fingerprints and the evidence forget_thought returned.
--     Append-only. A capture or edit to a forgotten text is refused, OB005,
--     unless ob1.reinstate_forgotten is 'on' for the transaction (the
--     maintainer: the fingerprint is kept, so "this was forgotten" can be
--     said; a keyed hash is SMD-3934's).
--   * The append-only guards of 116, 117 and 134 admit a DELETE under
--     ob1.forgetting of a row that holds that thought's text, once the
--     thought is deleted (ob1_forgetting names no living thought), and
--     nothing else.
--   * A write racing the forget (the maintainer, review pass 2: simplify):
--     only a capture or edit of one of its texts waits for it (the
--     fingerprint lock) and is refused after. Another store's write that
--     lands beside a running forget — a statement restated, an item updated,
--     a close proposal, a page section, a thought derived from it — may stay;
--     a second forget_thought sweeps it, the items an earlier forget took
--     included (its ledger rows' item_ids), and answers FORGOTTEN when there
--     is nothing left. PR 2's preflight check names a forgotten id still held;
--     serialising those writers against a forget is SMD-4299.
--
-- NOT CHANGED
--   * delete_thought: forgetting is the exception; a delete keeps its events.
--   * Outside the database: the sleep dumps (OB1_SLEEP_DUMP_DIR), Linear
--     comments already posted with a proposal's reason (087), the weekly
--     digest's files and extraction dumps. The ledger names them.
--   * An entity a surviving thought still mentions keeps its name and
--     aliases, even where the forgotten text gave them.
--   * Ids in the log: other thoughts' events keep the id they named, and the
--     strip's own update records it. An id is not the text.
--   * A deliverable whose spec it was keeps the spec's id.
--   * The operation over REST and MCP, its write scope and confirm echo
--     (PR 2); the other brains (PR 3).
--
-- LIMITS, NAMED
--   * Prose that absorbed the text can't be removed mechanically: thoughts
--     derived from it are listed (`irreproducible`), and so is every page
--     whose own log names it (`pages`) — its earlier renders, and a section
--     once built on it and since rewritten, whose revision keeps the earlier
--     body (revisions record no evidence; the maintainer, review pass 1:
--     listed, not deleted).
--   * Another thought's own history: one that once held the same text and
--     was edited away keeps it in its log.
--   * A twin whose key a raw write left stale (neither the text's
--     fingerprint nor NULL) is not read as a twin.
--   * A raw INSERT takes no fingerprint lock: one racing the forget with the
--     text is not held by it.
--   * The redact amendment and the relaxed guards trust ob1.forgetting for
--     any deleted thought: a role holding UPDATE on thought_audit and DELETE
--     on those tables can forget by hand, as forget_thought does.
--   * SMD-2117's fold, replaying another thought's history that held a
--     forgotten text, meets the OB005 refusal: it reinstates, or skips.
--
-- SAFETY
--   thought_audit gains one column, nullable. Five functions replaced (the
--   gate and four guards), each keeping every arm it had. One table added,
--   with two triggers of its own, and one trigger on thoughts: the refusal
--   of a forgotten text, which fires only for a fingerprint the ledger
--   holds. Each role able to write thoughts is granted
--   SELECT on the ledger: after 139 a capture reads it, so a role without it
--   cannot write a thought at all. MINOR under the version rules.
--   test-schema [126], test-upgrade [20cd].
--
-- Prerequisites
--   016 (content_fingerprint_of), 034 (query_log), 042 (citations), 055 (the
--   gate's payload arm), 060 (delete_thought), 064 (page sections), 067
--   (rebuild_derived), 084 (relation facets), 116, 117, 123 (result_items)
--   and 134. Applied by `bun db/migrate.ts`; re-applied alone, every
--   function is replaced again and the ledger kept.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
BEGIN
  IF to_regprocedure('content_fingerprint_of(text)') IS NULL
     OR to_regprocedure('delete_thought(uuid, jsonb, boolean)') IS NULL
     OR to_regprocedure('rebuild_derived(uuid, text, boolean, text[], boolean, boolean)') IS NULL
     OR to_regprocedure('ob1_capture_payload(uuid, timestamp with time zone, bigint)') IS NULL
     OR to_regprocedure('ob1_priority_project(text, text)') IS NULL
     OR to_regclass('page_sections') IS NULL OR to_regclass('priority_assertions') IS NULL
     OR to_regclass('open_item_events') IS NULL OR to_regclass('deliverable_events') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('query_log') AND attname = 'result_items' AND NOT attisdropped) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 139 needs 016, 034, 055, 060, 064, 067, 116, 117, 123 and 134 (content_fingerprint_of, query_log.result_items, ob1_capture_payload, delete_thought, page_sections, rebuild_derived, priority_assertions, open_item_events, deliverable_events); this schema lacks one',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. The redaction's stamp, and what a redacted diff is
-- ---------------------------------------------------------------------------
ALTER TABLE thought_audit ADD COLUMN IF NOT EXISTS redacted_at timestamptz;
COMMENT ON COLUMN thought_audit.redacted_at IS
  'When forget_thought redacted this event''s text (the redact amendment, migration 139 / SMD-1723); NULL for an event never redacted.';

CREATE OR REPLACE FUNCTION ob1_audit_redacted_diff(p_diff jsonb, p_action text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  -- Every text the diff rule (055) records becomes the marker, every metadata
  -- object {"forgotten": true}: the types kept, so a reader of the log meets
  -- the shape it knows. Ids, fingerprints, the vector's presence and times
  -- stay. A capture gains the marker as its content whatever it held, so the
  -- payload amendment, which never changes a content once set, can never fill
  -- it again.
  WITH d AS (SELECT CASE WHEN jsonb_typeof(p_diff) = 'object' THEN p_diff ELSE '{}'::jsonb END AS d),
       m AS (SELECT '"[forgotten]"'::jsonb AS t, '{"forgotten": true}'::jsonb AS o)
  SELECT CASE p_action
    WHEN 'capture' THEN
      d.d || jsonb_build_object('content', m.t)
          || CASE WHEN d.d ? 'metadata' AND d.d->'metadata' <> 'null'::jsonb THEN jsonb_build_object('metadata', m.o) ELSE '{}'::jsonb END
    WHEN 'update' THEN
      d.d
      || CASE WHEN jsonb_typeof(d.d->'content') = 'object' THEN jsonb_build_object('content',
           (d.d->'content')
           || CASE WHEN (d.d->'content') ? 'before' AND d.d->'content'->'before' <> 'null'::jsonb THEN jsonb_build_object('before', m.t) ELSE '{}'::jsonb END
           || CASE WHEN (d.d->'content') ? 'after'  AND d.d->'content'->'after'  <> 'null'::jsonb THEN jsonb_build_object('after',  m.t) ELSE '{}'::jsonb END)
         WHEN d.d ? 'content' THEN jsonb_build_object('content', m.t) ELSE '{}'::jsonb END
      || CASE WHEN jsonb_typeof(d.d->'metadata') = 'object' AND ((d.d->'metadata') ? 'before' OR (d.d->'metadata') ? 'after') THEN jsonb_build_object('metadata',
           (d.d->'metadata')
           || CASE WHEN (d.d->'metadata') ? 'before' AND d.d->'metadata'->'before' <> 'null'::jsonb THEN jsonb_build_object('before', m.o) ELSE '{}'::jsonb END
           || CASE WHEN (d.d->'metadata') ? 'after'  AND d.d->'metadata'->'after'  <> 'null'::jsonb THEN jsonb_build_object('after',  m.o) ELSE '{}'::jsonb END)
         WHEN d.d ? 'metadata' AND d.d->'metadata' <> 'null'::jsonb THEN jsonb_build_object('metadata', m.o) ELSE '{}'::jsonb END
    ELSE
      d.d
      || CASE WHEN d.d ? 'previous_content'  AND d.d->'previous_content'  <> 'null'::jsonb THEN jsonb_build_object('previous_content',  m.t) ELSE '{}'::jsonb END
      || CASE WHEN d.d ? 'previous_metadata' AND d.d->'previous_metadata' <> 'null'::jsonb THEN jsonb_build_object('previous_metadata', m.o) ELSE '{}'::jsonb END
  END
  FROM d, m
$$;
COMMENT ON FUNCTION ob1_audit_redacted_diff(jsonb, text) IS
  'What forget_thought''s redaction leaves of a thought_audit diff (migration 139 / SMD-1723): a capture''s content the marker ''[forgotten]'' (always, so the payload amendment can never fill it) and its metadata {"forgotten": true}; an update''s content and metadata before and after, each that held a value, the same; a tombstone''s previous_content and previous_metadata the same. Ids (derived_from, supersedes), fingerprints, the vector''s presence and times are kept. The redact amendment of thought_audit_refuse_mutation holds an UPDATE to exactly this.';

CREATE OR REPLACE FUNCTION ob1_forgetting()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  -- The thought forget_thought is forgetting in this transaction, once it is
  -- deleted, or NULL: the setting is the forget's alone, anything not a uuid
  -- reads as none, and a thought still standing is never one (review pass 1:
  -- the setting naming a living thought let the guards delete its rows).
  SELECT CASE WHEN pg_input_is_valid(current_setting('ob1.forgetting', true), 'uuid')
              THEN (SELECT f.id FROM (SELECT current_setting('ob1.forgetting', true)::uuid AS id) f
                     WHERE NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = f.id)) END
$$;
COMMENT ON FUNCTION ob1_forgetting() IS
  'The thought forget_thought is forgetting in this transaction (the setting ob1.forgetting), once that thought is deleted, or NULL: the one test the redact amendment and the relaxed guards of 116, 117 and 134 read, so no setting can reach a living thought''s rows. Migration 139 / SMD-1723.';

-- ---------------------------------------------------------------------------
-- 2. Immutable by rule: 055's gate verbatim — 008's refusal, 046's backfill
--    arm and 055's payload arm — and the redact arm, the third named
--    amendment (SMD-1723). The trigger knows which change is lawful.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thought_audit_refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_kind     text;
  v_origin   text;
  v_trust    text;
  v_why      text;
  v_content  text;
  v_created  timestamptz;
  v_source   text;
  v_old      jsonb;
  v_new      jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('ob1.audit_amend', true) = 'backfill' THEN
    -- ob1:audit-amend-fills-null-only — a CONTRACT SENTINEL, not prose (the
    -- 014 convention); preflight's `audit events` check reads it.
    -- What the row derives to, through the two rules the audit trigger and the
    -- backfill read.
    v_kind   := COALESCE(OLD.actor_kind, ob1_registry_kind(OLD.canonical_agent_id, OLD.actor_name));
    v_origin := COALESCE(OLD.origin, ob1_door_of(OLD.actor_context));
    v_trust  := COALESCE(OLD.trust, CASE WHEN v_kind IS NOT NULL THEN ob1_trust_ceiling(v_kind, OLD.actor_context->'claimed'->>'trust') END);
    -- Each condition named when it fails (run-it, second review pass: thirteen
    -- different refusals read one sentence), so a hand amendment learns which
    -- of the five it broke — and that it must fill everything derivable at once.
    -- Each of the three may be left as it was (a fill may be partial — the
    -- backfill's candidates are derived under its statement's snapshot, the
    -- gate's under a fresher one, and a key registered between the two must
    -- not roll a pass back; fourth review pass) or set to what it derives to;
    -- never anything else, and something must be filled. `diff` is among the
    -- columns that must not move under THIS value: the payload is the arm
    -- below's, under its own (055).
    IF (to_jsonb(OLD) - 'actor_kind' - 'trust' - 'origin' - 'backfilled_at')
       <> (to_jsonb(NEW) - 'actor_kind' - 'trust' - 'origin' - 'backfilled_at') THEN
      v_why := 'a column other than actor_kind, trust, origin and backfilled_at changes';
    ELSIF NEW.actor_kind IS DISTINCT FROM OLD.actor_kind AND NEW.actor_kind IS DISTINCT FROM v_kind THEN
      v_why := format('actor_kind must be what the registry holds for the row''s key, %L', v_kind);
    ELSIF NEW.trust IS DISTINCT FROM OLD.trust AND NEW.trust IS DISTINCT FROM v_trust THEN
      v_why := format('trust must be what the rule gives from that kind and the row''s filed claim, %L', v_trust);
    ELSIF NEW.origin IS DISTINCT FROM OLD.origin AND NEW.origin IS DISTINCT FROM v_origin THEN
      v_why := format('origin must be the door the row''s own blob carries, %L', v_origin);
    ELSIF NEW.actor_kind IS NOT DISTINCT FROM OLD.actor_kind AND NEW.trust IS NOT DISTINCT FROM OLD.trust AND NEW.origin IS NOT DISTINCT FROM OLD.origin THEN
      v_why := 'nothing is filled';
    ELSIF NEW.backfilled_at IS DISTINCT FROM now() THEN
      v_why := 'backfilled_at must be now(), this transaction''s time';
    ELSE
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'thought_audit is append-only: the backfill amendment may only fill a NULL actor_kind, trust or origin with what the row derives to, and stamp backfilled_at with now() — here %.',
      v_why;
  END IF;

  IF TG_OP = 'UPDATE' AND current_setting('ob1.audit_amend', true) = 'payload' THEN
    -- ob1:audit-amend-fills-payload-only — a CONTRACT SENTINEL, not prose
    -- (the 014 convention); test-schema reads it. The third named amendment
    -- (055): a CAPTURE row's diff.content and diff.created_at, where absent,
    -- with what the log and the row derive to (ob1_capture_payload, the
    -- backfill's own reading), and nothing else — every other column
    -- byte-equal with `diff` removed as the fifth column under this value
    -- alone, every other key of diff byte-equal, a value once set never
    -- changed, something filled. Each condition named when it fails.
    -- A NULL diff (a hand INSERT's; every writer's is an object) counts as
    -- empty before, so the pass can fill it onto an object.
    v_old := COALESCE(OLD.diff, '{}'::jsonb);
    v_new := COALESCE(NEW.diff, '{}'::jsonb);
    IF OLD.action <> 'capture' THEN
      v_why := 'only a capture row takes a payload';
    ELSIF (to_jsonb(OLD) - 'diff') <> (to_jsonb(NEW) - 'diff') THEN
      v_why := 'a column other than diff changes';
    ELSIF jsonb_typeof(v_old) <> 'object' OR jsonb_typeof(v_new) <> 'object' THEN
      v_why := 'diff must be an object before and after (a NULL diff counts as empty)';
    ELSIF (v_old - 'content' - 'created_at') <> (v_new - 'content' - 'created_at') THEN
      v_why := 'a key of diff other than content and created_at changes';
    ELSIF v_old ? 'content' AND v_new->'content' IS DISTINCT FROM v_old->'content' THEN
      v_why := 'a content once set is never changed';
    ELSIF v_old ? 'created_at' AND v_new->'created_at' IS DISTINCT FROM v_old->'created_at'
          AND (v_new->>'created_at' IS NULL OR v_new->>'created_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}'
               OR v_old->>'created_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}'
               OR NOT pg_input_is_valid(v_new->>'created_at', 'timestamptz')
               OR NOT pg_input_is_valid(v_old->>'created_at', 'timestamptz')) THEN
      -- Byte-equal is unchanged, whatever the bytes: a created_at set by hand
      -- to no timestamp is not this arm's to judge, and the pass, which never
      -- rewrites a set one, fills the content beside it (cold read, fourth
      -- review pass: the shape test ran on the unchanged value, so the fill
      -- was refused five times and the apply failed). Shape and validity in
      -- their own arm, the cast in the next: SQL's OR promises no order, and
      -- a cast that ran first on a string that is no timestamp would raise
      -- its own error in place of this sentence (sixth review pass; the fill
      -- arm below was split the same way in the first). The shape alone
      -- admits "2024-13-45T99:00:00", which the cast still rejects, so
      -- pg_input_is_valid judges the value too (cold read, seventh).
      v_why := 'a created_at once set is never changed';
    ELSIF v_old ? 'created_at' AND v_new->'created_at' IS DISTINCT FROM v_old->'created_at'
          AND (v_new->>'created_at')::timestamptz IS DISTINCT FROM (v_old->>'created_at')::timestamptz THEN
      -- As an instant, not as bytes: a timestamptz in jsonb renders in the
      -- session's TimeZone, and a hand fill under another zone is the same time.
      v_why := 'a created_at once set is never changed';
    ELSIF (v_new ? 'content') = (v_old ? 'content') AND (v_new ? 'created_at') = (v_old ? 'created_at') THEN
      v_why := 'nothing is filled';
    ELSIF (v_new ? 'created_at') AND NOT (v_old ? 'created_at') AND (v_old ? 'content') THEN
      -- A complete capture event gains no time it never had, however the
      -- row's created_at is moved later (run-it, first review pass).
      v_why := 'a created_at is filled with the content or before it, never onto a row that already carries its content';
    ELSE
      SELECT p.content, p.row_created_at, p.source INTO v_content, v_created, v_source
        FROM ob1_capture_payload(OLD.thought_id, OLD.created_at, OLD.seq) p;
      IF (v_new ? 'content') AND NOT (v_old ? 'content') AND jsonb_typeof(v_new->'content') <> 'string' THEN
        v_why := 'content must be a string';
      ELSIF (v_new ? 'content') AND NOT (v_old ? 'content')
         AND (v_content IS NULL OR (v_new->>'content') IS DISTINCT FROM v_content) THEN
        v_why := CASE WHEN v_content IS NULL THEN 'no content derives for this row (no later content-moving update, no tombstone, no live row)'
                      ELSE format('content must be the text the log and the row derive to (from the %s)', v_source) END;
      ELSIF (v_new ? 'created_at') AND NOT (v_old ? 'created_at')
         AND (v_new->>'created_at' IS NULL OR v_new->>'created_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}'
              OR NOT pg_input_is_valid(v_new->>'created_at', 'timestamptz')) THEN
        -- Shape and validity first, so a string that is no timestamp — by
        -- shape, or by a month of 13 — is refused by name rather than by the
        -- cast's own error (run-it, first review pass; cold read, seventh).
        v_why := 'created_at must be a timestamp';
      ELSIF (v_new ? 'created_at') AND NOT (v_old ? 'created_at')
         AND (v_created IS NULL OR (v_new->>'created_at')::timestamptz IS DISTINCT FROM v_created) THEN
        v_why := CASE WHEN v_created IS NULL THEN 'no created_at derives for this row (no live row, or the row''s equals the event''s)'
                      ELSE 'created_at must be the live row''s own' END;
      ELSE
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION
      'thought_audit is append-only: the payload amendment may only fill a capture row''s diff.content and diff.created_at, where absent, with what the log and the row derive to — here %.',
      v_why;
  END IF;

  IF TG_OP = 'UPDATE' AND current_setting('ob1.audit_amend', true) = 'redact' THEN
    -- ob1:audit-amend-redacts-forgotten-only — a CONTRACT SENTINEL, not prose
    -- (the 014 convention); test-schema reads it. The third named amendment
    -- (139, SMD-1723), after backfill and payload: an event of the thought
    -- forget_thought is forgetting in this transaction, once that thought is
    -- deleted, its diff replaced by what ob1_audit_redacted_diff leaves of it
    -- and redacted_at stamped with now(), once — every other column
    -- byte-equal. Each condition named when it fails.
    IF ob1_forgetting() IS DISTINCT FROM OLD.thought_id THEN
      -- ob1_forgetting() names no thought still standing: forget_thought
      -- deletes it first.
      v_why := 'only an event of a deleted thought this transaction is forgetting (ob1.forgetting) is redacted';
    ELSIF OLD.redacted_at IS NOT NULL THEN
      v_why := 'an event is redacted once';
    ELSIF (to_jsonb(OLD) - 'diff' - 'redacted_at') <> (to_jsonb(NEW) - 'diff' - 'redacted_at') THEN
      v_why := 'a column other than diff and redacted_at changes';
    ELSIF NEW.diff IS DISTINCT FROM ob1_audit_redacted_diff(OLD.diff, OLD.action) THEN
      v_why := 'diff must be what ob1_audit_redacted_diff leaves of it';
    ELSIF NEW.redacted_at IS DISTINCT FROM now() THEN
      v_why := 'redacted_at must be now(), this transaction''s time';
    ELSE
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'thought_audit is append-only: the redact amendment may only replace a forgotten thought''s event''s text with the marker, once, and stamp redacted_at with now() — here %.',
      v_why;
  END IF;

  -- 008: the guidance is in the MESSAGE rather than in USING HINT deliberately.
  -- Bun's Postgres client returns the HINT field as UTF-16 bytes with
  -- interleaved nulls, so anything put there is unreadable to the runtime this
  -- server actually uses.
  RAISE EXCEPTION
    'thought_audit is append-only: % is not permitted. To prune history, DROP TRIGGER % in a migration — deliberately, and with a record of why.',
    TG_OP, CASE WHEN TG_OP = 'TRUNCATE' THEN 'thought_audit_immutable_truncate' ELSE 'thought_audit_immutable' END;
END;
$$;
COMMENT ON FUNCTION thought_audit_refuse_mutation() IS
  'thought_audit''s guard (trigger thought_audit_immutable, and thought_audit_immutable_truncate): every DELETE and every truncation refused, and every UPDATE but its three named amendments — backfill (046: a NULL actor_kind, trust or origin filled with what the row derives to), payload (055: a capture row''s diff.content and diff.created_at filled where absent), and redact (139: an event of the thought forget_thought is forgetting, once deleted, its diff replaced by ob1_audit_redacted_diff and redacted_at stamped, once). Migrations 008, 046, 055 and 139 / SMD-1723.';

-- ---------------------------------------------------------------------------
-- 3. The ledger: what was forgotten, when, by whom, and the evidence
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS thought_forgotten (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  thought_id     uuid        NOT NULL,
  forgotten_at   timestamptz NOT NULL DEFAULT now(),
  actor_name     text,
  actor_agent_id uuid,
  fingerprints   text[]      NOT NULL DEFAULT '{}',
  evidence       jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS thought_forgotten_thought_idx ON thought_forgotten (thought_id);
CREATE INDEX IF NOT EXISTS thought_forgotten_fingerprints_idx ON thought_forgotten USING gin (fingerprints);
COMMENT ON TABLE thought_forgotten IS
  'One row per thought forget_thought removed: when, by whom (the key''s name and agent id), every fingerprint its text had that no standing thought holds, and the evidence the call returned (what each store gave up, the children it could not rebuild, the twins that keep the text, the copies outside the brain). Append-only. A capture or edit to a text whose fingerprint it holds is refused OB005 unless ob1.reinstate_forgotten is on. Migration 139 / SMD-1723.';

CREATE OR REPLACE FUNCTION ob1_forgotten_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    MESSAGE = format('thought_forgotten is append-only: %s refused (the record that a thought was forgotten is itself kept)', TG_OP),
    ERRCODE = 'restrict_violation';
END;
$$;
COMMENT ON FUNCTION ob1_forgotten_guard() IS
  'Refuses every UPDATE and DELETE of thought_forgotten, and its truncation — for the owner too. Migration 139 / SMD-1723.';

DROP TRIGGER IF EXISTS thought_forgotten_append_only ON thought_forgotten;
CREATE TRIGGER thought_forgotten_append_only
  BEFORE UPDATE OR DELETE ON thought_forgotten
  FOR EACH ROW EXECUTE FUNCTION ob1_forgotten_guard();
DROP TRIGGER IF EXISTS thought_forgotten_no_truncate ON thought_forgotten;
CREATE TRIGGER thought_forgotten_no_truncate
  BEFORE TRUNCATE ON thought_forgotten
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_forgotten_guard();

-- ---------------------------------------------------------------------------
-- 4. A forgotten text is refused on its way back
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_refuse_forgotten_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_at timestamptz;
BEGIN
  -- An edit that leaves the text as it was, an empty ledger, or a caller
  -- reinstating on purpose (the maintainer, 2026-11-13: refused unless
  -- reinstated) passes untouched.
  IF TG_OP = 'UPDATE' AND NEW.content IS NOT DISTINCT FROM OLD.content THEN
    RETURN NEW;
  END IF;
  IF current_setting('ob1.reinstate_forgotten', true) = 'on' OR NOT EXISTS (SELECT 1 FROM thought_forgotten) THEN
    RETURN NEW;
  END IF;
  -- The writer's key, and the canonical one: a raw write may leave the key
  -- NULL, or stale beside an edited text.
  SELECT max(f.forgotten_at) INTO v_at
    FROM thought_forgotten f
   WHERE f.fingerprints && ARRAY[NEW.content_fingerprint, content_fingerprint_of(NEW.content)];
  IF v_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'OB005',
      MESSAGE = format('this text was forgotten on %s; writing it again needs set_config(''ob1.reinstate_forgotten'', ''on'', true)', v_at),
      DETAIL = jsonb_build_object('forgotten_at', v_at)::text;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION ob1_refuse_forgotten_text() IS
  'Refuses (OB005, DETAIL {forgotten_at}) a thought written with a text whose fingerprint thought_forgotten holds — a capture, or an edit that changes the text — unless ob1.reinstate_forgotten is on for the transaction. Reads the writer''s content_fingerprint and content_fingerprint_of(content). Migration 139 / SMD-1723.';

DROP TRIGGER IF EXISTS thoughts_refuse_forgotten ON thoughts;
CREATE TRIGGER thoughts_refuse_forgotten
  BEFORE INSERT OR UPDATE OF content ON thoughts
  FOR EACH ROW EXECUTE FUNCTION ob1_refuse_forgotten_text();

-- ---------------------------------------------------------------------------
-- 5. The append-only guards admit the forget's deletes, and nothing else
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_forgetting_item(p_item text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  -- An open item read from the thought this transaction is forgetting: its
  -- projection names that thought as its origin, or any of its events does.
  SELECT ob1_forgetting() IS NOT NULL AND p_item IS NOT NULL
     AND (EXISTS (SELECT 1 FROM open_items i WHERE i.item_id::text = p_item AND i.origin_thought_id = ob1_forgetting())
          OR EXISTS (SELECT 1 FROM open_item_events e WHERE e.item_id::text = p_item AND e.origin_thought_id = ob1_forgetting())
          -- An item an earlier forget of the thought took: a write that raced it may have left an event behind, with
          -- no origin and no item (review pass 2), which the second forget sweeps.
          OR EXISTS (SELECT 1 FROM thought_forgotten f WHERE f.thought_id = ob1_forgetting() AND f.evidence->'item_ids' ? p_item))
$$;
COMMENT ON FUNCTION ob1_forgetting_item(text) IS
  'Whether an open item (by its id as text) was read from the thought this transaction is forgetting (ob1_forgetting), or was taken by an earlier forget of it (its ledger rows'' item_ids): the guards of 116 and 117 admit the forget''s delete of its rows. Migration 139 / SMD-1723.';

CREATE OR REPLACE FUNCTION ob1_priority_assertions_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Only an open row closing, once: every other column as it was.
    -- The whole row but the three closing columns, as jsonb: a column a later
    -- migration adds is held without editing a list here (review pass 5).
    -- maker_key is left out: a stored generated column is not yet computed in
    -- a BEFORE trigger's NEW, and the columns it is made from are compared.
    IF OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL
       AND to_jsonb(NEW) - ARRAY['closed_at', 'close_reason', 'closed_by', 'maker_key']
           = to_jsonb(OLD) - ARRAY['closed_at', 'close_reason', 'closed_by', 'maker_key'] THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING
      MESSAGE = 'priority_assertions is append-only: a row changes only to close its window, once',
      ERRCODE = 'restrict_violation';
  END IF;
  -- 139 (SMD-1723): forget_thought deletes a statement on the thought it is
  -- forgetting, or on an open item read from it, or one taking its due time
  -- from either — a reason may hold the text. Nothing else.
  IF TG_OP = 'DELETE' AND ob1_forgetting() IS NOT NULL
     AND ((OLD.item_kind = 'thought' AND OLD.item_key = ob1_forgetting()::text)
          OR (OLD.due_ref_kind = 'thought' AND OLD.due_ref_key = ob1_forgetting()::text)
          OR (OLD.item_kind = 'item' AND ob1_forgetting_item(OLD.item_key))
          OR (OLD.due_ref_kind = 'item' AND ob1_forgetting_item(OLD.due_ref_key))) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING
    MESSAGE = format('priority_assertions is append-only: %s refused (a statement stays in the history; replace or clear it instead)', TG_OP),
    ERRCODE = 'restrict_violation';
END;
$$;
COMMENT ON FUNCTION ob1_priority_assertions_guard() IS
  'Refuses an UPDATE of priority_assertions other than an open row closing its window once (closed_at, close_reason, closed_by), every TRUNCATE, and every DELETE but forget_thought''s of a statement on the thought it is forgetting, on an open item read from it, or taking its due time from either (ob1_forgetting, 139) — for the owner too. Migration 116 / SMD-3663. The forget''s delete admitted by migration 139 / SMD-1723.';

CREATE OR REPLACE FUNCTION ob1_item_events_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- 139 (SMD-1723): forget_thought deletes the events of an item read from
  -- the thought it is forgetting — an item's text is the thought's.
  IF TG_OP = 'DELETE' AND ob1_forgetting_item(OLD.item_id::text) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING
    MESSAGE = format('open_item_events is append-only: %s refused (an item changes by a new event: update_item or set_item_status)', TG_OP),
    ERRCODE = 'restrict_violation';
END;
$$;
COMMENT ON FUNCTION ob1_item_events_guard() IS
  'Refuses every UPDATE of open_item_events, every TRUNCATE, and every DELETE but forget_thought''s of the events of an item read from the thought it is forgetting (ob1_forgetting_item, 139) — for the owner too. Migration 117 / SMD-3665. The forget''s delete admitted by migration 139 / SMD-1723.';

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
  -- 139 (SMD-1723): forget_thought deletes a proposal whose evidence is the
  -- thought it is forgetting, or on an item read from it.
  IF TG_OP = 'DELETE' AND ob1_forgetting() IS NOT NULL
     AND (OLD.evidence_thought_id = ob1_forgetting() OR ob1_forgetting_item(OLD.item_id::text)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING
    MESSAGE = format('open_item_close_proposals keeps every proposal: %s refused (reject it instead)', TG_OP),
    ERRCODE = 'restrict_violation';
END;
$$;
COMMENT ON FUNCTION ob1_item_proposals_guard() IS
  'Refuses an UPDATE of open_item_close_proposals other than a pending row being decided once (decision, decided_at, decider_name, decider_agent_id, decision_reason), every TRUNCATE, and every DELETE but forget_thought''s of a proposal whose evidence is the thought it is forgetting or on an item read from it (139) — for the owner too. Migration 117 / SMD-3665. The forget''s delete admitted by migration 139 / SMD-1723.';

CREATE OR REPLACE FUNCTION ob1_deliverable_events_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- 139 (SMD-1723): forget_thought deletes the events of the deliverable that
  -- is the thought it is forgetting; an outcome may quote it.
  IF TG_OP = 'DELETE' AND ob1_forgetting() IS NOT NULL AND OLD.thought_id = ob1_forgetting() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING
    MESSAGE = format('deliverable_events is append-only: %s refused (a deliverable changes by a new event: verify_deliverable)', TG_OP),
    ERRCODE = 'restrict_violation';
END;
$$;
COMMENT ON FUNCTION ob1_deliverable_events_guard() IS
  'Refuses every UPDATE of deliverable_events, every TRUNCATE, and every DELETE but forget_thought''s of the events of the deliverable that is the thought it is forgetting (139) — for the owner too. Migration 134 / SMD-1715. The forget''s delete admitted by migration 139 / SMD-1723.';

-- ---------------------------------------------------------------------------
-- 6. forget_thought
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forget_thought(
  p_id    uuid,
  p_actor jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_row          thoughts%ROWTYPE;
  v_found        boolean;
  v_ledgered     boolean;
  v_when         timestamptz;
  v_cited        int;
  v_sample       jsonb;
  v_fps          text[];
  v_twins        uuid[];
  v_children     uuid[];
  v_pages        uuid[] := '{}';
  v_items        text[];
  v_rebuild      jsonb;
  v_del          jsonb;
  v_n            jsonb := '{}'::jsonb;
  v_c            int;
  v_q            int;
  v_total        int;
  v_pair         record;
  v_actor        jsonb;
  v_evidence     jsonb;
  v_answer       jsonb;
  v_prev_amend   text := current_setting('ob1.audit_amend', true);
  v_prev_forget  text := current_setting('ob1.forgetting', true);
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'forget_thought needs a thought id', ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Every setting a refusal must keep outside the block below, as
  -- delete_thought does (060).
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;
  -- ob1:supersession-review (036) first, as delete_thought and update_thought
  -- take it; then every fingerprint the text has had, read before any row
  -- lock and locked as a capture of that text locks it (033: the fingerprint
  -- lock, then the row), in order, so a capture or an edit to one of those
  -- texts waits for this forget and then meets the ledger (review pass 1: a
  -- capture of an earlier text raced it); then the row.
  PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));
  SELECT array_agg(DISTINCT fp ORDER BY fp) INTO v_fps
    FROM (SELECT t.content_fingerprint AS fp FROM thoughts t WHERE t.id = p_id
          UNION ALL SELECT content_fingerprint_of(t.content) FROM thoughts t WHERE t.id = p_id
          UNION ALL SELECT a.diff->'content_fingerprint'->>'before' FROM thought_audit a WHERE a.thought_id = p_id
          UNION ALL SELECT a.diff->'content_fingerprint'->>'after'  FROM thought_audit a WHERE a.thought_id = p_id
          UNION ALL SELECT content_fingerprint_of(a.diff->>'content') FROM thought_audit a
                     WHERE a.thought_id = p_id AND a.redacted_at IS NULL AND jsonb_typeof(a.diff->'content') = 'string'
          UNION ALL SELECT content_fingerprint_of(a.diff->'content'->>'before') FROM thought_audit a
                     WHERE a.thought_id = p_id AND a.redacted_at IS NULL AND jsonb_typeof(a.diff->'content'->'before') = 'string'
          UNION ALL SELECT content_fingerprint_of(a.diff->'content'->>'after') FROM thought_audit a
                     WHERE a.thought_id = p_id AND a.redacted_at IS NULL AND jsonb_typeof(a.diff->'content'->'after') = 'string'
          UNION ALL SELECT content_fingerprint_of(a.diff->>'previous_content') FROM thought_audit a
                     WHERE a.thought_id = p_id AND a.redacted_at IS NULL AND jsonb_typeof(a.diff->'previous_content') = 'string') s
   WHERE fp IS NOT NULL;
  PERFORM pg_advisory_xact_lock(hashtextextended(fp, 0)) FROM unnest(COALESCE(v_fps, '{}')) fp ORDER BY fp;
  SELECT * INTO v_row FROM thoughts WHERE id = p_id FOR NO KEY UPDATE;
  v_found := FOUND;
  v_ledgered := EXISTS (SELECT 1 FROM thought_forgotten f WHERE f.thought_id = p_id);

  -- No row: a thought deleted before it was forgotten is forgotten all the
  -- same, from what the log and the stores still hold (review pass 1:
  -- delete first is an operator's likely first move). An id the log never
  -- held is NOT_FOUND.
  IF NOT v_found AND NOT v_ledgered AND NOT EXISTS (SELECT 1 FROM thought_audit a WHERE a.thought_id = p_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;

  -- A thought another cites is refused, as delete_thought refuses it (the
  -- maintainer, 2026-11-13): the operator detaches first, by deleting it with
  -- delete_thought(id, actor, true), then forgets it. A citation so detached
  -- names it as source_deleted_id and refuses nothing (review pass 2: it
  -- refused for good); the sweep below deletes it. The same answer, up to ten
  -- citing rows, newest first (042).
  SELECT count(*)::int INTO v_cited
    FROM thought_facets f
   WHERE f.kind = 'citation' AND f.payload->>'source_id' = p_id::text AND f.thought_id <> p_id AND thought_facet_active(f);
  IF v_cited > 0 THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'thought_id', s.thought_id, 'source_id', s.source_id,
                                                 'stance', s.stance, 'text', s.text, 'created_at', s.created_at)
                              ORDER BY s.created_at DESC, s.id), '[]'::jsonb)
      INTO v_sample
      FROM (SELECT f.id, f.thought_id, (f.payload->>'source_id')::uuid AS source_id,
                   f.payload->>'stance' AS stance, f.payload->>'text' AS text, f.created_at
              FROM thought_facets f
             WHERE f.kind = 'citation' AND f.payload->>'source_id' = p_id::text AND f.thought_id <> p_id AND thought_facet_active(f)
             ORDER BY f.created_at DESC, f.id
             LIMIT 10) s;
    RETURN jsonb_build_object('ok', false, 'error', 'CITED', 'id', p_id, 'cited_by', v_cited, 'citations', v_sample);
  END IF;

  BEGIN
    PERFORM set_config('ob1.forgetting', p_id::text, true);
    -- A raw write below declares nothing (046), as delete_thought clears it.
    PERFORM set_config('ob1.event', '', true);

    -- The fingerprints a standing thought also holds stay out: a twin keeps
    -- its text, and is named. A twin holds its text under a NULL key (018:
    -- one live holder per key, 003's partial unique index), so a row with no
    -- key is read by the fingerprint of its content.
    SELECT array_agg(t.id ORDER BY t.id) INTO v_twins
      FROM thoughts t
     WHERE t.id <> p_id
       AND (t.content_fingerprint = ANY(COALESCE(v_fps, '{}'))
            OR (t.content_fingerprint IS NULL AND content_fingerprint_of(t.content) = ANY(COALESCE(v_fps, '{}'))));
    SELECT COALESCE(array_agg(fp ORDER BY fp), '{}') INTO v_fps
      FROM unnest(COALESCE(v_fps, '{}')) fp
     WHERE NOT EXISTS (SELECT 1 FROM thoughts t
                        WHERE t.id <> p_id
                          AND (t.content_fingerprint = fp OR (t.content_fingerprint IS NULL AND content_fingerprint_of(t.content) = fp)));

    IF v_found THEN
      -- The lineage walk (063/067), with the row still standing: its windows,
      -- its entity links and the entities left with none, the snapshot's
      -- vectors at those fingerprints; the children it can't rebuild.
      v_rebuild := rebuild_derived(p_id, 'forget', true, v_fps);
    ELSE
      -- Deleted already: its windows, links and lineage went with the row;
      -- the snapshot keeps the vectors (060: no foreign key), which go here.
      DELETE FROM ob1_embedding_snapshot s WHERE s.content_fingerprint = ANY(v_fps);
      GET DIAGNOSTICS v_c = ROW_COUNT;
      v_rebuild := jsonb_build_object('input_gone', true, 'row', 'deleted before the forget', 'snapshot_rows', v_c);
      -- Its entity links went with the row, leaving any entity only it named
      -- with no mention: 016's residue, which prune_orphan_entities takes —
      -- every such entity in the brain, the forgotten thought's among them
      -- (review pass 2: a name from the text stood). Once, on the first
      -- forget: a later one sweeps this thought's leftovers, not the brain's.
      IF NOT v_ledgered THEN
        v_rebuild := v_rebuild || jsonb_build_object('orphan_entities', prune_orphan_entities());
      END IF;
    END IF;

    -- The relation facets on other thoughts that target it (084, 120), and
    -- the expired or superseded citations of it, which may quote it.
    DELETE FROM thought_facets f
     WHERE f.kind = 'relation' AND f.payload->>'target' = p_id::text AND f.thought_id <> p_id;
    GET DIAGNOSTICS v_c = ROW_COUNT;
    v_n := v_n || jsonb_build_object('relations', v_c);
    DELETE FROM thought_facets f
     WHERE f.id IN (SELECT x.id FROM thought_facets x
                     WHERE x.kind = 'citation' AND x.payload->>'source_id' = p_id::text AND x.thought_id <> p_id AND NOT thought_facet_active(x));
    GET DIAGNOSTICS v_c = ROW_COUNT;
    v_n := v_n || jsonb_build_object('inactive_citations', v_c);
    -- The citations detached from it when it was deleted (042: each keeps its
    -- text and names it as source_deleted_id), active or not.
    DELETE FROM thought_facets f
     WHERE f.kind = 'citation' AND f.payload->>'source_deleted_id' = p_id::text AND f.thought_id <> p_id;
    GET DIAGNOSTICS v_c = ROW_COUNT;
    v_n := v_n || jsonb_build_object('detached_citations', v_c);

    -- Its id out of other thoughts' derived_from (a raw update, which the
    -- audit trigger records). Prose those thoughts absorbed can't be removed
    -- mechanically: they are listed for a person to review.
    WITH ch AS (
      SELECT t.id FROM thoughts t
       WHERE t.id <> p_id AND jsonb_typeof(t.derived_from) = 'array' AND t.derived_from @> jsonb_build_array(p_id::text)
       ORDER BY t.id FOR NO KEY UPDATE OF t
    ), done AS (
      UPDATE thoughts t
         SET derived_from = (SELECT jsonb_agg(e ORDER BY o) FROM jsonb_array_elements(t.derived_from) WITH ORDINALITY x(e, o)
                              WHERE e <> to_jsonb(p_id::text))
        FROM ch WHERE t.id = ch.id
      RETURNING t.id
    )
    SELECT array_agg(id ORDER BY id) INTO v_children FROM done;
    v_n := v_n || jsonb_build_object('derived_refs', COALESCE(cardinality(v_children), 0));

    -- The page sections built on it (the maintainer, 2026-11-13), through
    -- delete_page_section (064): the row, its revisions and its lineage go,
    -- and the page thought is re-rendered without it. That page's own log
    -- keeps the earlier render, another thought's history: the page is listed
    -- for review beside the children. Its next pass writes the section again.
    v_c := 0;
    FOR v_pair IN
      SELECT s.id, s.page_id FROM page_sections s
       WHERE s.page_id <> p_id
         AND (p_id = ANY(s.evidence_thought_ids) OR p_id = ANY(COALESCE(s.pending_evidence_thought_ids, '{}'::uuid[])))
       ORDER BY s.page_id, s.id
    LOOP
      PERFORM delete_page_section(v_pair.id, (p_actor->>'name'));
      v_c := v_c + 1;
      v_pages := array_append(v_pages, v_pair.page_id);
    END LOOP;
    v_n := v_n || jsonb_build_object('page_sections', v_c);
    -- A page whose log names it — a section once built on it, since rewritten
    -- on other evidence, whose earlier body a revision keeps: revisions record
    -- no evidence, so which section held it can't be told. Listed for review
    -- (the maintainer, review pass 1).
    SELECT array_agg(DISTINCT x ORDER BY x) INTO v_pages
      FROM (SELECT unnest(v_pages) AS x
            UNION SELECT a.thought_id FROM thought_audit a JOIN pages pg ON pg.id = a.thought_id
             WHERE a.thought_id <> p_id
               AND (a.diff->'derived_from' @> jsonb_build_array(p_id::text)
                    OR a.diff->'derived_from'->'before' @> jsonb_build_array(p_id::text)
                    OR a.diff->'derived_from'->'after' @> jsonb_build_array(p_id::text))) s;

    -- The query log's references to it: the id leaves a search's results,
    -- each score with its id (they are aligned by position), and an agenda's
    -- items, the others kept (review pass 1); the query text stays, being
    -- what a caller typed. An action row on it, which must name its target
    -- (034's CHECK), goes.
    UPDATE query_log q
       SET result_ids = x.ids, result_scores = x.scores
      FROM (SELECT q2.id,
                   ARRAY(SELECT r FROM unnest(q2.result_ids) WITH ORDINALITY u(r, o) WHERE r IS DISTINCT FROM p_id ORDER BY o) AS ids,
                   CASE WHEN q2.result_scores IS NULL THEN NULL
                        ELSE ARRAY(SELECT s FROM unnest(q2.result_scores) WITH ORDINALITY u(s, o)
                                    WHERE (q2.result_ids)[o] IS DISTINCT FROM p_id ORDER BY o) END AS scores
              FROM query_log q2 WHERE p_id = ANY(q2.result_ids)) x
     WHERE q.id = x.id;
    GET DIAGNOSTICS v_c = ROW_COUNT;
    v_q := v_c;
    DELETE FROM query_log q WHERE q.target_id = p_id;
    GET DIAGNOSTICS v_c = ROW_COUNT;
    v_q := v_q + v_c;
    UPDATE query_log q
       SET result_items = (SELECT COALESCE(jsonb_agg(e ORDER BY o), '[]'::jsonb)
                             FROM jsonb_array_elements(q.result_items) WITH ORDINALITY x(e, o)
                            WHERE (e->>'key') IS DISTINCT FROM p_id::text AND (e->>'id') IS DISTINCT FROM p_id::text)
     WHERE jsonb_typeof(q.result_items) = 'array'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(q.result_items) e WHERE e->>'key' = p_id::text OR e->>'id' = p_id::text);
    GET DIAGNOSTICS v_c = ROW_COUNT;
    v_n := v_n || jsonb_build_object('query_log_rows', v_q + v_c);

    -- The row, through delete_thought: its tombstone, its projection and the
    -- cascades. Anything but ok undoes every step above.
    IF v_found THEN
      v_del := delete_thought(p_id, NULL, false);
      IF NOT COALESCE((v_del->>'ok')::boolean, false) THEN
        RAISE EXCEPTION USING ERRCODE = 'OB006', MESSAGE = 'forget_thought: delete_thought refused', DETAIL = v_del::text;
      END IF;
    END IF;

    -- Now the row is gone, the append-only stores' rows on it: the guards of
    -- 116, 117 and 134 admit a forget's delete only of a thought already
    -- deleted (ob1_forgetting, review pass 1). The open items read from it,
    -- then the priority statements on it, on them, or taking a due time from
    -- either (116), each item re-projected.
    SELECT COALESCE(array_agg(DISTINCT k), '{}') INTO v_items
      FROM (SELECT i.item_id::text AS k FROM open_items i WHERE i.origin_thought_id = p_id
            UNION SELECT e.item_id::text FROM open_item_events e WHERE e.origin_thought_id = p_id
            UNION SELECT jsonb_array_elements_text(f.evidence->'item_ids') FROM thought_forgotten f
                   WHERE f.thought_id = p_id AND jsonb_typeof(f.evidence->'item_ids') = 'array') s;
    v_c := 0;
    FOR v_pair IN
      WITH gone AS (
        DELETE FROM priority_assertions pa
         WHERE (pa.item_kind = 'thought' AND pa.item_key = p_id::text)
            OR (pa.due_ref_kind = 'thought' AND pa.due_ref_key = p_id::text)
            OR (pa.item_kind = 'item' AND pa.item_key = ANY(v_items))
            OR (pa.due_ref_kind = 'item' AND pa.due_ref_key = ANY(v_items))
        RETURNING pa.item_kind, pa.item_key
      )
      SELECT item_kind, item_key, count(*)::int AS n FROM gone GROUP BY 1, 2 ORDER BY 1, 2
    LOOP
      v_c := v_c + v_pair.n;
      PERFORM ob1_priority_project(v_pair.item_kind, v_pair.item_key);
    END LOOP;
    v_n := v_n || jsonb_build_object('priority_statements', v_c);

    -- The close proposals whose evidence it is, or on those items; then the
    -- items' events and their projection (117).
    DELETE FROM open_item_close_proposals p
     WHERE p.evidence_thought_id = p_id OR p.item_id::text = ANY(v_items);
    GET DIAGNOSTICS v_c = ROW_COUNT;
    v_n := v_n || jsonb_build_object('item_proposals', v_c);
    DELETE FROM open_item_events e WHERE e.item_id::text = ANY(v_items);
    GET DIAGNOSTICS v_c = ROW_COUNT;
    v_n := v_n || jsonb_build_object('item_events', v_c);
    DELETE FROM open_items i WHERE i.item_id::text = ANY(v_items);
    GET DIAGNOSTICS v_c = ROW_COUNT;
    v_n := v_n || jsonb_build_object('items', v_c);

    -- Its deliverable's events (134), now the row and its facet are gone.
    DELETE FROM deliverable_events d WHERE d.thought_id = p_id;
    GET DIAGNOSTICS v_c = ROW_COUNT;
    v_n := v_n || jsonb_build_object('deliverable_events', v_c);

    -- Every event in the log for it, the tombstone just written included:
    -- the redact amendment.
    PERFORM set_config('ob1.audit_amend', 'redact', true);
    UPDATE thought_audit a SET diff = ob1_audit_redacted_diff(a.diff, a.action), redacted_at = now()
     WHERE a.thought_id = p_id AND a.redacted_at IS NULL;
    GET DIAGNOSTICS v_c = ROW_COUNT;
    PERFORM set_config('ob1.audit_amend', COALESCE(v_prev_amend, ''), true);
    v_n := v_n || jsonb_build_object('audit_events', v_c);

    -- Forgotten before, and nothing left to take: FORGOTTEN, as it was.
    SELECT COALESCE(sum(value::int), 0)::int INTO v_total FROM jsonb_each_text(v_n);
    IF v_ledgered AND NOT v_found AND v_total = 0
       AND COALESCE((v_rebuild->>'snapshot_rows')::int, 0) = 0 AND cardinality(COALESCE(v_children, '{}')) = 0 THEN
      SELECT max(forgotten_at) INTO v_when FROM thought_forgotten WHERE thought_id = p_id;
      PERFORM set_config('ob1.forgetting', COALESCE(v_prev_forget, ''), true);
      RETURN jsonb_build_object('ok', false, 'error', 'FORGOTTEN', 'id', p_id, 'forgotten_at', v_when);
    END IF;

    BEGIN
      v_actor := NULLIF(current_setting('ob1.actor', true), '')::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_actor := NULL;
    END;
    v_evidence := jsonb_build_object(
      'gone', NOT v_found,
      'removed', v_n,
      'rebuild', v_rebuild,
      'irreproducible', to_jsonb(COALESCE(v_children, '{}'::uuid[])),
      'pages', to_jsonb(COALESCE(v_pages, '{}'::uuid[])),
      'twins', to_jsonb(COALESCE(v_twins, '{}'::uuid[])),
      'item_ids', to_jsonb(COALESCE(v_items, '{}'::text[])),
      'outside', jsonb_build_array('the sleep dumps (OB1_SLEEP_DUMP_DIR)', 'Linear comments already posted with a proposal''s reason (board_findings_posted)',
                                   'the weekly digest''s files', 'extraction dumps (extract-entities.ts --dump)'));
    INSERT INTO thought_forgotten (thought_id, actor_name, actor_agent_id, fingerprints, evidence)
    VALUES (p_id, v_actor->>'name',
            CASE WHEN pg_input_is_valid(v_actor->>'agent_id', 'uuid') THEN (v_actor->>'agent_id')::uuid END,
            v_fps, v_evidence)
    RETURNING forgotten_at INTO v_when;
    PERFORM set_config('ob1.forgetting', COALESCE(v_prev_forget, ''), true);
    v_answer := jsonb_build_object('ok', true, 'id', p_id, 'forgotten_at', v_when) || v_evidence;
  EXCEPTION WHEN SQLSTATE 'OB006' THEN
    -- delete_thought's answer, every step above undone with it.
    DECLARE
      v_detail text;
    BEGIN
      GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
      v_answer := v_detail::jsonb;
    END;
  END;
  RETURN v_answer;
END;
$$;
COMMENT ON FUNCTION forget_thought(uuid, jsonb) IS
  'Forget a thought: remove it and everything in the database holding its text, in one transaction, and return the evidence (migration 139 / SMD-1723). Takes the supersession lock, then the capture''s fingerprint lock for every text it has had (in order), then the row; a write racing the forget on another store may land beside it, and a second call sweeps what it left (FORGOTTEN when nothing). An id the log never held: {ok:false, error:NOT_FOUND}. Cited by an active citation: {ok:false, error:CITED, id, cited_by, citations}, as delete_thought; the operator detaches first (delete_thought(id, actor, true)), then forgets it, its detached citations deleted. A thought deleted before is forgotten from what remains (gone true): its snapshot vectors, the brain''s orphaned entities (prune_orphan_entities) and every store below. Else: rebuild_derived(id, ''forget'', true, its fingerprints) (windows, entity links, orphaned entities, snapshot vectors); relation facets targeting it, expired or superseded citations of it and citations detached from it deleted; its id stripped from other thoughts'' derived_from (those listed irreproducible); page sections whose evidence names it deleted through delete_page_section, each page re-rendered, and every page whose own log names it listed in pages (its log and its revisions may keep an earlier render); the query log''s result_ids (with their scores) and result_items cleared of it, its action rows deleted; the row deleted through delete_thought; then the priority statements on it, on open items read from it, or taking a due time from either, deleted and re-projected; those items, their events and close proposals (and proposals whose evidence it is) deleted; its deliverable''s events deleted; every event of it in thought_audit redacted (the redact amendment); a thought_forgotten row written. Forgotten already with nothing left: FORGOTTEN with forgotten_at. Returns {ok:true, id, forgotten_at, gone, removed{relations, inactive_citations, detached_citations, derived_refs, page_sections, query_log_rows, priority_statements, item_proposals, item_events, items, deliverable_events, audit_events}, rebuild, irreproducible[] (thoughts derived from it, for a person to review), pages[] (pages to review), twins[] (standing thoughts holding the same text), item_ids[] (the items it took, which a later call sweeps again), outside[] (copies beyond the brain)}.';

-- ---------------------------------------------------------------------------
-- 7. Every role that writes thoughts reads the ledger, which the refusal on
--    thoughts reads. The owner holds it already; a re-apply grants what is
--    held. Never to PUBLIC.
-- ---------------------------------------------------------------------------
DO $grant$
DECLARE
  v_role record;
BEGIN
  FOR v_role IN
    SELECT DISTINCT a.grantee
      FROM pg_class c, aclexplode(c.relacl) AS a
     WHERE c.oid = 'thoughts'::regclass AND a.grantee <> c.relowner AND a.grantee <> 0 AND a.privilege_type IN ('INSERT', 'UPDATE')
  LOOP
    EXECUTE format('GRANT SELECT ON thought_forgotten TO %s', quote_ident(pg_get_userbyid(v_role.grantee)));
  END LOOP;
END
$grant$;
