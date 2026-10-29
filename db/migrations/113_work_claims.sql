-- =============================================================================
-- Migration 113: work claims — who holds a ticket, or one piece of it, under
--                a lease, so two agents never build the same change (SMD-3597)
-- =============================================================================
--
-- WHY
--   Several agents work one repository at once — Claude Code sessions, Codex,
--   Cursor, a cloud session, an agent on another machine — and a brain recorded
--   nothing about who is working on what. On 2026-10-29 a session recommended
--   SMD-3379 PR 1b-2 while another session had its worktree open: the ticket
--   had been In Progress since its first PR, the branch was unpushed, and
--   nothing any agent could read said the piece was taken (SMD-3596). Every
--   brain should be able to track claimed work (the maintainer, 2026-10-29),
--   so this is a core migration every brain takes, not an opt-in plugin; the
--   label a result naming a claimed ticket carries (SMD-3599) is on the core's
--   read path beside 095's `moved`, which a plugin cannot reach.
--
-- WHAT
--   1. work_claims, one row per claim, kept after it ends as its history.
--      * THE WORK: `issue`, a ticket key in the form the brain's readers find
--        (server-portable/stated-status.ts KEY_RE: SMD-3379), upper-cased and
--        trimmed by the functions; `piece`, optional, the part of the ticket
--        (`PR 1b-2`), trimmed with its spaces collapsed, compared case-folded
--        through the generated `piece_key` ('' for the whole ticket).
--      * THE HOLDER: holder_name, holder_agent_id and holder_kind, stamped
--        from the call's actor envelope (ob1.actor: the p_actor the server
--        passes for the key, 029's shape) through 046's registry lookup —
--        050's rule, the key and never the client's word. A call with no
--        envelope name is refused: a claim nobody holds protects nothing.
--      * THE SESSION: a client's own name for the agent holding the claim
--        (Claude Code's session id, a Codex run's, a GUI session's). Required.
--        A claim is the caller's own only when the key AND the session match:
--        sessions working under one key — the dogfood's Claude Code sessions
--        share one — must still refuse each other, or the 2026-10-29 case
--        reads as one holder and the second claim is granted. A session names
--        nobody outside its key: it cannot make a claim read as another key's.
--      * THE LABEL: free text for people (tool, machine, branch). Shown,
--        trusted for nothing.
--      * THE LEASE: claimed_at, renewed_at, expires_at. A claim past its
--        expires_at, not released, has LAPSED: it counts as free, so no
--        reaper is needed. The next claim on the same work closes it
--        (released_at, released_by the taker, release_reason 'lapsed; taken
--        over') in the claim's own transaction.
--      * THE END: released_at, released_by / _agent_id / _kind (the envelope
--        of the call that ended it) and release_reason.
--
--   2. THE RULES, kept by the functions under one lock per ticket.
--      * A live claim — unreleased, unexpired — refuses another holder's claim
--        on the same work. A whole-ticket claim and a claim on one of its
--        pieces are the same work, either way round; two different pieces of
--        one ticket are not.
--      * The holder's own claim on the same work (key and session) is renewed,
--        not refused: claiming twice is safe.
--      * A refusal is an ANSWER, not an error: outcome 'refused', a stable
--        code, a message naming the first holder, and every claim in the way.
--        Callers branch on it; an exception would abort their transaction.
--        A malformed argument (a ticket key that is not one, a blank session,
--        a lease out of range, no holder) is the caller's bug and raises.
--
--   3. THE FUNCTIONS (SECURITY INVOKER, PUBLIC's EXECUTE as every core
--      function; each returns jsonb {outcome, code, message, claim, held_by}):
--      * claim_work(p_issue, p_session, p_piece, p_label, p_lease_seconds,
--        p_actor): 'claimed', 'renewed' or 'refused' (WORK_CLAIMED).
--      * renew_work_claim(p_claim, p_session, p_lease_seconds, p_actor):
--        'renewed', or 'refused' — CLAIM_NOT_FOUND, CLAIM_NOT_YOURS,
--        CLAIM_RELEASED (released, or taken over after it lapsed), or
--        WORK_CLAIMED (it lapsed and another holder's claim now covers it).
--      * release_work_claim(p_claim, p_session, p_reason, p_force, p_actor):
--        'released', 'already_released', or 'refused' — CLAIM_NOT_FOUND,
--        CLAIM_NOT_YOURS. p_force releases another holder's claim, for an
--        operator key only (046's registry kind) and with a reason.
--      * list_work_claims(p_issues, p_holder, p_include_ended, p_limit): the
--        live claims, or every claim with p_include_ended, each with its
--        `state` — live, lapsed or released. STABLE, one query for a page of
--        tickets (SMD-3599 reads it that way).
--      The lease is p_lease_seconds, 60 to 604800 (a week), default 14400
--      (four hours): an agent's session waits on a person for hours, and a
--      worker's fifteen minutes (015) would lapse under it.
--
--   4. CONCURRENCY. Each writing call takes a transaction advisory lock on its
--      ticket (hashtextextended('ob1:work-claim:' || issue, 0)), so a claim on
--      the whole ticket and a claim on one of its pieces wait for each other,
--      then reads under a snapshot taken after the lock. That needs READ
--      COMMITTED, where each statement takes a new snapshot; under REPEATABLE
--      READ or SERIALIZABLE the read would predate the lock, so the calls are
--      refused there by name (068's rule). The partial unique index
--      work_claims_one_unreleased (one unreleased row per ticket and piece)
--      holds the exact-work half of the rule for a write made without the
--      lock; the whole-against-piece half is the lock's alone.
--
--   5. NOT THE EVENT LOG. Claims are not thoughts: thought_audit is the
--      thoughts' log (thought_id on every row; since 060 the row is its
--      projection, docs/event-log-as-truth.md), and a claim changes no
--      thought. The table keeps its own history instead — an ended claim's row
--      stays, with who ended it and why. SMD-2608's reviewer columns took the
--      same line for a reject.
--
--   ob1:work-claim-holder-from-the-envelope and ob1:work-claim-one-per-work —
--   CONTRACT SENTINELS, not prose (the 014 convention).
--
-- PRIVILEGES
--   The `claims` group (db/config.mjs ROLE_GRANTS): SELECT, INSERT and UPDATE
--   on work_claims. No DELETE: an ended claim stays as history. The holder's
--   kind is read from ob1_agents — the capture group's SELECT (046), which
--   every server role holds. Soft: a role without the group is refused the
--   claim calls, with the grant named, and nothing else. The server first
--   calls them in SMD-3598, whose preflight will say so.
--
-- SAFETY
--   One new table, two indexes on it, five functions; nothing existing is
--   changed. MINOR under FORK.md's version rules.
--   test-schema [101] (the rules), test-live [46] (two claims at once, held),
--   test-upgrade [20be].
--
-- Prerequisites
--   008 (ob1_current_actor), 046 (ob1_registry_kind), 061
--   (ob1_actor_agent_id). Applied by `bun db/migrate.ts`. Re-applied: the
--   table and its indexes are kept, and the functions are replaced as they
--   were.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
BEGIN
  IF to_regprocedure('ob1_current_actor()') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 113 needs 008 (ob1_current_actor); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_registry_kind(uuid, text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 113 needs 046 (ob1_registry_kind); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_actor_agent_id()') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 113 needs 061 (ob1_actor_agent_id); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

CREATE TABLE IF NOT EXISTS work_claims (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  issue                text        NOT NULL,
  piece                text,
  piece_key            text        GENERATED ALWAYS AS (COALESCE(lower(piece), '')) STORED,
  holder_name          text        NOT NULL,
  holder_agent_id      uuid,
  holder_kind          text,
  session              text        NOT NULL,
  label                text,
  claimed_at           timestamptz NOT NULL,
  renewed_at           timestamptz,
  expires_at           timestamptz NOT NULL,
  released_at          timestamptz,
  released_by          text,
  released_by_agent_id uuid,
  released_by_kind     text,
  release_reason       text,
  CONSTRAINT work_claims_issue_key   CHECK (issue ~ '^[A-Z][A-Z0-9]+-[1-9][0-9]*$'),
  CONSTRAINT work_claims_piece_form  CHECK (piece IS NULL OR (piece <> '' AND length(piece) <= 100 AND piece = regexp_replace(btrim(piece), '\s+', ' ', 'g'))),
  CONSTRAINT work_claims_holder      CHECK (holder_name <> '' AND length(holder_name) <= 200),
  CONSTRAINT work_claims_holder_kind CHECK (holder_kind IS NULL OR holder_kind IN ('operator', 'agent', 'ingested')),
  CONSTRAINT work_claims_session     CHECK (session <> '' AND length(session) <= 200),
  CONSTRAINT work_claims_label       CHECK (label IS NULL OR length(label) <= 500),
  CONSTRAINT work_claims_lease       CHECK (expires_at > claimed_at),
  CONSTRAINT work_claims_released_by_kind CHECK (released_by_kind IS NULL OR released_by_kind IN ('operator', 'agent', 'ingested')),
  CONSTRAINT work_claims_ended       CHECK (released_at IS NOT NULL OR (released_by IS NULL AND released_by_agent_id IS NULL AND released_by_kind IS NULL AND release_reason IS NULL))
);

COMMENT ON TABLE work_claims IS
  'Who holds a ticket, or one piece of it (piece: PR 1b-2), under a lease, so two agents never build one change. Live: unreleased and unexpired; lapsed: unreleased and past expires_at, which counts as free; released: ended, kept as history with who ended it. Written only through claim_work, renew_work_claim and release_work_claim; read through list_work_claims. Migration 113 / SMD-3597.';
COMMENT ON COLUMN work_claims.holder_name IS
  'The name the claiming call''s actor envelope (ob1.actor) carried: the key''s name. Stamped by claim_work, never from an argument. Migration 113 / SMD-3597.';
COMMENT ON COLUMN work_claims.session IS
  'The client''s own name for the agent holding the claim (a Claude Code session id, a GUI session). A claim is its caller''s own only when the key and the session both match, so sessions under one key refuse each other; it names nobody outside the key. Migration 113 / SMD-3597.';
COMMENT ON COLUMN work_claims.label IS
  'Free text the client gives for people (tool, machine, branch). Shown, trusted for nothing. Migration 113 / SMD-3597.';
COMMENT ON COLUMN work_claims.piece_key IS
  'The piece compared case-folded; '''' for a whole-ticket claim. A whole-ticket claim and a piece claim of one ticket are the same work; two different pieces are not. Migration 113 / SMD-3597.';

-- ob1:work-claim-one-per-work
CREATE UNIQUE INDEX IF NOT EXISTS work_claims_one_unreleased ON work_claims (issue, piece_key) WHERE released_at IS NULL;
COMMENT ON INDEX work_claims_one_unreleased IS
  'One unreleased claim per ticket and piece: the exact-work half of claim_work''s rule, held for a write made without its lock. A lapsed claim stays unreleased until the next claim on the work closes it. Migration 113 / SMD-3597.';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- A ticket key as the brain's readers find it, or a raise naming the input.
CREATE OR REPLACE FUNCTION ob1_work_claim_issue(p_issue text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v text := upper(btrim(COALESCE(p_issue, '')));
BEGIN
  IF v !~ '^[A-Z][A-Z0-9]+-[1-9][0-9]*$' THEN
    RAISE EXCEPTION USING
      MESSAGE = format('not a ticket key: %L (a team key, a hyphen and a number, such as SMD-3379)', left(COALESCE(p_issue, ''), 80)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v;
END;
$$;
COMMENT ON FUNCTION ob1_work_claim_issue(text) IS
  'A ticket key upper-cased and trimmed, in the form server-portable/stated-status.ts finds in text (SMD-3379); raises on anything else. Migration 113 / SMD-3597.';

-- A piece trimmed with its spaces collapsed; NULL for none or a blank one.
CREATE OR REPLACE FUNCTION ob1_work_claim_piece(p_piece text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v text := NULLIF(regexp_replace(btrim(COALESCE(p_piece, '')), '\s+', ' ', 'g'), '');
BEGIN
  IF length(v) > 100 THEN
    RAISE EXCEPTION USING MESSAGE = format('a piece is at most 100 characters; this one has %s', length(v)), ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v;
END;
$$;
COMMENT ON FUNCTION ob1_work_claim_piece(text) IS
  'A claim''s piece trimmed with its runs of white space made one space; NULL for none, so the claim is on the whole ticket. Raises past 100 characters. Migration 113 / SMD-3597.';

-- One claim as the functions return it.
CREATE OR REPLACE FUNCTION ob1_work_claim_json(c work_claims, p_now timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'issue', c.issue, 'piece', c.piece,
    'holder', c.holder_name, 'holder_agent_id', c.holder_agent_id, 'holder_kind', c.holder_kind,
    'session', c.session, 'label', c.label,
    'claimed_at', c.claimed_at, 'renewed_at', c.renewed_at, 'expires_at', c.expires_at,
    'released_at', c.released_at, 'released_by', c.released_by, 'released_by_kind', c.released_by_kind,
    'release_reason', c.release_reason,
    'state', CASE WHEN c.released_at IS NOT NULL THEN 'released' WHEN c.expires_at <= p_now THEN 'lapsed' ELSE 'live' END)
$$;
COMMENT ON FUNCTION ob1_work_claim_json(work_claims, timestamptz) IS
  'One work claim as jsonb, with its state at p_now: live, lapsed or released. Migration 113 / SMD-3597.';

-- The caller's envelope, set from p_actor when given (029's shape), and the
-- holder it names: name, agent, kind. Raises when it names nobody.
-- ob1:work-claim-holder-from-the-envelope
CREATE OR REPLACE FUNCTION ob1_work_claim_actor(p_actor jsonb, p_what text, OUT name text, OUT agent_id uuid, OUT kind text)
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;
  name := NULLIF(btrim(COALESCE(ob1_current_actor()->>'name', '')), '');
  IF name IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('%s needs a holder: no actor envelope names one', p_what),
      HINT = 'Call it through the server, which passes the key as p_actor, or pass p_actor => ''{"name": "<key name>"}''.',
      ERRCODE = 'insufficient_privilege';
  END IF;
  agent_id := ob1_actor_agent_id();
  kind := ob1_registry_kind(agent_id, name);
END;
$$;
COMMENT ON FUNCTION ob1_work_claim_actor(jsonb, text) IS
  'Sets ob1.actor from p_actor when given, then returns the envelope''s holder (name, 061''s agent id, 046''s registry kind); raises naming p_what when the envelope names nobody. Migration 113 / SMD-3597.';

-- The lock and the snapshot after it. READ COMMITTED alone, so the reads
-- that follow see every claim committed before the lock was granted.
CREATE OR REPLACE FUNCTION ob1_work_claim_lock(p_issue text, p_what text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('%s must run under READ COMMITTED; this transaction is %s', p_what, upper(current_setting('transaction_isolation'))),
      HINT = 'Under REPEATABLE READ or SERIALIZABLE its read of the claims would predate its lock. BEGIN ISOLATION LEVEL READ COMMITTED; then call it.',
      ERRCODE = 'feature_not_supported';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:work-claim:' || p_issue, 0));
END;
$$;
COMMENT ON FUNCTION ob1_work_claim_lock(text, text) IS
  'Takes the transaction advisory lock on one ticket''s claims (a whole-ticket claim and its pieces share it), refusing a transaction above READ COMMITTED by name. Migration 113 / SMD-3597.';

-- Whether a claim is the holder's own: the same session, and the same key —
-- its agent id when the call has one, else its name on a claim with no agent.
-- Never NULL: a NULL here read as "own" in a release (first draft).
CREATE OR REPLACE FUNCTION ob1_work_claim_is_holder(c work_claims, p_name text, p_agent uuid, p_session text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(c.session = p_session
                  AND CASE WHEN p_agent IS NOT NULL THEN c.holder_agent_id = p_agent
                           ELSE c.holder_agent_id IS NULL AND c.holder_name = p_name END, false)
$$;
COMMENT ON FUNCTION ob1_work_claim_is_holder(work_claims, text, uuid, text) IS
  'True when the claim is held by this key (its agent id when given, else its name on a claim with no agent) and this session; false otherwise, never NULL. Migration 113 / SMD-3597.';

-- The live claims of other holders that cover this work, oldest first.
CREATE OR REPLACE FUNCTION ob1_work_claims_in_the_way(p_issue text, p_piece_key text, p_name text, p_agent uuid, p_session text, p_now timestamptz)
RETURNS SETOF work_claims
LANGUAGE sql
STABLE
AS $$
  SELECT c.* FROM work_claims c
   WHERE c.issue = p_issue
     AND c.released_at IS NULL AND c.expires_at > p_now
     AND (c.piece_key = p_piece_key OR c.piece_key = '' OR p_piece_key = '')
     AND NOT ob1_work_claim_is_holder(c, p_name, p_agent, p_session)
   ORDER BY c.claimed_at, c.id
$$;
COMMENT ON FUNCTION ob1_work_claims_in_the_way(text, text, text, uuid, text, timestamptz) IS
  'Another holder''s live claims on this work: the same piece, the whole ticket, or (for a whole-ticket claim) any piece. A holder is a key (its agent id, else its name) and a session together. Migration 113 / SMD-3597.';

CREATE OR REPLACE FUNCTION ob1_work_claim_session(p_session text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v text := btrim(COALESCE(p_session, ''));
BEGIN
  IF v = '' OR length(v) > 200 THEN
    RAISE EXCEPTION USING
      MESSAGE = 'a claim needs a session of 1 to 200 characters: the client''s own name for the agent holding it (a session id)',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v;
END;
$$;
COMMENT ON FUNCTION ob1_work_claim_session(text) IS
  'A claim''s session trimmed; raises when blank or past 200 characters. Migration 113 / SMD-3597.';

CREATE OR REPLACE FUNCTION ob1_work_claim_lease(p_lease_seconds int)
RETURNS interval
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 60 OR p_lease_seconds > 604800 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('a lease is 60 to 604800 seconds (a minute to a week); %s is not', COALESCE(p_lease_seconds::text, 'NULL')),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN make_interval(secs => p_lease_seconds);
END;
$$;
COMMENT ON FUNCTION ob1_work_claim_lease(int) IS
  'A lease in seconds as an interval; raises outside 60 to 604800. Migration 113 / SMD-3597.';

-- ---------------------------------------------------------------------------
-- claim_work
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_work(
  p_issue         text,
  p_session       text,
  p_piece         text  DEFAULT NULL,
  p_label         text  DEFAULT NULL,
  p_lease_seconds int   DEFAULT 14400,
  p_actor         jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_issue   text     := ob1_work_claim_issue(p_issue);
  v_piece   text     := ob1_work_claim_piece(p_piece);
  v_key     text     := COALESCE(lower(ob1_work_claim_piece(p_piece)), '');
  v_session text     := ob1_work_claim_session(p_session);
  v_lease   interval := ob1_work_claim_lease(p_lease_seconds);
  v_label   text     := NULLIF(btrim(COALESCE(p_label, '')), '');
  v_who     record;
  v_now     timestamptz;
  v_mine    work_claims;
  v_row     work_claims;
  v_held    jsonb;
  v_first   work_claims;
BEGIN
  IF length(v_label) > 500 THEN
    RAISE EXCEPTION USING MESSAGE = format('a label is at most 500 characters; this one has %s', length(v_label)), ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_who FROM ob1_work_claim_actor(p_actor, 'claim_work');
  PERFORM ob1_work_claim_lock(v_issue, 'claim_work');
  v_now := clock_timestamp();

  SELECT jsonb_agg(ob1_work_claim_json(w, v_now)) INTO v_held
    FROM ob1_work_claims_in_the_way(v_issue, v_key, v_who.name, v_who.agent_id, v_session, v_now) w;
  IF v_held IS NOT NULL THEN
    SELECT * INTO v_first FROM ob1_work_claims_in_the_way(v_issue, v_key, v_who.name, v_who.agent_id, v_session, v_now) LIMIT 1;
    RETURN jsonb_build_object(
      'outcome', 'refused', 'code', 'WORK_CLAIMED',
      'message', format('%s%s is held by %s (%s) since %s%s, until %s',
                        v_issue, COALESCE(' ' || v_first.piece, ''), v_first.holder_name, v_first.session,
                        to_char(v_first.claimed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"'),
                        COALESCE('; ' || v_first.label, ''),
                        to_char(v_first.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"')),
      'claim', NULL, 'held_by', v_held);
  END IF;

  -- The caller's own unreleased claim on exactly this work, live or lapsed:
  -- renewed. Nothing of another holder's covers it (read above).
  SELECT * INTO v_mine FROM work_claims c
   WHERE c.issue = v_issue AND c.piece_key = v_key AND c.released_at IS NULL
     AND ob1_work_claim_is_holder(c, v_who.name, v_who.agent_id, v_session)
   FOR UPDATE;
  IF FOUND THEN
    UPDATE work_claims SET expires_at = v_now + v_lease, renewed_at = v_now, label = COALESCE(v_label, label)
     WHERE id = v_mine.id RETURNING * INTO v_row;
    RETURN jsonb_build_object('outcome', 'renewed', 'code', NULL, 'message', NULL, 'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb);
  END IF;

  -- A lapsed claim of another holder's on exactly this work: taken over.
  UPDATE work_claims
     SET released_at = v_now, released_by = v_who.name, released_by_agent_id = v_who.agent_id,
         released_by_kind = v_who.kind, release_reason = 'lapsed; taken over'
   WHERE issue = v_issue AND piece_key = v_key AND released_at IS NULL AND expires_at <= v_now;

  INSERT INTO work_claims (issue, piece, holder_name, holder_agent_id, holder_kind, session, label, claimed_at, expires_at)
  VALUES (v_issue, v_piece, v_who.name, v_who.agent_id, v_who.kind, v_session, v_label, v_now, v_now + v_lease)
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('outcome', 'claimed', 'code', NULL, 'message', NULL, 'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb);
END;
$$;
COMMENT ON FUNCTION claim_work(text, text, text, text, int, jsonb) IS
  'Claims a ticket (p_issue), or one piece of it (p_piece), for the key p_actor names and the client''s session, for p_lease_seconds (60 to 604800, default 14400). Returns jsonb {outcome, code, message, claim, held_by}: claimed; renewed, the caller''s own unreleased claim on the same work; or refused (WORK_CLAIMED), with every live claim of another holder''s that covers it — the same piece, the whole ticket, or any piece of it for a whole-ticket claim. A lapsed claim on the same work is closed as taken over. READ COMMITTED only. Migration 113 / SMD-3597.';

-- ---------------------------------------------------------------------------
-- renew_work_claim
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION renew_work_claim(
  p_claim         uuid,
  p_session       text,
  p_lease_seconds int   DEFAULT 14400,
  p_actor         jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_session text     := ob1_work_claim_session(p_session);
  v_lease   interval := ob1_work_claim_lease(p_lease_seconds);
  v_who     record;
  v_issue   text;
  v_now     timestamptz;
  v_row     work_claims;
  v_held    jsonb;
BEGIN
  SELECT * INTO v_who FROM ob1_work_claim_actor(p_actor, 'renew_work_claim');
  SELECT issue INTO v_issue FROM work_claims WHERE id = p_claim;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'CLAIM_NOT_FOUND', 'message', format('no claim %s', p_claim), 'claim', NULL, 'held_by', '[]'::jsonb);
  END IF;
  PERFORM ob1_work_claim_lock(v_issue, 'renew_work_claim');
  v_now := clock_timestamp();
  SELECT * INTO v_row FROM work_claims WHERE id = p_claim FOR UPDATE;

  IF NOT ob1_work_claim_is_holder(v_row, v_who.name, v_who.agent_id, v_session) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'CLAIM_NOT_YOURS',
      'message', format('claim %s is held by %s (%s), not this key and session', p_claim, v_row.holder_name, v_row.session),
      'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb);
  END IF;
  IF v_row.released_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'CLAIM_RELEASED',
      'message', format('claim %s ended at %s (%s); claim the work again', p_claim,
                        to_char(v_row.released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"'), COALESCE(v_row.release_reason, 'released')),
      'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb);
  END IF;
  -- Lapsed meanwhile, another holder may have claimed a piece or the whole.
  SELECT jsonb_agg(ob1_work_claim_json(w, v_now)) INTO v_held
    FROM ob1_work_claims_in_the_way(v_row.issue, v_row.piece_key, v_who.name, v_who.agent_id, v_session, v_now) w;
  IF v_held IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'WORK_CLAIMED',
      'message', format('claim %s lapsed and another holder''s claim now covers its work (%s)', p_claim, v_held->0->>'holder'),
      'claim', ob1_work_claim_json(v_row, v_now), 'held_by', v_held);
  END IF;
  UPDATE work_claims SET expires_at = v_now + v_lease, renewed_at = v_now WHERE id = p_claim RETURNING * INTO v_row;
  RETURN jsonb_build_object('outcome', 'renewed', 'code', NULL, 'message', NULL, 'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb);
END;
$$;
COMMENT ON FUNCTION renew_work_claim(uuid, text, int, jsonb) IS
  'Extends the caller''s own claim (the key p_actor names and the session) to p_lease_seconds from now. Returns jsonb {outcome, code, message, claim, held_by}: renewed, or refused — CLAIM_NOT_FOUND, CLAIM_NOT_YOURS, CLAIM_RELEASED (ended, or taken over after it lapsed), WORK_CLAIMED (it lapsed and another holder''s claim covers its work). A lapsed claim nobody covers is renewed. READ COMMITTED only. Migration 113 / SMD-3597.';

-- ---------------------------------------------------------------------------
-- release_work_claim
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION release_work_claim(
  p_claim   uuid,
  p_session text    DEFAULT NULL,
  p_reason  text    DEFAULT NULL,
  p_force   boolean DEFAULT false,
  p_actor   jsonb   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_who    record;
  v_issue  text;
  v_now    timestamptz;
  v_row    work_claims;
  v_own    boolean;
BEGIN
  IF length(v_reason) > 500 THEN
    RAISE EXCEPTION USING MESSAGE = format('a reason is at most 500 characters; this one has %s', length(v_reason)), ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_who FROM ob1_work_claim_actor(p_actor, 'release_work_claim');
  SELECT issue INTO v_issue FROM work_claims WHERE id = p_claim;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'CLAIM_NOT_FOUND', 'message', format('no claim %s', p_claim), 'claim', NULL, 'held_by', '[]'::jsonb);
  END IF;
  PERFORM ob1_work_claim_lock(v_issue, 'release_work_claim');
  v_now := clock_timestamp();
  SELECT * INTO v_row FROM work_claims WHERE id = p_claim FOR UPDATE;

  IF v_row.released_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'already_released', 'code', NULL, 'message', NULL, 'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb);
  END IF;
  v_own := ob1_work_claim_is_holder(v_row, v_who.name, v_who.agent_id, btrim(COALESCE(p_session, '')));
  IF NOT v_own THEN
    IF NOT p_force THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'CLAIM_NOT_YOURS',
        'message', format('claim %s is held by %s (%s), not this key and session; an operator key may release it with p_force and a reason', p_claim, v_row.holder_name, v_row.session),
        'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb);
    END IF;
    IF v_who.kind IS DISTINCT FROM 'operator' THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'CLAIM_NOT_YOURS',
        'message', format('only an operator key may release another holder''s claim; %s is %s', v_who.name, COALESCE(v_who.kind, 'unclassified')),
        'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb);
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION USING MESSAGE = 'releasing another holder''s claim needs a reason', ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;
  UPDATE work_claims
     SET released_at = v_now, released_by = v_who.name, released_by_agent_id = v_who.agent_id,
         released_by_kind = v_who.kind, release_reason = COALESCE(v_reason, 'released')
   WHERE id = p_claim RETURNING * INTO v_row;
  RETURN jsonb_build_object('outcome', 'released', 'code', NULL, 'message', NULL, 'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb);
END;
$$;
COMMENT ON FUNCTION release_work_claim(uuid, text, text, boolean, jsonb) IS
  'Ends a claim: the caller''s own (the key p_actor names and the session), or with p_force another holder''s, for an operator key (046''s registry kind) and with a reason. Returns jsonb {outcome, code, message, claim, held_by}: released, already_released, or refused — CLAIM_NOT_FOUND, CLAIM_NOT_YOURS. The row stays, with who ended it and why. READ COMMITTED only. Migration 113 / SMD-3597.';

-- ---------------------------------------------------------------------------
-- list_work_claims
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_work_claims(
  p_issues        text[]  DEFAULT NULL,
  p_holder        text    DEFAULT NULL,
  p_include_ended boolean DEFAULT false,
  p_limit         int     DEFAULT 100
)
RETURNS TABLE (
  id uuid, issue text, piece text, holder text, holder_agent_id uuid, holder_kind text,
  session text, label text, claimed_at timestamptz, renewed_at timestamptz, expires_at timestamptz,
  released_at timestamptz, released_by text, released_by_kind text, release_reason text, state text
)
LANGUAGE sql
STABLE
AS $$
  SELECT c.id, c.issue, c.piece, c.holder_name, c.holder_agent_id, c.holder_kind,
         c.session, c.label, c.claimed_at, c.renewed_at, c.expires_at,
         c.released_at, c.released_by, c.released_by_kind, c.release_reason,
         CASE WHEN c.released_at IS NOT NULL THEN 'released' WHEN c.expires_at <= statement_timestamp() THEN 'lapsed' ELSE 'live' END
    FROM work_claims c
   WHERE (p_issues IS NULL OR c.issue = ANY (ARRAY(SELECT upper(btrim(k)) FROM unnest(p_issues) k)))
     AND (p_holder IS NULL OR c.holder_name = p_holder)
     AND (p_include_ended OR (c.released_at IS NULL AND c.expires_at > statement_timestamp()))
   ORDER BY c.issue, c.piece_key, c.claimed_at, c.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000)
$$;
COMMENT ON FUNCTION list_work_claims(text[], text, boolean, int) IS
  'The live work claims — or every claim with p_include_ended — of the tickets p_issues names (all when NULL; keys upper-cased and trimmed), of one holder''s key name when p_holder is given, each with its state (live, lapsed, released), by ticket, piece and claim time; p_limit 1 to 1000 (default 100). Migration 113 / SMD-3597.';
