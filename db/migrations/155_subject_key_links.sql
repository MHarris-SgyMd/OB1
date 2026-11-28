-- =============================================================================
-- Migration 155: a pr: subject key takes the repository its GitHub link names,
--                once an operator names the brain's (SMD-3887 PR 3b-1,
--                docs/claim-validity.md row 13)
-- =============================================================================
--
-- WHY
--   153 scopes every bare `pr:` and `version:` key to the operator's
--   repository. Row 13, as the maintainer narrowed it on 2026-11-19, also says
--   a pull request's URL naming another repository scopes its key to that one,
--   once a repository is set. On the canary on 2026-11-24, 64 of the 85 bare
--   `pr:` subjects stood on texts holding the PR's GitHub link with the same
--   number, 56 of them under repositories other than the brain's (among
--   them siggymd/client 31, siggymd/infrastructure 11 and siggymd/platform
--   11). 153's
--   mapping would have scoped them all to the setting's repository, and its
--   writer would then have kept the wrong key. The maintainer chose
--   (2026-11-24) that one SQL rule scope by the link, so the mapping, the
--   writer and the sweep through it agree.
--
-- WHAT
--   * ob1_subject_linked_key(text, key) — for a bare `pr:<n>` key, the key
--     scoped to the repository a GitHub pull-request link in the text names
--     for the same number (`github.com/<owner>/<repo>/pull/<n>`, `www.` or
--     not, any case, leading zeros), owner and repository lowercased; NULL
--     when no link names the number, when links name it under two
--     repositories, when the scoped key would be no key, and for any other
--     key. IMMUTABLE.
--   * set_subject_repo — 153's body, but where marked 155: a key's target is
--     its link's repository first, else the setting's, for a bare key and for
--     a remap's alike; a key its link already scopes does not move. The cap
--     counts the keys moved and their targets (two thread locks apiece), and
--     both have their thread locks taken first. A twin's lineage names the
--     repository its key went to, a link's or the setting's.
--   * record_thought_subjects — 153's body, but where marked 155: on a brain
--     whose operator names a repository, a bare `pr:` key a link in the
--     thought's text names is written to the link's repository before any
--     other rule (then the scoped key the thought holds, then the setting's).
--     With no repository set, a link changes nothing, as row 13 says.
--
-- SAFETY
--   One new function, and two replaced on 153's bodies. Nothing stored
--   changes: no brain has a repository set before 3b-1 (the maintainer's word
--   on SMD-3887, 2026-11-24), and with none set the two write as 153's did.
--   MINOR under FORK.md's version rules. test-schema [140], test-upgrade
--   [20cr].
--
-- Prerequisites
--   016 (content_fingerprint_of), 046 (ob1_registry_kind), 061 (derivations),
--   111 (ob1_record_derivation), 113 (ob1_filed_ticket), 115
--   (ob1_work_claim_actor), 130 (ob1_thread_lock_keys and the
--   one-standing-subject-a-key index), 153 (the setting, its functions and
--   the bodies this file carries). Applied by `bun db/migrate.ts`. Re-applied:
--   the functions replaced as they were.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not hold
-- (052's shape).
DO $qc$
DECLARE
  v_need text[][] := ARRAY[
    ARRAY['content_fingerprint_of(text)', '016 (content_fingerprint_of)'],
    ARRAY['ob1_registry_kind(uuid, text)', '046 (ob1_registry_kind)'],
    ARRAY['ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid)', '111 (ob1_record_derivation)'],
    ARRAY['ob1_filed_ticket(jsonb)', '113 (ob1_filed_ticket)'],
    ARRAY['ob1_work_claim_actor(jsonb, text)', '115 (ob1_work_claim_actor)'],
    ARRAY['ob1_thread_lock_keys(text[])', '130 (ob1_thread_lock_keys)'],
    ARRAY['subject_key_valid(text)', '153 (subject_key_valid)'],
    ARRAY['ob1_subject_scoped_key(text, text)', '153 (ob1_subject_scoped_key)'],
    ARRAY['ob1_subject_unscoped_key(text)', '153 (ob1_subject_unscoped_key)'],
    ARRAY['ob1_subject_repo()', '153 (ob1_subject_repo)'],
    ARRAY['ob1_subject_repo_refusal(text)', '153 (ob1_subject_repo_refusal)'],
    ARRAY['ob1_subject_repo_map_max()', '153 (ob1_subject_repo_map_max)']];
  i int;
BEGIN
  IF to_regclass('derivations') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 155 needs 061 (derivations, the lineage the mapping copies); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regclass('subject_repo_settings') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 155 needs 153 (subject_repo_settings, the operator''s subject-key repository); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  FOR i IN 1 .. array_length(v_need, 1) LOOP
    IF to_regprocedure(v_need[i][1]) IS NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = format('migration 155 needs %s; this schema lacks it', v_need[i][2]),
        -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
        HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
        ERRCODE = 'invalid_schema_definition';
    END IF;
  END LOOP;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. ob1_subject_linked_key — the repository a pull request's link names
-- ---------------------------------------------------------------------------
-- ob1:subject-key-links — a CONTRACT SENTINEL, not prose: a GitHub
-- pull-request link alone names a key's repository (the maintainer,
-- 2026-11-23): any other host leaves the key to the setting's. The number must
-- be the key's, read as a number, and one repository alone must claim it. A
-- link begins the text or a URL (`://`), or follows any mark but one a host's
-- name, a path or a query holds (a letter, digit, `.`, `-`, `_`, `/`, `=`,
-- `?`, `&`, `%` or `:`): a comma, a backtick or `**` before it is no bar
-- (review pass 4), and `mirror.example.com/github.com/…` no link (pass 3).
-- A protocol-relative `//github.com/…` where a link may begin is one too
-- (`href="//github.com/…"`, review pass 6).
CREATE OR REPLACE FUNCTION ob1_subject_linked_key(p_text text, p_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  -- Every link of the number counts, a repository no key can name among them (review pass 2): two repositories
  -- leave it to the setting's, and one that is no key gives nothing.
  SELECT CASE WHEN count(DISTINCT s.k) = 1 AND subject_key_valid(min(s.k)) THEN min(s.k) END
    FROM (SELECT 'pr:' || lower(m[1]) || '/' || lower(m[2]) || '#' || m[3]::bigint::text AS k
            FROM regexp_matches(COALESCE(p_text, ''),
                   '(?:(?:^|[^A-Za-z0-9./=?&%_:-])(?://)?|://)(?:www\.)?github\.com/([A-Za-z0-9-]{1,39})/([A-Za-z0-9._-]{1,100})/pull/0*([0-9]{1,9})(?![0-9])',
                   'gi') AS m
           -- The key's number by a pattern, NULL for any other key, so no cast meets a key not pr:<n> whatever order the
           -- planner reads the condition in (review pass 6).
           WHERE m[3]::bigint = substring(p_key FROM '^pr:([0-9]{1,9})$')::bigint) AS s
$$;
COMMENT ON FUNCTION ob1_subject_linked_key(text, text) IS
  'For a bare pr:<n> subject key, the key scoped to the repository a GitHub pull-request link in the text names for the same number (github.com/<owner>/<repo>/pull/<n>, www. or not, any case, leading zeros), owner and repository lowercased (ob1:subject-key-links); NULL when no link names the number, when links name it under two repositories (a repository no key can name counted among them), when the one it names would make no key (subject_key_valid), and for any other key or a NULL text. IMMUTABLE. set_subject_repo''s mapping and record_thought_subjects read a bare key''s repository from it before the setting''s. Migration 155 / SMD-3887.';

-- ---------------------------------------------------------------------------
-- 2. set_subject_repo — 153's setter, its keys scoped by their links first
-- ---------------------------------------------------------------------------
-- 153's body verbatim but where marked 155.
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
  -- 155: the targets the count reads, each facet's target, and the bound from the keys alone.
  v_targets text[] := '{}';
  v_map     jsonb := '{}';
  v_lower   integer;
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
    -- 155 (SMD-3887 PR 3b-1): each key's target is the one a GitHub link in its thought's text names
    -- (ob1_subject_linked_key), else the setting's; the keys moved and their targets are both counted and locked, as
    -- a link can send one bare key to several repositories. A key whose target is itself (scoped by its link to the
    -- repository a remap moves from) does not move. Each facet's target is read here once, from its thought's text
    -- now, and the mapping below takes it from v_map rather than read the text again: an edit committed between the
    -- two would otherwise move a key to a target whose thread lock was never taken first (review pass 1).
    -- A bound first, from the keys alone (review pass 4): each distinct bare key the setting can scope moves, to a
    -- target of its own (no two bare keys share one), so past the cap of them the check below would refuse too, and
    -- no text need be read to say so.
    SELECT count(DISTINCT f2.payload->>'key') INTO v_lower
      FROM thought_facets f2
     WHERE f2.kind = 'subject' AND f2.valid_until IS NULL
       AND (f2.payload->>'key' ~ '^pr:[0-9]{1,9}$' OR f2.payload->>'key' ~ '^version:v[0-9]+(\.[0-9]+){1,3}$')
       AND subject_key_valid(ob1_subject_scoped_key(f2.payload->>'key', v_repo));
    IF v_lower > ob1_subject_repo_map_max() THEN
      RETURN jsonb_build_object('ok', false, 'error', 'TOO_MANY_KEYS', 'keys', v_lower, 'targets', NULL, 'max', ob1_subject_repo_map_max(),
        'message', format('setting %s would move at least %s distinct pr: and version: keys, each to a target of its own, in one transaction, %s or more thread locks held to the commit, past the %s (two for each of %s keys) one mapping takes; nothing is set',
                          v_repo, v_lower, 2 * v_lower, 2 * ob1_subject_repo_map_max(), ob1_subject_repo_map_max()));
    END IF;
    -- The text is read for a pr: key alone, the one a link can scope (review pass 4).
    SELECT COALESCE(jsonb_object_agg(f2.id::text,
                      COALESCE(CASE WHEN ob1_subject_unscoped_key(f2.payload->>'key') ~ '^pr:'
                                    THEN ob1_subject_linked_key(t2.content, ob1_subject_unscoped_key(f2.payload->>'key')) END,
                               ob1_subject_scoped_key(ob1_subject_unscoped_key(f2.payload->>'key'), v_repo))), '{}') INTO v_map
      FROM thought_facets f2 JOIN thoughts t2 ON t2.id = f2.thought_id
     WHERE f2.kind = 'subject' AND f2.valid_until IS NULL
       AND ((f2.payload->>'key' ~ '^pr:[0-9]{1,9}$' OR f2.payload->>'key' ~ '^version:v[0-9]+(\.[0-9]+){1,3}$')
              OR (v_from IS NOT NULL AND ob1_subject_unscoped_key(f2.payload->>'key') <> f2.payload->>'key'
                  AND ob1_subject_scoped_key(ob1_subject_unscoped_key(f2.payload->>'key'), v_from) = f2.payload->>'key'));
    -- A facet's key is never edited (111's validator), so its key read again here is the one counted.
    SELECT COALESCE(array_agg(DISTINCT f3.payload->>'key' ORDER BY f3.payload->>'key'), '{}'), COALESCE(array_agg(DISTINCT e.value ORDER BY e.value), '{}')
      INTO v_bare, v_targets
      FROM jsonb_each_text(v_map) AS e JOIN thought_facets f3 ON f3.id = e.key::uuid
     WHERE subject_key_valid(e.value) AND e.value <> f3.payload->>'key';
    IF cardinality(v_bare) + cardinality(v_targets) > 2 * ob1_subject_repo_map_max() THEN
      -- 155: the keys and their targets, two thread locks apiece, as the check counts them (review pass 1).
      RETURN jsonb_build_object('ok', false, 'error', 'TOO_MANY_KEYS', 'keys', cardinality(v_bare), 'targets', cardinality(v_targets), 'max', ob1_subject_repo_map_max(),
        'message', format('setting %s would move %s distinct pr: and version: keys to %s targets in one transaction, %s thread locks held to the commit, past the %s (two for each of %s keys) one mapping takes; nothing is set',
                          v_repo, cardinality(v_bare), cardinality(v_targets), cardinality(v_bare) + cardinality(v_targets), 2 * ob1_subject_repo_map_max(), ob1_subject_repo_map_max()));
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
    PERFORM ob1_thread_lock_keys(v_bare || v_targets);  -- 155: the targets as counted above

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
        -- 155: the target the count read (v_map): the repository a GitHub link in the text named for the number,
        -- else the setting's. A key its link scopes already stays where it is, and a facet the count did not see (a
        -- raw write since) is left for the next setting.
        v_key := v_map->>f.id::text;
        IF v_key IS NULL OR v_key = f.key THEN
          CONTINUE;
        END IF;
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
                                          || jsonb_build_object('scoped_from', f.key, 'repo', COALESCE(substring(v_key FROM '^pr:([^#]+)#'), substring(v_key FROM '^version:([^@]+)@'))),  -- 155: the key's own repository, a link's or the setting's
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
                                                           'scoped_from', f.key, 'repo', COALESCE(substring(v_key FROM '^pr:([^#]+)#'), substring(v_key FROM '^version:([^@]+)@'))),  -- 155: as above
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
  'The operator names the repository a brain scopes its pr: and version: subject keys to (docs/claim-validity.md row 13). Only a key the registry classifies operator, named by its agent id in p_actor (a name lends no kind); any other answers {ok: false, error: NOT_OPERATOR, key, kind, message}. The value is trimmed and lowercased; one ob1_subject_repo_refusal names answers {ok: false, error: BAD_REPO, message}. NULL clears it: keys scoped already stay, and new keys are unscoped. Setting what stands writes no setting ({changed: false}), and maps any unscoped key a raw write left standing under it. Setting a repository maps every standing unscoped pr:/version: subject (ob1:subject-repo-mapping), a pr: key to the repository a GitHub link in its thought''s text names for its number (ob1_subject_linked_key) and every other to the setting''s: the facet closed and its scoped twin written with the same by and judge_key and the closed facet''s lineage, its recipe noting scoped_from and repo and a rebuild asked of it (stale_since, stale_reason) kept; a thought holding the scoped key already has the unscoped one closed alone; a key too long once scoped stands bare, counted unscopable. Keys and targets past twice ob1_subject_repo_map_max() (two thread locks apiece) answer {ok: false, error: TOO_MANY_KEYS, keys, targets, max, message}, nothing written. Under the ob1:subject-repo lock, exclusive here and shared in record_thought_subjects, so no subject write interleaves with the mapping; the facets and thoughts moved are row-locked, and every key moved has its thread lock (ob1_thread_lock_keys) taken first, in key order. The thread triggers re-link both keys at the commit, so each thread keeps its members. Keys scoped to another repository stay, unless p_remap_previous: a change of repository then moves the keys scoped to the one it replaces to the new one as it maps a bare key (lineage noting scoped_from), to correct a mistaken setting; with no new repository it answers {ok: false, error: REMAP_NEEDS_REPO}. Returns {ok: true, changed, repo, previous, set_at (ISO, UTC), set_by, mapped, closed_alone, unscopable, remapped (facets moved from the previous repository), keys (the distinct scoped keys), thoughts (those a facet moved on)}, the same shape when nothing changed. SECURITY INVOKER: the caller needs the setting''s INSERT and UPDATE, and to map, what record_thought_subjects needs. Since 155 a bare pr: key, and a remap''s, is scoped to the repository a GitHub link in its thought''s text names for its number (ob1_subject_linked_key), else to the setting''s; the cap counts the keys moved and their targets, two thread locks apiece. Migrations 153, 155 / SMD-3887.';

