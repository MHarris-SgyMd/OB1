-- =============================================================================
-- Migration 054: resolve_agent writes a key's row only when the write says
--                something, and a revocation that commits while it waits is
--                an answer (SMD-2090)
-- =============================================================================
--
-- WHY
--   010's resolve_agent ran `UPDATE ob1_agent_keys SET last_used_at = now(),
--   scope = COALESCE(p_scope, scope)` on every lookup of a known, unrevoked
--   key. That write takes the key's row lock, so any transaction holding the
--   row made the lookup wait: an open revoke_agent_key, an operator's SELECT …
--   FOR UPDATE, another replica's lookup of the same key. The SQL store caps
--   each wait at 250 ms (SMD-2072) and a key whose lookup times out is `busy`,
--   refused with a retry. The cap bounds the cost; the wait itself was for a
--   write that, most of the time, changed nothing anyone reads.
--
--   And the write re-checked only key_hash. A lookup that overlapped a
--   revoke_agent_key of the same key, not yet committed, read the key as
--   active (its SELECT does not wait), waited on the revoker's row lock in the
--   UPDATE, and once the revoker committed wrote last_used_at and answered
--   ok:true. The server then kept that answer for its cache TTL (60 s by
--   default). Measured in SMD-2072's second review pass: a revocation
--   committing 50 or 150 ms into the lookup was served ok three runs in three.
--
-- WHAT
--   resolve_agent(text, text, text) redefined on 010's body, same signature
--   (its grants stand across CREATE OR REPLACE). The known-key branch:
--
--   * READS FIRST, AS BEFORE. The plain SELECT of the key, its revocation and
--     its agent never waits on a row lock, so a committed revocation is still
--     refused at once. It now also reads last_used_at and the recorded scope.
--   * WRITES ONLY WHEN STALE. The row is written when last_used_at is NULL,
--     more than five minutes old or in the future (a clock stepped back, a
--     restore from a skewed host — else it would never be written until the
--     clock passed it), or when a scope was presented that differs from the
--     one recorded. Otherwise nothing is written and no row lock is taken: a
--     recently used key presenting its recorded scope answers while another
--     transaction holds its row. Five minutes is five times the server's
--     default cache TTL, so a server re-resolving a key once a minute writes
--     its row one lookup in five; OB1_AGENT_CACHE_TTL_MS=0 (a lookup per
--     request) writes it once per five minutes rather than on every request.
--     last_used_at now means "the last use, to within five minutes", which is
--     what it is read for: which keys are in use, which have gone quiet. A
--     scope change is always written,
--     since the column's job is to show a privilege change (010, 049) — so a
--     key presented under two scopes at once (two processes on different
--     MCP_ACCESS_KEYS during a rollout) writes on every lookup from either,
--     as 010 did on every lookup of any key.
--   * THE WRITE RE-CHECKS THE REVOCATION. `WHERE key_hash = … AND revoked_at IS
--     NULL`: under READ COMMITTED an UPDATE that waited on a row re-evaluates
--     its WHERE against the version that committed, so a revocation that
--     landed during the wait leaves nothing to write. When nothing was written
--     the row is read again — each statement of a VOLATILE function under READ
--     COMMITTED takes a fresh snapshot: revoked answers REVOKED, exactly as a
--     lookup after the commit does. A row gone (deleted by hand while the
--     lookup waited) is treated as a key never seen: the lookup falls through
--     to 010's registration below — the rotation branch, or first sight if its
--     agent went too — which a later lookup would have done anyway.
--   * SO DOES REGISTRATION. 010's `INSERT … ON CONFLICT (key_hash) DO UPDATE`
--     — reached by the loser of two first sights and, since this file, by a
--     row deleted during the wait — wrote over whatever row won, revoked or
--     not. Its DO UPDATE now carries `WHERE ob1_agent_keys.revoked_at IS
--     NULL`, and when it writes nothing the row is read and REVOKED answered.
--     The ON CONFLICT locks the row it refuses until the transaction ends, so
--     that read finds the revoked version, never a row deleted in between.
--   * UNDER REPEATABLE READ OR SERIALIZABLE both writes fail 40001 instead of
--     re-reading — the waiting UPDATE, as 010's did, and the ON CONFLICT on a
--     row committed after the snapshot. The server retries 40001 (agents.ts),
--     and the retry, a fresh snapshot, reads the revocation.
--
--   The rest is 010's body: the rename branch, the rotation, first sight.
--   What stays:
--   * A lookup that overlaps an uncommitted revocation of a key it does not
--     need to write answers ok, having read the key before the revocation
--     committed — the same answer as a lookup a moment earlier, and the one
--     the server's TTL already allows for (a revocation "takes effect within
--     the server resolve cache TTL", 010's column comment). What this file
--     removes is the answer given AFTER the commit.
--   * A first sight that answers REVOKED from registration keeps the agent
--     row it inserted for its label, with no key, and a later key under that
--     label rotates onto it. It needs one digest presented under two names at
--     once (auth.ts refuses that config); 010 left the same row and answered
--     ok. Removing it would need DELETE, which the server role is not granted,
--     or a subtransaction, whose rollback would release the refused row's lock.
--   * A role granted SELECT and INSERT but not UPDATE on ob1_agent_keys failed
--     every known-key lookup under 010; now it fails only a lookup that writes
--     — a stale one, a scope change, or a registration (INSERT … ON CONFLICT DO
--     UPDATE needs UPDATE too). The documented grants (db/config.mjs's server
--     group) include it.
--
-- SAFETY
--   Refuses up front, by name, when 010's table or the three columns the body
--   reads, writes or re-checks (last_used_at, revoked_at, scope) are missing
--   (a ledger baselined over an older schema) — 049's guard. No table change,
--   no data change; the function and two comments. Idempotent: CREATE OR
--   REPLACE and COMMENT, so a re-run lands here, and so does --reapply, which
--   runs 010's body and then this file's. A redefined function is a behaviour
--   change at the schema, so under the version rules it ships in a minor
--   release (check-fork's checkFragments).
-- =============================================================================

DO $g$
BEGIN
  -- to_regclass, not ::regclass, so a missing table is NULL here rather than an error.
  IF to_regclass('ob1_agent_keys') IS NULL
     OR (SELECT count(*) FROM pg_attribute
          WHERE attrelid = to_regclass('ob1_agent_keys')
            AND attname IN ('last_used_at', 'revoked_at', 'scope') AND NOT attisdropped) <> 3 THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 054 needs 010 (ob1_agent_keys.last_used_at, revoked_at, scope); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$g$;

CREATE OR REPLACE FUNCTION resolve_agent(
  p_key_hash text,
  p_label    text,
  p_scope    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_hash     text := lower(trim(COALESCE(p_key_hash, '')));
  v_label    text := trim(COALESCE(p_label, ''));
  v_agent    uuid;
  v_current  text;
  v_revoked  timestamptz;
  v_reason   text;
  v_used     timestamptz;
  v_scope    text;
  v_gone     boolean := false;
  v_created  boolean := false;
  v_rotated  boolean := false;
  v_conflict boolean := false;
BEGIN
  -- Refuse rather than register. A caller that passes a raw key here would
  -- otherwise store one, which is the single thing this table must never hold.
  IF v_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_KEY_HASH');
  END IF;
  IF v_label = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_LABEL');
  END IF;

  -- A plain read, which never waits on a row lock: a committed revocation is
  -- refused at once whoever holds the row.
  SELECT k.canonical_agent_id, k.revoked_at, k.revoked_reason, a.label, k.last_used_at, k.scope
    INTO v_agent, v_revoked, v_reason, v_current, v_used, v_scope
    FROM ob1_agent_keys k
    JOIN ob1_agents a USING (canonical_agent_id)
   WHERE k.key_hash = v_hash;

  IF FOUND THEN
    IF v_revoked IS NOT NULL THEN
      -- The agent id comes back with the refusal on purpose: the caller is
      -- being denied, but its history is still identified and queryable.
      RETURN jsonb_build_object(
        'ok', false, 'error', 'REVOKED',
        'agent_id', v_agent, 'label', v_current,
        'revoked_at', v_revoked, 'reason', v_reason);
    END IF;

    -- ob1:stale-only-touch — the row is written, and its lock taken, only
    -- when the write says something: a use not recorded in five minutes (or
    -- recorded in the future, which would otherwise never be written until
    -- the clock passed it), or a scope that differs from the one recorded
    -- (SMD-2090).
    IF v_used IS NULL OR v_used < now() - interval '5 minutes' OR v_used > now()
       OR (p_scope IS NOT NULL AND p_scope IS DISTINCT FROM v_scope) THEN
      -- revoked_at re-checked: an UPDATE that waited on the row re-reads its
      -- WHERE against the version that committed, so a revocation that landed
      -- during the wait leaves nothing to write.
      UPDATE ob1_agent_keys
         SET last_used_at = now(),
             scope        = COALESCE(p_scope, scope)
       WHERE key_hash = v_hash
         AND revoked_at IS NULL;

      IF NOT FOUND THEN
        -- The row changed while the UPDATE waited. Under READ COMMITTED each
        -- statement of a VOLATILE function takes a fresh snapshot, so this
        -- reads what committed.
        SELECT k.canonical_agent_id, k.revoked_at, k.revoked_reason, a.label
          INTO v_agent, v_revoked, v_reason, v_current
          FROM ob1_agent_keys k
          JOIN ob1_agents a USING (canonical_agent_id)
         WHERE k.key_hash = v_hash;
        v_gone := NOT FOUND;
        IF v_revoked IS NOT NULL AND NOT v_gone THEN
          RETURN jsonb_build_object(
            'ok', false, 'error', 'REVOKED',
            'agent_id', v_agent, 'label', v_current,
            'revoked_at', v_revoked, 'reason', v_reason);
        END IF;
      END IF;
    END IF;

    -- A row deleted while the UPDATE waited is a key never seen: it falls
    -- through to the registration below — the rotation branch, or first
    -- sight if its agent went too — as the next lookup would.
    IF NOT v_gone THEN
      IF v_current IS DISTINCT FROM v_label THEN
        BEGIN
          UPDATE ob1_agents SET label = v_label WHERE canonical_agent_id = v_agent;
          v_current := v_label;
        EXCEPTION WHEN unique_violation THEN
          -- Another agent already answers to that name: one raw key registered
          -- under two names in MCP_ACCESS_KEYS. Keep the existing name and
          -- report the conflict (010); auth.ts refuses such a config outright.
          v_conflict := true;
        END;
      END IF;

      RETURN jsonb_build_object(
        'ok', true, 'agent_id', v_agent, 'label', v_current,
        'created', false, 'rotated', false, 'label_conflict', v_conflict);
    END IF;
  END IF;

  SELECT canonical_agent_id INTO v_agent FROM ob1_agents WHERE label = v_label;

  IF FOUND THEN
    v_rotated := true;
  ELSE
    -- ON CONFLICT: two clients presenting an unregistered key at once would
    -- otherwise race. `xmax = 0` is true only for a row this statement
    -- INSERTed, so the losing side reports created:false (010).
    INSERT INTO ob1_agents (label) VALUES (v_label)
    ON CONFLICT (label) DO UPDATE SET updated_at = now()
    RETURNING canonical_agent_id, (xmax = 0) INTO v_agent, v_created;
  END IF;

  -- The loser of two first sights, and a row deleted during a wait above, meet
  -- a row another transaction wrote. Written over only if it is not revoked
  -- (SMD-2090); a revoked one leaves nothing written, and is read and refused.
  INSERT INTO ob1_agent_keys (key_hash, canonical_agent_id, scope, last_used_at)
  VALUES (v_hash, v_agent, p_scope, now())
  ON CONFLICT (key_hash) DO UPDATE SET last_used_at = now()
    WHERE ob1_agent_keys.revoked_at IS NULL;

  IF NOT FOUND THEN
    -- The ON CONFLICT locked the row it refused, and holds it to the end of
    -- the transaction: this reads that revoked row, never one deleted between.
    SELECT k.canonical_agent_id, k.revoked_at, k.revoked_reason, a.label
      INTO v_agent, v_revoked, v_reason, v_current
      FROM ob1_agent_keys k
      JOIN ob1_agents a USING (canonical_agent_id)
     WHERE k.key_hash = v_hash;
    RETURN jsonb_build_object(
      'ok', false, 'error', 'REVOKED',
      'agent_id', v_agent, 'label', v_current,
      'revoked_at', v_revoked, 'reason', v_reason);
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'agent_id', v_agent, 'label', v_label,
    'created', v_created, 'rotated', v_rotated, 'label_conflict', false);
END;
$$;

COMMENT ON FUNCTION resolve_agent(text, text, text) IS
  'Resolve a key digest + key name to a stable canonical_agent_id, registering on first sight. Distinguishes a rename (hash known, label new) from a rotation (label known, hash new); both preserve the id. Returns {ok:false, error:REVOKED} with the agent id still attached, so a refused key stays identified. A known key''s row is written only when last_used_at is NULL, over five minutes old or in the future, or the presented scope changed, so a recently used key presenting its recorded scope takes no row lock; a revocation that commits while that write waits, or before a registration writes over a row another transaction inserted, answers REVOKED (migration 054, SMD-2090).';

COMMENT ON COLUMN ob1_agent_keys.last_used_at IS
  'The key''s last use, to within five minutes: resolve_agent writes it when it is NULL, older than that or in the future, or when the presented scope changed, and not otherwise, so a lookup of a recently used key takes no row lock (migration 054, SMD-2090). resolve_agent sets it on every row it inserts, so NULL means a row written or cleared outside it (by hand, or by a restore).';
