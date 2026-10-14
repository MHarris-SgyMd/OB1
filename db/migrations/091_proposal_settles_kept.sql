-- =============================================================================
-- Migration 091: every time the consolidation pass settled a proposal since
--                the judge last asserted it is kept on its row, across
--                067's reopen — so a finding the pass took back reads taken
--                back, whatever the row says now (SMD-2913)
-- =============================================================================
--
-- WHY
--   SMD-2682 reads what became of each finding board-sync posted (087) from
--   the rows as they stand. The pass's settle (067: a rejection whose
--   review_note begins 'settled by the pass:') is the judge taking an
--   outdates finding back. But rebuild_derived reopens a settled row on any
--   later text move — status stale, reviewed_at and the note cleared — and
--   the pass's next settle writes a new time. A finding taken back on its
--   fifth day then reads open again after an unrelated ticket edit, and
--   unanswered once it is 30 days old or settled again past day 30: the
--   acceptance rate understated. Ticket texts carry `Status:`, `Parent:` and
--   `Labels:`, so they move often.
--
--   A reopen is the brain asking again, not the judge saying it again: a
--   re-judge that finds the conflict again replaces the row in place (063),
--   back to pending with judged_at moved, and that is the judge asserting
--   the finding once more. The relation side needs nothing here: a relation
--   has no reopen — said again, it is the judge's verdict again (084).
--
-- WHAT
--   * supersession_proposals.pass_settled_at — every time the pass settled
--     the row since the judge last asserted it, oldest first: the
--     reviewed_at of each settle. Empty for a row the pass has not settled
--     since.
--   * supersession_proposals_keep_settles, BEFORE INSERT OR UPDATE: the one
--     writer of the column — a value a caller writes is replaced. It empties
--     the column when judged_at moves (063's replace in place: a re-judge
--     found the conflict again), appends NEW.reviewed_at when the row
--     becomes settled (it was not before the write), and otherwise keeps it
--     as it was — 067's reopen and a person's review alike. A row inserted
--     settled starts with its time. The judge's assertion is read from the
--     write itself, not by comparing judged_at with settle times written by
--     other transactions, so two passes at once cannot misorder them.
--   * Rows settled now are backfilled with their reviewed_at, before the
--     trigger exists. A settle 067 already reopened before this file left no
--     time behind; it is not recovered.
--
-- NOT HERE
--   * The read (server-portable/brain-info.ts FINDING_OUTCOMES_SQL): each
--     proposal's first settle in the column, the latest of them over every
--     proposal a finding named that is still present — the server's change,
--     beside this one.
--   * Grants: none. The trigger writes the row being written, so a role that
--     may settle (UPDATE on the table, 029's) needs nothing more, and 087's
--     table stays insert-only.
--   * A bound on the array: one element per settle since the last assertion,
--     and each settle after the first needs a text move under the pair and a
--     pass to re-judge it.
--   * A caller's value on INSERT: the trigger replaces it, so a data-only
--     reload (pg_restore --data-only, COPY) of supersession_proposals with
--     triggers enabled rebuilds each row's array from its status alone and
--     loses settles a reopen had cleared — load it with the trigger disabled,
--     as a full pg_restore does (triggers come after the data).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; the backfill touches only settled
-- rows still empty, under no trigger (dropped first); CREATE OR REPLACE.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regprocedure('settle_supersession_proposal(uuid, text, jsonb, text, text, text, jsonb, uuid)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 091 needs 067 (settle_supersession_proposal); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

ALTER TABLE supersession_proposals
  ADD COLUMN IF NOT EXISTS pass_settled_at timestamptz[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN supersession_proposals.pass_settled_at IS
  'Every time the consolidation pass settled this row (067: rejected with a review_note beginning ''settled by the pass:'') since the judge last asserted it, oldest first — each settle''s reviewed_at, kept when rebuild_derived reopens the row (stale, reviewed_at cleared) and the pass settles it again; emptied when a re-judge finds the conflict again (063, judged_at moved). Written only by supersession_proposals_keep_settles. Read by SMD-2682''s findings read: a finding the pass took back on its fifth day reads taken back after a reopen. Migration 091 / SMD-2913.';

DROP TRIGGER IF EXISTS supersession_proposals_keep_settles ON supersession_proposals;

-- The rows settled now: their settle's time is the row's.
UPDATE supersession_proposals
   SET pass_settled_at = ARRAY[reviewed_at]
 WHERE status = 'rejected' AND review_note LIKE 'settled by the pass:%'
   AND reviewed_at IS NOT NULL AND pass_settled_at = '{}';

CREATE OR REPLACE FUNCTION ob1_keep_proposal_settles()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  -- The marker is 067's, which rebuild_derived reads to reopen the row.
  v_settled boolean := NEW.status = 'rejected' AND coalesce(NEW.review_note LIKE 'settled by the pass:%', false);
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.pass_settled_at := CASE WHEN v_settled THEN ARRAY[coalesce(NEW.reviewed_at, now())] ELSE '{}'::timestamptz[] END;
    RETURN NEW;
  END IF;
  -- The judge asserted it again (063 moves judged_at): the settles before
  -- were of the earlier verdict.
  NEW.pass_settled_at := CASE WHEN NEW.judged_at IS DISTINCT FROM OLD.judged_at THEN '{}'::timestamptz[] ELSE OLD.pass_settled_at END;
  IF v_settled AND NOT (OLD.status = 'rejected' AND coalesce(OLD.review_note LIKE 'settled by the pass:%', false)) THEN
    NEW.pass_settled_at := NEW.pass_settled_at || coalesce(NEW.reviewed_at, now());
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION ob1_keep_proposal_settles() IS
  'BEFORE INSERT OR UPDATE on supersession_proposals (supersession_proposals_keep_settles, 091): the one writer of pass_settled_at. Empties it when judged_at moves (063''s replace in place: the judge asserted the row again); appends NEW.reviewed_at (now() when it is null) when the row becomes settled by the pass — rejected with a review_note beginning ''settled by the pass:'' (067''s marker) where it was not before the write; otherwise keeps it as it was. A value a caller writes is replaced on every write; a row inserted settled starts with its time. Migration 091 / SMD-2913.';

CREATE TRIGGER supersession_proposals_keep_settles
  BEFORE INSERT OR UPDATE ON supersession_proposals
  FOR EACH ROW EXECUTE FUNCTION ob1_keep_proposal_settles();
