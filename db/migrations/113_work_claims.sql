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
--      * THE WORK: `issue`, a ticket key (SMD-3379: an ASCII team key of at
--        most 16 letters and digits, a hyphen, a number of at most 10 digits
--        with no leading zero — the shape server-portable/stated-status.ts
--        finds, narrowed by the caps and the zero), upper-cased; `piece`,
--        optional, the part of the ticket (`PR 1b-2`), cleaned as all free text
--        is (below), compared case-folded through the generated `piece_key`
--        ('' for the whole ticket). The fold is the database's lower(), so it
--        follows its collation: on a C-collated brain only ASCII letters fold
--        (`Étape` and `étape` are two pieces), and an operating-system upgrade
--        that changes the collation's case rules leaves stored keys as they
--        were folded.
--      * THE HOLDER: holder_name, holder_agent_id and holder_kind, stamped
--        from the call's actor envelope (ob1.actor: the p_actor the server
--        passes for the key, 029's shape) through 046's registry lookup —
--        050's rule, the key and never the client's word. A call whose
--        envelope names nobody raises: a claim nobody holds protects nothing.
--        A key the registry calls `ingested` (an importer copying outside
--        text) cannot claim.
--      * THE TOKEN: claim_work mints a token — `wc_` and 64 hex digits, two
--        gen_random_uuid() values, 244 random bits — and returns it once; the
--        row keeps only its SHA-256 (token_hash). A claim is the caller's own
--        only when the key AND the token match. Two agents under one key — the
--        dogfood's Claude Code sessions share one — each hold a different
--        token, so they refuse each other. A token is never shown again: a
--        refusal, a list or a claim names the holder's key, never anything that
--        proves ownership (review pass 1: a session string the refusal printed
--        let any agent copy it and act as the holder). A token is useless to
--        another key (a claim made by name alone: to a key not carrying the
--        name it had when it claimed), but to its own key it is a bearer
--        secret. Send it as a bind parameter, never in a statement's text: a
--        bind parameter stays out of pg_stat_activity and error lines, though
--        not out of statement logs (log_statement, log_min_duration_statement,
--        auto_explain), which print bind values whole unless
--        log_parameter_max_length = 0, a setting only a superuser can make
--        (review pass 4). Keep it out of captured text too. Its shape,
--        wc_[0-9a-f]{64}, is for secret scanners.
--      * THE LABEL: free text for people (tool, machine, session, branch),
--        at most 500. Shown as data, trusted for nothing.
--      * FREE TEXT (a piece, a label, a reason): control characters made
--        spaces, the invisible marks deleted (soft hyphen, zero-width space,
--        word joiner, byte-order mark), every run of white space, Unicode's
--        included, made one space, trimmed. Other blank-looking characters
--        (a Hangul filler) are kept: lookalikes are not this file's to judge.
--        No text another key wrote is put in a message: a refusal names the
--        work the caller asked for, the holder's key and the times, and the
--        rest is in held_by, as data.
--      * THE LEASE: claimed_at, renewed_at, expires_at. A claim past its
--        expires_at, not released, has LAPSED: it counts as free, so no
--        reaper is needed. The next claim on exactly that ticket and piece
--        closes it (released_at, released_by the taker, release_reason
--        'lapsed; taken over') in the claim's own transaction; a lapsed claim
--        the next claims only overlap stays unreleased and free.
--      * THE END: released_at, released_by / _agent_id / _kind (the envelope
--        of the call that ended it) and release_reason.
--
--   2. THE RULES, kept by the functions under one lock per ticket.
--      * A live claim — unreleased, unexpired — refuses another holder's claim
--        on the same work. A whole-ticket claim and a claim on one of its
--        pieces are the same work, either way round; two different pieces of
--        one ticket are not.
--      * The holder's own claim on exactly this work (key and token) is
--        renewed, not refused: claiming twice with the token is safe — unless
--        it has lapsed and another live claim now covers it, when the call is
--        refused and the claim stays lapsed, renewable once that claim ends.
--        A lapsed claim on exactly this work is taken over by any claim
--        without its token, its own key's included: a lost token's recovery,
--        the old row closed as 'lapsed; taken over' by the key itself. Every
--        other claim is in the way — the same key's without its token, and the
--        holder's own on overlapping work (a whole ticket it holds, when it
--        claims a piece): no two live claims cover one work, whoever holds
--        them (review pass 2).
--      * A refusal is an ANSWER, not an error: outcome 'refused', a stable
--        code, a message naming the first holder's key, and every claim in
--        the way. Callers branch on it; an exception would abort their
--        transaction. A malformed argument (not a ticket key, a piece blank
--        once cleaned, a malformed token, a lease out of range, a renew with no
--        token, an operator's force with no reason) and a call that
--        cannot claim at all (no holder, an ingested key, a transaction above
--        READ COMMITTED) raise. A release with no token is not malformed: an
--        operator's forced release needs none, and anyone else's answers
--        CLAIM_NOT_YOURS.
--      * What raises, by SQLSTATE: 22023 a malformed argument; 42501 a call
--        with no holder (the caller passed no key: the server's bug, not the
--        client's) and an ingested key; 0A000 a transaction above READ
--        COMMITTED; 25006 a read-only one; 40P01 two transactions taking two
--        tickets' locks in opposite orders. A role without the claims group
--        gets 42501 too, naming work_claims: a deployment's error. A refused
--        forced release shares CLAIM_NOT_YOURS with any other, told apart by
--        its message; list_work_claims matches nothing for a malformed key
--        rather than raising.
--      * p_actor sets ob1.actor for the rest of the calling transaction (029's
--        shape): a later call in it that passes no p_actor is stamped with the
--        same key.
--
--   3. THE FUNCTIONS (SECURITY INVOKER, PUBLIC's EXECUTE as every core
--      function; each writer returns jsonb {outcome, code, message, claim,
--      held_by, token}):
--      * claim_work(p_issue, p_piece, p_label, p_lease_seconds, p_token,
--        p_actor): 'claimed' (with the new token), 'renewed' (p_token is the
--        caller's own unreleased claim on exactly this work), or 'refused'
--        (WORK_CLAIMED).
--      * renew_work_claim(p_claim, p_token, p_lease_seconds, p_actor):
--        'renewed', or 'refused' — CLAIM_NOT_FOUND, CLAIM_NOT_YOURS,
--        CLAIM_RELEASED (released, or taken over after it lapsed), or
--        WORK_CLAIMED (it lapsed and another claim, the holder's own on
--        overlapping work included, now covers it).
--      * release_work_claim(p_claim, p_token, p_reason, p_force, p_actor):
--        'released', 'already_released' (to any caller: an ended claim's
--        row is anyone's to read in the list), or 'refused' — CLAIM_NOT_FOUND,
--        CLAIM_NOT_YOURS. p_force releases another holder's claim, for an
--        operator key named by its agent id (a name alone lends no kind,
--        SMD-2608's rule) and with a reason; an operator forcing with no
--        reason raises.
--      * list_work_claims(p_issues, p_holder, p_include_ended, p_limit): the
--        live claims, or every claim with p_include_ended, each with its
--        `state` — live, lapsed or released. STABLE, one query for a page of
--        tickets (SMD-3599 reads it that way).
--      The lease is p_lease_seconds, 60 to 604800 (a week), default 14400
--      (four hours): an agent's session waits on a person for hours, and a
--      worker's fifteen minutes (015) would lapse under it. The writers judge
--      a lapse by clock_timestamp() at their lock, the list by its statement's
--      start: a claim lapsing while one statement runs can read live in its
--      list and lapsed to its claim.
--
--   4. CONCURRENCY. Each writing call raises (0A000) in a transaction above
--      READ COMMITTED first, then takes a transaction advisory lock on its ticket
--      (hashtextextended('ob1:work-claim:' || issue, 0)), so a claim on the
--      whole ticket and a claim on one of its pieces wait for each other, and
--      reads under a snapshot taken after the lock. That needs READ
--      COMMITTED, where each statement takes a new snapshot; under REPEATABLE
--      READ or SERIALIZABLE the read would predate the lock (068's rule). The
--      partial unique index work_claims_one_unreleased (one unreleased row per
--      ticket and piece) holds the exact-work half of the rule for a write
--      made without the lock; the whole-against-piece half is the lock's
--      alone. Every writer — claim, renew, release — takes its ticket's lock
--      until its transaction ends: two transactions writing two tickets in
--      opposite orders deadlock (40P01). Make one writer call per
--      transaction, or take tickets in key order; nothing enforces it.
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
--   every server role holds; a role without it fails naming ob1_agents. Soft:
--   a role without the group gets a permission error (42501) naming
--   work_claims on the claim calls, and nothing else. Preflight's existing
--   `work claims` row is 015's worker claims, not these.
--   The rules hold for callers of the functions; a role holding the group can
--   still write the table directly, as with every core table its group
--   writes (the pages group's convention). The server first calls them in
--   SMD-3598, whose preflight will check the group. A forced release needs an
--   operator key by its agent id, so board-sync (whose key is `ingested`)
--   releasing a closed ticket's claims is a path of its own (SMD-3600), not
--   p_force.
--
-- SAFETY
--   One new table, two indexes on it (its key, and the partial unique
--   index), fourteen functions (four calls, ten
--   helpers); nothing existing is changed. MINOR under FORK.md's version
--   rules. test-schema [101] (the rules), test-live [46] (two claims at once,
--   held), test-upgrade [20be].
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
  token_hash           bytea       NOT NULL,
  label                text,
  claimed_at           timestamptz NOT NULL,
  renewed_at           timestamptz,
  expires_at           timestamptz NOT NULL,
  released_at          timestamptz,
  released_by          text,
  released_by_agent_id uuid,
  released_by_kind     text,
  release_reason       text,
  CONSTRAINT work_claims_issue_key   CHECK (issue ~ '^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,9}$'),
  CONSTRAINT work_claims_piece_form  CHECK (piece IS NULL OR (piece <> '' AND length(piece) <= 100 AND piece = btrim(piece) AND piece !~ '[[:cntrl:]]')),
  CONSTRAINT work_claims_holder      CHECK (holder_name <> '' AND length(holder_name) <= 200),
  CONSTRAINT work_claims_holder_kind CHECK (holder_kind IS NULL OR holder_kind IN ('operator', 'agent')),
  CONSTRAINT work_claims_token_hash  CHECK (length(token_hash) = 32),
  CONSTRAINT work_claims_label       CHECK (label IS NULL OR (length(label) <= 500 AND label !~ '[[:cntrl:]]')),
  CONSTRAINT work_claims_lease       CHECK (expires_at > claimed_at),
  CONSTRAINT work_claims_released_by_kind CHECK (released_by_kind IS NULL OR released_by_kind IN ('operator', 'agent', 'ingested')),
  CONSTRAINT work_claims_reason      CHECK (release_reason IS NULL OR (length(release_reason) <= 500 AND release_reason !~ '[[:cntrl:]]')),
  CONSTRAINT work_claims_ended       CHECK (released_at IS NOT NULL OR (released_by IS NULL AND released_by_agent_id IS NULL AND released_by_kind IS NULL AND release_reason IS NULL))
);

COMMENT ON TABLE work_claims IS
  'Who holds a ticket, or one piece of it (piece: PR 1b-2), under a lease, so two agents never build one change. Live: unreleased and unexpired; lapsed: unreleased and past expires_at, which counts as free; released: ended, kept as history with who ended it. Written through claim_work, renew_work_claim and release_work_claim; read through list_work_claims. Migration 113 / SMD-3597.';
COMMENT ON COLUMN work_claims.holder_name IS
  'The name the claiming call''s actor envelope (ob1.actor) carried: the key''s name. Stamped by claim_work, never from an argument. Migration 113 / SMD-3597.';
COMMENT ON COLUMN work_claims.token_hash IS
  'SHA-256 of the token claim_work returned once. A claim is its caller''s own only when the key and the token both match, so agents under one key refuse each other; the token itself is never stored or shown again. Migration 113 / SMD-3597.';
COMMENT ON COLUMN work_claims.label IS
  'Free text the client gives for people (tool, machine, session, branch), control characters made spaces. Shown as data, trusted for nothing, never put in a message. Migration 113 / SMD-3597.';
COMMENT ON COLUMN work_claims.piece_key IS
  'The piece compared case-folded (lower()); '''' for a whole-ticket claim. A whole-ticket claim and a piece claim of one ticket are the same work; two different pieces are not. Migration 113 / SMD-3597.';

-- ob1:work-claim-one-per-work
CREATE UNIQUE INDEX IF NOT EXISTS work_claims_one_unreleased ON work_claims (issue, piece_key) WHERE released_at IS NULL;
COMMENT ON INDEX work_claims_one_unreleased IS
  'One unreleased claim per ticket and piece: the exact-work half of claim_work''s rule, held for a write made without its lock. A lapsed claim stays unreleased until the next claim on exactly its ticket and piece closes it. Migration 113 / SMD-3597.';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Free text a client gives: control characters made spaces; the invisible
-- marks deleted — soft hyphen, zero-width space, word joiner, byte-order mark
-- (review pass 2: made spaces, "PR1" and "PR<zero-width>1" were two pieces);
-- every run of white space, Unicode's too — no-break, the en/em family, the
-- ideographic space (review pass 1: \s alone left them) — made one space;
-- trimmed; NULL when blank. The joiners (U+200C, U+200D) are kept: they join
-- letters and emoji, and are no space. Raises past p_max characters, naming
-- p_what. The characters are spelled as chr() codes, which need a UTF8
-- database (every brain is one).
CREATE OR REPLACE FUNCTION ob1_work_claim_text(p text, p_max int, p_what text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_marks text := '[' || chr(173) || chr(8203) || chr(8288) || chr(65279) || ']';
  v_space text := '[[:space:]' || chr(160) || chr(5760) || chr(8192) || '-' || chr(8202) || chr(8232) || chr(8233)
                  || chr(8239) || chr(8287) || chr(12288) || ']+';
  v text := NULLIF(btrim(regexp_replace(regexp_replace(regexp_replace(COALESCE(p, ''), '[[:cntrl:]]', ' ', 'g'), v_marks, '', 'g'), v_space, ' ', 'g')), '');
BEGIN
  IF length(v) > p_max THEN
    RAISE EXCEPTION USING MESSAGE = format('%s is at most %s characters; this one has %s', p_what, p_max, length(v)), ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v;
END;
$$;
COMMENT ON FUNCTION ob1_work_claim_text(text, int, text) IS
  'A client''s free text (a piece, a label, a reason): control characters made spaces, the soft hyphen, zero-width space, word joiner and byte-order mark deleted, every run of white space (Unicode''s included) made one space, trimmed; NULL when blank; raises past p_max characters. Migration 113 / SMD-3597.';

-- A ticket key, or a raise naming the input.
CREATE OR REPLACE FUNCTION ob1_work_claim_issue(p_issue text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  -- Matched as ASCII before upper(), which maps some other letters onto ASCII
  -- ones (U+017F to S); refused past 200 characters rather than cut, so text
  -- after a key is never dropped onto it (review pass 2).
  v text := CASE WHEN length(p_issue) > 200 THEN NULL ELSE ob1_work_claim_text(p_issue, 200, 'a ticket key') END;
BEGIN
  IF v IS NULL OR v !~ '^[A-Za-z][A-Za-z0-9]{1,15}-[1-9][0-9]{0,9}$' THEN
    RAISE EXCEPTION USING
      MESSAGE = format('not a ticket key: %L (a team key of at most 16 letters and digits, a hyphen and a number with no leading zero, such as SMD-3379)', left(COALESCE(p_issue, ''), 80)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN upper(v);
END;
$$;
COMMENT ON FUNCTION ob1_work_claim_issue(text) IS
  'A ticket key upper-cased and trimmed (SMD-3379: a team key of at most 16 letters and digits, a hyphen, at most 10 digits with no leading zero); raises on anything else. Migration 113 / SMD-3597.';

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

-- A token's SHA-256, NULL for none; raises on a malformed one.
CREATE OR REPLACE FUNCTION ob1_work_claim_token_hash(p_token text)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_token IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_token !~ '^wc_[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING MESSAGE = 'not a claim token: claim_work returns one as wc_ and 64 hex digits', ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN sha256(convert_to(p_token, 'UTF8'));
END;
$$;
COMMENT ON FUNCTION ob1_work_claim_token_hash(text) IS
  'The SHA-256 of a claim token (wc_ and 64 hex digits) as work_claims keeps it; NULL for none; raises on any other text. Migration 113 / SMD-3597.';

-- One claim as the functions return it: no token, no hash.
CREATE OR REPLACE FUNCTION ob1_work_claim_json(c work_claims, p_now timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'issue', c.issue, 'piece', c.piece,
    'holder', c.holder_name, 'holder_agent_id', c.holder_agent_id, 'holder_kind', c.holder_kind,
    'label', c.label,
    'claimed_at', c.claimed_at, 'renewed_at', c.renewed_at, 'expires_at', c.expires_at,
    'released_at', c.released_at, 'released_by', c.released_by, 'released_by_kind', c.released_by_kind,
    'release_reason', c.release_reason,
    'state', CASE WHEN c.released_at IS NOT NULL THEN 'released' WHEN c.expires_at <= p_now THEN 'lapsed' ELSE 'live' END)
$$;
COMMENT ON FUNCTION ob1_work_claim_json(work_claims, timestamptz) IS
  'One work claim as jsonb, with its state at p_now (live, lapsed or released) and neither its token nor its hash. Migration 113 / SMD-3597.';

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
  IF length(name) > 200 THEN
    RAISE EXCEPTION USING MESSAGE = format('%s: a holder''s key name is at most 200 characters; this one has %s', p_what, length(name)), ERRCODE = 'invalid_parameter_value';
  END IF;
  agent_id := ob1_actor_agent_id();
  kind := ob1_registry_kind(agent_id, name);
END;
$$;
COMMENT ON FUNCTION ob1_work_claim_actor(jsonb, text) IS
  'Sets ob1.actor from p_actor when given, then returns the envelope''s holder (name, 061''s agent id, 046''s registry kind); raises naming p_what when the envelope names nobody or a name past 200 characters. Migration 113 / SMD-3597.';

-- READ COMMITTED alone, checked before a writer reads anything, so the reads
-- after its lock see every claim committed before the lock was granted.
CREATE OR REPLACE FUNCTION ob1_work_claim_isolation(p_what text)
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
END;
$$;
COMMENT ON FUNCTION ob1_work_claim_isolation(text) IS
  'Raises, naming p_what, in a transaction above READ COMMITTED: a claim call''s reads must postdate its lock. Migration 113 / SMD-3597.';

CREATE OR REPLACE FUNCTION ob1_work_claim_lock(p_issue text)
RETURNS void
LANGUAGE sql
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('ob1:work-claim:' || p_issue, 0))
$$;
COMMENT ON FUNCTION ob1_work_claim_lock(text) IS
  'Takes the transaction advisory lock on one ticket''s claims; a whole-ticket claim and its pieces share it. Migration 113 / SMD-3597.';

-- Whether a claim is the caller's own: the same token, and the same key — a
-- claim made with an agent id by that id, a claim made by name alone by the
-- name, whatever the caller's id now (review pass 2: a key whose id resolved
-- after it claimed was locked out of its own claim; the token is the proof).
-- Never NULL: a NULL here read as "own" in a release (first draft).
CREATE OR REPLACE FUNCTION ob1_work_claim_is_holder(c work_claims, p_name text, p_agent uuid, p_token_hash bytea)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(c.token_hash = p_token_hash
                  AND CASE WHEN c.holder_agent_id IS NOT NULL THEN c.holder_agent_id = p_agent
                           ELSE c.holder_name = p_name END, false)
$$;
COMMENT ON FUNCTION ob1_work_claim_is_holder(work_claims, text, uuid, bytea) IS
  'True when the claim is the caller''s own: this token''s hash, and the key — a claim made with an agent id by that id, one made by name alone by the name; false otherwise, never NULL. Migration 113 / SMD-3597.';

-- The live claims that cover this work, oldest first, but the one claim being
-- renewed (p_exclude). Every other claim is in the way, the caller's own on
-- overlapping work included (review pass 2: excluding whatever the token
-- matched let a holder of the whole ticket, passing its token, claim a piece
-- too — two claims of one holder on one work, neither renewable).
CREATE OR REPLACE FUNCTION ob1_work_claims_in_the_way(p_issue text, p_piece_key text, p_exclude uuid, p_now timestamptz)
RETURNS SETOF work_claims
LANGUAGE sql
STABLE
AS $$
  SELECT c.* FROM work_claims c
   WHERE c.issue = p_issue
     AND c.released_at IS NULL AND c.expires_at > p_now
     AND (c.piece_key = p_piece_key OR c.piece_key = '' OR p_piece_key = '')
     AND c.id IS DISTINCT FROM p_exclude
   ORDER BY c.claimed_at, c.id
$$;
COMMENT ON FUNCTION ob1_work_claims_in_the_way(text, text, uuid, timestamptz) IS
  'The live claims on this work but p_exclude, the one being renewed: the same piece, the whole ticket, or (for a whole-ticket claim) any piece. No two live claims cover one work, whoever holds them. Migration 113 / SMD-3597.';

-- ---------------------------------------------------------------------------
-- claim_work
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_work(
  p_issue         text,
  p_piece         text  DEFAULT NULL,
  p_label         text  DEFAULT NULL,
  p_lease_seconds int   DEFAULT 14400,
  p_token         text  DEFAULT NULL,
  p_actor         jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_issue   text     := ob1_work_claim_issue(p_issue);
  v_piece   text     := ob1_work_claim_text(p_piece, 100, 'a piece');
  v_key     text     := COALESCE(lower(ob1_work_claim_text(p_piece, 100, 'a piece')), '');
  v_label   text     := ob1_work_claim_text(p_label, 500, 'a label');
  v_lease   interval := ob1_work_claim_lease(p_lease_seconds);
  v_hash    bytea    := ob1_work_claim_token_hash(p_token);
  v_who     record;
  v_now     timestamptz;
  v_mine    work_claims;
  v_row     work_claims;
  v_held    jsonb;
  v_token   text;
BEGIN
  -- A piece given but blank once cleaned would claim the whole ticket, the
  -- broadest claim: refused instead (review pass 3).
  IF p_piece IS NOT NULL AND v_piece IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'a piece was given but is blank once cleaned; pass NULL to claim the whole ticket', ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM ob1_work_claim_isolation('claim_work');
  SELECT * INTO v_who FROM ob1_work_claim_actor(p_actor, 'claim_work');
  IF v_who.kind = 'ingested' THEN
    RAISE EXCEPTION USING
      MESSAGE = format('claim_work: %s is an ingested key (an importer''s), which cannot claim work', v_who.name),
      ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM ob1_work_claim_lock(v_issue);
  v_now := clock_timestamp();

  -- The caller's own unreleased claim on exactly this work, live or lapsed,
  -- that its token names: the one claim the read below leaves out.
  IF v_hash IS NOT NULL THEN
    SELECT * INTO v_mine FROM work_claims c
     WHERE c.issue = v_issue AND c.piece_key = v_key AND c.released_at IS NULL
       AND ob1_work_claim_is_holder(c, v_who.name, v_who.agent_id, v_hash)
     FOR UPDATE;
  END IF;

  SELECT jsonb_agg(ob1_work_claim_json(w, v_now) ORDER BY w.claimed_at, w.id) INTO v_held
    FROM ob1_work_claims_in_the_way(v_issue, v_key, v_mine.id, v_now) w;
  IF v_held IS NOT NULL THEN
    -- The message names the work the caller asked for, the first holder's key
    -- and the times — never text another key wrote (its piece, its label),
    -- which stays in held_by as data (review passes 1 and 2).
    RETURN jsonb_build_object(
      'outcome', 'refused', 'code', 'WORK_CLAIMED',
      'message', format('%s%s is covered by a claim of %s since %s, until %s',
                        v_issue, COALESCE(' ' || v_piece, ''), v_held->0->>'holder',
                        to_char((v_held->0->>'claimed_at')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"'),
                        to_char((v_held->0->>'expires_at')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"')),
      'claim', NULL, 'held_by', v_held, 'token', NULL);
  END IF;

  -- The caller's own claim, nothing else covering it: renewed.
  IF v_mine.id IS NOT NULL THEN
    UPDATE work_claims SET expires_at = v_now + v_lease, renewed_at = v_now, label = COALESCE(v_label, label)
     WHERE id = v_mine.id RETURNING * INTO v_row;
    RETURN jsonb_build_object('outcome', 'renewed', 'code', NULL, 'message', NULL, 'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb, 'token', NULL);
  END IF;

  -- A lapsed claim on exactly this ticket and piece: taken over. (Nothing live
  -- covers the work, so every unreleased row here has lapsed.)
  UPDATE work_claims
     SET released_at = v_now, released_by = v_who.name, released_by_agent_id = v_who.agent_id,
         released_by_kind = v_who.kind, release_reason = 'lapsed; taken over'
   WHERE issue = v_issue AND piece_key = v_key AND released_at IS NULL AND expires_at <= v_now;

  v_token := 'wc_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO work_claims (issue, piece, holder_name, holder_agent_id, holder_kind, token_hash, label, claimed_at, expires_at)
  VALUES (v_issue, v_piece, v_who.name, v_who.agent_id, v_who.kind, ob1_work_claim_token_hash(v_token), v_label, v_now, v_now + v_lease)
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('outcome', 'claimed', 'code', NULL, 'message', NULL, 'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb, 'token', v_token);
END;
$$;
COMMENT ON FUNCTION claim_work(text, text, text, int, text, jsonb) IS
  'Claims a ticket (p_issue), or one piece of it (p_piece), for the key p_actor names, for p_lease_seconds (60 to 604800, default 14400). Returns jsonb {outcome, code, message, claim, held_by, token}: claimed, with the token that proves the claim (shown this once); renewed, when p_token is the caller''s own unreleased claim on exactly this work and nothing else covers it; or refused (WORK_CLAIMED), with every live claim covering it but that one — the same piece, the whole ticket, or any piece of it for a whole-ticket claim, the caller''s own on overlapping work included. A lapsed own claim another live claim now covers is refused and stays lapsed. A lapsed claim on exactly this ticket and piece is closed as taken over, the caller''s own included (the recovery for a lost token). Raises for no holder, an ingested key, a malformed argument (a piece blank once cleaned among them), or a transaction above READ COMMITTED. Migration 113 / SMD-3597.';

-- ---------------------------------------------------------------------------
-- renew_work_claim
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION renew_work_claim(
  p_claim         uuid,
  p_token         text,
  p_lease_seconds int   DEFAULT 14400,
  p_actor         jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_hash  bytea    := ob1_work_claim_token_hash(p_token);
  v_lease interval := ob1_work_claim_lease(p_lease_seconds);
  v_who   record;
  v_issue text;
  v_now   timestamptz;
  v_row   work_claims;
  v_held  jsonb;
BEGIN
  IF v_hash IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'renew_work_claim needs the claim''s token: the one claim_work returned', ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM ob1_work_claim_isolation('renew_work_claim');
  SELECT * INTO v_who FROM ob1_work_claim_actor(p_actor, 'renew_work_claim');
  SELECT issue INTO v_issue FROM work_claims WHERE id = p_claim;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'CLAIM_NOT_FOUND', 'message', format('no claim %s', COALESCE(p_claim::text, '(none given)')), 'claim', NULL, 'held_by', '[]'::jsonb, 'token', NULL);
  END IF;
  PERFORM ob1_work_claim_lock(v_issue);
  v_now := clock_timestamp();
  SELECT * INTO v_row FROM work_claims WHERE id = p_claim FOR UPDATE;

  IF NOT ob1_work_claim_is_holder(v_row, v_who.name, v_who.agent_id, v_hash) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'CLAIM_NOT_YOURS',
      'message', format('claim %s is held by %s, not by this key with this token', p_claim, v_row.holder_name),
      'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb, 'token', NULL);
  END IF;
  IF v_row.released_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'CLAIM_RELEASED',
      'message', format('claim %s ended at %s; claim the work again', p_claim,
                        to_char(v_row.released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"')),
      'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb, 'token', NULL);
  END IF;
  -- Lapsed meanwhile, another holder may have claimed a piece or the whole.
  SELECT jsonb_agg(ob1_work_claim_json(w, v_now) ORDER BY w.claimed_at, w.id) INTO v_held
    FROM ob1_work_claims_in_the_way(v_row.issue, v_row.piece_key, v_row.id, v_now) w;
  IF v_held IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'WORK_CLAIMED',
      'message', format('claim %s lapsed and a claim of %s now covers its work', p_claim, v_held->0->>'holder'),
      'claim', ob1_work_claim_json(v_row, v_now), 'held_by', v_held, 'token', NULL);
  END IF;
  UPDATE work_claims SET expires_at = v_now + v_lease, renewed_at = v_now WHERE id = p_claim RETURNING * INTO v_row;
  RETURN jsonb_build_object('outcome', 'renewed', 'code', NULL, 'message', NULL, 'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb, 'token', NULL);
END;
$$;
COMMENT ON FUNCTION renew_work_claim(uuid, text, int, jsonb) IS
  'Extends the caller''s own claim (the key p_actor names, and p_token, which claim_work returned) to p_lease_seconds from now. Returns jsonb {outcome, code, message, claim, held_by, token}: renewed, or refused — CLAIM_NOT_FOUND, CLAIM_NOT_YOURS, CLAIM_RELEASED (ended, or taken over after it lapsed), WORK_CLAIMED (it lapsed and another claim covers its work). A lapsed claim nothing covers is renewed. READ COMMITTED only. Migration 113 / SMD-3597.';

-- ---------------------------------------------------------------------------
-- release_work_claim
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION release_work_claim(
  p_claim  uuid,
  p_token  text    DEFAULT NULL,
  p_reason text    DEFAULT NULL,
  p_force  boolean DEFAULT false,
  p_actor  jsonb   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_hash   bytea := ob1_work_claim_token_hash(p_token);
  v_reason text  := ob1_work_claim_text(p_reason, 500, 'a reason');
  v_who    record;
  v_issue  text;
  v_now    timestamptz;
  v_row    work_claims;
BEGIN
  PERFORM ob1_work_claim_isolation('release_work_claim');
  SELECT * INTO v_who FROM ob1_work_claim_actor(p_actor, 'release_work_claim');
  SELECT issue INTO v_issue FROM work_claims WHERE id = p_claim;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'CLAIM_NOT_FOUND', 'message', format('no claim %s', COALESCE(p_claim::text, '(none given)')), 'claim', NULL, 'held_by', '[]'::jsonb, 'token', NULL);
  END IF;
  PERFORM ob1_work_claim_lock(v_issue);
  v_now := clock_timestamp();
  SELECT * INTO v_row FROM work_claims WHERE id = p_claim FOR UPDATE;

  IF v_row.released_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'already_released', 'code', NULL, 'message', NULL, 'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb, 'token', NULL);
  END IF;
  IF NOT ob1_work_claim_is_holder(v_row, v_who.name, v_who.agent_id, v_hash) THEN
    IF p_force IS NOT TRUE THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'CLAIM_NOT_YOURS',
        'message', format('claim %s is held by %s, not by this key with this token', p_claim, v_row.holder_name),
        'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb, 'token', NULL);
    END IF;
    -- The operator's kind by its agent id alone: a name is anyone's to write
    -- in an envelope, so it lends no kind (SMD-2608's rule; review pass 1).
    IF v_who.agent_id IS NULL OR ob1_registry_kind(v_who.agent_id, NULL) IS DISTINCT FROM 'operator' THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'CLAIM_NOT_YOURS',
        'message', format('only an operator key, named by its agent id, may release another holder''s claim; %s is %s', v_who.name,
                          CASE WHEN v_who.agent_id IS NULL THEN 'named by its name alone' ELSE COALESCE(ob1_registry_kind(v_who.agent_id, NULL), 'unclassified') END),
        'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb, 'token', NULL);
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION USING MESSAGE = 'releasing another holder''s claim needs a reason', ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;
  UPDATE work_claims
     SET released_at = v_now, released_by = v_who.name, released_by_agent_id = v_who.agent_id,
         released_by_kind = v_who.kind, release_reason = COALESCE(v_reason, 'released')
   WHERE id = p_claim RETURNING * INTO v_row;
  RETURN jsonb_build_object('outcome', 'released', 'code', NULL, 'message', NULL, 'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb, 'token', NULL);
END;
$$;
COMMENT ON FUNCTION release_work_claim(uuid, text, text, boolean, jsonb) IS
  'Ends a claim: the caller''s own (the key p_actor names, and p_token), or with p_force another holder''s, for an operator key named by its agent id (046''s registry kind for the id; a name alone lends none) and with a reason. Returns jsonb {outcome, code, message, claim, held_by, token}: released, already_released, or refused — CLAIM_NOT_FOUND, CLAIM_NOT_YOURS. The row stays, with who ended it and why. READ COMMITTED only. Migration 113 / SMD-3597.';

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
  label text, claimed_at timestamptz, renewed_at timestamptz, expires_at timestamptz,
  released_at timestamptz, released_by text, released_by_kind text, release_reason text, state text
)
LANGUAGE sql
STABLE
AS $$
  SELECT c.id, c.issue, c.piece, c.holder_name, c.holder_agent_id, c.holder_kind,
         c.label, c.claimed_at, c.renewed_at, c.expires_at,
         c.released_at, c.released_by, c.released_by_kind, c.release_reason,
         CASE WHEN c.released_at IS NOT NULL THEN 'released' WHEN c.expires_at <= statement_timestamp() THEN 'lapsed' ELSE 'live' END
    FROM work_claims c
   WHERE (p_issues IS NULL OR c.issue = ANY (ARRAY(SELECT upper(ob1_work_claim_text(left(k, 200), 200, 'a ticket key')) FROM unnest(p_issues) k)))
     AND (p_holder IS NULL OR c.holder_name = p_holder)
     AND (p_include_ended OR (c.released_at IS NULL AND c.expires_at > statement_timestamp()))
   ORDER BY c.issue, c.piece_key, c.claimed_at, c.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000)
$$;
COMMENT ON FUNCTION list_work_claims(text[], text, boolean, int) IS
  'The live work claims — or every claim with p_include_ended — of the tickets p_issues names (all when NULL; keys cleaned and upper-cased as claim_work cleans them), of one holder''s key name when p_holder is given, each with its state (live, lapsed, released), by ticket, piece and claim time; p_limit 1 to 1000 (default 100). Never a token or its hash. Migration 113 / SMD-3597.';
