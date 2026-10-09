-- =============================================================================
-- Migration 083: a capture-only key's stamp yields to a re-capture by a key
--                that can read at a higher trust — the row's marks and trust
--                move to that key (SMD-2664)
-- =============================================================================
--
-- WHY
--   A capture-only key (scope `capture`) may declare a trust below its kind:
--   the Chrome extension labels every capture `ingested`, and 073 stamps the
--   declaration on the row beside the key's two marks. When a write key
--   later captures the same text, the capture lands on that row (035) and
--   050's same-text arm keeps the stamp: the actor follows the content, and
--   the content is unchanged. So the writer's thought kept the capture key's
--   `trust`, `actor_kind` and `actor_name` — it dropped out of every
--   min_trust read above `ingested` and carried the outside-text notice in
--   the prose tools, though the writer's own capture would have been stamped
--   at its kind had it come first (SMD-2638 review pass 1, P12, on the real
--   server). 082 ends the capture key's OWNERSHIP of such a row; the stamp is
--   a separate fact, and stayed.
--
-- WHAT
--   * ob1_restamp_recapture(id, fingerprint, actor, declared) — the stores
--     call it when a capture by a key that can read (no p_payload.recapture =
--     'keep') landed on a row that already held the text, after 082's note.
--     It locks the row as update_thought does, and moves nothing unless:
--       - the actor in force is not a capture-only key's (`"scope":
--         "capture"`, passed or already the session's ob1.actor) — that key
--         keeps the row under 080;
--       - the row's fingerprint is still the one the caller captured — the
--         text did not move between the capture and this call;
--       - the row's stamp is still a capture-only key's: its capture row
--         carries 082's `"scope": "capture"` mark, and no update since has
--         changed the text (by 003's fingerprint) or restamped it. A lowering
--         a key that can read declared — the operator's own `ingested` — is
--         that key's statement about its text, and stands under 050's rule
--         (review pass 1: an agent key re-sending the operator's outside text
--         verbatim relabelled it);
--       - no other agent has been weighed on the row (below);
--       - the writer is classified: the stamp the write would have put on a
--         new text (ob1_actor_stamp with the write's declared trust, the
--         event's as the server sends it) names an actor_kind. An
--         unclassified writer, or a call with no actor, is weighed for
--         nothing and records nothing.
--     A classified writer is weighed: that stamp's trust against the row's
--     (ob1_trust_rank: operator > agent > ingested > none). Strictly higher,
--     it appends one update event — the metadata with the writer's
--     actor_kind, actor_name and trust, and `restamped` in the diff — and
--     projects it; the whole stamp moves, not the trust alone, so a row's
--     trust is never above the kind its marks name, and once moved, no later
--     re-capture moves it. Not higher, it records the decline once per agent
--     — an update event, diff `{"restamp_declined": true}` — and moves
--     nothing. Either event moves updated_at, as 082's note does.
--     A decline settles the row against every other agent: the first
--     classified key that can read to land on it is the one weighed against
--     the capture key (review pass 2: a capture key's outside text, the
--     operator's equal `ingested` re-capture of it recorded nothing, and an
--     agent key's re-send after it relabelled the text). The same agent's
--     own later landing may still move it — the same by agent id, so a
--     decline naming none (a name-only writer) settles the row for every
--     caller. The record is this function's own: 082's note is written by
--     conditions of its own — for unclassified keys and calls with no actor
--     too, and not on a row it counts as taken — and settled rows wrongly
--     when read (review pass 3).
--     So when a capture-only key captured a text first, the first classified
--     key that can read to capture it after leaves the higher of their two
--     trusts; a key that can read that captured first keeps its own stamp,
--     its lowering included.
--   * backfill_thought_actors — 073's pass, deriving a row's writer from the
--     log: a restamp event with no text-writing row after it, by seq, is now
--     that writer, so a pass after a restamp derives the stamp the row
--     carries rather than the lower one before it. A decline is no writer.
--     Every other row derives as before. Not called here: no restamp event
--     exists before this file, so a pass would find what 073's found.
--
-- NOT HERE
--   * A re-capture before this file. Its update event, when the merge wrote
--     one, cannot be told from a metadata edit, and one that changed nothing
--     wrote none (046's gate); no decline is on such a row, so the first
--     classified key that can read to land after the upgrade is weighed.
--   * A capture-only key's row from before SMD-2638's scope mark: nothing
--     says whose it is, and it keeps its stamp.
--   * Settling low. The first classified writer settles the row whatever it
--     declared: an agent key declaring `ingested`, or an `ingested`-kind key,
--     landing first leaves the capture key's stamp and refuses the operator
--     after it. And over a row with no trust (an unclassified capture key's)
--     an `ingested` writer is higher, so it moves the stamp — once, to
--     `ingested`. Both keep trust low, the direction a label may err in.
--   * A name-only writer: one whose registry lookup failed — an outage, or a
--     misconfiguration such as a role not re-granted after an upgrade, for
--     as long as it lasts — or was refused (the registry rejecting the key's
--     label or digest), and board-sync, whose actor never carries an agent
--     id. Its decline names no agent, so it settles the row for every
--     caller, that writer's own later landings included.
--   * Two live keys on one agent id (a key renamed and a new key given its
--     old name, which 010's rotation reads as one agent): one's decline is
--     the other's own. The registry's to fix, as it is for 082's and
--     SMD-2473's agent checks.
--   * A decline moves updated_at with nothing visible changed, so a client's
--     update_thought holding an earlier if_unchanged_since is refused as a
--     stale read — once per row, as 082's note is.
--   * A metadata edit (update_thought, a raw UPDATE) leaving the text: still
--     050's rule, the stamp kept. Board-sync's metadata patch adopting a row
--     in place is such an edit; its capture that lands on a row in the
--     instant before (db/sync-linear.ts's `existed` path) is a re-capture
--     like any other — weighed only if the operator classified board-sync.
--   * A caller of upsert_thought outside the stores (a recipe or script
--     calling it directly) restamps nothing: only the stores call this
--     function.
--   * A text change written with the audit trigger off after a restamp: the
--     backfill cannot see it, and the restamp's key stands — where 073, with
--     text-changing update rows none of which matches the standing text,
--     derives nobody. A restamp carries no text to check.
--   * SMD-2653 (a capture-only key's metadata.importance read by the weekly
--     digest) is the same family — a value one key set on a row other keys
--     come to hold — and its own ticket.
--
-- Idempotent: CREATE OR REPLACE throughout.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regprocedure('ob1_append_thought_event(uuid, text, text, jsonb, jsonb)') IS NULL
     OR to_regprocedure('ob1_project_thought_event(uuid, vector, text, boolean)') IS NULL
     OR to_regprocedure('ob1_actor_stamp(jsonb, text)') IS NULL
     OR to_regprocedure('ob1_trust_rank(text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 083 needs 055, 060, 073 and 074 (ob1_append_thought_event, ob1_project_thought_event, ob1_actor_stamp, ob1_trust_rank); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. A capture-only key's stamp yields to a higher re-capture.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_restamp_recapture(p_id uuid, p_fingerprint text, p_actor jsonb DEFAULT NULL, p_declared text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_meta jsonb;
  v_fp   text;
  v_new  jsonb;
  v_ev   uuid;
  v_agent uuid;
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
                 WHERE u.thought_id = p_id AND u.action = 'update' AND u.diff ? 'restamped') THEN
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
                AND (d.canonical_agent_id IS NULL OR v_agent IS NULL OR d.canonical_agent_id <> v_agent)) THEN
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
                                         AND d.canonical_agent_id = v_agent) THEN
      v_ev := ob1_append_thought_event(p_id, 'update', v_meta->>'source', '{"restamp_declined": true}'::jsonb,
                                       jsonb_build_object('trust', v_new->>'trust'));
      IF v_ev IS NOT NULL THEN
        PERFORM ob1_project_thought_event(v_ev);
      END IF;
    END IF;
    RETURN false;
  END IF;
  -- The trust it lands at is the event's declaration, so the audit row's
  -- trust is the row's — and a declaration above the key's kind, clamped by
  -- the stamp, is not filed a second time (the capture's own event did).
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
  'Moves a capture-only key''s stamp to the key whose capture just landed on its row, when that key''s trust is higher: called by the stores after a capture without p_payload.recapture = ''keep'' (a key that can read) landed on an existing row, after ob1_note_recapture. Sets ob1.actor from p_actor (008''s envelope) and locks the row. Moves nothing when the actor in force carries "scope": "capture", the row''s fingerprint is no longer p_fingerprint (the text moved since the capture), its metadata is not an object, or its stamp is not still a capture-only key''s — its capture row carries no "scope": "capture", or an update since changed the text or restamped it — or another agent''s decline is on it (a "restamp_declined" update event this function wrote: the first classified key that can read to land settles the row; a decline naming no agent id — a name-only writer — is no caller''s own, so it settles the row for every caller). Otherwise computes the stamp the write would have put on a new text (ob1_actor_stamp with p_declared, the write event''s trust). An unclassified writer (no actor_kind) moves and records nothing. A classified one whose trust does not rank strictly above the row''s (ob1_trust_rank) records the decline once per agent — an update event, diff {"restamp_declined": true}, only updated_at moving — and moves nothing. One whose trust does appends one update event — the metadata with the writer''s actor_kind, actor_name and trust, and "restamped": true in the diff, the event declaring that trust — and projects it. Returns whether it moved the stamp. backfill_thought_actors reads the event as the stamp''s writer. Migration 083 / SMD-2664.';

-- ---------------------------------------------------------------------------
-- 2. backfill_thought_actors — 073's body; a restamp is a writer.
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
   * 083: a re-capture that moved the stamp — ob1_restamp_recapture's event,
   * `restamped` in its diff — writes no text, and is the writer when no
   * text-writing row came after it by seq, the newest such: that re-capture's key
   * wrote the stamp the row carries, at a trust above the one before it, and
   * a pass must not put the lower one back (SMD-2664). Its kind is the
   * registry's now, as for any writer.
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
               -- 083: a restamp, when every row after it is another restamp.
               -- The two arms after it need no change: a restamp that does
               -- not vouch has a text-changing update after it, so f.fp is
               -- the row's hash, no capture vouches and no restamp's NULL
               -- after-text matches. (With no text-carrying update, f.fp is
               -- NULL and a restamp matches the update arm too — and vouches
               -- by this one anyway.)
               ((a.restamped AND COALESCE(bool_and(a.restamped) OVER newer, true))
                OR (a.action = 'update' AND a.fa IS NOT DISTINCT FROM f.fp)
                OR (a.action = 'capture' AND NOT bool_or(a.action = 'update') OVER ())) AS vouched
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
                 content_fingerprint_of(a.diff->'content'->>'before') AS fb,
                 content_fingerprint_of(a.diff->'content'->>'after')  AS fa
          FROM thought_audit a
          WHERE a.thought_id = t.id
            AND (a.action = 'capture' OR (a.action = 'update' AND (a.diff ? 'content' OR a.diff ? 'restamped')))
          OFFSET 0
        ) a
        -- A content-writing row by the trigger's rule: a capture, or an update
        -- whose text CHANGED by 003's normalised fingerprint — 018's unchanged
        -- edit (case, whitespace) is in the diff and is not a change of writer,
        -- on the row or here (first review pass: the two disagreed, and a pass
        -- rewrote the trigger's stamp). 083: and a re-capture that moved the
        -- stamp.
        WHERE a.action = 'capture' OR a.fb IS DISTINCT FROM a.fa OR a.restamped
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
        -- 046's amendments and a VACUUM. 083: a vouched restamp ahead of all.
        ORDER BY (a.restamped AND COALESCE(bool_and(a.restamped) OVER newer, true)) DESC,
                 (a.action = 'update' AND a.fa IS NOT DISTINCT FROM f.fp) DESC,
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
  'Sets metadata.actor_kind, metadata.actor_name and (since 073) metadata.trust on every thought to what thought_audit derives for the write of its current content — the update row whose after-text is the row''s text, else the capture when no update ever changed the text (update rows present and none matching: nobody), the newest by created_at then seq among matches — or, since 083, the newest re-capture that moved the stamp (ob1_restamp_recapture''s event, `restamped` in its diff) when no text-writing row came after it by seq: ob1_registry_kind for its id or name NOW (so a reclassified key reaches its rows) else the actor_kind 046 stamped, its actor_name, and a trust that is never raised — the lowest of the trust that write recorded (thought_audit.trust; or, recorded none, the claim it filed under actor_context.claimed while its key was unclassified), that kind now, and the row''s own metadata.trust when it is a ladder word, none where the log supports none — wherever the row and the log disagree, stripping a mark no audit row vouches for. Returns {ok, rows (written this call), differing (found disagreeing), awaiting (writer named but unclassified — set_agent_kind, then this)}. p_limit (at least 1) bounds the rows written and the write lock per call, not the scan (every call derives every thought) nor the audit rows (one per row written); each call its own transaction. Holds the updated_at trigger for the write (a stamp is not an edit), which needs the table''s owner; each row written leaves an audit row whose origin is backfill_thought_actors. Idempotent: a second pass finds nothing. Migration 050 / SMD-1726; trust 073 / SMD-1724; the restamp 083 / SMD-2664.';
