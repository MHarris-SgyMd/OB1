-- =============================================================================
-- Migration 152: a pr: or version: subject key names its repository, on a brain
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
--     IMMUTABLE. The setter's mapping and PR 3b's thread read take it.
--   * subject_repo_settings — the operator's settings, 140's shape: one row a
--     setting, at most one standing (ended_at NULL), a row history once written
--     (it changes only to end, once; DELETE and TRUNCATE refused), set and ended
--     by a key the registry classifies operator, named by its agent id. Its own
--     table, not an ob1_config row (132's reason: the roles that read
--     ob1_config would need a write on every row of it).
--   * ob1_subject_repo() — the standing repository, or NULL. STABLE. A stored
--     value the refusal names raises (140's principle), so a sweep fails loudly
--     rather than scope keys to a repository the operator did not set.
--   * set_subject_repo(repo, actor) — the operator's write. Only a key the
--     registry classifies operator, named by its agent id: any other answers
--     {ok: false, error: NOT_OPERATOR}. A value the refusal names answers
--     {ok: false, error: BAD_REPO}. The value is trimmed and lowercased. NULL
--     clears: keys already scoped stay as they are, and the sweep's new keys are
--     unscoped again. Setting what stands writes nothing ({changed: false}).
--     Setting a repository, a first one or another, maps every STANDING
--     unscoped `pr:` and `version:` subject to it (below); keys scoped to
--     another repository stay, since they name it truly.
--   * subject_repo_setting() — the standing setting for brain_info, never
--     raising.
--
-- THE MAPPING (inside set_subject_repo)
--   A subject facet is written once and only closed (111's validator), so a key
--   is never edited: each standing unscoped `pr:`/`version:` subject is closed
--   and its scoped twin written with the same `by` and `judge_key`, and the
--   closed facet's lineage row is copied to the twin (the same inputs, the
--   same fingerprints, the same pass), its recipe noting `scoped_from` and
--   `repo`. Not through record_thought_subjects: that door refuses a thought
--   whose text moved since its subject was found, or one filed under a ticket
--   since, and a facet left unscoped would split its thread. Thought by
--   thought in id order, each under 111's advisory lock on the thought, the
--   thought locked FOR KEY SHARE first (130's order). A thought holding the
--   scoped key standing already has the unscoped one closed alone (one
--   standing subject a thought and key, 130). The thread triggers (120, 130)
--   re-link both keys of every facet moved at the commit: the unscoped key's
--   edges close and the scoped key's are written, so each thread keeps its
--   members and their order.
--
-- WHO READS AND WRITES
--   The roles holding SELECT on thought_facets get SELECT on
--   subject_repo_settings (the sweep reads the setting in PR 3b, the server's
--   thread read too); those holding INSERT on thought_facets get INSERT and
--   UPDATE as well (db/config.mjs: SELECT in the capture group, the three in
--   the structure group). The trigger holds what a row may be, and the setter
--   who may call it (132's convention). The setter is SECURITY INVOKER: its
--   mapping writes thought_facets and derivations as the caller.
--
-- SAFETY
--   One new table, its key and a partial unique index, two triggers and six
--   functions, and subject_key_valid replaced with a wider rule under its
--   signature: every key it admitted it admits still. Nothing stored changes
--   until an operator sets a repository. MINOR under FORK.md's version rules.
--   test-schema [137], test-upgrade [20co].
--
-- Prerequisites
--   046 (ob1_registry_kind), 061 (ob1_actor_agent_id), 111 (subject_key_valid,
--   ob1_record_derivation's `subject` kind), 115 (ob1_work_claim_actor), 120
--   (the thread triggers), 130 (the one-standing-subject-a-key index). Applied
--   by `bun db/migrate.ts`. Re-applied: the table, its indexes and rows are
--   kept, and the functions and triggers replaced as they were.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not hold
-- (052's shape).
DO $qc$
DECLARE
  v_need text[][] := ARRAY[
    ARRAY['ob1_registry_kind(uuid, text)', '046 (ob1_registry_kind)'],
    ARRAY['ob1_actor_agent_id()', '061 (ob1_actor_agent_id)'],
    ARRAY['subject_key_valid(text)', '111 (subject_key_valid)'],
    ARRAY['ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid)', '111 (ob1_record_derivation)'],
    ARRAY['ob1_work_claim_actor(jsonb, text)', '115 (ob1_work_claim_actor)'],
    ARRAY['ob1_thread_relink_subject()', '120 (ob1_thread_relink_subject)']];
  i int;
BEGIN
  IF to_regclass('thought_facets_subject_key_uniq') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 152 needs 130 (thought_facets_subject_key_uniq, one standing subject a thought and key); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  FOR i IN 1 .. array_length(v_need, 1) LOOP
    IF to_regprocedure(v_need[i][1]) IS NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = format('migration 152 needs %s; this schema lacks it', v_need[i][2]),
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
  'Whether a text is a subject key: ticket:<TEAM-N>, pr:<number> or pr:<owner>/<repo>#<number>, version:v<n>.<n>[.<n>[.<n>]] or version:<owner>/<repo>@v<n>.<n>[...], or phrase:<lower-case words>, at most 207 characters. The owner (1 to 39 letters, digits and inner hyphens) and the repository (1 to 100 letters, digits, dots, hyphens and underscores, not . or ..) are lowercase, as GitHub names them. IMMUTABLE: a key''s shape never depends on the brain''s setting; a brain scopes its keys only once its operator names a repository (set_subject_repo), and both shapes stay valid. The facet validator, record_thought_subjects and the thread edges read it. Migrations 111, 152 / SMD-3306, SMD-3887.';

-- ---------------------------------------------------------------------------
-- 2. ob1_subject_repo_refusal — what is wrong with a repository value
-- ---------------------------------------------------------------------------
-- The one place the setting's shape is spelled: the trigger, set_subject_repo
-- and ob1_subject_repo() read it, so a migration that changes it replaces this
-- one function.
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
  'What is wrong with a repository value for the subject-key setting — NULL, not lowercase, not <owner>/<repo> as GitHub names it, or a repository of . or .. — in words, or NULL for none. The one place the shape is spelled: subject_repo_settings'' trigger, set_subject_repo and ob1_subject_repo() read it. Migration 152 / SMD-3887.';

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
  'A bare subject key scoped to a repository: pr:<n> becomes pr:<repo>#<n> and version:v<n>... becomes version:<repo>@v<n>...; any other key (ticket:, phrase:, a key scoped already), or a NULL repository, comes back as given. IMMUTABLE. set_subject_repo maps a brain''s standing keys by it; the thread read resolves a bare key by it (SMD-3887 PR 3b). Migration 152 / SMD-3887.';

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
  'The operator''s repository for subject keys (ob1_subject_repo(): the standing row''s repo, or NULL when none stands, and the brain''s pr: and version: keys stay unscoped). One row per setting, at most one standing (ended_at NULL); a row changes only to end, once, when the next setting or a clear replaces it, and a DELETE or TRUNCATE is refused, so the rows say which repository stood when. repo is checked by ob1_subject_repo_refusal when written. set_by and ended_by name the operator key by its name then, with its agent id, which the trigger holds to a key the registry classifies operator. Written through set_subject_repo, an operator key''s alone, which maps the standing unscoped keys to it. Migration 152 / SMD-3887.';

CREATE UNIQUE INDEX IF NOT EXISTS subject_repo_settings_one_standing ON subject_repo_settings ((true)) WHERE ended_at IS NULL;

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
  'Refuses a subject_repo_settings row whose repo ob1_subject_repo_refusal names (22023, in its words), one written already ended, one whose set_by_agent_id (or, ending it, ended_by_agent_id) the registry does not classify operator (42501), an UPDATE other than a standing row ending once, and every DELETE and TRUNCATE — for the owner too. Migration 152 / SMD-3887.';

CREATE OR REPLACE TRIGGER subject_repo_settings_history
  BEFORE INSERT OR UPDATE OR DELETE ON subject_repo_settings
  FOR EACH ROW EXECUTE FUNCTION ob1_subject_repo_settings_guard();
CREATE OR REPLACE TRIGGER subject_repo_settings_no_truncate
  BEFORE TRUNCATE ON subject_repo_settings
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_subject_repo_settings_guard();

-- The grants, carried to the roles that hold thought_facets' already (140's
-- carry): a role holding SELECT on thought_facets gets SELECT here, one holding
-- INSERT there gets INSERT and UPDATE too, as db/config.mjs's groups list them;
-- the owner holds every privilege already. A re-apply grants what is held
-- already, which changes nothing.
DO $grant$
DECLARE
  v_item record;
BEGIN
  FOR v_item IN
    SELECT DISTINCT a.grantee, a.privilege_type
      FROM pg_class c, aclexplode(c.relacl) AS a
     WHERE c.oid = 'thought_facets'::regclass AND a.grantee <> c.relowner AND a.privilege_type IN ('SELECT', 'INSERT')
  LOOP
    EXECUTE format('GRANT %s ON subject_repo_settings TO %s',
                   CASE v_item.privilege_type WHEN 'SELECT' THEN 'SELECT' ELSE 'SELECT, INSERT, UPDATE' END,
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
  'The repository a brain scopes its pr: and version: subject keys to: the standing operator setting (subject_repo_settings), or NULL when none stands, and keys stay unscoped. A stored value ob1_subject_repo_refusal names raises 22000 naming the setting. Migration 152 / SMD-3887.';

-- ---------------------------------------------------------------------------
-- 6. set_subject_repo — the operator's write, which maps the standing keys
-- ---------------------------------------------------------------------------
-- One writer at a time, by a transaction advisory lock taken before the
-- standing row is read (140's set_work_claim_cap).
CREATE OR REPLACE FUNCTION set_subject_repo(p_repo text DEFAULT NULL, p_actor jsonb DEFAULT NULL)
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
  v_keys    text[] := '{}';
  v_thts    integer := 0;
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

  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:subject-repo', 0));
  v_now := clock_timestamp();
  SELECT * INTO v_old FROM subject_repo_settings WHERE ended_at IS NULL FOR UPDATE;
  IF v_old.repo IS NOT DISTINCT FROM v_repo THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'repo', v_repo, 'previous', v_repo,
      'set_at', v_old.set_at, 'set_by', v_old.set_by, 'mapped', 0, 'keys', 0, 'thoughts', 0);
  END IF;
  IF v_old.id IS NOT NULL THEN
    UPDATE subject_repo_settings SET ended_at = v_now, ended_by = v_who.name, ended_by_agent_id = v_who.agent_id
     WHERE id = v_old.id;
  END IF;
  IF v_repo IS NOT NULL THEN
    INSERT INTO subject_repo_settings (repo, set_by, set_by_agent_id, set_at)
    VALUES (v_repo, v_who.name, v_who.agent_id, v_now)
    RETURNING * INTO v_new;

    -- ob1:subject-repo-mapping — a CONTRACT SENTINEL, not prose: every standing
    -- unscoped pr:/version: subject closed and its scoped twin written with its
    -- lineage, thought by thought in id order under 111's lock.
    FOR v_thought IN
      SELECT DISTINCT f2.thought_id
        FROM thought_facets f2
       WHERE f2.kind = 'subject' AND f2.valid_until IS NULL
         AND (f2.payload->>'key' ~ '^pr:[0-9]{1,9}$' OR f2.payload->>'key' ~ '^version:v[0-9]+(\.[0-9]+){1,3}$')
       ORDER BY f2.thought_id
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('ob1:subject:' || v_thought::text, 0));
      SELECT COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)) INTO v_fp
        FROM thoughts t WHERE t.id = v_thought FOR KEY SHARE;
      IF NOT FOUND THEN
        CONTINUE;
      END IF;
      v_thts := v_thts + 1;
      FOR f IN
        SELECT s.id, s.payload->>'key' AS key, s.payload->>'by' AS way, s.payload->>'judge_key' AS judge
          FROM thought_facets s
         WHERE s.thought_id = v_thought AND s.kind = 'subject' AND s.valid_until IS NULL
           AND (s.payload->>'key' ~ '^pr:[0-9]{1,9}$' OR s.payload->>'key' ~ '^version:v[0-9]+(\.[0-9]+){1,3}$')
         ORDER BY s.payload->>'key', s.id
           FOR UPDATE
      LOOP
        v_key := ob1_subject_scoped_key(f.key, v_repo);
        UPDATE thought_facets SET valid_until = now() WHERE id = f.id;
        v_keys := v_keys || v_key;
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
        SELECT d.input_ids, d.input_fingerprints, d.recipe, d.canonical_agent_id INTO v_lin
          FROM derivations d
         WHERE d.artifact_kind = 'subject' AND d.artifact_id = f.id AND d.produced_by = f.judge;
        IF FOUND THEN
          PERFORM ob1_record_derivation('subject', v_id, v_lin.input_ids, v_lin.input_fingerprints, f.judge,
                                        COALESCE(v_lin.recipe, jsonb_build_object('deterministic', f.way <> 'model'))
                                          || jsonb_build_object('scoped_from', f.key, 'repo', v_repo),
                                        v_lin.canonical_agent_id);
        ELSE
          PERFORM ob1_record_derivation('subject', v_id, ARRAY[v_thought], ARRAY[v_fp], f.judge,
                                        jsonb_build_object('deterministic', f.way <> 'model', 'declared', false,
                                                           'scoped_from', f.key, 'repo', v_repo),
                                        NULL);
        END IF;
        v_mapped := v_mapped + 1;
      END LOOP;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('ok', true, 'changed', true, 'repo', v_repo, 'previous', v_old.repo,
    'set_at', CASE WHEN v_repo IS NULL THEN NULL ELSE v_new.set_at END,
    'set_by', CASE WHEN v_repo IS NULL THEN NULL ELSE v_new.set_by END,
    'mapped', v_mapped, 'closed_alone', v_dupes,
    'keys', (SELECT count(DISTINCT k) FROM unnest(v_keys) AS k), 'thoughts', v_thts);
END
$$;
COMMENT ON FUNCTION set_subject_repo(text, jsonb) IS
  'The operator names the repository a brain scopes its pr: and version: subject keys to (docs/claim-validity.md row 13). Only a key the registry classifies operator, named by its agent id in p_actor (a name lends no kind); any other answers {ok: false, error: NOT_OPERATOR, key, kind, message}. The value is trimmed and lowercased; one ob1_subject_repo_refusal names answers {ok: false, error: BAD_REPO, message}. NULL clears it: keys scoped already stay, and new keys are unscoped. Setting what stands writes nothing ({changed: false}). Setting a repository maps every standing unscoped pr:/version: subject to it (ob1:subject-repo-mapping): the facet closed and its scoped twin (ob1_subject_scoped_key) written with the same by and judge_key and the closed facet''s lineage, its recipe noting scoped_from and repo; a thought holding the scoped key already has the unscoped one closed alone. Thought by thought in id order under the subject door''s lock; the thread triggers re-link both keys at the commit, so each thread keeps its members. Keys scoped to another repository stay. Returns {ok: true, changed, repo, previous, set_at, set_by, mapped, closed_alone, keys (the distinct scoped keys), thoughts}. SECURITY INVOKER: the caller needs the setting''s INSERT and UPDATE, and to map, what record_thought_subjects needs. Migration 152 / SMD-3887.';

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
  'The standing subject-key repository for brain_info: {repo: null, source: none} when none is set (keys stay unscoped), else {repo, source: operator, set_at, set_by, refused} where refused is ob1_subject_repo_refusal''s word on it or null. Never raises, unlike ob1_subject_repo(). Migration 152 / SMD-3887.';
