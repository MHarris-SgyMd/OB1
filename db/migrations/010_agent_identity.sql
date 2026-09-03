-- ============================================================================
-- 010 — per-agent identity: a stable id that outlives the credential
--
-- Start with what is NOT missing, because it changes the size of this migration.
--
--   The extension this is ported from exists so that "rotating an agent's key
--   does not orphan its history". This fork already has that property. Migration
--   008 records `thought_audit.actor_name` — the NAME of the access key from
--   `MCP_ACCESS_KEYS`, never its hash. Swap the digest in
--   `laptop:write:<sha256>` and every prior row still says `laptop`.
--
--   So the headline benefit of schemas/per-agent-identity was already delivered
--   by binding to the name. What binding to a name does NOT survive:
--
--     1. A RENAME. `laptop` becomes `macbook` and the history is stranded under
--        a name nothing points at any more. Nothing records that they are one
--        agent, and nothing ever can, after the fact.
--
--     2. NAME REUSE. Retire `laptop`, hand the name to an unrelated client six
--        months later, and two agents' histories silently merge into one.
--
--     3. A TYPO. `actor_name` is free text arriving from an environment
--        variable. `labtop:write:…` invents an agent, indistinguishably from a
--        real one, and nothing anywhere notices.
--
--     4. REVOCATION AS AN EVENT. The env holds only currently-valid keys. It is
--        a configuration, not a history: nothing records that a key ever
--        existed, when it was first used, when it was last used, or that it was
--        revoked and why. Deleting the line is the whole audit trail.
--
--     5. REVOKING WITHOUT A REDEPLOY. Killing a leaked key today means editing a
--        secret and restarting the server.
--
-- Those five are what this migration buys, and the honest framing of its value:
-- not "attribution now survives rotation" but "attribution now survives a
-- rename, distinguishes reuse, and leaves a record of the credential itself".
--
--
-- Departures from schemas/per-agent-identity, each a consequence of running
-- off Supabase:
--
--   NO SECURITY DEFINER. Upstream's lookup RPC is SECURITY DEFINER so that a
--   low-privilege `service_role` can read a table it has no rights to. Here the
--   application connects as the role that OWNS these tables, so a definer
--   function grants it nothing it does not already hold — while adding the
--   search_path attack surface that makes SECURITY DEFINER worth avoiding when
--   it buys nothing. Migrations 004 and 008 set this precedent and
--   db/test-schema.ts [10] enforces it.
--
--   NO RLS, NO service_role GRANT, NO REVOKE ... FROM PUBLIC. Same reason:
--   `service_role` does not exist here, and RLS on a table only ever touched by
--   its owner never fires. A policy that never evaluates is not security, it is
--   the appearance of it.
--
--   ONE FIELD FOR REVOCATION, NOT TWO. Upstream carries `active boolean` AND
--   `revoked_at timestamptz` with a CHECK constraint keeping them consistent —
--   two columns encoding one fact, which is precisely the pair that drifts the
--   first time something updates one and not the other. `revoked_at IS NULL`
--   means active. There is nothing to keep in sync.
--
--   PREFIXED TABLE NAMES. Upstream's `openbrain_agents` becomes `ob1_agents`,
--   matching `ob1_config`. `agents` unqualified is too generic for a database
--   that may not belong exclusively to this application.
--
--   THE ENVIRONMENT STAYS THE AUTHENTICATOR. Upstream's design has the server
--   hash a presented key and ask the database whether it is valid. Doing that
--   here would give this deployment TWO sources of truth for which keys work —
--   `MCP_ACCESS_KEYS` and a table — and the failure mode of disagreement is a
--   key that authenticates against one and not the other. So `auth.ts` is
--   unchanged in what it decides: the env says whether a key is valid and what
--   it may do. This table records WHO that key belongs to, and one thing more —
--   see `revoked_at` below.
--
-- Safety
--   * Additive. `thoughts` is untouched. `thought_audit` gains one nullable
--     column; its existing rows correctly read NULL, because they predate the
--     registry and no honest value can be invented for them.
--   * Idempotent.
--
-- Prerequisites
--   Migration 008.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The agents
--
-- `label` is UNIQUE because it is the join between this table and the
-- environment: it holds the same string as the key's name in MCP_ACCESS_KEYS,
-- and auth.ts already refuses a config with two keys of the same name.
--
-- Rows here are meant to accumulate, not to be deleted. An agent that has been
-- retired keeps its row so the audit history it left behind stays joinable —
-- which is why thought_audit does not carry a foreign key to it (below).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ob1_agents (
  canonical_agent_id UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The current name. It can change; the id cannot. That is the whole point.
  label              TEXT        NOT NULL UNIQUE,

  -- Free-form, for a deployment that wants to record what an agent is.
  metadata           JSONB       NOT NULL DEFAULT '{}'::jsonb,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ob1_agents IS
  'Stable identity for each client that writes. canonical_agent_id outlives both the credential (rotation) and the name (rename); label mirrors the key name in MCP_ACCESS_KEYS. Rows are meant to accumulate — a retired agent keeps its row so its audit history stays joinable.';

DROP TRIGGER IF EXISTS ob1_agents_updated_at ON ob1_agents;
CREATE TRIGGER ob1_agents_updated_at
  BEFORE UPDATE ON ob1_agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- The credentials, by hash
--
-- Only digests. The same rule auth.ts follows: this table must not be usable as
-- a credential if it leaks. The CHECK enforces it rather than trusting callers —
-- a raw 64-character key would satisfy a length test but not a hex one, and the
-- lowercase check keeps a hash from being registered twice in two cases.
--
-- Why store hashes at all when the env authenticates? Because the hash is the
-- one thing that survives a RENAME, exactly as the name is the one thing that
-- survives a ROTATION. Holding both is what lets resolve_agent() tell the two
-- apart instead of guessing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ob1_agent_keys (
  key_hash           TEXT        PRIMARY KEY
    CHECK (key_hash ~ '^[0-9a-f]{64}$'),

  canonical_agent_id UUID        NOT NULL
    REFERENCES ob1_agents(canonical_agent_id) ON DELETE CASCADE,

  -- The scope this key was last seen presenting, from auth.ts. Recorded rather
  -- than enforced: the env decides what a key may do. A read key that starts
  -- arriving as a write key is a privilege change worth being able to see.
  scope              TEXT        CHECK (scope IN ('read', 'write')),

  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at       TIMESTAMPTZ,

  /**
   * NULL means active. One column, not `active` plus `revoked_at`.
   *
   * This is the one place the database DOES gate access, and it is deliberate:
   * revoking a key by editing MCP_ACCESS_KEYS requires changing a secret and
   * restarting the server, which is too slow for a credential you have just
   * discovered in a log. Setting revoked_at is a single UPDATE and takes effect
   * within the server's resolve cache TTL.
   *
   * It can only ever be MORE restrictive than the environment — a hash revoked
   * here is refused even though the env still accepts it, never the reverse.
   * That direction is what makes a second gate safe rather than a second source
   * of truth.
   */
  revoked_at         TIMESTAMPTZ,
  revoked_reason     TEXT,

  metadata           JSONB       NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE ob1_agent_keys IS
  'SHA-256 digests of access keys, mapped to the agent they belong to. Never raw keys. The environment remains the authenticator; revoked_at here is a kill switch that can only be more restrictive than MCP_ACCESS_KEYS, never less.';

COMMENT ON COLUMN ob1_agent_keys.revoked_at IS
  'NULL means active. Set it to refuse a key without editing MCP_ACCESS_KEYS and redeploying; takes effect within the server resolve cache TTL (OB1_AGENT_CACHE_TTL_MS, default 60s).';

CREATE INDEX IF NOT EXISTS ob1_agent_keys_agent_idx
  ON ob1_agent_keys (canonical_agent_id);

CREATE INDEX IF NOT EXISTS ob1_agent_keys_active_idx
  ON ob1_agent_keys (canonical_agent_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- thought_audit.canonical_agent_id
--
-- Alongside actor_name, not instead of it. Two reasons to keep both:
--
--   * Rows written before this migration have a name and no id. Dropping the
--     name would discard the only attribution those rows have.
--   * The name at the time of writing is itself a fact worth keeping. After a
--     rename, `actor_name` says what the agent was called then and
--     canonical_agent_id says which agent it was. A join would answer only the
--     second question.
--
-- No foreign key, for the same reason thought_id has none: an audit row must
-- outlive its subject. An agent row deleted by hand must not take history with
-- it.
--
-- ALTER TABLE on an append-only table is safe — thought_audit_immutable is a
-- ROW trigger on UPDATE/DELETE, and adding a column is neither.
-- ---------------------------------------------------------------------------
ALTER TABLE thought_audit
  ADD COLUMN IF NOT EXISTS canonical_agent_id UUID;

COMMENT ON COLUMN thought_audit.canonical_agent_id IS
  'Stable agent id from ob1_agents, via the ob1.actor transaction setting. NULL for rows written before migration 010 and for mutations made outside the server. Deliberately not a foreign key: audit outlives its subject.';

CREATE INDEX IF NOT EXISTS thought_audit_agent_idx
  ON thought_audit (canonical_agent_id, created_at DESC)
  WHERE canonical_agent_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- resolve_agent — name and hash together, so a rename and a rotation are
-- distinguishable
--
-- Called by the server once per authenticated request (cached; see agents.ts)
-- with the presented key's digest and the name the environment gave it. It
-- registers on first sight, so an existing deployment needs no admin step: the
-- registry fills itself as clients connect.
--
-- The four cases, and why each resolves the way it does:
--
--   HASH KNOWN, LABEL SAME       — the ordinary request. Touch last_used_at.
--
--   HASH KNOWN, LABEL DIFFERENT  — a RENAME. Same credential, new name in the
--                                  env. The agent is the same one, so its label
--                                  follows and its history stays attached to
--                                  the id.
--
--   HASH UNKNOWN, LABEL KNOWN    — a ROTATION. New credential for an agent we
--                                  already know. Register the hash against the
--                                  existing id.
--
--   NEITHER KNOWN                — first sight. A new agent.
--
-- The ambiguity worth stating rather than hiding: renaming AND rotating in one
-- step is indistinguishable from a new agent, and is treated as one. There is
-- no information left to join on — both identifiers changed at once. Do the two
-- separately, with one request in between, and the chain holds.
-- ---------------------------------------------------------------------------
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

  SELECT k.canonical_agent_id, k.revoked_at, k.revoked_reason, a.label
    INTO v_agent, v_revoked, v_reason, v_current
    FROM ob1_agent_keys k
    JOIN ob1_agents a USING (canonical_agent_id)
   WHERE k.key_hash = v_hash;

  IF FOUND THEN
    IF v_revoked IS NOT NULL THEN
      -- The agent id comes back with the refusal on purpose: the caller is
      -- being denied, but its history is still identified and queryable, which
      -- is the property the issue asks for.
      RETURN jsonb_build_object(
        'ok', false, 'error', 'REVOKED',
        'agent_id', v_agent, 'label', v_current,
        'revoked_at', v_revoked, 'reason', v_reason);
    END IF;

    UPDATE ob1_agent_keys
       SET last_used_at = now(),
           scope        = COALESCE(p_scope, scope)
     WHERE key_hash = v_hash;

    IF v_current IS DISTINCT FROM v_label THEN
      BEGIN
        UPDATE ob1_agents SET label = v_label WHERE canonical_agent_id = v_agent;
        v_current := v_label;
      EXCEPTION WHEN unique_violation THEN
        /**
         * Another agent already answers to that name.
         *
         * The way to reach this: one raw key registered under two names in
         * MCP_ACCESS_KEYS. Without the guard the two entries would rename the
         * same agent back and forth on alternate requests, and its label would
         * depend on whichever client spoke last. Keep the existing name and
         * report the conflict; auth.ts refuses such a config outright, so this
         * is the second line rather than the first.
         */
        v_conflict := true;
      END;
    END IF;

    RETURN jsonb_build_object(
      'ok', true, 'agent_id', v_agent, 'label', v_current,
      'created', false, 'rotated', false, 'label_conflict', v_conflict);
  END IF;

  SELECT canonical_agent_id INTO v_agent FROM ob1_agents WHERE label = v_label;

  IF FOUND THEN
    v_rotated := true;
  ELSE
    -- ON CONFLICT rather than a bare INSERT: two clients presenting an
    -- unregistered key at the same moment would otherwise race, and one would
    -- get a unique violation on a purely bookkeeping write.
    INSERT INTO ob1_agents (label) VALUES (v_label)
    ON CONFLICT (label) DO UPDATE SET updated_at = now()
    RETURNING canonical_agent_id INTO v_agent;
    v_created := true;
  END IF;

  INSERT INTO ob1_agent_keys (key_hash, canonical_agent_id, scope, last_used_at)
  VALUES (v_hash, v_agent, p_scope, now())
  ON CONFLICT (key_hash) DO UPDATE SET last_used_at = now();

  RETURN jsonb_build_object(
    'ok', true, 'agent_id', v_agent, 'label', v_label,
    'created', v_created, 'rotated', v_rotated, 'label_conflict', false);
END;
$$;

COMMENT ON FUNCTION resolve_agent(text, text, text) IS
  'Resolve a key digest + key name to a stable canonical_agent_id, registering on first sight. Distinguishes a rename (hash known, label new) from a rotation (label known, hash new); both preserve the id. Returns {ok:false, error:REVOKED} with the agent id still attached, so a refused key stays identified.';

-- ---------------------------------------------------------------------------
-- revoke_agent_key — the kill switch, as one call
--
-- A plain UPDATE would do, which is exactly why this exists: the plain UPDATE
-- that forgets `revoked_reason`, or matches an uppercase digest and silently
-- affects nothing, is the one somebody writes at 2am. Returns what it did.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION revoke_agent_key(
  p_key_hash text,
  p_reason   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_hash    text := lower(trim(COALESCE(p_key_hash, '')));
  v_agent   uuid;
  v_when    timestamptz;
  v_already boolean;
BEGIN
  SELECT revoked_at IS NOT NULL INTO v_already
    FROM ob1_agent_keys WHERE key_hash = v_hash;

  /**
   * A repeat call changes nothing at all — not the timestamp, and not the
   * reason. The first revocation is the event: it is when access actually
   * stopped and why. A later call with a different reason would overwrite the
   * record of the original one, and the second reason is invariably the vaguer
   * of the two ('again', 'cleanup') because whoever writes it already believes
   * the key is dead.
   */
  UPDATE ob1_agent_keys
     SET revoked_at     = COALESCE(revoked_at, now()),
         revoked_reason = CASE WHEN revoked_at IS NULL THEN p_reason
                               ELSE revoked_reason END
   WHERE key_hash = v_hash
  RETURNING canonical_agent_id, revoked_at INTO v_agent, v_when;

  IF v_agent IS NULL THEN
    -- Not a success. Revoking a hash that was never registered almost always
    -- means the hash was mistyped, and reporting ok would hide that at the
    -- moment it matters most.
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'agent_id', v_agent, 'revoked_at', v_when,
    -- So a caller can tell "I just revoked this" from "this was already dead".
    'already_revoked', COALESCE(v_already, false));
END;
$$;

COMMENT ON FUNCTION revoke_agent_key(text, text) IS
  'Refuse a key digest without editing MCP_ACCESS_KEYS. Idempotent: a repeat call keeps the first revocation time AND reason, and reports already_revoked. Returns {ok:false, error:NOT_FOUND} for an unregistered hash rather than reporting a revocation that did not happen.';

-- ---------------------------------------------------------------------------
-- The audit trigger, carrying the agent id
--
-- CREATE OR REPLACE takes the WHOLE body, so this is migration 008's function
-- reproduced in full with two changes. Writing it from memory instead of from
-- the file is how migration 008 briefly reverted migration 005's guard; the
-- same trap, one migration later.
--
-- The two changes:
--   * canonical_agent_id is read from the actor envelope and stored.
--   * `agent_id` is stripped from actor_context alongside name/source/session,
--     or it would be recorded twice — once in its column and once in the
--     free-form blob that exists for everything WITHOUT a column.
--
-- Everything else — the no-op guard especially — is 008's, unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thoughts_write_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor    jsonb := ob1_current_actor();
  v_action text;
  v_diff   jsonb;
  v_id     uuid;
  v_source text;
  v_agent  uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'capture';
    v_id     := NEW.id;
    v_source := NEW.metadata->>'source';
    v_diff   := jsonb_build_object('metadata', NEW.metadata);

  ELSIF TG_OP = 'UPDATE' THEN
    v_action := 'update';
    v_id     := NEW.id;
    v_source := NEW.metadata->>'source';
    -- Only what changed. Recording the whole row on every metadata touch would
    -- make the log expensive to store and tedious to read.
    v_diff := '{}'::jsonb;
    IF NEW.content IS DISTINCT FROM OLD.content THEN
      v_diff := v_diff || jsonb_build_object(
        'content', jsonb_build_object('before', OLD.content, 'after', NEW.content));
    END IF;
    IF NEW.metadata IS DISTINCT FROM OLD.metadata THEN
      v_diff := v_diff || jsonb_build_object(
        'metadata', jsonb_build_object('before', OLD.metadata, 'after', NEW.metadata));
    END IF;
    IF (NEW.embedding IS NULL) IS DISTINCT FROM (OLD.embedding IS NULL) THEN
      v_diff := v_diff || jsonb_build_object('embedding_present', NEW.embedding IS NOT NULL);
    END IF;

    /**
     * An update that changed nothing is not an event.
     *
     * The fingerprint dedup exists so a bulk re-import is idempotent, and a
     * re-capture of identical content takes the ON CONFLICT branch — moving
     * `updated_at` and nothing else. Recording that produced an audit row with
     * an empty diff per duplicate, so re-running a 10,000-thought import wrote
     * 10,000 rows saying nothing happened: unbounded growth on the exact
     * operation designed to be repeatable, and a log too noisy to read for the
     * question it exists to answer.
     *
     * `updated_at` moving on its own is bookkeeping, not history.
     */
    IF v_diff = '{}'::jsonb THEN
      RETURN NULL;
    END IF;

  ELSE  -- DELETE
    v_action := 'delete';
    v_id     := OLD.id;
    v_source := OLD.metadata->>'source';
    -- In full. The audit row has to be enough to reconstruct what was lost.
    v_diff   := jsonb_build_object(
      'previous_content',  OLD.content,
      'previous_metadata', OLD.metadata);
  END IF;

  /**
   * A malformed id must not break the mutation, for the same reason
   * ob1_current_actor() swallows unparseable JSON: audit observes, it does not
   * obstruct. A bad value is recorded as no value.
   *
   * Guarded by a pattern rather than by BEGIN … EXCEPTION, which was the first
   * version. A plpgsql block with an EXCEPTION clause establishes a savepoint
   * every time it is ENTERED, not only when it raises — so the safe-looking
   * form would have added a subtransaction to every audit row, on a trigger
   * whose measured cost is already 6% of a bulk insert.
   *
   * The pattern is the canonical hyphenated form, which is the only one this
   * server emits. A uuid written some other way Postgres would accept is read
   * as no id, which fails the same direction as an unparseable one.
   */
  v_agent := CASE
    WHEN actor->>'agent_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (actor->>'agent_id')::uuid
  END;

  INSERT INTO thought_audit (
    thought_id, action, source, actor_name, canonical_agent_id,
    author_session_id, diff, actor_context)
  VALUES (
    v_id,
    v_action,
    COALESCE(actor->>'source', v_source),
    actor->>'name',
    v_agent,
    actor->>'session',
    v_diff,
    -- NULL rather than an empty object when the actor carries nothing extra:
    -- `{}` on every row is storage and reading noise for no information.
    NULLIF(actor - 'name' - 'source' - 'session' - 'agent_id', '{}'::jsonb)
  );

  RETURN NULL;  -- AFTER trigger; the return value is ignored.
END;
$$;

-- The trigger itself is unchanged; 008 created it and CREATE OR REPLACE on the
-- function is enough. Recreating it here would be harmless but would suggest
-- the definition had changed when it has not.

-- No GRANT and no RLS. See the header.
