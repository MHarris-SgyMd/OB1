-- =============================================================================
-- Migration 100: the sleep scheduler's own cuts of a claimed thought are
--                counted apart from its stops, so a thought's stops say the
--                wakes that held it back and no more (SMD-3060)
-- =============================================================================
--
-- WHY
--   093 (SMD-2694) counts every hard stop that takes a claim in `stops`, and
--   meant the wakes that held a thought back. The scheduler (db/sleep.ts)
--   makes hard stops of its own by the same call: extraction set aside while
--   consolidation joins past a stalled thought (SMD-2694), restarted for work
--   that landed behind one in hand and set aside again once let out while
--   consolidation waits for its judge (SMD-3008), and its passes stopped when
--   one ends by itself, a follower is found outside or the sleep throws.
--   Through a judge outage of hours with captures arriving the let-out cuts
--   the stalled thought about once a minute, its `stops` climbing some 60 an
--   hour: the `held` word on
--   heartbeat:sleep, which preflight passes on, read that as wakes, and its
--   order (the most stalled, then the most stopped) let the scheduler's
--   cuts decide which three thoughts it names.
--
-- WHAT
--   * extraction_progress.cuts — the scheduler's own cuts that took the
--     claim from a worker with the row's text in hand, counted by
--     note_extraction_cut; `stops` counts the rest: a wake, the operator's
--     second signal.
--   * note_extraction_cut(…) — 093's holder rule (FOR SHARE on the claim,
--     nothing written unless the worker named holds it, a lock wait given up
--     after a second): cuts + 1, and nothing else moved. A cut is no wake,
--     so it neither stalls the thought nor ends its gaining: `stalled`,
--     `gained`, the windows and the stops stand. A set-aside cuts a thought
--     the scheduler reads stalled (or cannot tell), though a worker's claim
--     between that read and the stop can put a fresh capture in hand; the
--     scheduler's other stops cut whatever is in hand. A row of another
--     fingerprint or windowing is replaced, this cut its first.
--   * note_extraction_stop and save_extraction_window, redefined: 093's,
--     with `cuts` back to 0 where either replaces a row of another
--     fingerprint or windowing — that row's cuts were of other text. A save
--     under another window count keeps them, as it keeps the stops.
--   * The table's and `stops`' comments say the cuts are counted apart.
--
-- NOT HERE
--   * The cost of each let-out's fresh extraction run (SMD-3066).
--
-- Grants: none here. db/config.mjs's `extraction` group holds SELECT, INSERT,
-- UPDATE and DELETE on the table (093), the worker group UPDATE on
-- thought_work_claims for the lock, and the functions are SECURITY INVOKER,
-- as 093's are. Counts made before it stay as they were: a stop the
-- scheduler counted then is not moved to cuts. A sleep scheduler of an
-- earlier tree counts its own stops as stops: restart the sleep service on
-- this tree once this is applied, which also has the held word read cuts.
-- Needs 093 (extraction_progress), refused by name without it.
-- Idempotent: the column and its check added once; the functions and
-- comments replaced. 093 re-applied after it puts back 093's functions,
-- which leave `cuts` on a replaced row: after an older tree's --reapply over
-- a 100 brain, run this tree's --reapply (a plain run skips 100, recorded as
-- applied).
-- =============================================================================

DO $rc$
BEGIN
  IF to_regclass('extraction_progress') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 100 needs 093 (extraction_progress); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$rc$;

ALTER TABLE extraction_progress ADD COLUMN IF NOT EXISTS cuts int NOT NULL DEFAULT 0;

DO $ck$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'extraction_progress_cuts' AND conrelid = 'extraction_progress'::regclass) THEN
    ALTER TABLE extraction_progress ADD CONSTRAINT extraction_progress_cuts CHECK (cuts >= 0);
  END IF;
END
$ck$;

COMMENT ON TABLE extraction_progress IS
  'A long thought''s extraction windows answered under a claim that did not finish, kept so the next claim of the same text and windowing resumes from them; the hard stops that took the claim, the sleep scheduler''s own cuts apart, the windows saved since the last stop, and how many long stops in a row saved none. Written by save_extraction_window, note_extraction_stop and note_extraction_cut for the claim''s holder only; deleted with the claim, or by the worker on a succeeded release. Migration 093 / SMD-2694; the cuts apart, migration 100 / SMD-3060.';
COMMENT ON COLUMN extraction_progress.stops IS
  'Hard stops that took the claim from a worker with this text in hand — a wake, the operator''s second signal — the sleep scheduler''s own cuts aside (cuts, migration 100).';
COMMENT ON COLUMN extraction_progress.cuts IS
  'The sleep scheduler''s own hard stops that took the claim from a worker with this text in hand — extraction set aside or restarted around a stalled thought, or its passes stopped for a reason of its own (db/sleep.ts; SMD-2694, SMD-3008) — counted apart from stops, and moving neither stalled nor gained. Migration 100 / SMD-3060.';

-- ---------------------------------------------------------------------------
-- note_extraction_cut — count the scheduler's own cut for the claim's holder
--
-- Called by the scheduler's hard stop before it returns the lease, under the
-- same lock and holder rule as 093's stop. cuts goes up by one and nothing
-- else moves; a row of another fingerprint or windowing is replaced, this cut
-- its first.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION note_extraction_cut(
  p_thought_id  uuid,
  p_work_type   text,
  p_worker_id   text,
  p_fingerprint text,
  p_windowing   text
)
RETURNS boolean
LANGUAGE plpgsql
SET lock_timeout = '1s'
AS $$
BEGIN
  PERFORM 1 FROM thought_work_claims c
    WHERE c.thought_id = p_thought_id AND c.work_type = p_work_type
      AND c.status = 'claimed' AND c.worker_id = p_worker_id
    FOR SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO extraction_progress AS e (thought_id, work_type, fingerprint, windowing, cuts)
  VALUES (p_thought_id, p_work_type, p_fingerprint, p_windowing, 1)
  ON CONFLICT (thought_id, work_type) DO UPDATE SET
    cuts    = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.cuts + 1 ELSE 1 END,
    stops   = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.stops ELSE 0 END,
    stalled = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.stalled ELSE 0 END,
    gained  = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.gained ELSE 0 END,
    parts   = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.parts ELSE '{}'::jsonb END,
    windows = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.windows ELSE NULL END,
    fingerprint = EXCLUDED.fingerprint,
    windowing   = EXCLUDED.windowing,
    updated_at  = now();
  RETURN true;
