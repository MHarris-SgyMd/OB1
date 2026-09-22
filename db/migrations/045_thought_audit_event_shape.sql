-- =============================================================================
-- Migration 045: the event shape at the write boundary — thought_audit becomes
--                the log of record: who (from the key), the door, the ceiling on
--                the content, stance, cites, the valid window; immutable by rule
--                (SMD-1730)
-- =============================================================================
--
-- WHY
--   008 made thought_audit the one row every capture, update and delete
--   leaves, written by a trigger inside the mutating transaction, UPDATE and
--   DELETE refused by a second trigger. It says who (actor_name, 010's
--   canonical_agent_id), what changed (diff) and when. SMD-1729 makes it the
--   log the rest of the program derives its views from, and for that it lacks
--   the fields those views read, and one rule:
--
--     * WHO, as a KIND. actor_name is a string from an environment variable.
--       Nothing says whether the key belongs to the operator, to an agent, or
--       to an importer copying external text — and a read that wants "what
--       the operator said" (SMD-1726) or "how far to trust this" (SMD-1724)
--       has nothing to filter on.
--     * THE DOOR. SMD-1541 put the server a write came through in
--       actor_context.via, a JSON key in the blob 008 declares "analytical
--       only, nothing should depend on its shape". 008's own rule for
--       actor_name — promoting a column is a migration, promoting a JSON key
--       is an archaeology exercise — applies.
--     * STANCE, CITES, THE VALID WINDOW. 042's citation facet carries a stance
--       per statement and no audit trigger; nothing records what a write
--       claimed to rest on, or when the fact it states was true in the world.
--     * THE RULE. "Derived from the key, never the payload" was a sentence in
--       the epic and nothing in the schema: a payload could say anything about
--       who wrote it, and the trigger would file it.
--
-- WHAT
--   1. Eight nullable columns on thought_audit — actor_kind, trust, origin,
--      stance, cites uuid[], valid_from, valid_until, backfilled_at — with
--      CHECKs on the three enumerations and on the window, and a COMMENT each.
--      Adding a column to the append-only table is the 010 precedent: the
--      immutability trigger is a ROW trigger on UPDATE/DELETE, and ADD COLUMN
--      is neither.
--
--   2. TWO columns for the two questions, not one read two ways. actor_kind is
--      WHO HOLDS THE KEY (operator | agent | ingested); trust is THE CEILING ON
--      THE CONTENT (the same three words, ranked operator > agent > ingested).
--      The case that settles it, from SMD-1724: the operator's key handing in
--      an ingested web page is actor `operator`, trust `ingested` — one column
--      cannot say that. trust is never above the kind: undeclared, it IS the
--      kind; declared lower, the declaration stands; declared higher, it is
--      clamped to the kind and the attempt recorded on the same row
--      (actor_context.claimed). A key of unknown kind supports no claim above
--      the floor — only a declared `ingested` is kept, a lowering nobody can
--      abuse. SMD-1724 and SMD-1726 are label-and-filter work on these two.
--
--   3. THE KIND LIVES IN THE REGISTRY, AND THE FUNCTION IS THE ENFORCER.
--      ob1_agents (010) gains `kind`, set by set_agent_kind(label, kind) — an
--      upsert by label, so a key can be classified before its first request
--      (resolve_agent's "label known, hash new" branch then attaches the
--      digest). The audit trigger reads the kind by the envelope's agent_id
--      (010), or by the key's name for a writer that never resolved one (the
--      five servers of SMD-1541, the workers), and NEVER from the payload:
--      the database never sees the key, so the row the operator classified
--      is the one thing a claim can be checked against. Declined: a fourth
--      field on MCP_ACCESS_KEYS' `name:scope:sha256` — 010's rule is that the
--      environment authenticates and the table records who; a kind in the env
--      would be a claim the env does not enforce, parsed by seven byte-
--      identical auth.ts copies and every README that quotes the grammar.
--      NULL kind is honest — "nobody has classified this key" — and preflight
--      counts the rows waiting on one.
--
--   4. origin IS A SECOND COLUMN, AND source BECOMES ONE VOCABULARY. origin is
--      the door — SMD-1541's `via`, promoted from actor_context; the trigger
--      strips it from the blob as 010 strips agent_id. source keeps its name
--      and its meaning narrows to the row's OWN metadata.source: the trigger
--      no longer reads an actor's `source`. Until now the column carried three
--      vocabularies (SMD-1541's note on SMD-1730) — the main server passed
--      "mcp" (a transport), the workers passed their own names (a door), the
--      five vendored servers passed none (the row's origin) — so
--      `WHERE source = 'mcp'` found the main server's edits and missed every
--      MCP door under integrations/. Every in-repo writer now passes `via`;
--      an out-of-tree actor still sending `source` sees it land in
--      actor_context rather than having it silently interpreted.
--
--   5. THE EVENT RIDES ONE ENVELOPE KEY. `p_payload.event` on both inserting
--      upsert_thought forms; a tenth, defaulted `p_event` on update_thought
--      (032's mechanism for a new parameter, ACL captured and replayed). Shape:
--      {stance, cites, valid_from, valid_until, trust, actor_kind}, validated
--      by validate_write_event — stance one of three words; cites an array of
--      UUID strings naming thoughts that exist, canonicalised as derived_from
--      is; the window two timestamps in order; trust and actor_kind one of
--      three words; an unknown key refused so a misspelling cannot vanish. A
--      bad SHAPE is refused, as 025 refuses a bad derived_from — the write is
--      the choke point or it is an untrusted-input hole. A CLAIM the key
--      cannot support is clamped and recorded, not refused — the write is
--      legitimate, the label is not. The functions set ob1.event
--      UNCONDITIONALLY (an empty string when none), so a write in the same
--      transaction cannot inherit the previous call's event; delete_thought is
--      not redefined — a tombstone declares nothing, and the trigger reads no
--      event on DELETE — but its rows gain actor_kind, trust and origin from
--      the actor it has set since 009.
--
--   6. IMMUTABLE BY RULE. thought_audit_refuse_mutation (008) gains the one
--      lawful amendment this migration needs: under the transaction-local
--      setting ob1.audit_amend = 'backfill', an UPDATE may fill a NULL
--      actor_kind, trust or origin and stamp backfilled_at — every other
--      column byte-equal (to_jsonb(OLD) against to_jsonb(NEW) with the four
--      removed), a set value never changed, DELETE never. The trigger itself
--      knows which change is lawful, so a test can assert that an UPDATE of
--      `diff` is refused even under the setting. SMD-1723's redaction — the
--      audit rows' content replaced by a marker and a hash, with its own
--      event row — is the second named amendment and arrives with that
--      ticket; it goes in this function.
--
--   7. THE BACKFILL IS A FUNCTION. backfill_thought_audit_events(p_limit) fills
--      origin from actor_context->>'via' and actor_kind + trust from
--      ob1_agents by canonical_agent_id, else by label, stamping
--      backfilled_at — 023's shape, callable again as kinds are set. This file
--      calls it once: every row with a `via` gains its origin now; no row gains
--      a kind at apply time, because no agent has one yet. Each backfilled row
--      says so itself (backfilled_at) — that is the backfill's record; no
--      sentinel audit row is written, because an audit row names a thought.
--      preflight's `audit events` counts what still waits and names the
--      remedy.
--
--   8. NOT HERE, SAID SO. MCP tool arguments for stance, cites, the window and
--      trust: SMD-1733 (stance and cites, the grounding rule), SMD-1725 (the
--      window, the as_of read) and SMD-1724 (trust, the label) give them
--      semantics and add them; the store gains the argument with the first
--      tool. Facet events (042's comment on this ticket): a facet is a derived
--      sidecar and SMD-1731's derivations table records its lineage; the
--      event's `cites` is the record of what a WRITE claimed to rest on, 042's
--      rows the per-statement projection. Indexes on origin: no reader yet.
--
-- SCALE
--   The partition key is CHOSEN and NOT APPLIED: RANGE on created_at by month.
--   thought_audit is append-only, so a month once closed is cold and can move
--   to cheaper storage without a rewrite; the table's COMMENT says so.
--   SMD-1697's hundred-million bench is the measurement that decides when.
--   Two partial indexes (actor_kind, trust) for the reads SMD-1724/1726 build;
--   the trigger's cost gains one primary-key lookup on ob1_agents per row.
--
-- SAFETY
--   Additive: thoughts is untouched; thought_audit and ob1_agents gain nullable
--   columns behind IF NOT EXISTS; CHECKs are added once (pg_constraint guarded);
--   every function is CREATE OR REPLACE; update_thought's 9-argument form is
--   dropped and its ACL replayed onto the 10-argument one (032/033). Existing
--   rows read NULL in every new column until the backfill can derive a value.
--   Idempotent: a second run adds nothing, the backfill finds nothing.
--   MINOR under FORK.md's version rules: an added, defaulted parameter keeps
--   every 9-argument call resolving; no column is renamed or dropped.
--
-- Prerequisites
--   008 (thought_audit), 010 (ob1_agents), 025 (the trigger body carried),
--   033 (update_thought's body), 035 (upsert_thought's bodies), 042
--   (delete_thought is the current definer; not redefined). Applied by
--   `bun db/migrate.ts`.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The columns
-- ---------------------------------------------------------------------------
ALTER TABLE thought_audit
  ADD COLUMN IF NOT EXISTS actor_kind    TEXT,
  ADD COLUMN IF NOT EXISTS trust         TEXT,
  ADD COLUMN IF NOT EXISTS origin        TEXT,
  ADD COLUMN IF NOT EXISTS stance        TEXT,
  ADD COLUMN IF NOT EXISTS cites         UUID[],
  ADD COLUMN IF NOT EXISTS valid_from    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS valid_until   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS backfilled_at TIMESTAMPTZ;

ALTER TABLE ob1_agents
  ADD COLUMN IF NOT EXISTS kind TEXT;

-- The CHECKs, added once: ADD CONSTRAINT has no IF NOT EXISTS, so pg_constraint
-- is asked first (test-schema [2] re-applies every file and expects a no-op).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thought_audit_actor_kind_check') THEN
    ALTER TABLE thought_audit ADD CONSTRAINT thought_audit_actor_kind_check
      CHECK (actor_kind IS NULL OR actor_kind IN ('operator', 'agent', 'ingested'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thought_audit_trust_check') THEN
    ALTER TABLE thought_audit ADD CONSTRAINT thought_audit_trust_check
      CHECK (trust IS NULL OR trust IN ('operator', 'agent', 'ingested'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thought_audit_stance_check') THEN
    ALTER TABLE thought_audit ADD CONSTRAINT thought_audit_stance_check
      CHECK (stance IS NULL OR stance IN ('stated', 'retrieved', 'inferred'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thought_audit_valid_window_check') THEN
    ALTER TABLE thought_audit ADD CONSTRAINT thought_audit_valid_window_check
      CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from <= valid_until);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ob1_agents_kind_check') THEN
    ALTER TABLE ob1_agents ADD CONSTRAINT ob1_agents_kind_check
      CHECK (kind IS NULL OR kind IN ('operator', 'agent', 'ingested'));
  END IF;
END
$$;

COMMENT ON COLUMN thought_audit.actor_kind IS
  'Who holds the key that made the write: operator | agent | ingested (an importer copying external text). From ob1_agents.kind by the envelope''s agent_id (010), else by the key''s name — never from the payload. NULL: a key nobody has classified (set_agent_kind), or a mutation made outside the server. Migration 045 / SMD-1730.';
COMMENT ON COLUMN thought_audit.trust IS
  'The ceiling on the content, never above actor_kind (operator > agent > ingested): the kind itself when undeclared, the declaration when it is lower, the kind when the declaration was higher — with the attempt in actor_context.claimed. NULL when the kind is unknown, unless the write declared ingested. Migration 045 / SMD-1730.';
COMMENT ON COLUMN thought_audit.origin IS
  'The door the write came through — the server, integration or worker that made the call (the envelope''s via), promoted from actor_context by 045. Distinct from source, which is the row''s own metadata.source. NULL for a caller that names no door. Migration 045 / SMD-1730.';
COMMENT ON COLUMN thought_audit.source IS
  'The row''s own metadata.source at mutation time — what the client declared the content''s origin to be. Since 045 nothing else: the trigger no longer reads an actor''s source (which the main server set to "mcp" and the workers to their own names). The door is `origin`.';
COMMENT ON COLUMN thought_audit.stance IS
  'What kind of statement the write made — stated | retrieved | inferred (042''s words) — as the call declared it in the event. NULL: undeclared, or a row from before 045. Migration 045 / SMD-1730.';
COMMENT ON COLUMN thought_audit.cites IS
  'The thoughts the write claimed to rest on, as the event declared them — each one existed when the write ran; lowercased, de-duplicated, sorted. The record; 042''s citation facets are the per-statement projection. Migration 045 / SMD-1730.';
COMMENT ON COLUMN thought_audit.valid_from IS
  'When the fact the write states began to hold in the world, as the event declared it. NULL means unknown, and a read says unknown. Migration 045 / SMD-1730.';
COMMENT ON COLUMN thought_audit.valid_until IS
  'When the fact the write states stopped holding, as the event declared it; never before valid_from. NULL means unknown, and a read says unknown. Migration 045 / SMD-1730.';
COMMENT ON COLUMN thought_audit.backfilled_at IS
  'NULL when actor_kind, trust and origin were set by the write itself. Otherwise when backfill_thought_audit_events derived them after the fact — origin from actor_context.via, kind and trust from ob1_agents — the one amendment thought_audit_immutable allows. Migration 045 / SMD-1730.';
COMMENT ON COLUMN ob1_agents.kind IS
  'Who holds this key: operator | agent | ingested. Set by set_agent_kind(label, kind); the audit trigger reads it for actor_kind and as the ceiling on trust. NULL: unclassified — every write through the key is audited with an unknown kind until it is. Migration 045 / SMD-1730.';

COMMENT ON TABLE thought_audit IS
  'Append-only log of every capture/update/delete on thoughts, and since 045 the log of record SMD-1729''s views derive from: who (actor_name, canonical_agent_id, actor_kind from the key), the door (origin), the ceiling on the content (trust), what changed (diff), what the write claimed (stance, cites, valid_from/valid_until) and when (created_at). Written by a trigger inside the mutating transaction, so an event cannot be lost independently of the change it describes. thought_id is deliberately not a foreign key so audit rows outlive their subject. UPDATE and DELETE are refused by trigger, not by grant; the one lawful amendment fills a NULL actor_kind/trust/origin and stamps backfilled_at. Partition key chosen and not applied (SMD-1730): RANGE on created_at by month — append-only, so a closed month is cold; SMD-1697''s bench decides when.';

CREATE INDEX IF NOT EXISTS thought_audit_actor_kind_idx
  ON thought_audit (actor_kind, created_at DESC)
  WHERE actor_kind IS NOT NULL;

CREATE INDEX IF NOT EXISTS thought_audit_trust_idx
  ON thought_audit (trust, created_at DESC)
  WHERE trust IS NOT NULL;

-- ---------------------------------------------------------------------------
-- set_agent_kind — the operator classifies a key, by the name the env gives it
--
-- An upsert by label: a key can be classified BEFORE its first request, and
-- resolve_agent (010) then meets a known label with an unknown hash — its
-- rotation branch — and attaches the digest to this row. Returns what it did,
-- and the kind it replaced, so a reclassification is visible to the caller.
-- Rows written before the change keep the kind they were stamped with: the
-- audit row records what was known when the write ran.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_agent_kind(
  p_label text,
  p_kind  text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_label   text := trim(COALESCE(p_label, ''));
  v_agent   uuid;
  v_created boolean;
  v_before  text;
BEGIN
  IF v_label = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_LABEL');
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('operator', 'agent', 'ingested') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_KIND',
                              'detail', 'kind is operator, agent or ingested');
  END IF;

  SELECT kind INTO v_before FROM ob1_agents WHERE label = v_label;

  -- `xmax = 0` is true only for a row this statement INSERTed (010's rule).
  INSERT INTO ob1_agents (label, kind) VALUES (v_label, p_kind)
  ON CONFLICT (label) DO UPDATE SET kind = EXCLUDED.kind, updated_at = now()
  RETURNING canonical_agent_id, (xmax = 0) INTO v_agent, v_created;

  RETURN jsonb_build_object(
    'ok', true, 'agent_id', v_agent, 'label', v_label, 'kind', p_kind,
    'created', v_created, 'previous_kind', v_before);
END;
$$;

COMMENT ON FUNCTION set_agent_kind(text, text) IS
  'Classify the key named label as operator, agent or ingested — the value the audit trigger stamps as actor_kind and uses as the ceiling on trust. Upserts the ob1_agents row by label, so a key can be classified before its first request. Returns {ok, agent_id, label, kind, created, previous_kind}, or {ok:false, error: BAD_LABEL | BAD_KIND}. Migration 045 / SMD-1730.';

-- ---------------------------------------------------------------------------
-- validate_write_event — the one copy of the event's shape rule
--
-- Both inserting upsert_thought forms and update_thought call it. NULL and
-- JSON null come back NULL; an object comes back normalised — stance, trust
-- and actor_kind as their words; cites lowercased, de-duplicated and sorted
-- (validate_derived_from's canon, 025/032); the window as timestamptz text —
-- or one of its exceptions. A key the shape does not have is refused so a
-- misspelling cannot vanish. Existence of every cite is checked here, not by
-- the trigger: the write is the choke point (025, departure 3).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION validate_write_event(p_event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v        jsonb := p_event;
  v_out    jsonb := '{}'::jsonb;
  v_key    text;
  v_from   timestamptz;
  v_until  timestamptz;
  v_cites  jsonb;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(v) <> 'object' THEN
    RAISE EXCEPTION
      'event must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(v);
  END IF;

  SELECT string_agg(k, ', ' ORDER BY k) INTO v_key
    FROM jsonb_object_keys(v) AS k
   WHERE k NOT IN ('stance', 'cites', 'valid_from', 'valid_until', 'trust', 'actor_kind');
  IF v_key IS NOT NULL THEN
    RAISE EXCEPTION
      'event carries a key the shape does not have: % — the keys are stance, cites, valid_from, valid_until, trust, actor_kind.',
      v_key;
  END IF;

  IF v ? 'stance' AND jsonb_typeof(v->'stance') <> 'null' THEN
    IF jsonb_typeof(v->'stance') <> 'string' OR (v->>'stance') NOT IN ('stated', 'retrieved', 'inferred') THEN
      RAISE EXCEPTION 'event.stance must be stated, retrieved or inferred, got %.', v->'stance';
    END IF;
    v_out := v_out || jsonb_build_object('stance', v->>'stance');
  END IF;

  FOREACH v_key IN ARRAY ARRAY['trust', 'actor_kind'] LOOP
    IF v ? v_key AND jsonb_typeof(v->v_key) <> 'null' THEN
      IF jsonb_typeof(v->v_key) <> 'string' OR (v->>v_key) NOT IN ('operator', 'agent', 'ingested') THEN
        RAISE EXCEPTION 'event.% must be operator, agent or ingested, got %.', v_key, v->v_key;
      END IF;
      v_out := v_out || jsonb_build_object(v_key, v->>v_key);
    END IF;
  END LOOP;

  IF v ? 'cites' AND jsonb_typeof(v->'cites') <> 'null' THEN
    -- One rule, one copy: derived_from's (032's validate_derived_from) — a JSON
    -- array of UUID strings naming thoughts that exist, lowercased,
    -- de-duplicated, sorted; [] and JSON null are NULL. Its refusals name
    -- derived_from, so they are re-raised naming the event's field. A
    -- subtransaction, entered only when cites are named (first review pass:
    -- the first draft carried a second copy of the rule).
    BEGIN
      v_cites := validate_derived_from(v->'cites');
    EXCEPTION WHEN others THEN
      -- The rule's message echoes the input; bounded here, since a client
      -- can send a long one (run-it: a 100,000-character cite came back whole).
      RAISE EXCEPTION '%', left(replace(SQLERRM, 'derived_from', 'event.cites'), 500)
        || CASE WHEN length(SQLERRM) > 500 THEN '…' ELSE '' END;
    END;
    IF v_cites IS NOT NULL THEN
      v_out := v_out || jsonb_build_object('cites', v_cites);
    END IF;
  END IF;

  IF (v ? 'valid_from' AND jsonb_typeof(v->'valid_from') <> 'null')
     OR (v ? 'valid_until' AND jsonb_typeof(v->'valid_until') <> 'null') THEN
    -- A timestamp is a string that begins as a date does — YYYY-MM-DD — before
    -- Postgres is asked to read it: its input function also takes 'now',
    -- 'today', 'yesterday' and 'infinity', and a client's "now" would land as
    -- the call's time and read as a fact about the world (run-it, first
    -- review pass). Then a subtransaction, entered only when a window is
    -- named, so a text that is not a timestamp fails with a message about the
    -- event, not a raw cast.
    FOREACH v_key IN ARRAY ARRAY['valid_from', 'valid_until'] LOOP
      IF v ? v_key AND jsonb_typeof(v->v_key) <> 'null'
         AND (jsonb_typeof(v->v_key) <> 'string' OR (v->>v_key) !~ '^\d{4}-\d{2}-\d{2}') THEN
        RAISE EXCEPTION 'event.% must be a timestamp string beginning YYYY-MM-DD, got %.', v_key, left((v->v_key)::text, 80);
      END IF;
    END LOOP;
    BEGIN
      IF v ? 'valid_from' AND jsonb_typeof(v->'valid_from') <> 'null' THEN
        v_from := (v->>'valid_from')::timestamptz;
      END IF;
      IF v ? 'valid_until' AND jsonb_typeof(v->'valid_until') <> 'null' THEN
        v_until := (v->>'valid_until')::timestamptz;
      END IF;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'event.valid_from / valid_until must be timestamps, got % / %.', v->'valid_from', v->'valid_until';
    END;
    IF v_from IS NOT NULL AND v_until IS NOT NULL AND v_from > v_until THEN
      RAISE EXCEPTION 'event.valid_from (%) is after valid_until (%).', v_from, v_until;
    END IF;
    IF v_from IS NOT NULL THEN
      v_out := v_out || jsonb_build_object('valid_from', v_from);
    END IF;
    IF v_until IS NOT NULL THEN
      v_out := v_out || jsonb_build_object('valid_until', v_until);
    END IF;
  END IF;

  RETURN NULLIF(v_out, '{}'::jsonb);
END;
$$;

COMMENT ON FUNCTION validate_write_event(jsonb) IS
  'The write event''s shape rule (045): NULL and JSON null are NULL; otherwise an object with only stance (stated|retrieved|inferred), cites (UUID strings naming existing thoughts — lowercased, de-duplicated, sorted), valid_from / valid_until (timestamps, in order), trust and actor_kind (operator|agent|ingested — claims the audit trigger checks against the key), returned normalised, or an exception. Called by upsert_thought (both inserting forms) and update_thought. Migration 045 / SMD-1730.';

-- ---------------------------------------------------------------------------
-- The event, carried on the transaction beside the actor — 008's mechanism,
-- a second setting, so the actor envelope and the event stay two things.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_current_event()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  raw text := current_setting('ob1.event', true);
BEGIN
  IF raw IS NULL OR raw = '' THEN
    RETURN NULL;
  END IF;
  RETURN raw::jsonb;
EXCEPTION WHEN others THEN
  -- As ob1_current_actor: a malformed setting must not break a write. The
  -- functions set a validated value or an empty string, so this arm is for a
  -- hand-set value only.
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION ob1_current_event() IS
  'Reads the ob1.event transaction-local setting as jsonb — the write event validate_write_event normalised: {stance, cites, valid_from, valid_until, trust, actor_kind}. NULL when unset, empty or malformed, so audit never blocks a mutation. Migration 045 / SMD-1730.';

-- ---------------------------------------------------------------------------
-- Immutable by rule: 008's refusal, with the one lawful amendment
--
-- The trigger knows which change is lawful, so nothing outside it — no grant,
-- no DISABLE TRIGGER in a script — has to. Under ob1.audit_amend = 'backfill'
-- an UPDATE may fill a NULL actor_kind, trust or origin and stamp
-- backfilled_at — and ONLY with what the row itself derives to: the kind the
-- registry holds for the row's id (else its name), the door the row's own blob
-- carries as `via`, the trust the write path's rule gives (the declaration the
-- trigger filed under `claimed` when it stands under the kind, else the kind),
-- the stamp this transaction's time; something must be filled; every other
-- column byte-equal; a value once set never changed; DELETE and TRUNCATE
-- never. So a hand UPDATE under the setting can write nothing the backfill
-- would not (first review pass, run-it: the first gate let a door be invented,
-- a stamp back-dated, and a row re-stamped with nothing filled). The setting
-- is a key any role that can write the table may turn — the rule is WHAT may
-- change, not who. SMD-1723's redaction is the second amendment and goes here
-- with its ticket.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thought_audit_refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_kind     text;
  v_known    boolean := false;
  v_declared text;
  v_origin   text;
  v_trust    text;
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('ob1.audit_amend', true) = 'backfill' THEN
    -- ob1:audit-amend-fills-null-only — a CONTRACT SENTINEL, not prose (the
    -- 014 convention); preflight's `audit events` check reads it.
    -- What the row derives to, as the audit trigger and the backfill read it.
    IF OLD.canonical_agent_id IS NOT NULL THEN
      SELECT kind INTO v_kind FROM ob1_agents WHERE canonical_agent_id = OLD.canonical_agent_id;
      v_known := FOUND;
    END IF;
    IF NOT v_known AND OLD.actor_name IS NOT NULL THEN
      SELECT kind INTO v_kind FROM ob1_agents WHERE label = OLD.actor_name;
    END IF;
    v_kind     := COALESCE(OLD.actor_kind, v_kind);
    v_origin   := COALESCE(OLD.origin, CASE WHEN jsonb_typeof(OLD.actor_context->'via') = 'string' THEN OLD.actor_context->>'via' END);
    v_declared := OLD.actor_context->'claimed'->>'trust';
    v_trust    := COALESCE(OLD.trust, CASE WHEN v_kind IS NULL THEN NULL
                    WHEN v_declared IS NOT NULL
                         AND array_position(ARRAY['ingested', 'agent', 'operator'], v_declared)
                             <= array_position(ARRAY['ingested', 'agent', 'operator'], v_kind) THEN v_declared
                    ELSE v_kind END);
    IF (to_jsonb(OLD) - 'actor_kind' - 'trust' - 'origin' - 'backfilled_at')
       = (to_jsonb(NEW) - 'actor_kind' - 'trust' - 'origin' - 'backfilled_at')
       AND NEW.actor_kind IS NOT DISTINCT FROM v_kind
       AND NEW.trust      IS NOT DISTINCT FROM v_trust
       AND NEW.origin     IS NOT DISTINCT FROM v_origin
       AND (NEW.actor_kind IS DISTINCT FROM OLD.actor_kind
            OR NEW.trust IS DISTINCT FROM OLD.trust
            OR NEW.origin IS DISTINCT FROM OLD.origin)
       AND NEW.backfilled_at = now() THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'thought_audit is append-only: the backfill amendment may only fill a NULL actor_kind, trust or origin with what the row derives to (the registry''s kind for its key, the blob''s via, the rule''s trust) and stamp backfilled_at with now(); this UPDATE changes something else, or fills nothing.';
  END IF;

  -- 008: the guidance is in the MESSAGE rather than in USING HINT deliberately.
  -- Bun's Postgres client returns the HINT field as UTF-16 bytes with
  -- interleaved nulls, so anything put there is unreadable to the runtime this
  -- server actually uses.
  RAISE EXCEPTION
    'thought_audit is append-only: % is not permitted. To prune history, DROP TRIGGER thought_audit_immutable in a migration — deliberately, and with a record of why.',
    TG_OP;
END;
$$;

-- TRUNCATE fires no row trigger, so 008's rule had a door it did not mean to
-- leave (first review pass, run-it): the same function, as a statement trigger.
DROP TRIGGER IF EXISTS thought_audit_immutable_truncate ON thought_audit;
CREATE TRIGGER thought_audit_immutable_truncate
  BEFORE TRUNCATE ON thought_audit
  FOR EACH STATEMENT EXECUTE FUNCTION thought_audit_refuse_mutation();

-- ---------------------------------------------------------------------------
-- The audit trigger: 025's body with the event and the key-derived columns.
-- CREATE OR REPLACE takes the WHOLE body, so 025's — 010's id parsing, 025's
-- provenance diff, 008's no-op guard — is lifted from 025's file by script and
-- extended, not retyped (010's trap, stated there and in 025). The trigger
-- itself (008's `thoughts_audit`) is not recreated.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thoughts_write_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor    jsonb := ob1_current_actor();
  -- 045: the write event the function set beside the actor — stance, cites,
  -- the valid window, and the caller's DECLARED trust and actor_kind, which
  -- are checked against the key below and never copied. Read below, once.
  event    jsonb;
  v_action text;
  v_diff   jsonb;
  v_id     uuid;
  v_source text;
  v_agent  uuid;
  -- 045: who holds the key (the registry's word), whether the registry knew
  -- the id at all, the ceiling on the content, what the caller claimed that
  -- the key could not support, and the context blob with that claim folded in.
  v_kind     text;
  v_known    boolean := false;
  v_declared text;
  v_trust    text;
  v_claimed  jsonb := '{}'::jsonb;
  v_context  jsonb;
BEGIN
  /**
   * 045: the event is read ONCE and the setting cleared — so a raw write later
   * in the same transaction (an enhanced-columns UPDATE beside a capture), or
   * the child rows a tombstone's ON DELETE SET NULL touches, cannot inherit a
   * stance, cites or window declared for another row. A tombstone declares
   * nothing: on DELETE the event is not read at all — delete_thought sets
   * none, and one a previous call left on this transaction is not its own
   * (first review pass). The actor is 008's and stays as it was.
   */
  event := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE ob1_current_event() END;
  PERFORM set_config('ob1.event', '', true);

  IF TG_OP = 'INSERT' THEN
    v_action := 'capture';
    v_id     := NEW.id;
    v_source := NEW.metadata->>'source';
    v_diff   := jsonb_build_object('metadata', NEW.metadata);
    -- 025: a captured derivation is part of what the row was created with.
    IF NEW.derived_from IS NOT NULL THEN
      v_diff := v_diff || jsonb_build_object('derived_from', NEW.derived_from);
    END IF;
    IF NEW.supersedes IS NOT NULL THEN
      v_diff := v_diff || jsonb_build_object('supersedes', NEW.supersedes);
    END IF;

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
    -- 025: provenance is history too. The one that matters most is `supersedes`
    -- going NULL when a superseded parent is deleted — a change the old diff
    -- could not see, so the pointer vanished with no record. Now it is an event.
    IF NEW.supersedes IS DISTINCT FROM OLD.supersedes THEN
      v_diff := v_diff || jsonb_build_object(
        'supersedes', jsonb_build_object('before', OLD.supersedes, 'after', NEW.supersedes));
    END IF;
    IF NEW.derived_from IS DISTINCT FROM OLD.derived_from THEN
      v_diff := v_diff || jsonb_build_object(
        'derived_from', jsonb_build_object('before', OLD.derived_from, 'after', NEW.derived_from));
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
    -- In full. The audit row has to be enough to reconstruct what was lost —
    -- 025 adds the prior provenance to that record.
    v_diff   := jsonb_build_object(
      'previous_content',     OLD.content,
      'previous_metadata',    OLD.metadata,
      'previous_derived_from', OLD.derived_from,
      'previous_supersedes',   OLD.supersedes);
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

  /**
   * ob1:audit-event-from-the-key — a CONTRACT SENTINEL, not prose (the 014
   * convention); preflight's `audit events` check reads it.
   *
   * 045: actor_kind is the REGISTRY's word for who holds the key —
   * ob1_agents.kind, by the id the envelope carries (010) or, for a writer that
   * never resolved one, by the key's name (the label 010 keeps equal to it).
   * The payload's own `actor_kind` is never copied: the database never sees
   * the key, so the one thing it can check a claim against is the row the
   * operator classified. NULL is honest: a key nobody has classified yet
   * (set_agent_kind), or a mutation from outside the server. An id the
   * registry does not know — a server holding a cached id across a registry
   * rebuilt by hand — falls back to the name as a writer with no id does
   * (first review pass): the row is the same row either way.
   */
  IF v_agent IS NOT NULL THEN
    SELECT kind INTO v_kind FROM ob1_agents WHERE canonical_agent_id = v_agent;
    v_known := FOUND;
  END IF;
  IF NOT v_known AND actor ? 'name' THEN
    SELECT kind INTO v_kind FROM ob1_agents WHERE label = actor->>'name';
  END IF;

  /**
   * trust is the CEILING on the content, and the key's kind is the highest it
   * can be: an operator's key may hand in an ingested page (the settling case
   * — actor operator, trust ingested), an agent's key may not hand in
   * operator-typed text. Undeclared, trust is the kind itself. A key of
   * unknown kind can support no claim above the floor, so only `ingested` — a
   * lowering nobody can abuse — is kept from its declaration. A declared
   * value the key cannot support is clamped, not refused: the write is
   * legitimate, the label is not, and the row records both.
   */
  v_declared := event->>'trust';
  v_trust := CASE
    WHEN v_kind IS NULL THEN CASE WHEN v_declared = 'ingested' THEN 'ingested' END
    WHEN v_declared IS NULL THEN v_kind
    WHEN array_position(ARRAY['ingested', 'agent', 'operator'], v_declared)
         <= array_position(ARRAY['ingested', 'agent', 'operator'], v_kind) THEN v_declared
    ELSE v_kind
  END;
  IF v_declared IS NOT NULL AND v_declared IS DISTINCT FROM v_trust THEN
    v_claimed := v_claimed || jsonb_build_object('trust', v_declared);
  END IF;
  IF event->>'actor_kind' IS NOT NULL AND (event->>'actor_kind') IS DISTINCT FROM v_kind THEN
    v_claimed := v_claimed || jsonb_build_object('actor_kind', event->>'actor_kind');
  END IF;

  -- The free-form remainder: everything the envelope carried that has no
  -- column. `via` joins the strip list (it is the origin column now); `source`
  -- LEAVES it — the trigger no longer reads an actor's source (the column is
  -- the row's own metadata.source, one vocabulary), so a caller still sending
  -- one sees it here rather than having it silently interpreted. The attempt
  -- the key could not support rides under `claimed`.
  v_context := COALESCE(actor - 'name' - 'session' - 'agent_id', '{}'::jsonb);
  -- `via` is a door only as a string; anything else stays in the blob, visible,
  -- rather than becoming an origin spelled as JSON (run-it, first review pass).
  IF jsonb_typeof(actor->'via') = 'string' THEN
    v_context := v_context - 'via';
  END IF;
  IF v_claimed <> '{}'::jsonb THEN
    -- Merged under `claimed`, not written over a key the caller sent by that
    -- name (run-it, first review pass); a non-object of theirs moves under
    -- `caller`.
    v_context := v_context || jsonb_build_object('claimed',
      CASE WHEN jsonb_typeof(v_context->'claimed') = 'object' THEN (v_context->'claimed') || v_claimed
           WHEN v_context ? 'claimed' THEN jsonb_build_object('caller', v_context->'claimed') || v_claimed
           ELSE v_claimed END);
  END IF;

  INSERT INTO thought_audit (
    thought_id, action, source, actor_name, canonical_agent_id,
    author_session_id, diff, actor_context,
    actor_kind, trust, origin, stance, cites, valid_from, valid_until)
  VALUES (
    v_id,
    v_action,
    -- 045: the row's own metadata.source, and nothing else — see the header.
    v_source,
    actor->>'name',
    v_agent,
    actor->>'session',
    v_diff,
    -- NULL rather than an empty object when the actor carries nothing extra:
    -- `{}` on every row is storage and reading noise for no information.
    NULLIF(v_context, '{}'::jsonb),
    v_kind,
    v_trust,
    CASE WHEN jsonb_typeof(actor->'via') = 'string' THEN actor->>'via' END,
    -- NULL throughout on a tombstone: the event was not read (above).
    event->>'stance',
    CASE WHEN event ? 'cites' THEN ARRAY(SELECT jsonb_array_elements_text(event->'cites'))::uuid[] END,
    (event->>'valid_from')::timestamptz,
    (event->>'valid_until')::timestamptz
  );

  RETURN NULL;  -- AFTER trigger; the return value is ignored.
END;
$$;

-- ---------------------------------------------------------------------------
-- The two inserting upsert_thought forms: 035's bodies, each with one call
-- more — the event validated and set beside the actor. 013's 4-argument form
-- delegates to the 3-argument body and is not redefined. Lifted from 035's
-- file by script, not retyped (010's trap).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_thought(p_content text, p_payload jsonb DEFAULT '{}')
RETURNS jsonb AS $$
DECLARE
  v_fingerprint text;
  v_id          uuid;
BEGIN
  -- 005's guard, carried forward verbatim.
  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_payload);
  END IF;

  -- 008's actor, as the 3-argument form has read it since then (033): the
  -- audit trigger attributes a capture through PostgREST's two-step fallback,
  -- the one caller of this form, instead of recording NULL. Transaction-local.
  IF p_payload ? 'actor' THEN
    PERFORM set_config('ob1.actor', p_payload->>'actor', true);
  END IF;

  -- 045: the write event — validated (a bad shape is refused, as derived_from
  -- is) and set beside the actor for the audit trigger. UNCONDITIONALLY, an
  -- empty string when the envelope names none, so a write in the same
  -- transaction cannot inherit the previous call's event; the actor above is
  -- set only when present, as 008 wrote it.
  PERFORM set_config('ob1.event', COALESCE(validate_write_event(p_payload->'event')::text, ''), true);

  v_fingerprint := content_fingerprint_of(p_content);

  -- ob1:capture-takes-fingerprint-lock — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `atomic capture` reads it. 033: the lock 018
  -- takes for an edit that would take this key, spelled the same, taken
  -- before the INSERT so a capture and an edit of one text are serialised
  -- and the second sees the first's committed row (READ COMMITTED).
  PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));

  INSERT INTO thoughts (content, content_fingerprint, metadata)
  VALUES (p_content, v_fingerprint, COALESCE(p_payload->'metadata', '{}'::jsonb))
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
  SET updated_at = now(),
      metadata   = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION upsert_thought(text, jsonb) IS
  'Capture without a vector: content + metadata, merged into the row holding the same normalised text. Reads p_payload.actor (008, here since 033) for the audit trigger. Takes the fingerprint advisory lock before the write (033), the one update_thought takes, so a capture and an edit of one text are serialised (READ COMMITTED). Refuses a non-object payload (005). Reads no provenance from the envelope. Called by PostgREST clients by name and the two-step capture fallback; the servers capture through the 3- and 4-argument forms. Reads p_payload.event (045) — {stance, cites, valid_from, valid_until, trust, actor_kind} — validated by validate_write_event and set on ob1.event for the trigger, an empty setting when absent. Body otherwise 033''s; 045 is the last definer.';

CREATE OR REPLACE FUNCTION upsert_thought(
  p_content   text,
  p_payload   jsonb,
  p_embedding vector({{EMBEDDING_DIM}})
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_fingerprint text;
  v_id          uuid;
  -- 022: whether a row was there to lock, and the model its vector — and so
  -- its windows — was labelled with before this write (NULL: unknown). 035:
  -- read for every capture, so `existed` in the return is always right.
  v_existed     boolean := false;
  v_old_label   text;
  -- 035: the row's pointer after the write — the fresh row's, or the one the
  -- existing row keeps — returned so a caller told `existed` can say what
  -- stands instead of guessing.
  v_supersedes_now uuid;
  -- 025: the provenance the envelope carries, if any — written on a fresh
  -- row only (035).
  v_derived     jsonb;
  v_supersedes  text  := p_payload->>'supersedes';
BEGIN
  /**
   * Migration 005's guard, carried forward verbatim.
   *
   * This is the trap in redefining a function from a later migration: CREATE OR
   * REPLACE takes the whole body, so every change made to it in between is
   * silently reverted. Writing 008 without the check dropped 005's validation
   * and db/test-schema.ts caught it immediately — which is the only reason it
   * is here. Anything that redefines upsert_thought again must carry this,
   * and the audit setting below, forward too.
   */
  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_payload);
  END IF;

  -- 025: derived_from is validated HERE — the write is the choke point, or an
  -- untrusted-input hole (SMD-1253, departure 3). 033: through 032's
  -- validate_derived_from, the one copy of the rule — NULL, JSON null and []
  -- come back NULL; otherwise an array of UUID strings naming thoughts that
  -- exist, canonicalised, or one of its three exceptions. 035: validated
  -- before the write is known to be a dedup, so a bad reference is refused
  -- whether or not the text is new.
  v_derived := validate_derived_from(p_payload->'derived_from');

  -- 025: supersedes existence is the self-FK's job; check only its SHAPE here,
  -- so a bad string fails with a message about supersedes rather than a raw
  -- uuid cast error, and the FK reports a missing target.
  IF v_supersedes IS NOT NULL
     AND v_supersedes !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION
      'upsert_thought: supersedes must be a thought UUID string, got %.', v_supersedes;
  END IF;

  -- Transaction-local, so it cannot outlive this call on a pooled connection.
  -- Set before the INSERT so the AFTER trigger sees it.
  IF p_payload ? 'actor' THEN
    PERFORM set_config('ob1.actor', p_payload->>'actor', true);
  END IF;

  -- 045: the write event — validated (a bad shape is refused, as derived_from
  -- is) and set beside the actor for the audit trigger. UNCONDITIONALLY, an
  -- empty string when the envelope names none, so a write in the same
  -- transaction cannot inherit the previous call's event; the actor above is
  -- set only when present, as 008 wrote it.
  PERFORM set_config('ob1.event', COALESCE(validate_write_event(p_payload->'event')::text, ''), true);

  v_fingerprint := content_fingerprint_of(p_content);

  -- 035: no supersession lock here. 033 took it first when the envelope named
  -- supersedes, to order the ON CONFLICT fill of a NULL pointer against
  -- update_thought's cycle walk; the fill is gone, and the pointer a fresh
  -- row writes is one no concurrent walk can reach (see the header).

  -- ob1:capture-takes-fingerprint-lock — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `atomic capture` reads it. 033: the lock 018
  -- takes for an edit that would take this key, spelled the same. Taken
  -- BEFORE the row read, so a concurrent writer of this text — an edit
  -- taking the key, a first capture racing this one, an edit moving another
  -- row onto it — has committed before the read runs and the read finds its
  -- row (READ COMMITTED: a fresh snapshot per statement); without it those
  -- three found no row, and a re-capture's windows were left as they were.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));

  -- 022: the row this capture lands on, if any, locked — so the INSERT below
  -- lands on THIS row, not on one a concurrent writer commits meanwhile — and
  -- its label before the write, which says whether its windows still hold.
  -- FOR NO KEY UPDATE: ordered against update_thought's row lock, not
  -- against the FOR KEY SHARE every foreign key onto this row holds. 035:
  -- for every capture, not only one with a vector — `existed` below.
  SELECT embedding_model INTO v_old_label
    FROM thoughts WHERE content_fingerprint = v_fingerprint FOR NO KEY UPDATE;
  v_existed := FOUND;

  -- 021: the label is written beside the vector, from the envelope; NULL when
  -- the caller named none (an older server), which is a vector of unknown model.
  -- 025: derived_from and supersedes are written beside them, validated above
  -- — on a fresh row (035).
  INSERT INTO thoughts (content, content_fingerprint, metadata, embedding, embedding_model, derived_from, supersedes)
  VALUES (
    p_content,
    v_fingerprint,
    COALESCE(p_payload->'metadata', '{}'::jsonb),
    p_embedding,
    CASE WHEN p_embedding IS NULL THEN NULL ELSE p_payload->>'embedding_model' END,
    v_derived,
    v_supersedes::uuid
  )
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
    SET updated_at = now(),
        metadata   = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
        embedding  = COALESCE(EXCLUDED.embedding, thoughts.embedding),
        -- The label follows the vector (021): kept with a kept vector, the
        -- caller's with a new one — NULL if the caller named none.
        embedding_model = CASE WHEN EXCLUDED.embedding IS NULL THEN thoughts.embedding_model
                               ELSE EXCLUDED.embedding_model END
        -- ob1:re-capture-writes-no-provenance — a CONTRACT SENTINEL, not
        -- prose (the 014 convention); preflight's `atomic capture` reads it.
        -- 035: derived_from and supersedes are NOT in this SET. 025 filled a
        -- NULL one here (COALESCE(thoughts.x, EXCLUDED.x)) and never walked
        -- the pointer for a loop; a dedup of identical content is not the
        -- place to decide what the existing thought derives from or
        -- replaces. Setting, changing or clearing provenance on an existing
        -- thought is update_thought's, through its p_provenance envelope
        -- (032): walked, audited, one function. The return's `existed` tells
        -- the caller the envelope's provenance was not written.
  RETURNING id, supersedes INTO v_id, v_supersedes_now;

  -- ob1:vector-replaces-chunks — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `atomic capture` check reads it. 022: the windows
  -- stay while the label vouches for them — the row's vector was labelled
  -- with a model and the vector arriving is labelled with the same one — and
  -- go in every other case: a label unknown on either side, or another model.
  -- No vector arriving keeps vector, label and windows alike; a fresh insert
  -- runs no DELETE (v_existed). The 4-argument form delegates here and then
  -- writes the caller's windows; update_thought does the same for an edit.
  IF p_embedding IS NOT NULL AND v_existed
     AND (v_old_label = p_payload->>'embedding_model') IS NOT TRUE THEN
    DELETE FROM thought_chunks WHERE thought_id = v_id;
  END IF;

  -- 035: `existed` — the text was already captured; metadata merged, vector
  -- and windows by 021/022, provenance in the envelope not written — and
  -- `supersedes`, the row's pointer as it stands after this write.
  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint, 'existed', v_existed, 'supersedes', v_supersedes_now);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector) IS
  'Atomic capture: content + metadata + embedding in one statement. Reads p_payload.actor (008), p_payload.embedding_model (021), p_payload.derived_from / p_payload.supersedes (025) and p_payload.event (045: {stance, cites, valid_from, valid_until, trust, actor_kind}, validated by validate_write_event, set on ob1.event for the audit trigger — an empty setting when absent) from the envelope. derived_from is validated by validate_derived_from — an array of existing thought UUIDs, or the write is refused (SMD-1253); supersedes'' existence is the self-FK''s, checked where the column is written — a first capture (035). Takes the fingerprint advisory lock before the write (033), the one update_thought takes, so a capture and an edit of one text are serialised (READ COMMITTED); no supersession lock (035). On a re-capture the label follows the vector, the chunk rows stay only while the label vouches for them (022), and the envelope''s provenance is NOT written (035) — provenance lands on a first capture only; setting, changing or clearing it on an existing thought is update_thought''s p_provenance (032). Returns {id, fingerprint, existed, supersedes}: existed true means the text was already there and any provenance named was not written; supersedes is the row''s pointer after the write.';

-- ---------------------------------------------------------------------------
-- update_thought: 033's body under a 10-argument signature — p_event, defaulted
-- — with the event validated and set beside the actor. 032/033's mechanism for
-- a new parameter, carried one form further: capture the ACL of whichever
-- older form is there (9-, 8- or 7-argument — a brain where 033, 021 or 018
-- was re-applied by hand), drop all three (or every shorter call is "function
-- is not unique"), replay the ACL onto the new form. So this file, as the
-- last definer, leaves one function whatever state it meets, and
-- test-schema's restore of the last definer means what it did (033's
-- header). On a brain already at 045 the setting is empty and the DROPs find
-- nothing.
-- ---------------------------------------------------------------------------
SELECT set_config('ob1.acl_update_thought',
                  CASE WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb)') IS NOT NULL THEN ''
                       WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb)') IS NOT NULL THEN
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb)')), '')
                       WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)') IS NOT NULL THEN
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)')), '')
                       ELSE
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb)')), '') END,
                  false);

DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb);
DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text);
DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb);

