-- =============================================================================
-- Migration 089: a long thought's finished extraction windows survive a stop —
--                kept per claim, so the next claim of the same text resumes
--                where the last one stopped rather than at its first window,
--                and the stops counted, with how many gained nothing (SMD-2694)
-- =============================================================================
--
-- WHY
--   db/extract-entities.ts extracts a thought over the extraction window in
--   windows, one model call each (server-portable/entities.ts, SMD-1879), and
--   merges their answers only once the last has returned. A hard stop — the
--   sleep scheduler's wake (db/sleep.ts, SMD-1794), the operator's second
--   signal — aborts the call in hand and returns the claim
--   (release_claims_for_worker, 015), and every window already answered went
--   with it. On the stable brain every extraction over ten minutes is a
--   document of 17 to 74 windows at 30 to 300 s each, so a thought longer
--   than every sleep was never finished while the brain kept waking, and
--   consolidation, which joins once extraction is drained, never joined
--   behind it.
--
-- WHAT
--   * extraction_progress — one row per claim (thought, job key) a worker
--     took and did not finish: the windows answered so far, each the
--     window's own answer as entities.ts returns it, keyed by its index and
--     carrying the hash of the text it was sent (`h`), so a window is reused
--     only for the text it answered. The row says which text and windowing
--     its windows are of — the thought's content fingerprint (003) and the
--     worker's windowing, which decides where the windows fall — and a write
--     under another fingerprint or windowing replaces the row: an edit, or a
--     change of window size, starts afresh. Only parsed windows are kept; a
--     malformed one is asked again.
--   * stops counts the hard stops that took the claim from a worker with the
--     row's text in hand; stalled, the latest of them in a row that gained no
--     window (kept_at_stop is how many windows the row held at the last
--     one). A thought gaining a window in every sleep is not stalled; one
--     whose single window outlasts every sleep is, and SMD-2694's second PR
--     lets consolidation join past it.
--   * save_extraction_window(…) and note_extraction_stop(…) write it, and
--     only for the claim's holder: each locks the claim row FOR SHARE and
--     writes nothing (false) unless the row is claimed by the worker named.
--     So a save landing after the stop returned the lease, or after an edit
--     requeued the claim, keeps nothing, and two holders in turn never mix
--     windows. note_extraction_stop runs before the stop returns the lease.
--   * The row goes with its claim (a foreign key to thought_work_claims, ON
--     DELETE CASCADE — and so with the thought). The worker deletes it when
--     it releases the claim succeeded; a failed release keeps it, so
--     --retry-failed resumes a thought that timed out in a late window.
--     Nothing else deletes it: a row left beside a claim that is finished
--     is replaced or ignored, as every reader reads it beside a pending or
--     claimed row only.
--   * Grants: none here. db/config.mjs's `extraction` group holds SELECT,
--     INSERT, UPDATE and DELETE on it. The functions are SECURITY INVOKER,
--     as 015's are: the lock needs the worker group's UPDATE on
--     thought_work_claims, which an extraction role holds.
--
-- Idempotent: the table IF NOT EXISTS; the functions and comments replaced.
-- =============================================================================

CREATE TABLE IF NOT EXISTS extraction_progress (
  thought_id   uuid        NOT NULL,
  work_type    text        NOT NULL,
  fingerprint  text        NOT NULL,
  windowing    text        NOT NULL,
  windows      int,
  parts        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  stops        int         NOT NULL DEFAULT 0,
  stalled      int         NOT NULL DEFAULT 0,
  kept_at_stop int         NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thought_id, work_type),
  CONSTRAINT extraction_progress_claim FOREIGN KEY (thought_id, work_type)
    REFERENCES thought_work_claims (thought_id, work_type) ON DELETE CASCADE,
  CONSTRAINT extraction_progress_parts_object CHECK (jsonb_typeof(parts) = 'object'),
  CONSTRAINT extraction_progress_counts CHECK (stops >= 0 AND stalled >= 0 AND stalled <= stops AND kept_at_stop >= 0),
  CONSTRAINT extraction_progress_windows CHECK (windows IS NULL OR windows > 1)
);

COMMENT ON TABLE extraction_progress IS
  'A long thought''s extraction windows answered under a claim that did not finish, kept so the next claim of the same text and windowing resumes from them; the hard stops that took the claim, and how many in a row gained no window. Written by save_extraction_window and note_extraction_stop for the claim''s holder only; deleted with the claim, or by the worker on a succeeded release. Migration 089 / SMD-2694.';
COMMENT ON COLUMN extraction_progress.fingerprint IS
  'The content fingerprint (003) of the text the windows answered; a write under another replaces the row.';