-- ---------------------------------------------------------------------------
-- 3. record_thought_subjects — 153's door, a bare pr: key scoped by its link first
-- ---------------------------------------------------------------------------
-- 153's body verbatim but where marked 155.
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
  -- 155: the thought's text, read with its fingerprint, for its links.
  v_text   text;
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
  SELECT COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)), ob1_filed_ticket(t.metadata),
         CASE WHEN v_bare THEN t.content END INTO v_fp, v_filed, v_text  -- 155: the text the fingerprint is of, for its links
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
    -- 155: the thought's text was read with its fingerprint above, for a set holding a bare key alone (review pass 2), in
    -- the same statement, so it is the text the fingerprint checked: a read of its own could see an edit committed
    -- since, as FOR KEY SHARE does not hold one off (review pass 3). With no repository set it names nothing.
    IF v_repo IS NULL THEN
      v_text := NULL;
    END IF;
    SELECT COALESCE(array_agg(DISTINCT s ORDER BY s), '{}') INTO v_keys
      FROM (SELECT CASE WHEN NOT (k ~ '^pr:[0-9]{1,9}$' OR k ~ '^version:v[0-9]+(\.[0-9]+){1,3}$') THEN k
                        ELSE COALESCE(
                          -- 155: on a brain whose operator names a repository, the repository a GitHub link in the
                          -- text names for the number first; then the scoped key the thought holds, then the setting's.
                          CASE WHEN v_repo IS NOT NULL THEN ob1_subject_linked_key(v_text, k) END,
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
  'The subject pass''s write of one thought''s own subjects as a set (SMD-3306 PR 7a-3a): the standing `subject` facets made to be exactly these keys (each once; at most three, ob1:subject-set), found one way (`by`) by one pass (judge_key). A standing subject under a key of the set, found the same way by the same pass, is kept (its lineage row moved to the fingerprint read now); every other standing subject is closed (valid_until); each key not kept is written, with its lineage row (artifact_kind subject, its thought at the fingerprint read, produced_by the pass''s key; the recipe the caller''s, else deterministic unless the model found it) in the same transaction. NULL or an empty set closes every standing subject. `metadata` names one key. Refused, writing nothing (action none, stale), when the thought''s fingerprint is not the one the pass read, or the ticket it is filed under (ob1_filed_ticket) disagrees: metadata''s key under another ticket than it is filed under now, or any other way''s set on a thought filed since. Under the advisory lock on the thought (111''s), the thought locked FOR KEY SHARE first; the threads of the keys it moves re-link at the commit (120''s triggers, which lock them all in key order). Returns {ok, action, ids (the standing facets after, by key), kept, added, closed, closedIds (on a write), stale?, gone?}: action added when it wrote and closed nothing, closed when it closed and wrote nothing, replaced when it did both, kept when it did neither, none when nothing stood and nothing was asked, or on a refusal. SECURITY INVOKER: the caller needs INSERT on thought_facets (the structure group), UPDATE on it and on thoughts (the row locks) and the writes on derivations (the capture group), and since 120 what a re-link writes, as record_thought_subject. Since 153 (SMD-3887), each bare pr: or version: key is written as the key the thought holds already for the same number scoped to a repository (the setting''s first), so a thread keeps its members after the repository changes or is cleared; else, on a brain whose operator names a repository (ob1_subject_repo), scoped to it (ob1_subject_scoped_key), bare only when too long once scoped. Every write takes the ob1:subject-repo lock, shared here and in close_thought_subjects and exclusive in set_subject_repo, so no write interleaves with a mapping; a set holding a bare key reads the setting, and its caller needs SELECT on subject_repo_settings. Since 155, on a brain whose operator names a repository, a bare pr: key a GitHub link in the text names for its number is written scoped to that link''s repository (ob1_subject_linked_key) before any other rule. Migrations 130, 153, 155 / SMD-3306, SMD-3887.';