CREATE OR REPLACE FUNCTION update_thought(
  p_id                 uuid,
  p_content            text        DEFAULT NULL,
  p_metadata_patch     jsonb       DEFAULT NULL,
  p_embedding          vector({{EMBEDDING_DIM}}) DEFAULT NULL,
  p_chunks             jsonb       DEFAULT NULL,
  p_if_unchanged_since timestamptz DEFAULT NULL,
  p_actor              jsonb       DEFAULT NULL,
  -- 021: the model that produced p_embedding, as OB1_EMBEDDING_MODEL names it.
  p_embedding_model    text        DEFAULT NULL,
  -- 032: the provenance envelope — {"supersedes": uuid|null, "derived_from":
  -- [uuid…]|null}. An absent key leaves the column, a JSON null clears it, a
  -- value sets it. Defaulted, so every 8-argument caller resolves here now
  -- that the 8-argument form is gone.
  p_provenance         jsonb       DEFAULT NULL,
  -- 045: the write event — {"stance": stated|retrieved|inferred, "cites":
  -- [uuid…], "valid_from", "valid_until", "trust", "actor_kind"} — validated by
  -- validate_write_event and set on ob1.event for the audit trigger; trust and
  -- actor_kind are claims the trigger checks against the key, never copies.
  -- Defaulted, so every 9-argument caller resolves here now that the
  -- 9-argument form is gone.
  p_event              jsonb       DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing     thoughts%ROWTYPE;
  v_fingerprint  text;
  v_unchanged    boolean;
  -- The row holding v_fingerprint in the unique index, if any, and whether its
  -- text still hashes to it (a raw update around this function can leave a
  -- stale key): the twin, or the stale holder, reported as such below.
  v_other        uuid;
  v_other_same   boolean;
  v_updated      timestamptz;
  -- 032: whether the envelope names each key, and the value to write when it
  -- does (NULL clears). Two flags rather than two nullable values, because
  -- "clear" and "leave alone" are both NULL.
  v_set_supersedes boolean := COALESCE(p_provenance ? 'supersedes', false);
  v_set_derived    boolean := COALESCE(p_provenance ? 'derived_from', false);
  v_supersedes     uuid;
  v_derived        jsonb;
  v_walk           uuid;
  v_steps          int := 0;
BEGIN
  -- 032: the envelope's shape, before any lock is taken — 005's guard, for
  -- this parameter: a client that binds a JS string to a jsonb parameter
  -- double-encodes it. Then each key's value: supersedes a UUID string or
  -- null (shape here, existence under the row lock below), derived_from
  -- through the one rule.
  IF p_provenance IS NOT NULL AND jsonb_typeof(p_provenance) <> 'object' THEN
    RAISE EXCEPTION
      'update_thought: p_provenance must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_provenance);
  END IF;
  IF v_set_supersedes AND jsonb_typeof(p_provenance->'supersedes') <> 'null' THEN
    IF jsonb_typeof(p_provenance->'supersedes') <> 'string'
       OR (p_provenance->>'supersedes') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION
        'update_thought: supersedes must be a thought UUID string or null, got %.', p_provenance->'supersedes';
    END IF;
    v_supersedes := (p_provenance->>'supersedes')::uuid;
  END IF;
  IF v_set_derived THEN
    v_derived := validate_derived_from(p_provenance->'derived_from');
  END IF;

  -- 008: transaction-local, so it cannot outlive this call on a pooled
  -- connection; set before the UPDATE so the AFTER trigger sees it.
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;
  -- 045: the event, validated and set unconditionally (an empty string when
  -- none), so a write in the same transaction cannot inherit the previous
  -- call's — see upsert_thought.
  PERFORM set_config('ob1.event', COALESCE(validate_write_event(p_event)::text, ''), true);

  -- 032: a supersedes write is serialised with every other on 029's lock,
  -- taken BEFORE the row lock — see "Lock order" in 033's header — so the
  -- walk below reads committed pointers. Re-entrant: review_supersession_proposal
  -- holds it already when it calls here.
  IF v_supersedes IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));
  END IF;

  -- 033: the fingerprint lock BEFORE the row, whenever content arrives — the
  -- order every capture takes since this migration, so no writer holds a row
  -- while waiting on a fingerprint lock another writer holds while waiting
  -- on a row. 018 took it after the row read and only when the row did not
  -- already own the key; the second hash and the lookup still skip that
  -- case below, the lock does not. 003's rule, through 016's function: a
  -- fingerprint computed differently here would silently stop matching the
  -- ones capture writes.
  IF p_content IS NOT NULL THEN
    v_fingerprint := content_fingerprint_of(p_content);
    PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));
  END IF;

  -- The row lock: what "unchanged" is decided against below is the row as it
  -- is NOW, and stays so until this transaction ends. Without the lock a
  -- caller passing no if_unchanged_since could read text X, have another edit
  -- commit Y, and write X back over it as an "unchanged" edit that 013 would
  -- have refused. FOR NO KEY UPDATE, not 018's FOR UPDATE (032): the
  -- supersedes write below takes FOR KEY SHARE on the target row, which FOR
  -- UPDATE on that row — another edit of it, waiting on a fingerprint lock
  -- this one holds — would deadlock with. Two edits of one row still
  -- serialise, and delete_thought still waits.
  SELECT * INTO v_existing FROM thoughts WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;

  -- 009: a stale read is told apart from a missing row before the write, so
  -- the caller gets the reason rather than a bare "0 rows". Truncated on both
  -- sides to milliseconds — JavaScript's Date carries no more, and a caller
  -- passing back exactly what it read must pass this.
  IF p_if_unchanged_since IS NOT NULL
     AND date_trunc('milliseconds', COALESCE(v_existing.updated_at, v_existing.created_at))
         > date_trunc('milliseconds', p_if_unchanged_since) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'STALE_READ',
      'current_updated_at', COALESCE(v_existing.updated_at, v_existing.created_at));
  END IF;

  -- 032: the target exists, and pointing at it closes no loop. The first read
  -- answers both: NOT FOUND is the ghost; its pointer starts the walk. 029's
  -- walk, moved here so a hand edit and an acceptance are refused alike;
  -- bounded, so a chain longer than the bound is refused rather than walked
  -- for ever. A thought cannot supersede itself.
  IF v_supersedes IS NOT NULL THEN
    IF v_supersedes = p_id THEN
      RETURN jsonb_build_object('ok', false, 'error', 'WOULD_CYCLE', 'supersedes', v_supersedes);
    END IF;
    SELECT supersedes INTO v_walk FROM thoughts WHERE id = v_supersedes;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'SUPERSEDES_NOT_FOUND', 'supersedes', v_supersedes);
    END IF;
    WHILE v_walk IS NOT NULL LOOP
      IF v_walk = p_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'WOULD_CYCLE', 'supersedes', v_supersedes);
      END IF;
      v_steps := v_steps + 1;
      IF v_steps > 1000 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'WOULD_CYCLE', 'supersedes', v_supersedes, 'detail', 'chain longer than 1000');
      END IF;
      SELECT supersedes INTO v_walk FROM thoughts WHERE id = v_walk;
    END LOOP;
  END IF;

  IF p_content IS NOT NULL THEN
    IF v_existing.content_fingerprint = v_fingerprint THEN
      -- The row already owns this key, and it is locked: the unique index
      -- says no other row can hold it, so there is nothing to look up. The
      -- common case — every fingerprinted row a re-embed pass visits, every
      -- same-text re-save through the tool. (The lock above is held anyway
      -- since 033: one order for every writer.)
      v_unchanged := true;
    ELSE
      v_unchanged := v_fingerprint = content_fingerprint_of(v_existing.content);

      -- ob1:unchanged-edit-not-duplicate — a CONTRACT SENTINEL, not prose (the
      -- 014 convention). The one definition of "another row holding this key":
      -- the refusal below and the duplicate_of report both read it. Under the
      -- fingerprint lock taken above, so it sees the other writer's committed
      -- row rather than racing it to the unique index — see "The rule", 2, in
      -- 018's header. The holder's text is hashed again, because a stale key
      -- — a raw update of content around this function — is not the same
      -- text, and must not be reported as a twin.
      SELECT id, content_fingerprint_of(content) = v_fingerprint
        INTO v_other, v_other_same
      FROM thoughts
      WHERE content_fingerprint = v_fingerprint AND id <> p_id
      LIMIT 1;

      IF v_other IS NOT NULL THEN
        -- Editing a thought INTO a key another row holds. The partial unique
        -- index would reject this anyway, but as a constraint violation that
        -- surfaces at the tool boundary as an opaque 23505. An edit whose text
        -- normalises to what the row already holds creates no duplicate that
        -- was not already there, so it is not refused; what was found is
        -- reported instead — the twin, or the row whose stale key blocks the
        -- fingerprint this row should have had.
        IF NOT v_unchanged THEN
          RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE_CONTENT');
        END IF;
      END IF;
    END IF;
  END IF;

  /**
   * One statement. The `if_unchanged_since` predicate is repeated here rather
   * than relied on from the check above: between that SELECT and this UPDATE
   * another writer can commit, which is the race upstream's version has. The
   * WHERE clause is the actual guard; the check above exists only to produce a
   * better error message.
   */
  UPDATE thoughts SET
    content             = COALESCE(p_content, content),
    -- v_other is set only when content arrived: another row holds this key,
    -- so this row must not claim it — NULL, whatever a raw update around this
    -- function may have left here.
    content_fingerprint = CASE
                            WHEN p_content IS NULL   THEN content_fingerprint
                            WHEN v_other IS NOT NULL THEN NULL
                            ELSE v_fingerprint
                          END,
    metadata            = CASE WHEN p_metadata_patch IS NOT NULL
                               THEN metadata || p_metadata_patch ELSE metadata END,
    -- Only when content arrived. A metadata-only edit must not blank the
    -- vector and quietly remove the row from every semantic search.
    embedding           = CASE WHEN p_content IS NOT NULL THEN p_embedding ELSE embedding END,
    -- The label follows the vector (021): untouched when the vector is,
    -- NULL when the vector is set to NULL, the caller's when a vector arrives.
    embedding_model     = CASE
                            WHEN p_content IS NULL   THEN embedding_model
                            WHEN p_embedding IS NULL THEN NULL
                            ELSE p_embedding_model
                          END,
    -- 032: each provenance column moves only when the envelope names its key
    -- — to the value given, NULL included.
    supersedes          = CASE WHEN v_set_supersedes THEN v_supersedes ELSE supersedes END,
    derived_from        = CASE WHEN v_set_derived    THEN v_derived    ELSE derived_from END,
    updated_at          = now()
  WHERE id = p_id
    AND (p_if_unchanged_since IS NULL
         OR date_trunc('milliseconds', COALESCE(updated_at, created_at))
            <= date_trunc('milliseconds', p_if_unchanged_since))
  RETURNING updated_at INTO v_updated;

  IF v_updated IS NULL THEN
    -- Lost the race after the check above passed.
    RETURN jsonb_build_object('ok', false, 'error', 'STALE_READ');
  END IF;

  -- Chunks describe the content, so they follow it: replaced wholesale, as
  -- migration 007's capture path does, carrying 013's context.
  IF p_content IS NOT NULL THEN
    DELETE FROM thought_chunks WHERE thought_id = p_id;
    IF p_chunks IS NOT NULL AND jsonb_array_length(p_chunks) > 0 THEN
      INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding, context)
      SELECT p_id, (ord - 1)::int, elem->>'content',
             (elem->>'embedding')::vector({{EMBEDDING_DIM}}),
             elem->>'context'
      FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS a(elem, ord);
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', p_id, 'updated_at', v_updated)
         || CASE WHEN v_other IS NULL   THEN '{}'::jsonb
                 WHEN v_other_same       THEN jsonb_build_object('duplicate_of', v_other)
                 ELSE jsonb_build_object('fingerprint_held_by', v_other) END;