END;
$$;

COMMENT ON FUNCTION note_extraction_cut(uuid, text, text, text, text) IS
  'Count the sleep scheduler''s own hard stop of a claimed thought, before the lease is returned (false and nothing written unless the caller holds the claim): cuts + 1, the stops, stalled, gained and windows as they were; a row of another fingerprint or windowing replaced. Migration 100 / SMD-3060.';

-- ---------------------------------------------------------------------------
-- save_extraction_window — 093's, with cuts back to 0 where it replaces a row
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION save_extraction_window(
  p_thought_id  uuid,
  p_work_type   text,
  p_worker_id   text,
  p_fingerprint text,
  p_windowing   text,
  p_windows     int,
  p_index       int,
  p_part        jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SET lock_timeout = '1s'
AS $$
BEGIN
  IF p_index IS NULL OR p_index < 0 OR p_part IS NULL OR jsonb_typeof(p_part) <> 'object' THEN
    RAISE EXCEPTION 'save_extraction_window: a window needs an index of at least 0 and an answer object';
  END IF;
  PERFORM 1 FROM thought_work_claims c
    WHERE c.thought_id = p_thought_id AND c.work_type = p_work_type
      AND c.status = 'claimed' AND c.worker_id = p_worker_id
    FOR SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO extraction_progress AS e (thought_id, work_type, fingerprint, windowing, windows, parts, gained)
  VALUES (p_thought_id, p_work_type, p_fingerprint, p_windowing, p_windows, jsonb_build_object(p_index::text, p_part), 1)
  ON CONFLICT (thought_id, work_type) DO UPDATE SET
    parts   = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing AND e.windows IS NOT DISTINCT FROM EXCLUDED.windows
                   THEN e.parts || EXCLUDED.parts ELSE EXCLUDED.parts END,
    -- The stops and cuts a row of other text or windowing counted were not
    -- this text's; a change of window count alone keeps them, as the text's
    -- stops and cuts still were.
    stops   = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.stops ELSE 0 END,
    stalled = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.stalled ELSE 0 END,
    cuts    = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.cuts ELSE 0 END,
    gained  = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.gained + 1 ELSE 1 END,
    fingerprint = EXCLUDED.fingerprint,
    windowing   = EXCLUDED.windowing,
    windows     = EXCLUDED.windows,
    updated_at  = now();
  RETURN true;
END;
$$;

COMMENT ON FUNCTION save_extraction_window(uuid, text, text, text, text, int, int, jsonb) IS
  'Keep one answered window of a claimed thought, for the claim''s holder only (false otherwise, nothing written): replaces a row of another fingerprint or windowing, the windows of one of another window count (its stops and cuts kept), and a window kept under the same index; counts the save in gained. Migration 093 / SMD-2694; the cuts, migration 100 / SMD-3060.';

-- ---------------------------------------------------------------------------
-- note_extraction_stop — 093's, with cuts back to 0 where it replaces a row
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION note_extraction_stop(
  p_thought_id  uuid,
  p_work_type   text,
  p_worker_id   text,
  p_fingerprint text,
  p_windowing   text,
  p_long        boolean
)
RETURNS boolean
LANGUAGE plpgsql
SET lock_timeout = '1s'
AS $$
BEGIN
  PERFORM 1 FROM thought_work_claims c
    WHERE c.thought_id = p_thought_id AND c.work_type = p_work_type
      AND c.status = 'claimed' AND c.worker_id = p_worker_id
    FOR SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO extraction_progress AS e (thought_id, work_type, fingerprint, windowing, stops, stalled)
  VALUES (p_thought_id, p_work_type, p_fingerprint, p_windowing, 1, CASE WHEN p_long THEN 1 ELSE 0 END)
  ON CONFLICT (thought_id, work_type) DO UPDATE SET
    stops   = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.stops + 1 ELSE 1 END,
    stalled = CASE WHEN e.fingerprint <> EXCLUDED.fingerprint OR e.windowing <> EXCLUDED.windowing THEN EXCLUDED.stalled
                   WHEN e.gained > 0 THEN 0
                   WHEN p_long THEN e.stalled + 1
                   ELSE e.stalled END,
    cuts    = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.cuts ELSE 0 END,
    gained  = 0,
    parts   = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.parts ELSE '{}'::jsonb END,
    windows = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.windows ELSE NULL END,
    fingerprint = EXCLUDED.fingerprint,
    windowing   = EXCLUDED.windowing,
    updated_at  = now();
  RETURN true;
END;
$$;

COMMENT ON FUNCTION note_extraction_stop(uuid, text, text, text, text, boolean) IS
  'Count a hard stop that took a claimed thought from its holder, before the lease is returned (false and nothing written unless the caller holds the claim): stops + 1; stalled reset when a window was saved since the last stop, else + 1 on a long stop (p_long) and kept on a short one; gained back to 0; the sleep scheduler''s own cuts are note_extraction_cut''s. Migration 093 / SMD-2694; the cuts, migration 100 / SMD-3060.';