COMMENT ON COLUMN extraction_progress.windowing IS
  'The worker''s windowing (entities.ts windowingFor, as JSON) the windows fell under; a write under another replaces the row.';
COMMENT ON COLUMN extraction_progress.windows IS
  'How many windows the thought is sent in (a prefix''s, over the bound); NULL until a window is kept.';
COMMENT ON COLUMN extraction_progress.parts IS
  'The windows answered and parsed, keyed by window index: each window''s answer as entities.ts returns it, with `h`, the hash of the text it was sent.';
COMMENT ON COLUMN extraction_progress.stops IS
  'Hard stops that took the claim from a worker with this text in hand.';
COMMENT ON COLUMN extraction_progress.stalled IS
  'Of stops, the latest in a row that gained no window: a thought whose window outlasts every sleep.';
COMMENT ON COLUMN extraction_progress.kept_at_stop IS
  'How many windows the row held at the last stop, which the next stop compares against.';

-- ---------------------------------------------------------------------------
-- save_extraction_window — keep one answered window for the claim's holder
--
-- Locks the claim row FOR SHARE, so a release in flight is waited for and then
-- read, and writes nothing (false) unless the row is claimed by p_worker. A
-- row of another fingerprint or windowing is replaced — its windows, its stops
-- and its stalled count are of other text — and a window already kept under
-- the same index is replaced by this one.
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

  INSERT INTO extraction_progress AS e (thought_id, work_type, fingerprint, windowing, windows, parts)
  VALUES (p_thought_id, p_work_type, p_fingerprint, p_windowing, p_windows, jsonb_build_object(p_index::text, p_part))
  ON CONFLICT (thought_id, work_type) DO UPDATE SET
    parts        = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing
                        THEN e.parts || EXCLUDED.parts ELSE EXCLUDED.parts END,
    stops        = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.stops ELSE 0 END,
    stalled      = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.stalled ELSE 0 END,
    kept_at_stop = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.kept_at_stop ELSE 0 END,
    fingerprint  = EXCLUDED.fingerprint,
    windowing    = EXCLUDED.windowing,
    windows      = EXCLUDED.windows,
    updated_at   = now();
  RETURN true;
END;
$$;

COMMENT ON FUNCTION save_extraction_window(uuid, text, text, text, text, int, int, jsonb) IS
  'Keep one answered window of a claimed thought, for the claim''s holder only (false otherwise, nothing written): replaces a row of another fingerprint or windowing, and a window kept under the same index. Migration 089 / SMD-2694.';

-- ---------------------------------------------------------------------------
-- note_extraction_stop — count a hard stop for the claim's holder
--
-- Called by the stop before it returns the lease, under the same lock and the
-- same holder rule as the save. stops goes up by one; stalled goes to 0 when
-- the row holds more windows than at the last stop, and up by one when it
-- holds none more — a single-window thought, which keeps no window, stalls at
-- every stop. A row of another fingerprint or windowing is replaced, this stop
-- its first.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION note_extraction_stop(
  p_thought_id  uuid,
  p_work_type   text,
  p_worker_id   text,
  p_fingerprint text,
  p_windowing   text
)
RETURNS boolean
LANGUAGE plpgsql
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
  VALUES (p_thought_id, p_work_type, p_fingerprint, p_windowing, 1, 1)
  ON CONFLICT (thought_id, work_type) DO UPDATE SET
    stops        = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.stops + 1 ELSE 1 END,
    stalled      = CASE WHEN e.fingerprint <> EXCLUDED.fingerprint OR e.windowing <> EXCLUDED.windowing THEN 1
                        WHEN (SELECT count(*) FROM jsonb_object_keys(e.parts)) > e.kept_at_stop THEN 0
                        ELSE e.stalled + 1 END,
    kept_at_stop = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing
                        THEN (SELECT count(*)::int FROM jsonb_object_keys(e.parts)) ELSE 0 END,
    parts        = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.parts ELSE '{}'::jsonb END,
    windows      = CASE WHEN e.fingerprint = EXCLUDED.fingerprint AND e.windowing = EXCLUDED.windowing THEN e.windows ELSE NULL END,
    fingerprint  = EXCLUDED.fingerprint,
    windowing    = EXCLUDED.windowing,
    updated_at   = now();
  RETURN true;
END;
$$;

COMMENT ON FUNCTION note_extraction_stop(uuid, text, text, text, text) IS
  'Count a hard stop that took a claimed thought from its holder, before the lease is returned (false and nothing written unless the caller holds the claim): stops + 1, and stalled reset when a window was kept since the last stop, else + 1. Migration 089 / SMD-2694.';
