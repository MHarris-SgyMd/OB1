-- =============================================================================
-- Migration 153: a pr: or version: subject key names its repository, on a brain
--                whose operator names one (SMD-3887 PR 3a, docs/claim-validity.md
--                row 13)
-- =============================================================================
--
-- WHY
--   111's subject_key_valid admits `pr:<number>` and `version:v<n>.<n>` with no
--   repository. The brain ingests one repository's pull requests today; once a
--   second is ingested (SMD-3011), `pr:123` from two repositories is one key,
--   and SMD-3306's work threads would join unrelated work. A `ticket:` key
--   carries its team prefix and is safe.
--
--   The maintainer decided row 13 on 2026-11-19, narrowed the same day: keys
--   are scoped ONLY on a brain whose operator has set a brain setting naming a
--   repository. With no setting every key stays as today, and a URL in a text
--   changes nothing, so one pull request is one key. With the setting a bare
--   number or version takes the setting's repository, and a pull-request URL
--   naming another repository scopes the key to that one (PR 3b's sweep). Both
--   shapes stay valid. Setting it maps the brain's unscoped keys to it, with
--   their threads kept; the maintainer chose (2026-11-23) that the setter does
--   the mapping itself, in its own transaction, so no moment holds half a
--   brain's keys scoped and its threads split.
--
-- WHAT
--   * subject_key_valid — redefined (111 its only definer until now), the same
--     signature and IMMUTABLE: it reads no table, so a key's shape does not
--     depend on the setting. It admits, beside 111's four shapes,
--     `pr:<owner>/<repo>#<n>` and `version:<owner>/<repo>@v<n>.<n>[.<n>[.<n>]]`,
--     the owner and the repository lowercase, as GitHub names them: an owner of
--     1 to 39 letters, digits and inner hyphens, a repository of 1 to 100
--     letters, digits, dots, hyphens and underscores (not `.` or `..`). 111's
--     207-character bound holds every key.
--   * ob1_subject_repo_refusal(repo) — what is wrong with a repository value, in
--     words, or NULL: the one place the setting's shape is spelled, read by the
--     table's trigger, the setter and the reader.
--   * ob1_subject_scoped_key(key, repo) — a bare `pr:` or `version:` key scoped
--     to the repository; any other key, or a NULL repository, as given.
--     IMMUTABLE. The setter's mapping, the door and PR 3b's thread read take it.
--   * ob1_subject_unscoped_key(key) — its inverse: a scoped key's bare form.
--     IMMUTABLE. The door and the setter's remap read keys through it.
--   * subject_repo_settings — the operator's settings, 140's shape: one row a
--     setting, at most one standing (ended_at NULL), a row history once written
--     (it changes only to end, once; DELETE and TRUNCATE refused), set and ended
--     by a key the registry classifies operator, named by its agent id, and
--     through set_subject_repo alone (ob1_subject_repo_settings_by_setter,
--     review pass 3). Its own table, not an ob1_config row (132's reason: the
--     roles that read ob1_config would need a write on every row of it).
--   * ob1_subject_repo() — the standing repository, or NULL. STABLE. A stored
--     value the refusal names raises (140's principle), so a sweep fails loudly
--     rather than scope keys to a repository the operator did not set.
--   * set_subject_repo(repo, actor, remap_previous) — the operator's write.
--     Only a key the registry classifies operator, named by its agent id: any
--     other answers {ok: false, error: NOT_OPERATOR}. A value the refusal names
--     answers {ok: false, error: BAD_REPO}. The value is trimmed and lowercased.
--     NULL clears: keys already scoped stay as they are, and the sweep's new
--     keys are unscoped again. Setting what stands writes no setting ({changed:
--     false}), and maps any unscoped key a raw write left standing under it.
--     Setting a repository, a first one or another, maps every STANDING
--     unscoped `pr:` and `version:` subject to it (below); keys scoped to
--     another repository stay, since they name it truly — unless
--     remap_previous, which moves the keys scoped to the setting it replaces to
--     the new one, to correct a mistaken setting (the maintainer, 2026-11-24;
--     with no new repository it answers REMAP_NEEDS_REPO). A setting that would
--     map more distinct keys than ob1_subject_repo_map_max() answers {ok:
--     false, error: TOO_MANY_KEYS} and writes nothing (review pass 2).
--   * ob1_subject_repo_map_max() — 2,000, the most distinct keys one mapping
--     moves: its thread locks are held to its commit (below).
--   * subject_repo_setting() — the standing setting for brain_info, never
--     raising.
--   * record_thought_subjects — 130's door for a set, redefined on its own
--     body: on a brain whose operator names a repository a bare pr: or
--     version: key is written scoped to it (bare only when too long once
--     scoped), so a pass that finds `pr:12` again keeps the thread the setter
--     mapped instead of undoing it. A bare key the thought holds already
--     scoped, to any repository, keeps that facet, so a thread does not split
--     a member at a time after the repository changes or is cleared (the
--     maintainer, 2026-11-23). Every write takes the ob1:subject-repo lock,
--     shared, which the setter takes exclusively: a write in flight finishes
--     before a mapping reads the keys, and one that starts after waits and
--     reads the new setting (review pass 1). A set with no bare key takes it
--     too, as it closes whatever stands, a bare key being mapped among it
--     (review pass 3), but reads no setting (review pass 2).
--   * close_thought_subjects — 130's close of the set read, redefined on its
--     own body to take the same lock shared (review pass 3): a close beside a
--     mapping would close the bare key and leave its new twin standing.
--
-- THE MAPPING (inside set_subject_repo)
--   A subject facet is written once and only closed (111's validator), so a key
--   is never edited: each standing unscoped `pr:`/`version:` subject is closed
--   and its scoped twin written with the same `by` and `judge_key`, and the
--   closed facet's lineage row is copied to the twin (the same inputs, the
--   same fingerprints, the same pass), its recipe noting `scoped_from` and
--   `repo`. Not through record_thought_subjects: that door refuses a thought
--   whose text moved since its subject was found, or one filed under a ticket
--   since, and a facet left unscoped would split its thread. A rebuild asked
--   of the closed facet's row (stale_since, stale_reason) is asked of the
--   twin's (review pass 2). Thought by thought in id order, under the
--   ob1:subject-repo lock: no thought's advisory lock, as one per thought held
--   to the commit would fill the shared lock table on a large brain (review
--   pass 1); the facets and thoughts it moves are row-locked, the thought FOR
--   KEY SHARE first (130's order). Every key it moves, unscoped and scoped,
--   has its thread lock taken first, in key order, as db/threads.ts takes a
--   batch's, so the two queue rather than deadlock; those locks are held to
--   the commit, two a key, which is why ob1_subject_repo_map_max() bounds the
--   keys (review pass 2). A thought holding the scoped key standing already
--   has the unscoped one closed alone (one standing subject a thought and key,
--   130); a key too long once scoped stands bare, counted. The thread triggers
--   (120, 130) re-link both keys of every facet moved at the commit: the
--   unscoped key's edges close and the scoped key's are written, so each thread
--   keeps its members and their order. A remap (remap_previous, review pass 5)
--   moves each key scoped to the setting it replaces the same way, its twin's
--   recipe naming that key in `scoped_from`.
--
-- WHO READS AND WRITES
--   The roles reading or writing thought_facets get SELECT on
--   subject_repo_settings (the sweep reads the setting in PR 3b, the server's
--   thread read too); those writing both thought_facets and thought_sources
--   get INSERT and UPDATE as well (db/config.mjs: SELECT in the capture and
--   deliverables groups, the three in the structure group). A subject writer
--   passing a bare pr: or version: key reads the setting now, through
--   record_thought_subjects, so the SELECT is a writer's need from here on.
--   The trigger holds what a row may be, and the setter who may call it (132's
--   convention). The setter is SECURITY INVOKER: its mapping writes
--   thought_facets and derivations as the caller.
--
-- SAFETY
--   One new table, its key and a partial unique index, two triggers and nine
--   functions; subject_key_valid replaced with a wider rule under its
--   signature, every key it admitted admitted still; record_thought_subjects
--   and close_thought_subjects replaced on 130's bodies, writing as before
--   until a repository is set, beside a lock shared with the setter.
--   Nothing stored changes until an operator sets a repository. MINOR under
--   FORK.md's version rules.
--   test-schema [138], test-upgrade [20cp].
--
-- Prerequisites
--   016 (content_fingerprint_of), 046 (ob1_registry_kind), 061
--   (ob1_actor_agent_id), 111 (subject_key_valid, ob1_record_derivation's
--   `subject` kind), 113 (ob1_filed_ticket, which the carried door reads), 115
--   (ob1_work_claim_actor), 120 (the thread triggers), 130 (the
--   one-standing-subject-a-key index, ob1_thread_lock_keys, and the two
--   functions it carries). Applied by `bun db/migrate.ts`. Re-applied: the
--   table, its indexes and rows are kept, and the functions and triggers
--   replaced as they were.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not hold
-- (052's shape).
DO $qc$
DECLARE
  v_need text[][] := ARRAY[
    ARRAY['content_fingerprint_of(text)', '016 (content_fingerprint_of)'],
    ARRAY['ob1_registry_kind(uuid, text)', '046 (ob1_registry_kind)'],
    ARRAY['ob1_actor_agent_id()', '061 (ob1_actor_agent_id)'],
    ARRAY['subject_key_valid(text)', '111 (subject_key_valid)'],
    ARRAY['ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid)', '111 (ob1_record_derivation)'],
    ARRAY['ob1_filed_ticket(jsonb)', '113 (ob1_filed_ticket)'],
    ARRAY['ob1_work_claim_actor(jsonb, text)', '115 (ob1_work_claim_actor)'],
    ARRAY['ob1_thread_relink_subject()', '120 (ob1_thread_relink_subject)']];
  i int;
BEGIN
  IF to_regclass('thought_facets_subject_key_uniq') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 153 needs 130 (thought_facets_subject_key_uniq, one standing subject a thought and key); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  FOR i IN 1 .. array_length(v_need, 1) LOOP
    IF to_regprocedure(v_need[i][1]) IS NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = format('migration 153 needs %s; this schema lacks it', v_need[i][2]),
        -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
        HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
        ERRCODE = 'invalid_schema_definition';
    END IF;
  END LOOP;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. subject_key_valid — both shapes of a pr: and a version: key
-- ---------------------------------------------------------------------------
-- ob1:subject-key-shapes — a CONTRACT SENTINEL, not prose (the 014
-- convention): server-portable/subject.ts's subjectKeyValid mirrors these
-- rules, and db/test-schema.ts reads them both.
CREATE OR REPLACE FUNCTION subject_key_valid(p_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_key IS NOT NULL AND length(p_key) <= 207 AND (
       p_key ~ '^ticket:[A-Z][A-Z0-9]*-[0-9]+$'
    OR p_key ~ '^pr:[0-9]{1,9}$'
    OR p_key ~ '^pr:[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9._-]{1,100}#[0-9]{1,9}$'
    OR p_key ~ '^version:v[0-9]+(\.[0-9]+){1,3}$'
    OR p_key ~ '^version:[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9._-]{1,100}@v[0-9]+(\.[0-9]+){1,3}$'
    OR p_key ~ '^phrase:[^[:space:][:upper:]]+( [^[:space:][:upper:]]+)*$')
  AND NOT (p_key ~ '^(pr|version):[^/]*/\.\.?[#@]')
$$;
COMMENT ON FUNCTION subject_key_valid(text) IS
  'Whether a text is a subject key: ticket:<TEAM-N>, pr:<number> or pr:<owner>/<repo>#<number>, version:v<n>.<n>[.<n>[.<n>]] or version:<owner>/<repo>@v<n>.<n>[...], or phrase:<lower-case words>, at most 207 characters. The owner (1 to 39 letters, digits and inner hyphens) and the repository (1 to 100 letters, digits, dots, hyphens and underscores, not . or ..) are lowercase, as GitHub names them. IMMUTABLE: a key''s shape never depends on the brain''s setting; a brain scopes its keys only once its operator names a repository (set_subject_repo), and both shapes stay valid. The facet validator, record_thought_subjects and the thread edges read it. Migrations 111, 153 / SMD-3306, SMD-3887.';

-- ---------------------------------------------------------------------------
-- 2. ob1_subject_repo_refusal — what is wrong with a repository value
-- ---------------------------------------------------------------------------
-- The one place the setting's shape is spelled: the trigger, set_subject_repo,
-- ob1_subject_repo() and subject_repo_setting() read it, so a migration that
-- changes it replaces this one function.
CREATE OR REPLACE FUNCTION ob1_subject_repo_refusal(p_repo text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_repo IS NULL THEN 'a repository is required, as <owner>/<repo>'
    WHEN p_repo <> lower(p_repo) THEN format('a repository is lowercase, got %L', left(p_repo, 160))
    WHEN p_repo !~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9._-]{1,100}$'
      THEN format('a repository is <owner>/<repo> as GitHub names it (an owner of 1 to 39 letters, digits and inner hyphens; a repository of 1 to 100 letters, digits, dots, hyphens and underscores), got %L', left(p_repo, 160))
    WHEN split_part(p_repo, '/', 2) IN ('.', '..') THEN format('a repository is not . or .., got %L', p_repo)
    ELSE NULL
  END
$$;
COMMENT ON FUNCTION ob1_subject_repo_refusal(text) IS
  'What is wrong with a repository value for the subject-key setting — NULL, not lowercase, not <owner>/<repo> as GitHub names it, or a repository of . or .. — in words, or NULL for none. The one place the shape is spelled: subject_repo_settings'' trigger, set_subject_repo and ob1_subject_repo() read it. Migration 153 / SMD-3887.';

-- ---------------------------------------------------------------------------
-- 3. ob1_subject_scoped_key — a bare pr: or version: key in a repository
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_subject_scoped_key(p_key text, p_repo text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_repo IS NULL OR p_key IS NULL THEN p_key
    WHEN p_key ~ '^pr:[0-9]{1,9}$' THEN 'pr:' || p_repo || '#' || substr(p_key, 4)
    WHEN p_key ~ '^version:v[0-9]+(\.[0-9]+){1,3}$' THEN 'version:' || p_repo || '@' || substr(p_key, 9)
    ELSE p_key
  END
$$;
COMMENT ON FUNCTION ob1_subject_scoped_key(text, text) IS
  'A bare subject key scoped to a repository: pr:<n> becomes pr:<repo>#<n> and version:v<n>... becomes version:<repo>@v<n>...; any other key (ticket:, phrase:, a key scoped already), or a NULL repository, comes back as given. IMMUTABLE. set_subject_repo maps a brain''s standing keys by it; the thread read resolves a bare key by it (SMD-3887 PR 3b). Migration 153 / SMD-3887.';

-- A scoped pr: or version: key's bare form: pr:<repo>#<n> is pr:<n>, and
-- version:<repo>@v<n>... version:v<n>...; any other key as given. The door
-- reads a bare key against the scoped ones a thought holds by it, and the
-- setter's remap moves a key from one repository to another through it
-- (review pass 5).
CREATE OR REPLACE FUNCTION ob1_subject_unscoped_key(p_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(regexp_replace(p_key, '^pr:[^#/]+/[^#]+#', 'pr:'), '^version:[^@/]+/[^@]+@', 'version:')
$$;
COMMENT ON FUNCTION ob1_subject_unscoped_key(text) IS
  'A scoped pr: or version: subject key''s bare form (pr:<owner>/<repo>#<n> is pr:<n>, version:<owner>/<repo>@v<n>.<n> is version:v<n>.<n>); any other key, and NULL, as given. IMMUTABLE. ob1_subject_scoped_key''s inverse on the keys it scopes. Migration 153 / SMD-3887.';

-- ---------------------------------------------------------------------------
-- 4. subject_repo_settings — the operator's settings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subject_repo_settings (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo              text NOT NULL,
  set_by            text NOT NULL CHECK (btrim(set_by) <> '' AND length(set_by) <= 200),
  set_by_agent_id   uuid NOT NULL,
  set_at            timestamptz NOT NULL,
  ended_at          timestamptz,
  ended_by          text CHECK (btrim(ended_by) <> '' AND length(ended_by) <= 200),
  ended_by_agent_id uuid,
  CHECK ((ended_at IS NULL) = (ended_by IS NULL) AND (ended_at IS NULL) = (ended_by_agent_id IS NULL))
);
COMMENT ON TABLE subject_repo_settings IS
  'The operator''s repository for subject keys (ob1_subject_repo(): the standing row''s repo, or NULL when none stands, and the brain''s pr: and version: keys stay unscoped). One row per setting, at most one standing (ended_at NULL); a row changes only to end, once, when the next setting or a clear replaces it, and a DELETE or TRUNCATE is refused, so the rows say which repository stood when. repo is checked by ob1_subject_repo_refusal when written. set_by and ended_by name the operator key by its name then, with its agent id, which the trigger holds to a key the registry classifies operator. Written through set_subject_repo, an operator key''s alone, which maps the standing unscoped keys to it. Migration 153 / SMD-3887.';

CREATE UNIQUE INDEX IF NOT EXISTS subject_repo_settings_one_standing ON subject_repo_settings ((true)) WHERE ended_at IS NULL;

-- Only set_subject_repo writes a setting (review pass 3): its INSERT and UPDATE
-- are carried to the structure group's roles so the setter can run as its
-- caller, and a raw INSERT by one of them would stand a repository with no key
-- mapped, its threads split between the bare and the scoped key. Read from the
-- call stack (PG_CONTEXT), not a setting a caller could set (nor one 144's
-- forget_thought would have to empty): the write must come from inside
-- set_subject_repo. A role could still define a function of that name in a
-- schema it owns, so this stops a slip, not a role set on it.
CREATE OR REPLACE FUNCTION ob1_subject_repo_settings_by_setter()
RETURNS void
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_stack text;
BEGIN
  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  -- The setter's frame as PL/pgSQL names it: schema-qualified when the function is not visible on the session's
  -- search_path (format_procedure), so an optional schema (review pass 4), quoted when its name needs it (pass 5).
  IF v_stack !~ 'function (("([^"]|"")+"|[a-z_][a-z0-9_$]*)\.)?set_subject_repo\(text,jsonb,boolean\) line' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'subject_repo_settings is written by set_subject_repo alone, which maps the standing keys with the setting',
      HINT = 'SELECT set_subject_repo(<repo or NULL>, <an operator key''s actor envelope>)',
      ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;
COMMENT ON FUNCTION ob1_subject_repo_settings_by_setter() IS
  'Raises 42501 unless set_subject_repo(text, jsonb, boolean) is on the call stack (PG_CONTEXT): subject_repo_settings''s guard calls it last on an INSERT or an ending UPDATE, so a raw write cannot stand a repository without the mapping. A guard against a slip, not a privilege: a role holding the table''s writes could define a function of that name in its own schema. Migration 153 / SMD-3887.';

-- A row is checked when written, and is history after: it changes only to end,
-- once (140's guard, for the repository).
CREATE OR REPLACE FUNCTION ob1_subject_repo_settings_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_bad text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_bad := ob1_subject_repo_refusal(NEW.repo);
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION USING MESSAGE = v_bad, ERRCODE = 'invalid_parameter_value';
    END IF;
    IF NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION USING MESSAGE = 'subject_repo_settings: a setting stands when written; it ends when the next replaces it',
        ERRCODE = 'restrict_violation';
    END IF;
    IF ob1_registry_kind(NEW.set_by_agent_id, NULL) IS DISTINCT FROM 'operator' THEN
      RAISE EXCEPTION USING MESSAGE = format('subject_repo_settings: set_by_agent_id %s is no key the registry classifies operator', NEW.set_by_agent_id),
        ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM ob1_subject_repo_settings_by_setter();
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
       AND to_jsonb(NEW) - ARRAY['ended_at', 'ended_by', 'ended_by_agent_id']
           = to_jsonb(OLD) - ARRAY['ended_at', 'ended_by', 'ended_by_agent_id'] THEN
      IF ob1_registry_kind(NEW.ended_by_agent_id, NULL) IS DISTINCT FROM 'operator' THEN
        RAISE EXCEPTION USING MESSAGE = format('subject_repo_settings: ended_by_agent_id %s is no key the registry classifies operator', NEW.ended_by_agent_id),
          ERRCODE = 'insufficient_privilege';
      END IF;
      PERFORM ob1_subject_repo_settings_by_setter();
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING
      MESSAGE = 'subject_repo_settings is history: a row changes only to end, once',
      ERRCODE = 'restrict_violation';
  END IF;
  RAISE EXCEPTION USING
    MESSAGE = format('subject_repo_settings is history: %s refused (set a new repository, or clear it, with set_subject_repo)', TG_OP),
    ERRCODE = 'restrict_violation';
END;
$$;
COMMENT ON FUNCTION ob1_subject_repo_settings_guard() IS
  'Refuses a subject_repo_settings row whose repo ob1_subject_repo_refusal names (22023, in its words), one written already ended, one whose set_by_agent_id (or, ending it, ended_by_agent_id) the registry does not classify operator (42501), an UPDATE other than a standing row ending once, and every DELETE and TRUNCATE — for the owner too; then an INSERT or an ending UPDATE not made by set_subject_repo (ob1_subject_repo_settings_by_setter, 42501). Migration 153 / SMD-3887.';

CREATE OR REPLACE TRIGGER subject_repo_settings_history
  BEFORE INSERT OR UPDATE OR DELETE ON subject_repo_settings
  FOR EACH ROW EXECUTE FUNCTION ob1_subject_repo_settings_guard();
CREATE OR REPLACE TRIGGER subject_repo_settings_no_truncate
  BEFORE TRUNCATE ON subject_repo_settings
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_subject_repo_settings_guard();

-- The grants, carried to the roles that hold thought_facets' already (140's
-- carry), as db/config.mjs's groups list them: a role reading or writing
-- thought_facets gets SELECT here (every subject writer reads the setting); one
-- writing both thought_facets and thought_sources, the structure group's mark,
-- gets INSERT and UPDATE too, so the setter runs as the server's role. A
-- deliverables writer, which inserts facets but no sources, takes SELECT alone:
-- it never sets the repository (review pass 1). The owner holds every
-- privilege already. A re-apply grants what is held already, which changes
-- nothing.
DO $grant$
DECLARE
  v_item record;
BEGIN
  FOR v_item IN
    SELECT a.grantee,
           bool_or(a.privilege_type = 'INSERT' AND EXISTS (
             SELECT 1 FROM aclexplode((SELECT s.relacl FROM pg_class s WHERE s.oid = to_regclass('thought_sources'))) AS w
              WHERE w.grantee = a.grantee AND w.privilege_type = 'INSERT')) AS sets
      FROM pg_class c, aclexplode(c.relacl) AS a
     WHERE c.oid = 'thought_facets'::regclass AND a.grantee <> c.relowner AND a.privilege_type IN ('SELECT', 'INSERT')
     GROUP BY a.grantee
  LOOP
    EXECUTE format('GRANT %s ON subject_repo_settings TO %s',
                   CASE WHEN v_item.sets THEN 'SELECT, INSERT, UPDATE' ELSE 'SELECT' END,
                   CASE WHEN v_item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_item.grantee)) END);
  END LOOP;
END
$grant$;

-- ---------------------------------------------------------------------------
-- 5. ob1_subject_repo — the standing repository
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_subject_repo()
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_set subject_repo_settings;
  v_bad text;
BEGIN
  SELECT * INTO v_set FROM subject_repo_settings WHERE ended_at IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  -- Checked on every read, not only when written: a later migration may narrow
  -- the shape under a stored value. Raised, never skipped (140's principle): a
  -- key scoped to a repository the operator did not set is worse than a sweep
  -- that stops.
  v_bad := ob1_subject_repo_refusal(v_set.repo);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('the operator''s subject-key repository (set %s by %s) is refused, so no key is scoped: %s',
                       to_char(v_set.set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), v_set.set_by, v_bad),
      HINT = 'Set it again, or clear it with SELECT set_subject_repo(<repo or NULL>, <actor>) in psql, an operator key',
      ERRCODE = 'data_exception';
  END IF;
  RETURN v_set.repo;
END
$$;
COMMENT ON FUNCTION ob1_subject_repo() IS
  'The repository a brain scopes its pr: and version: subject keys to: the standing operator setting (subject_repo_settings), or NULL when none stands, and keys stay unscoped. A stored value ob1_subject_repo_refusal names raises 22000 naming the setting. Migration 153 / SMD-3887.';

-- ---------------------------------------------------------------------------
-- 6. set_subject_repo — the operator's write, which maps the standing keys
-- ---------------------------------------------------------------------------
-- ob1:subject-repo-map-max — a CONTRACT SENTINEL, not prose: the most distinct
-- keys one mapping moves (review pass 2). The mapping is one transaction (the
-- maintainer's choice), and the threads' locks it takes are held to its
-- commit, two a key (the key moved and its scoped twin): 2,000 keys hold 4,000
-- of the shared lock table's slots, which a default server sizes at 6,400
-- (max_locks_per_transaction 64 × max_connections 100) for every session at
-- once. A brain past it is refused, nothing written; mapping it in
-- batches is SMD-4559 (the maintainer, 2026-11-23). A function, so a test can
-- lower it. The cap bounds the keys, not a key's members: 130's trigger
-- re-links a key once per member moved, each over the whole thread, so a key
-- held by N thoughts costs N² at the commit (measured 2026-11-24: 0.3 s at
-- 250, 1.1 s at 500, 4.7 s at 1,000, as the extractor's own writes of them in
-- one transaction cost); re-linking each key once is SMD-4564.
CREATE OR REPLACE FUNCTION ob1_subject_repo_map_max()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 2000 $$;
COMMENT ON FUNCTION ob1_subject_repo_map_max() IS
  'The most distinct pr:/version: subject keys one set_subject_repo maps, unscoped and, on a remap, scoped to the previous repository (ob1:subject-repo-map-max): the mapping is one transaction and holds two thread locks a key to its commit, so past this it would run a default server''s shared lock table short. A setting that would map more answers {ok: false, error: TOO_MANY_KEYS} and writes nothing. Migration 153 / SMD-3887.';

-- One writer at a time, by a transaction advisory lock taken before the
-- standing row is read (140's set_work_claim_cap).
-- p_repo has no default: a clear is a NULL passed on purpose, never a call that named the actor alone (review pass 1).
-- p_remap_previous (review pass 5, the maintainer's choice of 2026-11-24): a change of repository also moves the keys
-- scoped to the setting it replaces, to correct a mistaken one; by default they stay, as they name it truly after a
-- real move.
CREATE OR REPLACE FUNCTION set_subject_repo(p_repo text, p_actor jsonb DEFAULT NULL, p_remap_previous boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_who     record;
  v_kind    text;
  v_repo    text;
  v_bad     text;
  v_old     subject_repo_settings;
  v_new     subject_repo_settings;
  v_now     timestamptz;
  v_thought uuid;
  v_fp      text;
  f         record;
  v_key     text;
  v_id      uuid;
  v_lin     record;
  v_mapped  integer := 0;
  v_dupes   integer := 0;
  v_unscopable integer := 0;
  v_keys    text[] := '{}';
  v_thts    integer := 0;
  v_bare    text[] := '{}';
  v_same    boolean;
  v_moved   boolean;
  v_from    text;
  v_remapped integer := 0;
BEGIN
  SELECT * INTO v_who FROM ob1_work_claim_actor(p_actor, 'set_subject_repo');
  -- The operator's kind by its agent id alone: a name lends no kind (SMD-2608).
  v_kind := CASE WHEN v_who.agent_id IS NULL THEN NULL ELSE ob1_registry_kind(v_who.agent_id, NULL) END;
  IF v_who.agent_id IS NULL OR v_kind IS DISTINCT FROM 'operator' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_OPERATOR', 'key', v_who.name, 'kind', v_kind,
      'message', format('only an operator key, named by its agent id, may set the subject-key repository; %s is %s', v_who.name,
                        CASE WHEN v_who.agent_id IS NULL THEN 'named by its name alone' ELSE COALESCE(v_kind, 'unclassified') END));
  END IF;
  v_repo := NULLIF(lower(btrim(p_repo)), '');
  IF p_repo IS NOT NULL THEN
    v_bad := ob1_subject_repo_refusal(v_repo);
    IF v_bad IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'BAD_REPO', 'message', v_bad);
    END IF;
  END IF;
  IF p_remap_previous AND v_repo IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'REMAP_NEEDS_REPO',
      'message', 'a remap moves the keys scoped to the previous repository to the new one: name the new one (a clear leaves scoped keys as they are)');
  END IF;

  -- ob1:subject-repo-lock — a CONTRACT SENTINEL, not prose: exclusive here, and shared in record_thought_subjects,
  -- which reads the setting under it, and in close_thought_subjects (review pass 3). A subject write in flight
  -- finishes before the mapping reads the keys, and one that starts after waits for the commit and reads the new
  -- setting, so no bare key is written beside a mapping (review pass 1). It takes no thought's advisory lock: the
  -- facets and thoughts it moves are row-locked, which holds no slot of the shared lock table however many there
  -- are; the threads' locks are bounded by the cap below.
  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:subject-repo', 0));
  v_now := clock_timestamp();
  SELECT * INTO v_old FROM subject_repo_settings WHERE ended_at IS NULL FOR UPDATE;
  -- The repository standing already: no setting is written, but a bare key standing under it — one a raw write of
  -- thought_facets left, which the door would have scoped — is mapped all the same, so setting it again repairs the
  -- thread (review pass 4). With none, nothing is written.
  v_same := v_old.repo IS NOT DISTINCT FROM v_repo;
  -- The repository a remap moves keys from: the one this setting replaces, when asked (review pass 5).
  v_from := CASE WHEN p_remap_previous AND NOT v_same THEN v_old.repo END;
  IF v_repo IS NOT NULL THEN
    -- The keys the mapping moves: each standing unscoped key, and on a remap each key scoped to the previous
    -- repository, whose form in the new one is a key (one too long once scoped stays). Past ob1_subject_repo_map_max()
    -- the setting is refused before anything is written (review pass 2).
    SELECT COALESCE(array_agg(DISTINCT f2.payload->>'key' ORDER BY f2.payload->>'key'), '{}') INTO v_bare
      FROM thought_facets f2
     WHERE f2.kind = 'subject' AND f2.valid_until IS NULL
       AND ((f2.payload->>'key' ~ '^pr:[0-9]{1,9}$' OR f2.payload->>'key' ~ '^version:v[0-9]+(\.[0-9]+){1,3}$')
              OR (v_from IS NOT NULL AND ob1_subject_unscoped_key(f2.payload->>'key') <> f2.payload->>'key'
                  AND ob1_subject_scoped_key(ob1_subject_unscoped_key(f2.payload->>'key'), v_from) = f2.payload->>'key'))
       AND subject_key_valid(ob1_subject_scoped_key(ob1_subject_unscoped_key(f2.payload->>'key'), v_repo));
    IF cardinality(v_bare) > ob1_subject_repo_map_max() THEN
      RETURN jsonb_build_object('ok', false, 'error', 'TOO_MANY_KEYS', 'keys', cardinality(v_bare), 'max', ob1_subject_repo_map_max(),
        'message', format('setting %s would map %s distinct unscoped pr: and version: keys in one transaction, past the %s one mapping takes (its thread locks are held to the commit); nothing is set',
                          v_repo, cardinality(v_bare), ob1_subject_repo_map_max()));
    END IF;
  END IF;
  IF v_same AND cardinality(v_bare) = 0 THEN
    -- The changed reply's shape, set_at as subject_repo_setting() gives it (review pass 1).
    RETURN jsonb_build_object('ok', true, 'changed', false, 'repo', v_repo, 'previous', v_repo,
      'set_at', CASE WHEN v_old.id IS NULL THEN NULL ELSE to_char(v_old.set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
      'set_by', v_old.set_by, 'mapped', 0, 'closed_alone', 0, 'unscopable', 0, 'remapped', 0, 'keys', 0, 'thoughts', 0);
  END IF;
  IF NOT v_same AND v_old.id IS NOT NULL THEN
    UPDATE subject_repo_settings SET ended_at = v_now, ended_by = v_who.name, ended_by_agent_id = v_who.agent_id
     WHERE id = v_old.id;
  END IF;
  IF NOT v_same AND v_repo IS NOT NULL THEN
    INSERT INTO subject_repo_settings (repo, set_by, set_by_agent_id, set_at)
    VALUES (v_repo, v_who.name, v_who.agent_id, v_now)
    RETURNING * INTO v_new;
  END IF;
  IF v_repo IS NOT NULL THEN
    -- Every key the mapping moves, unscoped and scoped, locked now in key order (130's ob1_thread_lock_keys): the
    -- commit's re-links take them again at once, so the setter queues behind a db/threads.ts batch, which locks its
    -- keys in the same order, rather than deadlocking with one as thought-id order could (review pass 2).
    PERFORM ob1_thread_lock_keys(v_bare || ARRAY(SELECT ob1_subject_scoped_key(ob1_subject_unscoped_key(k), v_repo) FROM unnest(v_bare) AS k));

    -- ob1:subject-repo-mapping — a CONTRACT SENTINEL, not prose: every standing
    -- unscoped pr:/version: subject (and on a remap every one scoped to the
    -- previous repository) closed and its scoped twin written with its
    -- lineage, thought by thought in id order, under the lock above.
    FOR v_thought IN
      SELECT DISTINCT f2.thought_id
        FROM thought_facets f2
       WHERE f2.kind = 'subject' AND f2.valid_until IS NULL
         AND ((f2.payload->>'key' ~ '^pr:[0-9]{1,9}$' OR f2.payload->>'key' ~ '^version:v[0-9]+(\.[0-9]+){1,3}$')
              OR (v_from IS NOT NULL AND ob1_subject_unscoped_key(f2.payload->>'key') <> f2.payload->>'key'
                  AND ob1_subject_scoped_key(ob1_subject_unscoped_key(f2.payload->>'key'), v_from) = f2.payload->>'key'))
       ORDER BY f2.thought_id
    LOOP
      SELECT COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)) INTO v_fp
        FROM thoughts t WHERE t.id = v_thought FOR KEY SHARE;
      IF NOT FOUND THEN
        CONTINUE;
      END IF;
      v_moved := false;
      FOR f IN
        SELECT s.id, s.payload->>'key' AS key, s.payload->>'by' AS way, s.payload->>'judge_key' AS judge
          FROM thought_facets s
         WHERE s.thought_id = v_thought AND s.kind = 'subject' AND s.valid_until IS NULL
           AND ((s.payload->>'key' ~ '^pr:[0-9]{1,9}$' OR s.payload->>'key' ~ '^version:v[0-9]+(\.[0-9]+){1,3}$')
              OR (v_from IS NOT NULL AND ob1_subject_unscoped_key(s.payload->>'key') <> s.payload->>'key'
                  AND ob1_subject_scoped_key(ob1_subject_unscoped_key(s.payload->>'key'), v_from) = s.payload->>'key'))
         ORDER BY s.payload->>'key', s.id
           FOR UPDATE
      LOOP
        v_key := ob1_subject_scoped_key(ob1_subject_unscoped_key(f.key), v_repo);
        IF NOT subject_key_valid(v_key) THEN
          -- Too long once the repository is in it (111 bounds a version's digits by the key's 207 characters alone):
          -- the bare key stands, counted, rather than refuse every setting (review pass 1).
          v_unscopable := v_unscopable + 1;
          CONTINUE;
        END IF;
        UPDATE thought_facets SET valid_until = now() WHERE id = f.id;
        v_keys := v_keys || v_key;
        v_moved := true;
        IF f.key <> ob1_subject_unscoped_key(f.key) THEN
          v_remapped := v_remapped + 1;
        END IF;
        IF EXISTS (SELECT 1 FROM thought_facets d
                    WHERE d.thought_id = v_thought AND d.kind = 'subject' AND d.valid_until IS NULL AND d.payload->>'key' = v_key) THEN
          -- The scoped key stands on the thought already: the unscoped one is
          -- closed alone (one standing subject a thought and key, 130).
          v_dupes := v_dupes + 1;
          CONTINUE;
        END IF;
        INSERT INTO thought_facets (thought_id, kind, payload)
        VALUES (v_thought, 'subject', jsonb_build_object('key', v_key, 'by', f.way, 'judge_key', f.judge))
        RETURNING id INTO v_id;
        -- ob1:subject-lineage-with-its-artifact (111's): the twin's lineage is
        -- the closed facet's — the same inputs, fingerprints and pass — its
        -- recipe saying the key was scoped from what. A facet with no lineage
        -- row (none should be: 111 writes them together) takes the text now.
        SELECT d.input_ids, d.input_fingerprints, d.recipe, d.canonical_agent_id, d.stale_since, d.stale_reason INTO v_lin
          FROM derivations d
         WHERE d.artifact_kind = 'subject' AND d.artifact_id = f.id AND d.produced_by = f.judge;
        IF FOUND THEN
          PERFORM ob1_record_derivation('subject', v_id, v_lin.input_ids, v_lin.input_fingerprints, f.judge,
                                        COALESCE(v_lin.recipe, jsonb_build_object('deterministic', f.way <> 'model'))
                                          || jsonb_build_object('scoped_from', f.key, 'repo', v_repo),
                                        v_lin.canonical_agent_id);
          IF v_lin.stale_since IS NOT NULL THEN
            -- A rebuild asked of the closed facet's row (063's mark) is asked of its twin's, which ob1_record_derivation
            -- wrote unmarked (review pass 2).
            UPDATE derivations SET stale_since = v_lin.stale_since, stale_reason = v_lin.stale_reason
             WHERE artifact_kind = 'subject' AND artifact_id = v_id AND produced_by = f.judge;
          END IF;
        ELSE
          PERFORM ob1_record_derivation('subject', v_id, ARRAY[v_thought], ARRAY[v_fp], f.judge,
                                        jsonb_build_object('deterministic', f.way <> 'model', 'declared', false,
                                                           'scoped_from', f.key, 'repo', v_repo),
                                        NULL);
        END IF;
        v_mapped := v_mapped + 1;
      END LOOP;
      -- A thought counted only when a facet on it moved: one whose bare keys are all too long once scoped is not
      -- (review pass 4).
      IF v_moved THEN
        v_thts := v_thts + 1;
      END IF;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('ok', true, 'changed', NOT v_same, 'repo', v_repo, 'previous', v_old.repo,
    'set_at', CASE WHEN v_repo IS NULL THEN NULL ELSE to_char(COALESCE(v_new.set_at, v_old.set_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
    'set_by', CASE WHEN v_repo IS NULL THEN NULL ELSE COALESCE(v_new.set_by, v_old.set_by) END,
    'mapped', v_mapped, 'closed_alone', v_dupes, 'unscopable', v_unscopable, 'remapped', v_remapped,
    'keys', (SELECT count(DISTINCT k) FROM unnest(v_keys) AS k), 'thoughts', v_thts);
END
$$;
COMMENT ON FUNCTION set_subject_repo(text, jsonb, boolean) IS
  'The operator names the repository a brain scopes its pr: and version: subject keys to (docs/claim-validity.md row 13). Only a key the registry classifies operator, named by its agent id in p_actor (a name lends no kind); any other answers {ok: false, error: NOT_OPERATOR, key, kind, message}. The value is trimmed and lowercased; one ob1_subject_repo_refusal names answers {ok: false, error: BAD_REPO, message}. NULL clears it: keys scoped already stay, and new keys are unscoped. Setting what stands writes no setting ({changed: false}), and maps any unscoped key a raw write left standing under it. Setting a repository maps every standing unscoped pr:/version: subject to it (ob1:subject-repo-mapping): the facet closed and its scoped twin (ob1_subject_scoped_key) written with the same by and judge_key and the closed facet''s lineage, its recipe noting scoped_from and repo and a rebuild asked of it (stale_since, stale_reason) kept; a thought holding the scoped key already has the unscoped one closed alone; a key too long once scoped stands bare, counted unscopable. More than ob1_subject_repo_map_max() distinct keys to map answers {ok: false, error: TOO_MANY_KEYS, keys, max, message}, nothing written. Under the ob1:subject-repo lock, exclusive here and shared in record_thought_subjects, so no subject write interleaves with the mapping; the facets and thoughts moved are row-locked, and every key moved has its thread lock (ob1_thread_lock_keys) taken first, in key order. The thread triggers re-link both keys at the commit, so each thread keeps its members. Keys scoped to another repository stay, unless p_remap_previous: a change of repository then moves the keys scoped to the one it replaces to the new one as it maps a bare key (lineage noting scoped_from), to correct a mistaken setting; with no new repository it answers {ok: false, error: REMAP_NEEDS_REPO}. Returns {ok: true, changed, repo, previous, set_at (ISO, UTC), set_by, mapped, closed_alone, unscopable, remapped (facets moved from the previous repository), keys (the distinct scoped keys), thoughts (those a facet moved on)}, the same shape when nothing changed. SECURITY INVOKER: the caller needs the setting''s INSERT and UPDATE, and to map, what record_thought_subjects needs. Migration 153 / SMD-3887.';

-- ---------------------------------------------------------------------------
-- 7. subject_repo_setting — the standing setting, for brain_info
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION subject_repo_setting()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_set subject_repo_settings;
BEGIN
  SELECT * INTO v_set FROM subject_repo_settings WHERE ended_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('repo', NULL, 'source', 'none');
  END IF;
  RETURN jsonb_build_object('repo', v_set.repo, 'source', 'operator',
    'set_at', to_char(v_set.set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'set_by', v_set.set_by,
    'refused', ob1_subject_repo_refusal(v_set.repo));
END
$$;
COMMENT ON FUNCTION subject_repo_setting() IS
  'The standing subject-key repository for brain_info: {repo: null, source: none} when none is set (keys stay unscoped), else {repo, source: operator, set_at, set_by, refused} where refused is ob1_subject_repo_refusal''s word on it or null. Never raises, unlike ob1_subject_repo(). Migration 153 / SMD-3887.';

-- ---------------------------------------------------------------------------
-- 8. record_thought_subjects — 130's door for a set, its keys scoped
-- ---------------------------------------------------------------------------
-- 130's body verbatim but where marked 153, and the bad-key refusal's words,
-- which name both shapes: a bare pr: or version: key written as the scoped key
-- the thought holds already, else scoped on a brain whose operator names a
-- repository, every write under the lock set_subject_repo takes exclusively
-- (review pass 1: the writers would otherwise undo the mapping, and one in
-- flight could slip a bare key past it; pass 3: a write of any set).
CREATE OR REPLACE FUNCTION record_thought_subjects(
  p_thought   uuid,
  p_keys      text[],
  p_by        text,
  p_judge_key text,
  p_agent     uuid,
  p_fp        text,
  p_recipe    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  -- ob1:subject-set — a CONTRACT SENTINEL, not prose: at most three keys a
  -- set (the maintainer, 2026-11-09: the capture hook's header lists three
  -- tickets at most, and the judge's question asks for three at most).
  c_max    constant integer := 3;
  v_keys   text[];
  v_bare   boolean;
  v_repo   text;
  v_fp     text;
  v_filed  text;
  v_stood  integer;
  v_kept   uuid[] := '{}';
  v_keptk  text[] := '{}';
  v_close  uuid[] := '{}';
  v_add    text[];
  v_id     uuid;
  v_key    text;
  v_ids    uuid[];
  r        record;
BEGIN
  IF p_thought IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subjects: a thought is required', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_judge_key IS NULL OR btrim(p_judge_key) = '' OR length(p_judge_key) > 200 THEN
    -- 111's bounds, refused as parameter errors: a check violation would read
    -- to the pass as the thought deleted mid-write (084's way).
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subjects: judge_key must name the pass, in at most 200 characters', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF array_ndims(p_keys) > 1 THEN
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subjects: the set is a one-dimensional array of keys', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF array_position(p_keys, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subjects: a key in the set is NULL (an empty set, or NULL, closes every standing subject)', ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The set: each key once, in key order.
  SELECT COALESCE(array_agg(DISTINCT k ORDER BY k), '{}') INTO v_keys FROM unnest(p_keys) AS k;
  -- 153 (SMD-3887): every write takes the ob1:subject-repo lock, shared here and in close_thought_subjects and
  -- exclusive in set_subject_repo, so no write interleaves with a mapping. Whatever its set, a write closes the
  -- thought's standing subjects, a bare one the setter is mapping among them: one that ran beside the mapping would
  -- miss the twin it writes and leave it standing (review pass 3; pass 2 had taken the lock for a bare key alone).
  -- Taken before the thought's lock; the setter takes no thought's advisory lock, so the order cannot cross. Only a
  -- set holding a bare pr: or version: key (v_bare) reads the setting, below, under the thought's lock (review pass 2).
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ob1:subject-repo', 0));
  v_bare := EXISTS (SELECT 1 FROM unnest(v_keys) AS k WHERE k ~ '^pr:[0-9]{1,9}$' OR k ~ '^version:v[0-9]+(\.[0-9]+){1,3}$');
  SELECT k INTO v_key FROM unnest(v_keys) AS k WHERE NOT subject_key_valid(k) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_thought_subjects: each key is ticket:<ID>, pr:<number> or pr:<owner>/<repo>#<number>, version:<v1.2.3> or version:<owner>/<repo>@<v1.2.3>, or phrase:<lower-case words>, got %L', left(v_key, 80)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cardinality(v_keys) > c_max THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_thought_subjects: a thought holds at most %s subjects, got %s keys', c_max, cardinality(v_keys)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cardinality(v_keys) > 0 AND (p_by IS NULL OR p_by NOT IN ('metadata', 'first_line', 'model')) THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_thought_subjects: by is metadata, first_line or model, got %L', p_by),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_by = 'metadata' AND cardinality(v_keys) > 1 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_thought_subjects: by metadata is one key, the ticket the thought is filed under, got %s keys', cardinality(v_keys)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cardinality(v_keys) > 0 AND (p_fp IS NULL OR btrim(p_fp) = '') THEN
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subjects: the fingerprint of the text the subjects were found in is required', ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 111's lock and order: one writer of a thought's subjects at a time, the
  -- thought locked FOR KEY SHARE before its facet rows. A thought gone
  -- answers none.
  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:subject:' || p_thought::text, 0));
  SELECT COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)), ob1_filed_ticket(t.metadata) INTO v_fp, v_filed
    FROM thoughts t WHERE t.id = p_thought FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'gone', true);
  END IF;
  -- 111's and 113's staleness: a text that moved since the pass read it, or
  -- a filed ticket that disagrees — metadata's key under another ticket than
  -- the thought is filed under now, or another way's set on a thought filed
  -- since. Nothing is written; the edit put the thought back in the pool.
  IF cardinality(v_keys) > 0 AND (p_fp IS DISTINCT FROM v_fp
       OR CASE WHEN p_by = 'metadata' THEN v_keys[1] IS DISTINCT FROM 'ticket:' || v_filed ELSE v_filed IS NOT NULL END) THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'stale', true);
  END IF;

  -- 153 (SMD-3887), under the thought's lock: each bare pr: or version: key becomes the key the thought holds already
  -- for the same number scoped to a repository — the setting's first, else the first by key — so a re-pass keeps its
  -- thread after the repository changed or was cleared, as the setter leaves keys scoped already (the maintainer,
  -- 2026-11-23); else, on a brain whose operator names a repository, the key scoped to it (ob1_subject_scoped_key), so
  -- a pass that found `pr:12` keeps the thread the setter mapped; else bare, as is one too long once scoped. One key
  -- for one, so the set's bound holds.
  IF v_bare THEN
    -- Read here, past the key checks and the gone and stale answers, so a stored setting the refusal names raises only
    -- where a key is scoped (review pass 5).
    v_repo := ob1_subject_repo();
    SELECT COALESCE(array_agg(DISTINCT s ORDER BY s), '{}') INTO v_keys
      FROM (SELECT CASE WHEN NOT (k ~ '^pr:[0-9]{1,9}$' OR k ~ '^version:v[0-9]+(\.[0-9]+){1,3}$') THEN k
                        ELSE COALESCE(
                          (SELECT h.payload->>'key' FROM thought_facets h
                            WHERE h.thought_id = p_thought AND h.kind = 'subject' AND h.valid_until IS NULL
                              AND h.payload->>'key' <> k
                              AND ob1_subject_unscoped_key(h.payload->>'key') = k
                            ORDER BY h.payload->>'key' = ob1_subject_scoped_key(k, v_repo) DESC, h.payload->>'key'
                            LIMIT 1),
                          CASE WHEN subject_key_valid(ob1_subject_scoped_key(k, v_repo)) THEN ob1_subject_scoped_key(k, v_repo) ELSE k END)
                   END AS s
              FROM unnest(v_keys) AS k) AS scoped;
  END IF;

  -- The standing subjects, each kept (under a key of the set, found the same
  -- way by the same pass) or closed.
  v_stood := 0;
  FOR r IN
    SELECT f.id, f.payload->>'key' AS key, f.payload->>'by' AS way, f.payload->>'judge_key' AS judge
      FROM thought_facets f
     WHERE f.thought_id = p_thought AND f.kind = 'subject' AND f.valid_until IS NULL
     ORDER BY f.payload->>'key', f.id
       FOR UPDATE
  LOOP
    v_stood := v_stood + 1;
    IF r.key = ANY (v_keys) AND r.way = p_by AND r.judge = p_judge_key AND NOT r.key = ANY (v_keptk) THEN
      v_kept := v_kept || r.id;
      v_keptk := v_keptk || r.key;
    ELSE
      v_close := v_close || r.id;
    END IF;
  END LOOP;
  SELECT COALESCE(array_agg(k ORDER BY k), '{}') INTO v_add FROM unnest(v_keys) AS k WHERE NOT k = ANY (v_keptk);

  IF v_stood = 0 AND cardinality(v_keys) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'ids', '[]'::jsonb, 'kept', 0, 'added', 0, 'closed', 0);
  END IF;

  -- The closes, then the writes in key order; the threads re-link at the
  -- commit, the first re-link locking every key moved (120's triggers).
  IF cardinality(v_close) > 0 THEN
    UPDATE thought_facets SET valid_until = now() WHERE id = ANY (v_close);
  END IF;
  -- Kept: the facet stands, its lineage moved to the text read now.
  FOREACH v_id IN ARRAY v_kept LOOP
    PERFORM ob1_record_derivation('subject', v_id, ARRAY[p_thought], ARRAY[p_fp], p_judge_key,
                                  COALESCE(p_recipe, jsonb_build_object('deterministic', p_by <> 'model', 'declared', false)), p_agent);
  END LOOP;
  FOREACH v_key IN ARRAY v_add LOOP
    INSERT INTO thought_facets (thought_id, kind, payload)
    VALUES (p_thought, 'subject', jsonb_build_object('key', v_key, 'by', p_by, 'judge_key', p_judge_key))
    RETURNING id INTO v_id;
    -- ob1:subject-lineage-with-its-artifact (111's): each facet and its
    -- lineage are one transaction (061's rule).
    PERFORM ob1_record_derivation('subject', v_id, ARRAY[p_thought], ARRAY[p_fp], p_judge_key,
                                  COALESCE(p_recipe, jsonb_build_object('deterministic', p_by <> 'model', 'declared', false)), p_agent);
  END LOOP;

  SELECT COALESCE(array_agg(f.id ORDER BY f.payload->>'key'), '{}') INTO v_ids
    FROM thought_facets f
   WHERE f.thought_id = p_thought AND f.kind = 'subject' AND f.valid_until IS NULL;
  RETURN jsonb_build_object(
    'ok', true,
    -- What moved: written alone (added), closed alone (closed), both
    -- (replaced), neither (kept).
    'action', CASE WHEN cardinality(v_close) = 0 AND cardinality(v_add) = 0 THEN 'kept'
                   WHEN cardinality(v_close) = 0 THEN 'added'
                   WHEN cardinality(v_add) = 0 THEN 'closed'
                   ELSE 'replaced' END,
    'ids', to_jsonb(v_ids),
    'kept', cardinality(v_kept), 'added', cardinality(v_add), 'closed', cardinality(v_close),
    'closedIds', to_jsonb(v_close));
END;
$$;

COMMENT ON FUNCTION record_thought_subjects(uuid, text[], text, text, uuid, text, jsonb) IS
  'The subject pass''s write of one thought''s own subjects as a set (SMD-3306 PR 7a-3a): the standing `subject` facets made to be exactly these keys (each once; at most three, ob1:subject-set), found one way (`by`) by one pass (judge_key). A standing subject under a key of the set, found the same way by the same pass, is kept (its lineage row moved to the fingerprint read now); every other standing subject is closed (valid_until); each key not kept is written, with its lineage row (artifact_kind subject, its thought at the fingerprint read, produced_by the pass''s key; the recipe the caller''s, else deterministic unless the model found it) in the same transaction. NULL or an empty set closes every standing subject. `metadata` names one key. Refused, writing nothing (action none, stale), when the thought''s fingerprint is not the one the pass read, or the ticket it is filed under (ob1_filed_ticket) disagrees: metadata''s key under another ticket than it is filed under now, or any other way''s set on a thought filed since. Under the advisory lock on the thought (111''s), the thought locked FOR KEY SHARE first; the threads of the keys it moves re-link at the commit (120''s triggers, which lock them all in key order). Returns {ok, action, ids (the standing facets after, by key), kept, added, closed, closedIds (on a write), stale?, gone?}: action added when it wrote and closed nothing, closed when it closed and wrote nothing, replaced when it did both, kept when it did neither, none when nothing stood and nothing was asked, or on a refusal. SECURITY INVOKER: the caller needs INSERT on thought_facets (the structure group), UPDATE on it and on thoughts (the row locks) and the writes on derivations (the capture group), and since 120 what a re-link writes, as record_thought_subject. Since 153 (SMD-3887), each bare pr: or version: key is written as the key the thought holds already for the same number scoped to a repository (the setting''s first), so a thread keeps its members after the repository changes or is cleared; else, on a brain whose operator names a repository (ob1_subject_repo), scoped to it (ob1_subject_scoped_key), bare only when too long once scoped. Every write takes the ob1:subject-repo lock, shared here and in close_thought_subjects and exclusive in set_subject_repo, so no write interleaves with a mapping; a set holding a bare key reads the setting, and its caller needs SELECT on subject_repo_settings. Migrations 130, 153 / SMD-3306, SMD-3887.';

-- ---------------------------------------------------------------------------
-- 9. close_thought_subjects — 130's close of the set read, under the same lock
-- ---------------------------------------------------------------------------
-- 130's body verbatim but where marked 153: the ob1:subject-repo lock taken
-- shared, as the door takes it (review pass 3).
CREATE OR REPLACE FUNCTION close_thought_subjects(
  p_thought uuid,
  p_facets  uuid[],
  p_fp      text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_fp    text;
  v_ids   uuid[];
  v_read  uuid[];
BEGIN
  IF p_thought IS NULL OR p_facets IS NULL OR cardinality(p_facets) = 0 OR array_ndims(p_facets) > 1 OR array_position(p_facets, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'close_thought_subjects: a thought and the subject facets read are required', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_fp IS NULL OR btrim(p_fp) = '' THEN
    RAISE EXCEPTION USING MESSAGE = 'close_thought_subjects: the fingerprint of the text read is required', ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 153 (SMD-3887): the ob1:subject-repo lock, shared, as record_thought_subjects takes it and set_subject_repo
  -- takes it exclusively: a close beside a mapping would close the bare key and miss the twin the mapping writes,
  -- leaving it standing (review pass 3). Before the thought's lock, as the door takes it.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ob1:subject-repo', 0));
  -- The door's lock and order (111): one writer per thought at a time, the
  -- thought locked FOR KEY SHARE before its facet rows.
  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:subject:' || p_thought::text, 0));
  SELECT COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)) INTO v_fp
    FROM thoughts t WHERE t.id = p_thought FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'gone', true);
  END IF;
  -- The text moved since it was read: what was asked of it says nothing of
  -- the text now, which the pool's trigger has put back in the pool.
  IF p_fp IS DISTINCT FROM v_fp THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'stale', true);
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY key, id), '{}') INTO v_ids
    FROM (SELECT f.id, f.payload->>'key' AS key
            FROM thought_facets f
           WHERE f.thought_id = p_thought AND f.kind = 'subject' AND f.valid_until IS NULL
             FOR UPDATE) s;
  IF cardinality(v_ids) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none');
  END IF;
  -- Another set stands now, written since the read (a pass's rule): not the
  -- one the caller means to close.
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_read FROM unnest(p_facets) AS x;
  IF (SELECT array_agg(x ORDER BY x) FROM unnest(v_ids) AS x) IS DISTINCT FROM v_read THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'moved', true, 'ids', to_jsonb(v_ids));
  END IF;
  UPDATE thought_facets SET valid_until = now() WHERE id = ANY (v_ids);
  RETURN jsonb_build_object('ok', true, 'action', 'closed', 'ids', to_jsonb(v_ids));
END;
$$;

COMMENT ON FUNCTION close_thought_subjects(uuid, uuid[], text) IS
  'Closes a thought''s standing subjects only while they are exactly the facets the caller read (as a set) and the thought''s text still has the fingerprint read (SMD-3306 PR 7a-3a): the subject sweep''s close of out-of-date subjects the model now names nothing for. Under record_thought_subjects''s advisory lock, the thought locked FOR KEY SHARE first; the closed keys'' threads re-link at the commit (120''s triggers, which lock them all in key order). Returns {ok, action: closed | none, ids?, gone?, stale?, moved?}: none with gone for a thought deleted, with stale for a text that moved, with moved (and the standing ids, by key) when another set stands, and alone when none does. SECURITY INVOKER: the caller needs UPDATE on thought_facets and on thoughts (the row locks), and what a re-link writes (120): INSERT on thought_facets (the structure group) and INSERT, UPDATE and SELECT on derivations (the capture group). Since 153 (SMD-3887) it takes the ob1:subject-repo lock shared, as record_thought_subjects does, so no close interleaves with set_subject_repo''s mapping. Migrations 130, 153 / SMD-3306, SMD-3887.';
