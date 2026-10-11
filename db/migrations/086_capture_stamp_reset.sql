-- =============================================================================
-- Migration 086: the operator resets a capture-only key's settled or moved
--                label — the row's declines and its restamp no longer count,
--                the capture key's stamp is put back, and the next re-capture
--                is weighed afresh (SMD-2744)
-- =============================================================================
--
-- WHY
--   Under 085 a capture-only key's stamp moves once: the first classified key
--   that can read to re-capture the text moves it (`restamped`) or records a
--   decline (`restamp_declined`), and either settles the row against every
--   other agent. So a label could stick at a value the operator holds wrong —
--   another key reached the row first, or a name-only decline was written
--   while the registry lookup failed or was misconfigured (a role not
--   re-granted after an upgrade), which settles the row for every caller. No
--   way out kept the row: update_thought's metadata patch naming `trust`
--   changes nothing on a write that leaves the text (050), a backfill pass
--   keeps the label, a text edit changes the text and a delete and re-capture
--   changes the id (SMD-2664 review pass 5, scenario S6, on the real server).
--
-- WHAT
--   * ob1_reset_capture_stamp(id, actor) — the operator's reset, which the
--     server's reset_capture_stamp tool calls (a write key's tool). Sets
--     ob1.actor from the actor as the write functions do, and refuses
--     (NOT_OPERATOR) unless the actor in force is a key the registry
--     classifies `operator` — by its id, else its name, the lookup the audit
--     row's actor_kind is made by, so the event it appends names the
--     operator — and is not a capture-only key's. Locks the row as
--     update_thought does. Refuses (NOT_CAPTURE_STAMP) a row whose label is
--     not 085's to move: its capture row carries no `"scope": "capture"`
--     mark, or its metadata is not an object. Then, since the row's latest
--     reset:
--       - no decline and no restamp — nothing settled, nothing written
--         (`reset: false`), read before any text is hashed;
--       - an update since the capture changed the text (by 003's
--         fingerprint) — refused, NOT_CAPTURE_STAMP: the label is the
--         editor's;
--       - else one update event, its diff `{"restamp_reset": true}`, and, when
--         a restamp moved the label, the metadata with the three stamp keys
--         (`actor_kind`, `actor_name`, `trust`) derived from the capture row
--         exactly as backfill_thought_actors derives a capture's: the
--         capture key's trimmed name, its kind as the registry holds it now
--         (else the kind its capture row recorded), the trust that row
--         recorded under that kind (or the claim it filed while the key was
--         unclassified), and the stamp the restamp found (its diff's
--         before-image) only lowering it, as the row's own word lowers the
--         backfill's — so the next backfill pass finds the row as the reset
--         left it, and a key reclassified down since comes back down. A key
--         the derivation gives no value stays absent; every other key as the
--         row holds it now. The answer names the key whose restamp it undid
--         (`moved_by`) and the keys whose declines no longer count
--         (`declined_by`) — the operator's own among them, when the operator
--         moved or kept the label since the last reset. A refusal of the
--         caller says the registry's kind for it. The event declares the
--         trust the row is left at, so the audit row's trust is the row's —
--         save where the row is left with none (an unclassified capture
--         key's), and the audit row records the operator's kind, as any
--         write declaring nothing does. It moves updated_at, as 085's
--         events do.
--     The weighing is then as if no reader had landed since the capture: the
--     next classified key that can read to re-capture it is weighed against
--     the stamp put back. (082's note stands: the row is no longer the
--     capture key's to supersede.) A reset of declines alone writes no
--     metadata: the label stays as it stands, even where the registry moved
--     since the capture and a backfill pass would derive it anew — the
--     next re-capture is weighed against it as it stands. The operator is
--     asked twice, before the row lock (so a key that is not the operator
--     learns nothing of which ids exist) and after it (so a key
--     reclassified while it waited is what it is now).
--   * ob1_restamp_recapture — 085's body; the declines and the restamp it
--     reads are those after the row's latest reset by seq, so a reset row is
--     weighed again. A text change still refuses whenever it was made.
--   * backfill_thought_actors — 085's body; a reset is in the candidate rows,
--     so a restamp with a reset after it is no writer, and the capture is the
--     writer again when no update ever changed the text. Every other row
--     derives as before.
--
-- NOT HERE
--   * The window after a reset: the first classified key that can read to
--     land settles the row again, so an agent key re-sending the text before
--     the operator's re-capture is weighed first. The operator re-captures
--     at once; a reset that also moved the label to the operator would skip
--     the weighing.
--   * A capture-only key's row from before SMD-2638's scope mark: nothing
--     says whose it is, and the reset refuses it (NOT_CAPTURE_STAMP), as 085
--     leaves it (SMD-2745).
--   * A decline settles the row against every other key, not the decliner:
--     the operator keeping outside text with an `ingested` re-capture still
--     moves the label by its own later plain re-capture (085's rule for the
--     same agent).
--   * Two live keys on one agent id (SMD-2746): the reset clears both keys'
--     declines alike.
--   * update_thought's `trust` patch on a write that leaves the text still
--     changes nothing (050); its reply is SMD-2744's second PR.
--
-- Idempotent: CREATE OR REPLACE throughout.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regprocedure('ob1_restamp_recapture(uuid, text, jsonb, text)') IS NULL
     OR to_regprocedure('ob1_registry_kind(uuid, text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 086 needs 046 and 085 (ob1_registry_kind, ob1_restamp_recapture); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. The operator's reset.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_reset_capture_stamp(p_id uuid, p_actor jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_actor    jsonb;
  v_agent    uuid;
  v_meta     jsonb;
  v_fp       text;
  v_since    bigint;
  v_declines integer;
  v_before   jsonb;
  v_moved    boolean;
  v_moved_by text;
  v_caller_kind text;
  v_cap_agent uuid;
  v_cap_name text;
  v_cap_kind text;
  v_cap_trust text;
  v_cap_claimed text;
  v_kind     text;
  v_trust    text;
  v_declined_by jsonb;
  v_after    jsonb;
  v_ev       uuid;
BEGIN
  -- 005's guard, for the actor as the write functions read it.
  IF p_actor IS NOT NULL AND jsonb_typeof(p_actor) <> 'object' THEN
    RAISE EXCEPTION
      'ob1_reset_capture_stamp: p_actor must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_actor);
  END IF;
  -- Transaction-local, as the write functions set it (008).
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;
  -- ob1:reset-is-the-operators — a CONTRACT SENTINEL, not prose (the 014
  -- convention). The operator alone: the registry's kind for the actor in
  -- force, by its id, else its name — 046's lookup, the one the append
  -- below stamps actor_kind by, so the event names the operator. A
  -- capture-only key reads nothing it resets, whatever its kind. No actor,
  -- or one naming no key, is nobody's: the registry holds no kind for it.
  v_actor := ob1_current_actor();
  v_agent := CASE WHEN v_actor->>'agent_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN (v_actor->>'agent_id')::uuid END;
  v_caller_kind := ob1_registry_kind(v_agent, v_actor->>'name');
  IF v_actor IS NULL OR v_actor->>'scope' = 'capture' OR v_caller_kind IS DISTINCT FROM 'operator' THEN
    -- The kind the registry holds for the caller, so the server can say
    -- whether classifying this key is the fix or the wrong one (review pass
    -- 2: an agent key was handed the line that would raise all its writes).
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_OPERATOR',
                              'kind', CASE WHEN v_actor->>'scope' = 'capture' THEN 'capture-only' ELSE v_caller_kind END);
  END IF;
  -- The row locked as update_thought and 085 lock it, so a re-capture and
  -- an edit are serialised with the reset, and each reads the log the
  -- other left.
  SELECT metadata, content_fingerprint INTO v_meta, v_fp FROM thoughts WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;
  -- Asked again now the row is held: a key reclassified while this call
  -- waited on the lock is what it is now (review pass 2: a key demoted to
  -- agent behind the lock reset the row, and the event named an agent).
  -- The first ask stays first, so a key that is not the operator learns
  -- nothing of which ids exist.
  v_caller_kind := ob1_registry_kind(v_agent, v_actor->>'name');
  IF v_caller_kind IS DISTINCT FROM 'operator' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_OPERATOR', 'kind', v_caller_kind);
  END IF;
  -- The rows 085 moves a label on, and no other: a capture-only key's
  -- capture (082's scope mark on its capture row), its text never changed
  -- since (below). Elsewhere the label is its writer's under 050, and a
  -- reset has no capture key's stamp to put back.
  SELECT c.canonical_agent_id, NULLIF(btrim(c.actor_name), ''), c.actor_kind, c.trust, c.actor_context->'claimed'->>'trust'
    INTO v_cap_agent, v_cap_name, v_cap_kind, v_cap_trust, v_cap_claimed
    FROM thought_audit c
   WHERE c.thought_id = p_id AND c.action = 'capture' AND c.actor_context->>'scope' = 'capture'
   ORDER BY c.seq LIMIT 1;
  IF NOT FOUND OR jsonb_typeof(v_meta) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_CAPTURE_STAMP');
  END IF;
  -- What settled the row since its latest reset: the declines, and the
  -- restamp that moved it — one at most in a window, since 085 moves a row
  -- once; the oldest by seq if a raw writer planted more, as its
  -- before-image is the stamp the capture key's held. The cheap reads first, as
  -- 085's are (its review pass 5): a row with nothing settled answers here,
  -- before any text is hashed.
  SELECT max(r.seq) INTO v_since FROM thought_audit r
   WHERE r.thought_id = p_id AND r.action = 'update' AND r.diff ? 'restamp_reset';
  SELECT count(*), COALESCE(jsonb_agg(DISTINCT NULLIF(btrim(d.actor_name), '')) FILTER (WHERE NULLIF(btrim(d.actor_name), '') IS NOT NULL), '[]'::jsonb)
    INTO v_declines, v_declined_by FROM thought_audit d
   WHERE d.thought_id = p_id AND d.action = 'update' AND d.diff ? 'restamp_declined'
     AND (v_since IS NULL OR d.seq > v_since);
  SELECT s.diff->'metadata'->'before', NULLIF(btrim(s.actor_name), '') INTO v_before, v_moved_by FROM thought_audit s
   WHERE s.thought_id = p_id AND s.action = 'update' AND s.diff ? 'restamped'
     AND (v_since IS NULL OR s.seq > v_since)
   ORDER BY s.seq LIMIT 1;
  v_moved := FOUND;
  IF v_declines = 0 AND NOT v_moved THEN
    RETURN jsonb_build_object('ok', true, 'reset', false, 'restored', false, 'declines', 0, 'declined_by', '[]'::jsonb, 'moved_by', NULL,
                              'actor_kind', v_meta->'actor_kind', 'actor_name', v_meta->'actor_name', 'trust', v_meta->'trust');
  END IF;
  -- A text change since the capture put its editor's stamp there (by 003's
  -- fingerprint: 018's unchanged edit keeps the stamp, so it is not one).
  IF EXISTS (SELECT 1 FROM thought_audit u
              WHERE u.thought_id = p_id AND u.action = 'update' AND u.diff ? 'content'
                AND content_fingerprint_of(u.diff->'content'->>'before')
                    IS DISTINCT FROM content_fingerprint_of(u.diff->'content'->>'after')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_CAPTURE_STAMP');
  END IF;
  -- The capture key's stamp, derived from its capture row exactly as
  -- backfill_thought_actors derives a capture's (073; review pass 2: from
  -- the restamp's before-image, a key classified after its capture came
  -- back with no trust, and the next pass gave it one — the weighing hung on
  -- whether a pass ran between): its trimmed name; its kind as the registry
  -- holds it NOW, else the kind its capture row recorded; the trust that row
  -- recorded under that kind, or the claim it filed while the key was
  -- unclassified; and the stamp the restamp found (its diff's
  -- before-image) only lowering it, as the row's own word lowers the
  -- backfill's — the backfill's next pass then finds the row as the reset
  -- left it. Never above the trust the restamp found where it found one,
  -- and a key reclassified down since comes back down; where it found none,
  -- the trust is what the backfill gives (a key classified since gets its
  -- kind's). Every other key as the row holds it now.
  v_after := v_meta;
  IF v_moved THEN
    v_kind := COALESCE(ob1_registry_kind(v_cap_agent, v_cap_name), v_cap_kind);
    v_trust := CASE WHEN v_cap_trust IS NOT NULL THEN ob1_trust_ceiling(v_kind, v_cap_trust)
                    ELSE ob1_trust_ceiling(v_kind, v_cap_claimed) END;
    v_trust := CASE WHEN v_trust IS NOT NULL THEN ob1_trust_ceiling(v_trust, v_before->>'trust') END;
    v_after := (v_meta - 'actor_kind' - 'actor_name' - 'trust')
               || CASE WHEN v_kind IS NOT NULL THEN jsonb_build_object('actor_kind', v_kind) ELSE '{}'::jsonb END
               || CASE WHEN v_cap_name IS NOT NULL THEN jsonb_build_object('actor_name', v_cap_name) ELSE '{}'::jsonb END
               || CASE WHEN v_trust IS NOT NULL THEN jsonb_build_object('trust', v_trust) ELSE '{}'::jsonb END;
  END IF;
  v_ev := ob1_append_thought_event(p_id, 'update', v_meta->>'source',
            ob1_thought_diff('update', NULL, NULL, v_meta, v_after, false, false, NULL, NULL, NULL, NULL, v_fp, v_fp)
              || '{"restamp_reset": true}'::jsonb,
            jsonb_build_object('trust', v_after->>'trust'));
  PERFORM ob1_project_thought_event(v_ev);
  RETURN jsonb_build_object('ok', true, 'reset', true, 'restored', v_moved, 'declines', v_declines, 'declined_by', v_declined_by, 'moved_by', v_moved_by,
                            'actor_kind', v_after->'actor_kind', 'actor_name', v_after->'actor_name', 'trust', v_after->'trust');
END;
$$;

COMMENT ON FUNCTION ob1_reset_capture_stamp(uuid, jsonb) IS
  'The operator''s reset of a capture-only key''s label that 085 settled or moved (SMD-2744): called by the server''s reset_capture_stamp tool. Sets ob1.actor from p_actor (008''s envelope) and answers {ok:false, error:"NOT_OPERATOR"} unless the actor in force names a key the registry classifies operator (ob1_registry_kind by its agent_id, else its name) and is not a capture-only key''s ("scope": "capture"). Locks the row: {ok:false, error:"NOT_FOUND"} when it is gone, "NOT_CAPTURE_STAMP" when its metadata is not an object or its capture row carries no "scope": "capture" mark. Since the row''s latest reset (a "restamp_reset" update event, by seq): no "restamp_declined" and no "restamped" event — {ok:true, reset:false}, nothing written; else "NOT_CAPTURE_STAMP" when an update since the capture changed its text (by content_fingerprint_of); else appends and projects one update event, diff {"restamp_reset": true} and, when a restamp moved the label, the metadata with actor_kind, actor_name and trust derived from the capture row as backfill_thought_actors derives a capture''s — the trimmed name, the registry''s kind for it now (else the capture row''s), the capture row''s trust (or its filed claim) under that kind, lowered by the oldest such restamp''s before-image and never raised; a key with no value absent, every other key as the row holds it — the event declaring the trust the row is left at (none declared where the row has none). Returns {ok, reset, restored, declines, declined_by (the keys whose declines no longer count), moved_by (the key whose restamp it undid), actor_kind, actor_name, trust} — the row''s stamp after; NOT_OPERATOR carries kind, the registry''s for the caller ("capture-only" for a capture-scoped one). ob1_restamp_recapture then reads only the declines and restamps after the reset, so the next classified re-capture is weighed afresh; backfill_thought_actors reads a restamp with a reset after it as no writer. Migration 086 / SMD-2744.';

-- ---------------------------------------------------------------------------
-- 2. ob1_restamp_recapture — 085's body; what settled the row is read since
--    its latest reset.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_restamp_recapture(p_id uuid, p_fingerprint text, p_actor jsonb DEFAULT NULL, p_declared text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_meta  jsonb;
  v_fp    text;
  v_new   jsonb;
  v_ev    uuid;
  v_agent uuid;
  v_since bigint;
BEGIN
  -- 005's guard, for the actor as upsert_thought reads it from its envelope.
  IF p_actor IS NOT NULL AND jsonb_typeof(p_actor) <> 'object' THEN
    RAISE EXCEPTION
      'ob1_restamp_recapture: p_actor must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_actor);
  END IF;
  -- Transaction-local, as the write functions set it (008).
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;
  -- A key that cannot read keeps the row it lands on (080): its re-capture
  -- vouches for nothing it did not already hold. Read from the actor in
  -- force, so a call passing none under a capture-scoped session is refused
  -- too (review pass 1).
  IF ob1_current_actor()->>'scope' = 'capture' THEN
    RETURN false;
  END IF;
  -- The row locked as update_thought locks it, so an edit and a second
  -- re-capture are serialised with this one, and each reads the log the
  -- other left.
  SELECT metadata, content_fingerprint INTO v_meta, v_fp FROM thoughts WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND OR jsonb_typeof(v_meta) IS DISTINCT FROM 'object' THEN
    RETURN false;  -- gone, or a raw writer's metadata, which no stamp reaches (050)
  END IF;
  -- The text the caller captured is the text that stands: an edit between
  -- the capture and this call put a text there this writer never sent.
  IF p_fingerprint IS NULL OR v_fp IS DISTINCT FROM p_fingerprint THEN
    RETURN false;
  END IF;
  -- 086: the operator's reset (ob1_reset_capture_stamp) puts the row back
  -- as if no reader had landed, so the restamp and the declines read below
  -- are those after its latest reset, by seq (SMD-2744). A text change
  -- refuses whenever it was made: a reset refuses such a row too.
  SELECT max(r.seq) INTO v_since FROM thought_audit r
   WHERE r.thought_id = p_id AND r.action = 'update' AND r.diff ? 'restamp_reset';
  -- ob1:recapture-restamps-capture-key — a CONTRACT SENTINEL, not prose (the
  -- 014 convention). Only a capture-only key's stamp yields: its capture row
  -- carries the scope mark, and nothing since has put another's stamp there
  -- — an earlier restamp here, a text change below. The cheap reads first:
  -- the text-change read hashes each edit's two texts, so a row already
  -- moved or settled is refused before it (review pass 5: 1,000 whitespace
  -- edits of a 100 KB text cost 7.5 s a re-capture, under the row lock).
  IF NOT EXISTS (SELECT 1 FROM thought_audit c
                  WHERE c.thought_id = p_id AND c.action = 'capture'
                    AND c.actor_context->>'scope' = 'capture')
     OR EXISTS (SELECT 1 FROM thought_audit u
                 WHERE u.thought_id = p_id AND u.action = 'update' AND u.diff ? 'restamped'
                   AND (v_since IS NULL OR u.seq > v_since)) THEN
    RETURN false;
  END IF;
  -- ob1:recapture-weighed-once — a CONTRACT SENTINEL, not prose (the 014
  -- convention). The first classified key that can read to land on the row
  -- settles it: its trust is weighed against the capture key's once, and
  -- the row moves to it or is left — left, it records so below. A later key
  -- does not get a second weighing: the operator re-capturing a capture
  -- key's outside text declaring `ingested` moved nothing, and an agent key
  -- re-sending it after must not relabel it (review pass 2). The record is
  -- this function's own, not 082's note, which 082 writes by conditions of
  -- its own — for an unclassified key and a call with no actor too, neither
  -- of which can move the stamp, and not for a row it counts as taken
  -- (review pass 3). The same agent's own later landing may — the
  -- same by agent id; a decline naming none (a name-only writer: board-sync,
  -- or a key whose registry lookup failed or was refused) is never the
  -- caller's own. The caller's id is read from the
  -- actor in force by 010's pattern, so a malformed setting is no id.
  v_agent := CASE WHEN ob1_current_actor()->>'agent_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN (ob1_current_actor()->>'agent_id')::uuid END;
  IF EXISTS (SELECT 1 FROM thought_audit d
              WHERE d.thought_id = p_id AND d.action = 'update' AND d.diff ? 'restamp_declined'
                AND (d.canonical_agent_id IS NULL OR v_agent IS NULL OR d.canonical_agent_id <> v_agent)
                AND (v_since IS NULL OR d.seq > v_since)) THEN
    RETURN false;
  END IF;
  -- A text change since the capture put the editor's stamp there (by 003's
  -- fingerprint: 018's unchanged edit keeps the stamp, so it is not one).
  IF EXISTS (SELECT 1 FROM thought_audit u
              WHERE u.thought_id = p_id AND u.action = 'update' AND u.diff ? 'content'
                AND content_fingerprint_of(u.diff->'content'->>'before')
                    IS DISTINCT FROM content_fingerprint_of(u.diff->'content'->>'after')) THEN
    RETURN false;
  END IF;
  -- The stamp this write would have put on a new text (073's rule: the key's
  -- kind, a declaration below it standing), and the row's moved to it only
  -- when the writer is classified and its trust ranks above the one there.
  -- A writer of no kind supports no claim above `ingested` (046), and its
  -- restamp would spend the row's one move on a stamp naming no kind
  -- (review pass 2: an unclassified key, or no actor at all, declaring
  -- `ingested` over a trust-less row locked the operator out).
  v_new := ob1_actor_stamp(v_meta, p_declared);
  IF NOT (v_new ? 'actor_kind') THEN
    RETURN false;  -- weighed nothing: an unclassified writer settles nothing
  END IF;
  IF ob1_trust_rank(v_new->>'trust') <= ob1_trust_rank(v_meta->>'trust') THEN
    -- Weighed and not higher: the row is settled, and says so once — an
    -- update event whose diff is the decline alone (only updated_at moves,
    -- as 082's note moves it), the audit row naming the key and the trust
    -- it was weighed at. The same agent's own decline is not written twice.
    IF v_agent IS NULL OR NOT EXISTS (SELECT 1 FROM thought_audit d
                                       WHERE d.thought_id = p_id AND d.action = 'update' AND d.diff ? 'restamp_declined'
                                         AND d.canonical_agent_id = v_agent
                                         AND (v_since IS NULL OR d.seq > v_since)) THEN
      v_ev := ob1_append_thought_event(p_id, 'update', v_meta->>'source', '{"restamp_declined": true}'::jsonb,
                                       jsonb_build_object('trust', v_new->>'trust'));
      IF v_ev IS NOT NULL THEN
        PERFORM ob1_project_thought_event(v_ev);
      END IF;
    END IF;
    RETURN false;
  END IF;
  -- The trust it lands at is the event's declaration, so the audit row's
  -- trust is the row's (the append and the stamp read the same registry
  -- kind; a name the stamp trims and the append does not — a padded
  -- name-only envelope, which the server never sends — can part them) — and
  -- a declaration above the key's kind, clamped by the stamp, is not filed a
  -- second time (the capture's own event did).
  v_ev := ob1_append_thought_event(p_id, 'update', v_meta->>'source',
            ob1_thought_diff('update', NULL, NULL, v_meta, v_new, false, false, NULL, NULL, NULL, NULL, v_fp, v_fp)
              || '{"restamped": true}'::jsonb,
            jsonb_build_object('trust', v_new->>'trust'));
  IF v_ev IS NULL THEN
    RETURN false;
  END IF;
  PERFORM ob1_project_thought_event(v_ev);
  RETURN true;
END;
$$;

COMMENT ON FUNCTION ob1_restamp_recapture(uuid, text, jsonb, text) IS
  'Moves a capture-only key''s stamp to the key whose capture just landed on its row, when that key''s trust is higher: called by the stores after a capture without p_payload.recapture = ''keep'' (a key that can read) landed on an existing row, after ob1_note_recapture. Sets ob1.actor from p_actor (008''s envelope) and locks the row. Moves nothing when the actor in force carries "scope": "capture", the row''s fingerprint is no longer p_fingerprint (the text moved since the capture), its metadata is not an object, or its stamp is not still a capture-only key''s — its capture row carries no "scope": "capture", or an update since changed the text or restamped it — or another agent''s decline is on it (a "restamp_declined" update event this function wrote: the first classified key that can read to land settles the row; a decline naming no agent id — a name-only writer — is no caller''s own, so it settles the row for every caller). Otherwise computes the stamp the write would have put on a new text (ob1_actor_stamp with p_declared, the write event''s trust). An unclassified writer (no actor_kind) moves and records nothing. A classified one whose trust does not rank strictly above the row''s (ob1_trust_rank) records the decline once per agent — an update event, diff {"restamp_declined": true}, only updated_at moving — and moves nothing. One whose trust does appends one update event — the metadata with the writer''s actor_kind, actor_name and trust, and "restamped": true in the diff, the event declaring that trust — and projects it. Returns whether it moved the stamp. backfill_thought_actors reads the event as the stamp''s writer. Since 086 the declines and the restamp read are those after the row''s latest reset (ob1_reset_capture_stamp''s "restamp_reset" event, by seq), so a reset row is weighed afresh; a text change refuses whenever it was made. Migration 085 / SMD-2664; the reset 086 / SMD-2744.';

-- ---------------------------------------------------------------------------
-- 3. backfill_thought_actors — 085's body; a reset undoes the restamps
--    before it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION backfill_thought_actors(p_limit integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET lock_timeout = '10s'
AS $$
DECLARE
  v_prev_actor text := current_setting('ob1.actor', true);
  v_prev_amend text := current_setting('ob1.actor_amend', true);
  -- 023's shape: a temp table named per call and dropped at commit, so two
  -- calls in one transaction never meet each other's, and nothing is dropped
  -- by hand (CLAUDE.md's rail; the first draft dropped a fixed name, which
  -- resolved to a permanent table of that name when no temp one existed —
  -- first review pass, reproduced).
  v_tbl      text := format('ob1_actor_backfill_%s',
                            to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'));
  v_rows     integer := 0;
  v_differ   integer;
  v_awaiting integer;
BEGIN
  IF p_limit IS NOT NULL AND p_limit < 1 THEN
    RAISE EXCEPTION 'backfill_thought_actors: p_limit must be at least 1, or NULL for every row (got %)',
      p_limit;
  END IF;

  /**
   * Every thought's writer, from the log: the update row whose after-text is
   * the row's text, else the capture when no update ever changed the text —
   * the newest by created_at then seq among candidates — read through 008's
   * thought_id index; nobody when update rows exist but none wrote the text
   * that stands (a capture-only thought rewritten unaudited cannot be told
   * apart, and its capturer stands). Its kind is what the registry says
   * NOW for its id or name — the trigger's rule applied late, and a
   * reclassification carried to the rows — else the kind 046 stamped on the
   * row (a key since removed from the registry). A thought with no such row
   * (loaded with the audit trigger off, or its log pruned by a migration)
   * derives to nothing, and a mark it carries is stripped: nobody vouches
   * for it. A metadata that is not an object has no mark to read or write.
   *
   * 085: a re-capture that moved the stamp — ob1_restamp_recapture's event,
   * `restamped` in its diff — writes no text, and is the writer when no
   * text-writing row came after it by seq, the newest such: that re-capture's key
   * wrote the stamp the row carries, at a trust above the one before it, and
   * a pass must not put the lower one back (SMD-2664). Its kind is the
   * registry's now, as for any writer.
   *
   * 086: the operator's reset (ob1_reset_capture_stamp's event,
   * `restamp_reset` in its diff) puts the capture key's stamp back, so a
   * restamp with a reset after it is no writer, and the capture is the
   * writer again when no update ever changed the text — a restamp and a
   * reset write no text, so neither counts as such an update. A reset is
   * no writer either (SMD-2744).
   *
   * 073: its trust is never raised. It is the lowest of three words: the
   * trust the log recorded for that write (thought_audit.trust — the key's
   * kind then, or what the write declared below it), or, for a write its key
   * could not yet support (no trust recorded, the key unclassified then),
   * the claim it filed under actor_context.claimed, the kind now standing in
   * for the kind then (046's own backfill reads the claim so); the key's
   * kind NOW, so a key reclassified down takes its rows down with it; and
   * the row's own metadata.trust when it is a word on the ladder — what a
   * writer before 073 set, and a lowering the log cannot see (a raw
   * multi-row statement under one ob1.event) — and only lowers: where the
   * log supports no trust, the row gets none, its word stripped with its
   * marks. A reclassification up raises none of them: the log cannot tell a
   * write that declared its key's kind from one that declared nothing (first
   * review pass, both readers), and a ceiling raised after the fact is the
   * one direction a label must not move. So a key reclassified down and back
   * up leaves its rows down — the named cost; a text-changing edit restamps
   * one (a same-text write keeps the trust it finds). Live, the stamp,
   * the append and this read one word from the same inputs, so a pass after
   * live writes finds nothing to change unless the registry moved.
   *
   * `differs` is where the row and the log disagree — the rows this pass
   * writes; `awaiting` is where the log names a key nobody has classified —
   * the rows the next pass fills once set_agent_kind has. updated_at rides
   * along so the write below can tell a row edited meanwhile (018's guard).
   */
  EXECUTE format($scan$
    CREATE TEMP TABLE %I ON COMMIT DROP AS
    SELECT d.id, d.updated_at, d.kind, d.name, x.trust,
           -- Differs when the value differs, or when the key is present with
           -- a value that reads as NULL (a JSON null a caller planted — `->>`
           -- says NULL for it as for an absent key; run-it, first review pass).
           (d.kind IS DISTINCT FROM d.present_kind OR (d.kind IS NULL AND d.has_kind)
            OR d.name IS DISTINCT FROM d.present_name OR (d.name IS NULL AND d.has_name)
            OR x.trust IS DISTINCT FROM d.present_trust
            OR (x.trust IS NULL AND d.has_trust)) AS differs,
           (d.kind IS NULL AND (d.w_name IS NOT NULL OR d.w_agent IS NOT NULL)) AS awaiting
    FROM (
      SELECT t.id, t.updated_at,
             -- (w is the LATERAL below; f.fp is the thought's own text hashed
             -- once per thought — the OFFSET 0 fences the subquery, or the
             -- planner pulls the hash up into w's sort key and runs it once
             -- per update row (third review pass, counted: 5 edits, 5 hashes
             -- of the same text) — NOT the content_fingerprint column: a raw
             -- content UPDATE leaves that column stale, and the stale hash
             -- anchored the previous writer's edit — second review pass.)
             -- A writer stands only for text the log vouches for: an update
             -- row whose after-text is the row's, or the capture when no
             -- update ever changed the text (a capture row carries no text to
             -- check). Update rows present and none matching means the text
             -- that stands was written unaudited — nobody's, as a no-row
             -- thought is (third review pass).
             CASE WHEN w.vouched
                  THEN COALESCE(ob1_registry_kind(w.canonical_agent_id, w.name), w.actor_kind) END AS kind,
             CASE WHEN w.vouched THEN w.name END               AS name,
             CASE WHEN w.vouched THEN w.trust END              AS w_trust,
             CASE WHEN w.vouched THEN w.claimed END            AS w_claimed,
             CASE WHEN w.vouched THEN w.name END               AS w_name,
             CASE WHEN w.vouched THEN w.canonical_agent_id END AS w_agent,
             t.metadata->>'actor_kind' AS present_kind,
             t.metadata->>'actor_name' AS present_name,
             t.metadata->>'trust'      AS present_trust,
             COALESCE(t.metadata ? 'actor_kind', false) AS has_kind,
             COALESCE(t.metadata ? 'actor_name', false) AS has_name,
             COALESCE(t.metadata ? 'trust', false)      AS has_trust
      FROM thoughts t
      CROSS JOIN LATERAL (
        -- Read only against update rows, so hashed only when one carries text
        -- (fourth review pass: a quarter of the hashes went to capture-only
        -- thoughts and were never compared). OFFSET 0 as above.
        SELECT CASE WHEN EXISTS (SELECT 1 FROM thought_audit u
                                  WHERE u.thought_id = t.id AND u.action = 'update' AND u.diff ? 'content')
                    THEN content_fingerprint_of(t.content) END AS fp
        OFFSET 0) f
      LEFT JOIN LATERAL (
        -- The name as the trigger reads it — trimmed, empty is none — so the
        -- two derive one value and a pass after a pass writes nothing
        -- (run-it, first review pass: a padded name flip-flopped every pass).
        SELECT a.actor_kind, NULLIF(btrim(a.actor_name), '') AS name, a.canonical_agent_id,
               -- 073: the trust the log recorded for the write, and the
               -- claim filed while its key could not support it (above).
               a.trust, a.actor_context->'claimed'->>'trust' AS claimed,
               -- Decided from the SET, not from which row sorts first: a
               -- capture stands only when no update ever changed the text
               -- (fourth review pass, planted: a pre-050 seq inverted under a
               -- created_at tie put the capture on top of an unmatched update,
               -- and it was vouched by its place in the order).
               -- 085: a restamp, when every row after it is another restamp —
               -- 086: a reset after it is not one.
               -- 086: the update arm and the capture arm read text-writing
               -- updates alone. A restamp's or a reset's after-text is NULL,
               -- which matched f.fp's NULL on a row no update ever gave a
               -- text — a reset vouched there, and a restamp before a reset;
               -- and either kept the capture from vouching.
               ((a.restamped AND COALESCE(bool_and(a.restamped) OVER newer, true))
                OR (a.texted AND a.fa IS NOT DISTINCT FROM f.fp)
                OR (a.action = 'capture' AND NOT bool_or(a.texted) OVER ())) AS vouched
        FROM (
          -- Each candidate row's two texts hashed ONCE, behind an OFFSET 0:
          -- read inline, the planner hashed them in every place the value is
          -- used — four sha256 of a 100 KB text per update row, the whole cost
          -- of a pass on a brain of long thoughts (third review pass, measured:
          -- 17.6 s at 100,000 thoughts with a tenth at 100 KB, of which the
          -- hashing of the update rows' texts was 15.9).
          SELECT a.actor_kind, a.actor_name, a.canonical_agent_id, a.action, a.created_at, a.seq,
                 a.trust, a.actor_context,
                 (a.action = 'update' AND a.diff ? 'restamped') AS restamped,
                 (a.action = 'update' AND a.diff ? 'restamp_reset') AS reset,
                 (a.action = 'update' AND NOT (a.diff ? 'restamped') AND NOT (a.diff ? 'restamp_reset')) AS texted,
                 content_fingerprint_of(a.diff->'content'->>'before') AS fb,
                 content_fingerprint_of(a.diff->'content'->>'after')  AS fa
          FROM thought_audit a
          WHERE a.thought_id = t.id
            AND (a.action = 'capture' OR (a.action = 'update' AND (a.diff ? 'content' OR a.diff ? 'restamped' OR a.diff ? 'restamp_reset')))
          OFFSET 0
        ) a
        -- A content-writing row by the trigger's rule: a capture, or an update
        -- whose text CHANGED by 003's normalised fingerprint — 018's unchanged
        -- edit (case, whitespace) is in the diff and is not a change of writer,
        -- on the row or here (first review pass: the two disagreed, and a pass
        -- rewrote the trigger's stamp). 085: and a re-capture that moved the
        -- stamp. 086: and the operator's reset, which no row vouches through:
        -- it is here to end the restamps before it.
        WHERE a.action = 'capture' OR a.fb IS DISTINCT FROM a.fa OR a.restamped OR a.reset
        -- The rows after this one, newest first: a restamp vouches only when
        -- each of them is another restamp (none for the newest row). By seq
        -- alone: created_at is the transaction's clock, and an edit that
        -- began before a restamp and committed after it carries the earlier
        -- one — by it the restamp read as newer, and the backfill gave the
        -- edit's text to the restamp's key (review pass 1, on two
        -- connections). A restamp is written after 050, so its seq is exact
        -- against every row.
        WINDOW newer AS (ORDER BY a.seq DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
        -- The row whose text stands first; then the newest transaction; then
        -- the order inside it. Not seq alone (second review pass — see the
        -- header): a pre-050 seq is heap order, and heap order lies after
        -- 046's amendments and a VACUUM. 085: a vouched restamp ahead of all.
        -- 086: then the vouched capture ahead of a reset, which is newer and
        -- vouches nothing (before 086 a vouched capture was the only row).
        ORDER BY (a.restamped AND COALESCE(bool_and(a.restamped) OVER newer, true)) DESC,
                 (a.texted AND a.fa IS NOT DISTINCT FROM f.fp) DESC,
                 (a.action = 'capture' AND NOT bool_or(a.texted) OVER ()) DESC,
                 a.created_at DESC, a.seq DESC
        LIMIT 1
      ) w ON true
      WHERE t.metadata IS NULL OR jsonb_typeof(t.metadata) = 'object'
    ) d
    -- 073: the trust, never raised (see the header comment): the log's, or
    -- the claim's for a write its key could not yet support, under the key's
    -- kind now (b) — then under the row's own word, which only lowers a trust
    -- the log supports: where b is none the row gets none (an unvouched
    -- text's word goes with its marks — second review pass), and a word off
    -- the ladder caps nothing (ob1_trust_ceiling places none).
    CROSS JOIN LATERAL (
      SELECT CASE WHEN b.trust IS NOT NULL THEN ob1_trust_ceiling(b.trust, d.present_trust) END AS trust
        FROM (SELECT CASE WHEN d.w_trust IS NOT NULL THEN ob1_trust_ceiling(d.kind, d.w_trust)
                          ELSE ob1_trust_ceiling(d.kind, d.w_claimed) END AS trust) b
    ) x
  $scan$, v_tbl);

  EXECUTE format('SELECT count(*) FILTER (WHERE differs), count(*) FILTER (WHERE awaiting) FROM %I', v_tbl)
    INTO v_differ, v_awaiting;

  IF v_differ > 0 THEN
    -- The stamp trigger takes the keys as given under this setting; the audit
    -- row each write leaves names the door and nobody. Both restored below —
    -- a hand call must not leave the transaction's actor changed.
    PERFORM set_config('ob1.actor_amend', 'backfill', true);
    PERFORM set_config('ob1.actor', '{"via": "backfill_thought_actors"}', true);
    -- EXCLUSIVE, as 023 takes it, BEFORE the ALTER: the ALTER's own SHARE ROW
    -- EXCLUSIVE does not conflict with the ROW SHARE update_thought holds on
    -- its row between its lock and its UPDATE, so a pass that met an edit in
    -- flight waited on the row while the edit waited on the table — a
    -- deadlock, the pass the victim (run-it, first review pass, reproduced).
    -- EXCLUSIVE conflicts with ROW SHARE, so the pass waits its turn instead;
    -- readers (ACCESS SHARE) proceed. Held to commit, which is why each call
    -- is its own transaction; lock_timeout 10 s aborts it cleanly.
    LOCK TABLE thoughts IN EXCLUSIVE MODE;
    -- A stamp is not an edit: 001's trigger would bump updated_at on every
    -- row written, and 018's stale-read guard and 021's evidence rule both
    -- read it. Held off for the write, to commit, as 023 holds it.
    ALTER TABLE thoughts DISABLE TRIGGER thoughts_updated_at;

    EXECUTE format($write$
    UPDATE thoughts t
       SET metadata = (COALESCE(t.metadata, '{}'::jsonb) - 'actor_kind' - 'actor_name' - 'trust')
                      || CASE WHEN d.kind IS NOT NULL THEN jsonb_build_object('actor_kind', d.kind) ELSE '{}'::jsonb END
                      || CASE WHEN d.name IS NOT NULL THEN jsonb_build_object('actor_name', d.name) ELSE '{}'::jsonb END
                      || CASE WHEN d.trust IS NOT NULL THEN jsonb_build_object('trust', d.trust) ELSE '{}'::jsonb END
      FROM (SELECT id, updated_at, kind, name, trust FROM %I WHERE differs LIMIT %s) d
     WHERE t.id = d.id
       -- Re-checked on the locked row: a thought edited since the scan has a
       -- newer writer, stamped by the trigger; it is left for the next pass.
       AND t.updated_at IS NOT DISTINCT FROM d.updated_at
       -- …and one another pass marked meanwhile — updated_at held still, so
       -- the marks themselves are compared — is not written or counted again
       -- (run-it, first review pass: two passes each reported every row).
       AND (t.metadata->>'actor_kind' IS DISTINCT FROM d.kind OR (d.kind IS NULL AND t.metadata ? 'actor_kind')
            OR t.metadata->>'actor_name' IS DISTINCT FROM d.name OR (d.name IS NULL AND t.metadata ? 'actor_name')
            OR t.metadata->>'trust' IS DISTINCT FROM d.trust OR (d.trust IS NULL AND t.metadata ? 'trust'))
    $write$, v_tbl, COALESCE(p_limit::text, 'ALL'));
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    ALTER TABLE thoughts ENABLE TRIGGER thoughts_updated_at;
    PERFORM set_config('ob1.actor', COALESCE(v_prev_actor, ''), true);
    PERFORM set_config('ob1.actor_amend', COALESCE(v_prev_amend, ''), true);
  END IF;

  RETURN jsonb_build_object('ok', true, 'rows', v_rows, 'differing', v_differ, 'awaiting', v_awaiting);
END;
$$;

COMMENT ON FUNCTION backfill_thought_actors(integer) IS
  'Sets metadata.actor_kind, metadata.actor_name and (since 073) metadata.trust on every thought to what thought_audit derives for the write of its current content — the update row whose after-text is the row''s text, else the capture when no update ever changed the text (update rows present and none matching: nobody), the newest by created_at then seq among matches — or, since 085, the newest re-capture that moved the stamp (ob1_restamp_recapture''s event, `restamped` in its diff) when no text-writing row came after it by seq: ob1_registry_kind for its id or name NOW (so a reclassified key reaches its rows) else the actor_kind 046 stamped, its actor_name, and a trust that is never raised — the lowest of the trust that write recorded (thought_audit.trust; or, recorded none, the claim it filed under actor_context.claimed while its key was unclassified), that kind now, and the row''s own metadata.trust when it is a ladder word, none where the log supports none — wherever the row and the log disagree, stripping a mark no audit row vouches for. Returns {ok, rows (written this call), differing (found disagreeing), awaiting (writer named but unclassified — set_agent_kind, then this)}. p_limit (at least 1) bounds the rows written and the write lock per call, not the scan (every call derives every thought) nor the audit rows (one per row written); each call its own transaction. Holds the updated_at trigger for the write (a stamp is not an edit), which needs the table''s owner; each row written leaves an audit row whose origin is backfill_thought_actors. Idempotent: a second pass finds nothing. Since 086 a restamp with the operator''s reset after it (ob1_reset_capture_stamp''s "restamp_reset" event, by seq) is no writer, and the capture is again when no update changed the text. Migration 050 / SMD-1726; trust 073 / SMD-1724; the restamp 085 / SMD-2664; the reset 086 / SMD-2744.';