END;
$$;

-- 032's ACL replay, verbatim, onto the 10-argument form from the 9-argument
-- form the capture above read — nothing on a brain that already had the
-- 10-argument form (CREATE OR REPLACE keeps its ACL).
DO $acl$
DECLARE
  v_acl  text := current_setting('ob1.acl_update_thought', true);
  v_item record;
BEGIN
  IF v_acl IS NULL OR v_acl = '' THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb) FROM PUBLIC';
  FOR v_item IN
    SELECT DISTINCT a.grantee FROM pg_proc p, aclexplode(p.proacl) AS a
    WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb)') AND a.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb) FROM %s', quote_ident(pg_get_userbyid(v_item.grantee)));
  END LOOP;
  FOR v_item IN SELECT grantee, privilege_type, is_grantable FROM aclexplode(v_acl::aclitem[]) LOOP
    IF v_item.privilege_type = 'EXECUTE' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb) TO %s%s',
                     CASE WHEN v_item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_item.grantee)) END,
                     CASE WHEN v_item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END IF;
  END LOOP;
END
$acl$;

COMMENT ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb) IS
  'Edit a thought by id. Recomputes content_fingerprint and replaces chunks — with their context — when content changes; an edit whose text normalises to what the row holds is never DUPLICATE_CONTENT, and reports duplicate_of when another row holds that text (a pair from before migration 003), or fingerprint_held_by when a row holds the key under other text, leaving this row''s fingerprint NULL. Every edit with content takes the fingerprint advisory lock (READ COMMITTED) — the one every capture through upsert_thought takes since 033 — and then locks the row FOR NO KEY UPDATE (032; FOR UPDATE until then, which the supersedes write''s FK check could deadlock with); both locks are held until the caller''s transaction ends, refusals included. Checks if_unchanged_since as a predicate in the UPDATE, so the guard is atomic. p_embedding_model (021) is written to thoughts.embedding_model beside the vector — the label follows the vector: untouched without content, NULL with content and no vector. p_provenance (032) is the envelope {"supersedes": uuid|null, "derived_from": [uuid…]|null}: an absent key leaves the column, a JSON null clears it, a value sets it — derived_from validated by validate_derived_from, supersedes an existing thought that closes no loop, the write serialised with review_supersession_proposal''s. p_event (045) is the write event {"stance", "cites", "valid_from", "valid_until", "trust", "actor_kind"}: validated by validate_write_event (a bad shape is refused), set on ob1.event for the audit trigger, which stamps stance, cites and the window on the row and checks trust and actor_kind against the key rather than copying them. Returns {ok:false, error} for NOT_FOUND | STALE_READ | DUPLICATE_CONTENT | SUPERSEDES_NOT_FOUND | WOULD_CYCLE.';


