-- =============================================================================
-- Migration 094: a proposal's review names who wrote each side —
--                list_proposal_writers returns each listed side's writer,
--                trust, whether its text is a capture-only key's, and what
--                supersedes it, so a reviewer can see that the side proposed
--                to stand came from a capture-only key (SMD-2707)
-- =============================================================================
--
-- WHY
--   A reviewer decides a supersession proposal from what db/consolidate.ts
--   --list and the list_supersession_proposals tool print: both texts (cut
--   at 160 or 200 characters), their dates and ids, the judge's verdict and
--   reason — nothing of who wrote either side. SMD-1873's review pass 3
--   proved the consequence on a scratch server: a capture-only key wrote a
--   near-copy of a write key's thought, the judge proposed the copy to
--   stand, the cut texts read the same, and the accept put the capture
--   key's thought over the write key's. 092 (SMD-2708) stops the key passing
--   that standing on; nothing showed the reviewer the writers. An
--   `outdates` whose newer side a capture-only key wrote ("the rota is now
--   daily") is the same blindness. 070's listing carries no writer: its
--   columns are the queue's, both texts and their fingerprints' moves.
--
-- WHAT
--   1. ob1_capture_only_text(id): whether the thought's text is still a
--      capture-only key's alone — its first capture row (the one
--      ob1_capturer_of reads, 082) carries "scope": "capture" in its
--      actor_context, which the server writes for such a key (SMD-1298), and
--      082's log has not taken it (ob1_capture_taken_by_log, 092: no key that
--      can read re-captured it, no text move, no adoption — each puts another
--      writer behind the text). Not the chain: an accept's taking leaves the
--      text the key's. One definition for the listing and db/consolidate.ts's
--      accept guard.
--   2. ob1_accept_takes(side, other): 092's taken read with the side's
--      pointer read as the other — whether an accept making the side stand
--      takes it from its capturer. And ob1_accept_lapses(side, other): 092's
--      lapse read and not written, the pointers that accept would clear, as
--      [{id, onto}] — none when the accept writes no event (the side already
--      points somewhere, or the pointer would loop or run past
--      update_thought's walk) or does not take the side; then its capturer's
--      capture-scoped pointers onto it and up the chain, and on from a
--      cleared row 082's log already took. Kept in step with
--      ob1_lapse_capture_pointers by hand, as 092's check and lapse are kept
--      with each other. Review pass 1: a mark read off the first superseder
--      alone missed pointers further up and claimed a lapse when one key
--      captured both sides; pass 2: it promised lapses for accepts 029
--      refuses, and said the side read current again where the cleared
--      pointer was onto a row above it.
--   3. list_proposal_writers(ids): per proposal named (any status, at most
--      200 ids read), each side's (older_, newer_) actor_name, actor_kind
--      and trust (the row's metadata keys 050 and 073 stamp, as the read
--      tools' `By:` line prints them), capture_only, superseded_by (the first
--      thought whose supersedes names it, by created_at, then id), lapses
--      (none on an accepted row) and takes; and same_capturer (both sides'
--      capturers one agent; NULL is no one's, so never the same). The
--      sentinel `ob1:listing-names-the-writers` marks the body.
--      A companion, not a redefinition of 070's listing: a RETURNS TABLE
--      cannot gain a column under CREATE OR REPLACE, and a listing dropped
--      and created with more columns under 070's arguments would break every
--      re-apply after it — 070, re-applied in order (--reapply), would meet
--      a form it cannot replace (measured: "cannot change return type of
--      existing function"). The stores and --list call the listing, then
--      list_proposal_writers with the page's ids; the CLI's accept guard
--      calls it alone, for the one row.
--   4. The readers, in the same change. Both listings print each side's
--      `By:` line, whether its text is a capture-only key's, the ingested
--      notice before an ingested side (SMD-2480's proposals half), the
--      superseder and what an accept would lapse. A proposal is flagged
--      WRITER when the side that stands is a capture-only key's text and the
--      accept would pass another's standing to it — the other side another
--      capturer's, or one capturer's both and the accept would take the side
--      (review pass 4: the second half) — or when it carries a recorded
--      trust below the other's (none recorded is not flagged: the
--      maintainer's choice, review pass 1). db/consolidate.ts --accept
--      refuses a flagged row without --force (the maintainer's choice, 070's
--      rule for a lineage pair: CLI-side, a guard and not a verdict). An
--      accept names the pointers its lapse cleared.
--
-- NOT HERE
--   * No verdict, no data step: nothing runs at apply time but the DDL.
--   * review_supersession_proposal is unchanged; the guard is the CLI's, the
--     one accept door (070).
--   * thought_changes' trust: SMD-2480.
--   * Why a lapse happened, on the lapse's own event: SMD-2933.
--   * A capture-scoped capture row with no agent id (the registry could not
--     attribute it) can never be taken by 082's log, which needs a capturer:
--     its text reads as a capture-only key's after any later edit (082's own
--     gap, which it refuses ownership by name for).
--   * A bound on the read's cost: each listed proposal reads both sides'
--     takes and lapses, so a page's cost runs with its chains, not its rows
--     alone — 200 proposals each under a 1,000-link chain took about 7 s on
--     a laptop (review pass 2), a realistic page of 200 20-30 ms; the tool's
--     default page is 10.
--
-- SAFETY
--   Four functions created and their COMMENTs; 070's listing untouched.
--   MINOR: nothing existing changes shape. EXECUTE is PUBLIC by default, as
--   on the listing, and no grant group in db/config.mjs names any of them. A brain
--   at 092 under a server from this tree lists without the writers, and the
--   reply says so; the CLI's accept guard warns and goes on without it.
--   test-schema [84], test-upgrade [20ao], test-live [16], test-store-sql
--   and test-store-postgrest [10], test-e2e-sql [13i], test-server [16l].
--
-- Prerequisites
--   016 (content_fingerprint_of), 025 (thoughts.derived_from), 029
--   (supersession_proposals), 082 (ob1_capturer_of), 092
--   (ob1_capture_taken_by_log). Applied by `bun db/migrate.ts`.
--
-- Idempotent: CREATE OR REPLACE.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regprocedure('content_fingerprint_of(text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 094 needs 016 (content_fingerprint_of); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'thoughts' AND column_name = 'derived_from') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 094 needs 025 (thoughts.derived_from); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regclass('supersession_proposals') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 094 needs 029 (supersession_proposals); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_capturer_of(uuid)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 094 needs 082 (ob1_capturer_of); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_capture_taken_by_log(uuid)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 094 needs 092 (ob1_capture_taken_by_log); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. Whether a thought's text is still a capture-only key's alone.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_capture_only_text(p_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  -- The FIRST capture row, as ob1_capturer_of reads it; none reads false.
  SELECT COALESCE((SELECT actor_context->>'scope' = 'capture' FROM thought_audit
                    WHERE thought_id = p_id AND action = 'capture'
                    ORDER BY created_at ASC, id ASC
                    LIMIT 1), false)
     AND NOT ob1_capture_taken_by_log(p_id)
$$;
COMMENT ON FUNCTION ob1_capture_only_text(uuid) IS
  'Whether a thought''s text is still a capture-only key''s alone: its first capture audit row (the one ob1_capturer_of reads) carries "scope": "capture" in its actor_context (SMD-1298), and 082''s log has not taken it (ob1_capture_taken_by_log: no re-capture by a key that can read, no text move, no adoption). An accept''s taking (the chain, 092) leaves it true. False with no capture row. Migration 094 / SMD-2707.';

-- ---------------------------------------------------------------------------
-- 2. Whether an accept would take the side, and what it would lapse.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_accept_takes(p_side uuid, p_other uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  -- 092's taken read, with p_side's pointer read as p_other — the event an
  -- accept making p_side stand appends: 082's log took it, or its chain then
  -- reaches a thought its capturer did not capture or one the log took
  -- (past the bound, not taken, as the lapse reads it). False for a thought
  -- no one attributable captured.
  SELECT c.agent IS NOT NULL
         AND (ob1_capture_taken_by_log(p_side)
              OR COALESCE(ob1_chain_reaches_outside(p_side, c.agent, p_side, p_other), false))
    FROM (SELECT ob1_capturer_of(p_side) AS agent) c
$$;
COMMENT ON FUNCTION ob1_accept_takes(uuid, uuid) IS
  'Whether an accept making p_side supersede p_other would take p_side from its capturer: 092''s taken read (ob1_capture_taken_by_log, or ob1_chain_reaches_outside with p_side''s pointer read as p_other; past the bound, not taken, as the lapse reads it). False for a thought no attributable agent captured. The gate ob1_accept_lapses reads once the accept would write an event, and the listing''s WRITER flag reads between one capturer''s two thoughts. Migration 094 / SMD-2707.';

CREATE OR REPLACE FUNCTION ob1_accept_lapses(p_side uuid, p_other uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_capturer uuid := ob1_capturer_of(p_side);
  v_work     uuid[] := ARRAY[p_side];
  v_seen     uuid[] := '{}';
  v_out      jsonb := '[]';
  v_x        uuid;
  v_cap      uuid;
  v_hit      uuid[];
  v_h        uuid;
  v_n        int := 0;
  v_down     uuid := p_other;
BEGIN
  -- ob1:accept-lapses-read — 092's lapse (ob1_lapse_capture_pointers), read
  -- and not written, for the event an accept making p_side stand over
  -- p_other appends: p_side.supersedes = p_other. Kept in step with it: the
  -- row taken now (082's log, or its chain read with the new pointer; past
  -- the bound, not taken), then the walk up — each row's capturer's
  -- capture-scoped pointers onto it that no update has re-pointed are what
  -- it clears, never p_side's own; the walk goes on through the pointers
  -- that stay, to 1,000 rows above, and from a cleared row 082's log had
  -- already taken (its own lapse event fires the trigger again there).
  -- No event, no lapse (review pass 2): 029's accept writes only onto a
  -- NULL pointer (one already p_other writes nothing, a third thought is
  -- ALREADY_SUPERSEDES), and update_thought refuses a loop (WOULD_CYCLE).
  IF v_capturer IS NULL OR (SELECT t.supersedes FROM thoughts t WHERE t.id = p_side) IS NOT NULL THEN
    RETURN v_out;
  END IF;
  -- update_thought's loop walk (088): past 1,001 rows below p_other it
  -- refuses as a loop too, a raw cycle not through p_side among them.
  WHILE v_down IS NOT NULL AND v_n < 1001 LOOP
    IF v_down = p_side THEN
      RETURN v_out;
    END IF;
    v_n := v_n + 1;
    v_down := (SELECT t.supersedes FROM thoughts t WHERE t.id = v_down);
  END LOOP;
  IF v_down IS NOT NULL THEN
    RETURN v_out;
  END IF;
  v_n := 0;
  IF NOT ob1_accept_takes(p_side, p_other) THEN
    RETURN v_out;
  END IF;
  WHILE array_length(v_work, 1) > 0 LOOP
    v_x := v_work[1];
    v_work := v_work[2:];
    v_n := v_n + 1;
    EXIT WHEN v_n > 1001;
    CONTINUE WHEN v_x = ANY(v_seen);
    v_seen := v_seen || v_x;
    v_cap := ob1_capturer_of(v_x);
    v_hit := ARRAY(
      SELECT t.id FROM thoughts t
       WHERE t.supersedes = v_x
         AND v_cap IS NOT NULL
         AND EXISTS (SELECT 1 FROM thought_audit c
                      WHERE c.thought_id = t.id AND c.action = 'capture'
                        AND c.canonical_agent_id = v_cap
                        AND c.actor_context->>'scope' = 'capture'
                        AND c.diff->>'supersedes' = v_x::text)
         AND NOT EXISTS (SELECT 1 FROM thought_audit u
                          WHERE u.thought_id = t.id AND u.action = 'update'
                            AND u.diff ? 'supersedes')
         AND t.id <> p_side
       ORDER BY t.id);
    FOREACH v_h IN ARRAY v_hit LOOP
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_h, 'onto', v_x));
      -- A cleared row 082's log already took: its lapse event walks from it.
      IF ob1_capture_taken_by_log(v_h) THEN
        v_work := v_work || v_h;
      END IF;
    END LOOP;
    -- The rows still pointing at it once those are cleared.
    v_work := v_work || ARRAY(SELECT t.id FROM thoughts t WHERE t.supersedes = v_x AND NOT (t.id = ANY(v_hit)) ORDER BY t.id);
  END LOOP;
  RETURN v_out;
END;
$$;
COMMENT ON FUNCTION ob1_accept_lapses(uuid, uuid) IS
  'The pointers 082''s lapse, as 092 runs it, would clear if an accept made p_side supersede p_other, as [{id, onto}] — the thought whose pointer is cleared and the thought it pointed at: none when the accept writes no event (p_side already points somewhere: 029 writes nothing or refuses ALREADY_SUPERSEDES; the pointer would close a loop, or the chain below p_other runs past update_thought''s 1,001-row walk: WOULD_CYCLE) or the new pointer does not take p_side (082''s log, or its chain read with it reaching outside its capturer''s own); else its capturer''s capture-scoped, never re-pointed pointers onto it, and up the chain through the pointers that stay, each row''s capturer''s onto that row (never p_side''s own; to 1,000 rows above; on from a cleared row 082''s log had already taken). A read of ob1_lapse_capture_pointers, kept in step with it. Migration 094 / SMD-2707.';

-- ---------------------------------------------------------------------------
-- 3. Each listed proposal's writers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_proposal_writers(p_ids uuid[])
RETURNS TABLE (
  id                    uuid,
  older_actor_name      text,
  older_actor_kind      text,
  older_trust           text,
  older_capture_only    boolean,
  older_superseded_by   uuid,
  older_lapses          jsonb,
  older_takes           boolean,
  newer_actor_name      text,
  newer_actor_kind      text,
  newer_trust           text,
  newer_capture_only    boolean,
  newer_superseded_by   uuid,
  newer_lapses          jsonb,
  newer_takes           boolean,
  same_capturer         boolean
)
LANGUAGE sql
STABLE
AS $$
  -- ob1:listing-names-the-writers — the proposals named (the listing's cap
  -- of them), each side's writer, whose text it is, its first superseder,
  -- and what an accept making it stand over the other side would lapse and
  -- whether it would take the side.
  WITH page AS (
    SELECT p.id, p.status, p.older_id, p.newer_id, o.metadata AS older_metadata, n.metadata AS newer_metadata
      FROM supersession_proposals p
      JOIN thoughts o ON o.id = p.older_id
      JOIN thoughts n ON n.id = p.newer_id
     WHERE p.id = ANY(p_ids[1:200])
  ),
  side AS (
    SELECT x.tid, ob1_capturer_of(x.tid) AS agent, ob1_capture_only_text(x.tid) AS only_text,
           (SELECT t.id FROM thoughts t WHERE t.supersedes = x.tid ORDER BY t.created_at, t.id LIMIT 1) AS superseded_by
      FROM (SELECT older_id AS tid FROM page UNION SELECT newer_id FROM page) x
  )
  SELECT g.id,
         g.older_metadata->>'actor_name', g.older_metadata->>'actor_kind', g.older_metadata->>'trust',
         -- An accepted row takes no accept (029: ALREADY_ACCEPTED).
         so.only_text, so.superseded_by, CASE WHEN g.status = 'accepted' THEN '[]'::jsonb ELSE ob1_accept_lapses(g.older_id, g.newer_id) END,
         ob1_accept_takes(g.older_id, g.newer_id),
         g.newer_metadata->>'actor_name', g.newer_metadata->>'actor_kind', g.newer_metadata->>'trust',
         sn.only_text, sn.superseded_by, CASE WHEN g.status = 'accepted' THEN '[]'::jsonb ELSE ob1_accept_lapses(g.newer_id, g.older_id) END,
         ob1_accept_takes(g.newer_id, g.older_id),
         COALESCE(so.agent = sn.agent, false)
    FROM page g
    JOIN side so ON so.tid = g.older_id
    JOIN side sn ON sn.tid = g.newer_id
   ORDER BY g.id
$$;

COMMENT ON FUNCTION list_proposal_writers(uuid[]) IS
  'Who wrote each side of the supersession proposals named (any status; the first 200 ids read): its actor_name, actor_kind and trust (050, 073), whether its text is still a capture-only key''s alone (ob1_capture_only_text), the first thought superseding it, the pointers an accept making it stand over the other side would lapse, as [{id, onto}] (ob1_accept_lapses; none on an accepted row), whether that accept would take it (ob1_accept_takes), and whether one agent captured both sides (same_capturer). The companion of list_supersession_proposals (070); an id naming no proposal returns nothing. Migration 094 / SMD-2707.';
