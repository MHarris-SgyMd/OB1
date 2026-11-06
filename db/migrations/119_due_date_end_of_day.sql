-- =============================================================================
-- Migration 119: a due date alone is the end of that day — an open item due
--                2027-03-01 is due by the end of that day in UTC, the next
--                day's start, so it is not overdue on its own day (SMD-3778)
-- =============================================================================
--
-- WHY
--   117's ob1_item_due read a bare date as the start of its day in UTC, the
--   rule set_priority's due_at kept (116, SMD-3664). list_items calls an item
--   overdue once its due time is past, so a to-do due on Tuesday read overdue
--   all of Tuesday, from midnight UTC. "Due on Tuesday" means by the end of
--   Tuesday. The maintainer chose (SMD-3778, 2026-11-05) the end of the day
--   everywhere: one reading of one string, for an open item's due time and a
--   priority's alike. The server reads set_priority's due_at that way itself
--   (server-portable/core/priority.ts), and the ingestion pipeline and
--   board-sync through server-portable/priority-scale.ts's dueInstant; this
--   migration is 117's half. A priority's not_before is a start, and stays
--   the start of its day.
--
-- WHAT
--   ob1_item_due(text) replaced, its signature and every other rule as 117
--   made it: a bare date is the next day's start in UTC; a date and time with
--   no offset is still that instant in UTC; with an offset, that instant. The
--   writers that call it (open_item, update_item) take the new reading with no
--   change of their own.
--
--   Due times stored before this migration stay as they were written: nothing
--   records whether one came from a bare date, so none is moved.
--
-- Re-applying it is a no-op. Migration 119 / SMD-3778.

-- 117 first: on a brain without open items this reader would have nothing to
-- read, so the file is refused by name.
DO $qc$
BEGIN
  IF to_regprocedure('ob1_item_due(text)') IS NULL OR to_regclass('open_items') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 119 needs 117 (ob1_item_due, open_items); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

CREATE OR REPLACE FUNCTION ob1_item_due(p_due text)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v timestamptz;
BEGIN
  IF p_due IS NULL THEN
    RETURN NULL;
  END IF;
  -- A date and time, never one of Postgres's words for one ('now', 'tomorrow',
  -- 'epoch', 'infinity'), anywhere in it: a word is the session's moment.
  IF btrim(p_due) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([Zz]|[+-][0-9]{2}(:?[0-9]{2})?)?)?$' THEN
    RAISE EXCEPTION USING MESSAGE = format('not a due time: %L (a time with its offset)', left(p_due, 80)), ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    -- An offset follows a time: a date's own '-01' is none.
    IF btrim(p_due) ~ '[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([Zz]|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN
      v := p_due::timestamptz;
    ELSIF btrim(p_due) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      -- A date alone is due by the end of that day: the next day's start in UTC
      -- (SMD-3778), never the session's time zone.
      v := (p_due::date + 1)::timestamp AT TIME ZONE 'UTC';
    ELSE
      -- A date and time with no offset is that instant in UTC (117's review pass 4).
      v := p_due::timestamp AT TIME ZONE 'UTC';
    END IF;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_time_zone_displacement_value THEN
    RAISE EXCEPTION USING MESSAGE = format('not a due time: %L (a time with its offset)', left(p_due, 80)), ERRCODE = 'invalid_parameter_value';
  END;
  IF NOT isfinite(v) THEN
    RAISE EXCEPTION USING MESSAGE = format('a due time is a moment, not %L', left(p_due, 80)), ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v;
END;
$$;
COMMENT ON FUNCTION ob1_item_due(text) IS
  'An open item''s due time from text: NULL for NULL; ISO 8601 alone (a date, or a date and time with an optional offset), so none of Postgres''s words (now, today, tomorrow, epoch, infinity) anywhere in it; raises 22023 for anything else, or a date Postgres can''t read. A date alone is due by the end of that day: the next day''s start in UTC, as set_priority reads a bare due_at. A date and time with no offset is that instant in UTC. Migrations 117 and 119 / SMD-3665, SMD-3778.';