-- ---------------------------------------------------------------------------
-- backfill_thought_audit_events — the derived columns on rows from before 045
--
-- origin from actor_context.via (SMD-1541's rows), actor_kind and trust from
-- ob1_agents by the row's canonical_agent_id, else by its actor_name (the
-- label). Under the amendment the immutability trigger allows, and nothing
-- else: a set value is never changed, backfilled_at is stamped. Callable
-- again as kinds are set — 023's shape — with p_limit to bound a pass on a
-- large log; returns what it did and how many rows still wait on a kind.
-- This file calls it once below.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION backfill_thought_audit_events(p_limit integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows     integer;
  v_awaiting integer;
BEGIN
  PERFORM set_config('ob1.audit_amend', 'backfill', true);

  WITH candidates AS (
    SELECT a.id,
           COALESCE(a.actor_kind, g_id.kind, g_label.kind) AS kind,
           -- What the write declared while its key was unclassified: the
           -- trigger could not honour it then and filed it under claimed.
           a.actor_context->'claimed'->>'trust'             AS declared,
           COALESCE(a.origin, CASE WHEN jsonb_typeof(a.actor_context->'via') = 'string' THEN a.actor_context->>'via' END) AS origin
      FROM thought_audit a
      -- By the id, else by the name — as the trigger reads it, including an id
      -- the registry no longer knows (first review pass).
      LEFT JOIN ob1_agents g_id    ON g_id.canonical_agent_id = a.canonical_agent_id
      LEFT JOIN ob1_agents g_label ON g_id.canonical_agent_id IS NULL AND g_label.label = a.actor_name
     WHERE (a.actor_kind IS NULL AND COALESCE(g_id.kind, g_label.kind) IS NOT NULL)
        OR (a.origin IS NULL AND jsonb_typeof(a.actor_context->'via') = 'string')
     ORDER BY a.created_at
     LIMIT CASE WHEN p_limit IS NULL THEN NULL ELSE GREATEST(p_limit, 0) END
  )
  UPDATE thought_audit a
     SET actor_kind    = COALESCE(a.actor_kind, c.kind),
         -- The trigger's rule, applied late: the declaration stands when it
         -- is not above the kind, else the kind; undeclared, the kind (first
         -- review pass — the first draft wrote the kind over a lower
         -- declaration). The claim stays in the blob: it was unverifiable
         -- when the row was written, and the row says so.
         trust         = COALESCE(a.trust, CASE WHEN a.actor_kind IS NULL THEN
                           CASE WHEN c.declared IS NOT NULL
                                 AND array_position(ARRAY['ingested', 'agent', 'operator'], c.declared)
                                     <= array_position(ARRAY['ingested', 'agent', 'operator'], c.kind)
                                THEN c.declared ELSE c.kind END END),
         origin        = COALESCE(a.origin, c.origin),
         backfilled_at = now()
    FROM candidates c
   WHERE a.id = c.id
     -- Re-read on the row as it is when the lock is taken (READ COMMITTED),
     -- not as the candidates saw it: a pass that ran beside this one and
     -- filled the row first leaves it nothing to fill, and it is skipped
     -- rather than re-stamped and counted again (run-it, first review pass).
     AND ((a.actor_kind IS NULL AND c.kind IS NOT NULL)
          OR (a.origin IS NULL AND c.origin IS NOT NULL));
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  PERFORM set_config('ob1.audit_amend', '', true);

  -- Rows attributed to a key whose kind nobody has set: what set_agent_kind
  -- and another call here would fill. Rows with no actor_name can never gain
  -- one and are not counted.
  SELECT count(*)::int INTO v_awaiting
    FROM thought_audit
   WHERE actor_kind IS NULL AND actor_name IS NOT NULL;

  RETURN jsonb_build_object('ok', true, 'rows', v_rows, 'awaiting_kind', v_awaiting);
END;
$$;

COMMENT ON FUNCTION backfill_thought_audit_events(integer) IS
  'Fill actor_kind, trust and origin on thought_audit rows written before 045, or before their key was classified: origin from actor_context.via, kind and trust from ob1_agents by canonical_agent_id else by actor_name, stamping backfilled_at — the one amendment thought_audit_immutable allows. Idempotent; p_limit bounds a pass. Returns {ok, rows, awaiting_kind}: awaiting_kind is the rows that still name a key with no kind. Migration 045 / SMD-1730.';

-- Once, here: every SMD-1541 row gains its origin now; no row gains a kind at
-- apply time, since no agent has one yet. Re-runs find nothing.
SELECT backfill_thought_audit_events();
