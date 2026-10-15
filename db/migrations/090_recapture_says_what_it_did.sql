-- =============================================================================
-- Migration 090: a re-capture over a capture-only key's label says what it
--                did — moved the label to the caller, kept it, found it
--                settled, or weighed nothing — and the stamp the row carries
--                after (SMD-2898)
-- =============================================================================
--
-- WHY
--   Under 085 (and 086's reset) a key that can read re-capturing a
--   capture-only key's text moves the row's label to it or keeps it and
--   records a decline, and either settles the row against every other key
--   (a name-only key's decline, against every key).
--   ob1_restamp_recapture answered a boolean, which the stores dropped, so
--   capture_thought's reply said none of it: not that the text landed on an
--   existing thought, not whether the label moved, not that the row is now
--   settled — only thought_changes did. Every walkthrough of SMD-2744's
--   review passes ran into it: a client that re-captured text could not
--   tell whether it now held the label, nor that the reset (086) was the way
--   out. The answer is read inside the call, with the row locked: SMD-2744's
--   second PR read its row back after the write, and each of four review
--   passes found a new seam in that read.
--
-- WHAT
--   * ob1_weigh_recapture(id, fingerprint, actor, declared) — 086's
--     ob1_restamp_recapture body, its guards, lock, reads, events and
--     sentinels as they were; what it answers is what each branch found:
--       - `moved`: the stamp moved to the caller — `stamp` the caller's
--         (the row's after), `before` the capture-only key's it replaced;
--       - `kept`: weighed now and not higher — the row's decline recorded,
--         or the caller's own already on it — `weighed` the trust it was
--         weighed at, `own` whether the caller has an agent id (085 weighs a
--         key's own later landing again only by its id: a name-only decline
--         settles the row for every caller, the decliner's own included);
--       - `settled`: not weighed — a restamp (`by: "restamp"`, `mine` when
--         the stamp names the caller) or a decline (`by: "decline"`: another
--         key's, or a name-only key's own; `decliner` its key's name,
--         `decliner_weighed` whether it names an agent id, by which 085 still
--         weighs that key's own later landing) since the row's latest reset —
--         while no update since moved the text's fingerprint. 085 settles a row only while its text
--         is the captured one, and 086's reset refuses a row whose text moved,
--         so a fingerprint moved in the log is a change of text after the
--         settle, the label the editor's — the restamper's own edit included —
--         and the answer `none`. The update's diff says so (055's
--         `content_fingerprint`), so a settled row still hashes nothing (085's
--         review pass 5);
--       - `unweighed`: the caller's key has no kind, so nothing was weighed
--         and this call recorded nothing;
--       - `none`: not a capture-only key's label to weigh — a capture-scoped
--         caller, the row gone or its metadata not an object, the text moved
--         since the capture, no scope mark on its capture row, or a change of
--         text since.
--     `stamp` is the row's actor_kind, actor_name and trust after the call
--     (a key the row lacks is absent), on every outcome but `none`.
--   * ob1_restamp_recapture — kept, its signature and boolean answer as 085
--     made them (a return type cannot change in place, and 085's and 086's
--     CREATE OR REPLACE re-applied over a jsonb form would fail): it calls
--     ob1_weigh_recapture and answers whether the label moved. A server
--     before this file calls it and moves the label as before.
--
-- NOT HERE
--   * The server's reply (render.ts) and the stores' reading of the answer:
--     the server's change, beside this one. This server calls
--     ob1_weigh_recapture, falls back to ob1_restamp_recapture on a database
--     before 090 — which moves the label and answers nothing, so the reply
--     is as it was — and to nothing before 085.
--   * A plain re-capture of a row that is not a capture-only key's: `none`,
--     and the reply says what it said.
--   * A raw content UPDATE that leaves the fingerprint stale (055 records no
--     move): on a settled row it reads `settled` where the reset, which
--     hashes, refuses. Telling it from a whitespace edit — both a content
--     diff with no fingerprint move — would hash each edit under the row
--     lock, the cost 085's review pass 5 removed; a raw writer's row only.
--   * The converse, a raw `SET content_fingerprint = NULL` and a refill
--     (backfill_content_fingerprints, or an edit's re-save): a fingerprint
--     move with no change of text, so a settled row reads `none` — the note
--     silenced, never false. "A move came after the settle" holds for what
--     the write functions record.
--   * The fingerprint read detoasts each update's diff since the latest
--     reset; it hashes nothing.
--
-- Idempotent: CREATE OR REPLACE throughout.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regprocedure('ob1_restamp_recapture(uuid, text, jsonb, text)') IS NULL
     OR to_regprocedure('ob1_reset_capture_stamp(uuid, jsonb)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 090 needs 085 and 086 (ob1_restamp_recapture, ob1_reset_capture_stamp); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. ob1_weigh_recapture — 086's body; it answers what it did.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_weigh_recapture(p_id uuid, p_fingerprint text, p_actor jsonb DEFAULT NULL, p_declared text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_meta   jsonb;
  v_fp     text;
  v_new    jsonb;
  v_ev     uuid;
  v_agent  uuid;
  v_since  bigint;
  v_stamp  jsonb;
  v_settle text;
  v_by     text;
  v_byid   boolean;
  c_none   CONSTANT jsonb := '{"outcome": "none"}';
BEGIN
  -- 005's guard, for the actor as upsert_thought reads it from its envelope.
  IF p_actor IS NOT NULL AND jsonb_typeof(p_actor) <> 'object' THEN
    RAISE EXCEPTION
      'ob1_weigh_recapture: p_actor must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
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
    RETURN c_none;
  END IF;
  -- The row locked as update_thought locks it, so an edit and a second
  -- re-capture are serialised with this one, and each reads the log the
  -- other left.
  SELECT metadata, content_fingerprint INTO v_meta, v_fp FROM thoughts WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND OR jsonb_typeof(v_meta) IS DISTINCT FROM 'object' THEN
    RETURN c_none;  -- gone, or a raw writer's metadata, which no stamp reaches (050)
  END IF;
  -- The text the caller captured is the text that stands: an edit between
  -- the capture and this call put a text there this writer never sent.
  IF p_fingerprint IS NULL OR v_fp IS DISTINCT FROM p_fingerprint THEN
    RETURN c_none;
  END IF;
  -- 090: the row's stamp as it stands, under the lock — every answer but a
  -- move's and none's names it (SMD-2898).
  v_stamp := COALESCE((SELECT jsonb_object_agg(k.key, k.value) FROM jsonb_each(v_meta) k
                        WHERE k.key IN ('actor_kind', 'actor_name', 'trust')), '{}'::jsonb);
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
                    AND c.actor_context->>'scope' = 'capture') THEN
    RETURN c_none;
  END IF;
  -- The caller's id, read from the actor in force by 010's pattern, so a
  -- malformed setting is no id (086 read it after the restamp below; it
  -- reads nothing).
  v_agent := CASE WHEN ob1_current_actor()->>'agent_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN (ob1_current_actor()->>'agent_id')::uuid END;
  -- 090: a restamp since the latest reset settled the row; `mine` when the
  -- stamp names the caller — by name, as the stamp holds it: the reply says
  -- whose the label is.
  IF EXISTS (SELECT 1 FROM thought_audit u
              WHERE u.thought_id = p_id AND u.action = 'update' AND u.diff ? 'restamped'
                AND (v_since IS NULL OR u.seq > v_since)) THEN
    v_settle := 'restamp';
  ELSE
    -- ob1:recapture-weighed-once — a CONTRACT SENTINEL, not prose (the 014
    -- convention). The first classified key that can read to land on the row
    -- settles it: its trust is weighed against the capture key's once, and
    -- the row moves to it or is left — left, it records so below. A later
    -- key does not get a second weighing: the operator re-capturing a
    -- capture key's outside text declaring `ingested` moved nothing, and an
    -- agent key re-sending it after must not relabel it (review pass 2). The
    -- record is this function's own, not 082's note, which 082 writes by
    -- conditions of its own — for an unclassified key and a call with no
    -- actor too, neither of which can move the stamp, and not for a row it
    -- counts as taken (review pass 3). The same agent's own later landing
    -- may — the same by agent id; a decline naming none (a name-only writer:
    -- board-sync, or a key whose registry lookup failed or was refused) is
    -- never the caller's own.
    -- 090: the decline read with its key — whose own later landing 085 still
    -- weighs when the decline names its agent id (review pass 2 of SMD-2898:
    -- the reply told other keys the row was fixed while the decliner could
    -- still move it).
    SELECT NULLIF(btrim(d.actor_name), ''), d.canonical_agent_id IS NOT NULL INTO v_by, v_byid
      FROM thought_audit d
     WHERE d.thought_id = p_id AND d.action = 'update' AND d.diff ? 'restamp_declined'
       AND (d.canonical_agent_id IS NULL OR v_agent IS NULL OR d.canonical_agent_id <> v_agent)
       AND (v_since IS NULL OR d.seq > v_since)
     ORDER BY d.seq LIMIT 1;
    IF FOUND THEN
      v_settle := 'decline';
    END IF;
  END IF;
  IF v_settle IS NOT NULL THEN
    -- 090: a settled row whose text moved since reads `none`, as the log's
    -- own record of a fingerprint moving says (055): 085 settles a row only
    -- while the text is the captured one, and 086's reset refuses a row
    -- whose text moved, so such a move is one after the settle, and the
    -- label the editor's (review pass 1 of SMD-2898: the restamper's own
    -- edit kept the restamper's name on the stamp, and the reply named a
    -- reset that refuses).
    IF EXISTS (SELECT 1 FROM thought_audit e
                WHERE e.thought_id = p_id AND e.action = 'update' AND e.diff ? 'content_fingerprint'
                  AND (v_since IS NULL OR e.seq > v_since)) THEN
      RETURN c_none;
    END IF;
    -- A decline left the capture-only key's stamp.
    RETURN CASE v_settle
             WHEN 'restamp' THEN jsonb_build_object('outcome', 'settled', 'by', 'restamp', 'stamp', v_stamp,
                                                    'mine', COALESCE(ob1_actor_stamp(v_meta, p_declared)->>'actor_name' = v_stamp->>'actor_name', false))
             ELSE jsonb_build_object('outcome', 'settled', 'by', 'decline', 'stamp', v_stamp, 'decliner', v_by, 'decliner_weighed', v_byid)
           END;
  END IF;
  -- A text change since the capture put the editor's stamp there (by 003's
  -- fingerprint: 018's unchanged edit keeps the stamp, so it is not one).
  IF EXISTS (SELECT 1 FROM thought_audit u
              WHERE u.thought_id = p_id AND u.action = 'update' AND u.diff ? 'content'
                AND content_fingerprint_of(u.diff->'content'->>'before')
                    IS DISTINCT FROM content_fingerprint_of(u.diff->'content'->>'after')) THEN
    RETURN c_none;
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
    -- weighed nothing: an unclassified writer settles nothing
    RETURN jsonb_build_object('outcome', 'unweighed', 'stamp', v_stamp);
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
    RETURN jsonb_build_object('outcome', 'kept', 'stamp', v_stamp, 'weighed', v_new->'trust', 'own', v_agent IS NOT NULL);
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
    RETURN c_none;
  END IF;
  PERFORM ob1_project_thought_event(v_ev);
  RETURN jsonb_build_object('outcome', 'moved',
                            'stamp', COALESCE((SELECT jsonb_object_agg(k.key, k.value) FROM jsonb_each(v_new) k
                                                WHERE k.key IN ('actor_kind', 'actor_name', 'trust')), '{}'::jsonb),
                            'before', v_stamp);
END;
$$;

COMMENT ON FUNCTION ob1_weigh_recapture(uuid, text, jsonb, text) IS
  'Weighs a re-capture against a capture-only key''s label and says what it did (SMD-2898): called by the stores after a capture without p_payload.recapture = ''keep'' (a key that can read) landed on an existing row, after ob1_note_recapture. 086''s ob1_restamp_recapture body — sets ob1.actor from p_actor (008''s envelope), locks the row, and moves the stamp to the caller when its trust ranks strictly above the row''s (ob1_trust_rank), recording a decline once per agent when it does not (085, 086) — answering, from inside the call: {outcome:"moved", stamp, before} when the stamp moved (stamp the caller''s, before the capture-only key''s); {outcome:"kept", stamp, weighed, own} when weighed now and not higher (the decline recorded, or the caller''s own already on the row; weighed the trust it was weighed at; own whether the caller has an agent id, by which alone 085 weighs a key''s later landing again); {outcome:"settled", by, stamp, mine | decliner, decliner_weighed} when a restamp (by "restamp", mine when the stamp names the caller) or a decline — another key''s, or a name-only key''s own (by "decline", decliner its key''s name, decliner_weighed whether it names an agent id, by which 085 still weighs that key''s own later landing) — since the row''s latest reset settled it; {outcome:"unweighed", stamp} when the caller''s key has no kind, so nothing was weighed or recorded; {outcome:"none"} when the label is not a capture-only key''s to weigh — a capture-scoped caller, the row gone or its metadata not an object, the fingerprint no longer p_fingerprint, no "scope": "capture" capture row, or a change of text since (by content_fingerprint_of; on a settled row, an update since the latest reset whose diff moved content_fingerprint — a raw edit leaving the fingerprint stale is not seen there). stamp is the row''s actor_kind, actor_name and trust after the call. Migration 090 / SMD-2898, on 085 / SMD-2664 and 086 / SMD-2744.';

-- ---------------------------------------------------------------------------
-- 2. ob1_restamp_recapture — 085's boolean, over the answer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_restamp_recapture(p_id uuid, p_fingerprint text, p_actor jsonb DEFAULT NULL, p_declared text DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT COALESCE(ob1_weigh_recapture(p_id, p_fingerprint, p_actor, p_declared)->>'outcome' = 'moved', false);
$$;

COMMENT ON FUNCTION ob1_restamp_recapture(uuid, text, jsonb, text) IS
  'Moves a capture-only key''s stamp to the key whose capture just landed on its row, when that key''s trust is higher — 085''s function, its signature and answer kept: since 090 it calls ob1_weigh_recapture, which holds the body (086''s: the declines and restamp read since the row''s latest reset), and returns whether the stamp moved. A server before 090 calls it; this server calls ob1_weigh_recapture, which says what it did. Migration 085 / SMD-2664; the reset 086 / SMD-2744; the answer 090 / SMD-2898.';
