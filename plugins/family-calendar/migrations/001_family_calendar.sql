-- The family calendar's tables (SMD-2311): the household's members, their
-- activities (one-time or weekly) and the dates to remember. Ported from
-- extensions/family-calendar/schema.sql, which applied them to the public
-- schema by hand.
--
-- Runs as the plugin's role, ob1_plugin_family_calendar, with its schema,
-- plugin_family_calendar, first on the path: each table here is the
-- plugin's own, and nothing in the core is referenced.
--
-- user_id is upstream's multi-user column, kept nullable and ignored: the
-- fork is one operator's brain (SMD-1716), so no operation writes or reads it
-- (decided 2026-11-02). It waits for a multi-user change that may never come.

CREATE TABLE IF NOT EXISTS family_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- 'self', 'spouse', 'child', 'parent', or anything else the caller says.
  relationship  text,
  birth_date    date,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid,
  -- Null: the whole family's.
  family_member_id  uuid REFERENCES family_members (id),
  title             text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  -- 'sports', 'medical', 'school', 'social', …
  activity_type     text,
  -- A weekly activity's day; null for one that is dated alone.
  day_of_week       text CHECK (day_of_week IN ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')),
  start_time        time,
  end_time          time,
  -- A dated activity's first day, or the first week a weekly one runs.
  start_date        date,
  -- Its last day; null for one that runs on.
  end_date          date,
  location          text,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activities_end_not_before_start CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  -- Weekly, dated, or both: one with neither falls in no week.
  CONSTRAINT activities_weekly_or_dated CHECK (day_of_week IS NOT NULL OR start_date IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS important_dates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid,
  -- Null: a date of the whole family's.
  family_member_id      uuid REFERENCES family_members (id),
  title                 text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  date_value            date NOT NULL,
  -- A birthday or an anniversary: it comes round on the same day each year.
  recurring_yearly      boolean NOT NULL DEFAULT false,
  reminder_days_before  integer NOT NULL DEFAULT 7 CHECK (reminder_days_before BETWEEN 0 AND 365),
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS activities_by_member ON activities (family_member_id);
CREATE INDEX IF NOT EXISTS activities_by_dates ON activities (start_date, end_date);
CREATE INDEX IF NOT EXISTS important_dates_by_member ON important_dates (family_member_id);
CREATE INDEX IF NOT EXISTS important_dates_by_date ON important_dates (date_value);

-- What the operations answer, one jsonb object a row (`answer`): its member
-- folded in as { id, name, relationship } (null for the whole family's), its
-- dates as YYYY-MM-DD text and its times as HH:MM — a date is no instant, and
-- a time has no zone — and its timestamp as ISO text in UTC. user_id is left
-- out. Beside it, the raw values the operations filter and order by. An
-- operation selects named columns, never `*`, so a column added here later
-- changes no prepared statement's result (check 41).
CREATE OR REPLACE VIEW activity_rows AS
  SELECT a.id, a.family_member_id, a.title, a.activity_type, a.day_of_week, m.name AS member_name,
         a.start_date AS starts, a.end_date AS ends, a.start_time AS starts_at, a.created_at,
         jsonb_build_object(
           'id', a.id, 'family_member_id', a.family_member_id, 'title', a.title, 'activity_type', a.activity_type, 'day_of_week', a.day_of_week,
           'start_time', to_char(a.start_time, 'HH24:MI'), 'end_time', to_char(a.end_time, 'HH24:MI'),
           'start_date', a.start_date::text, 'end_date', a.end_date::text, 'location', a.location, 'notes', a.notes,
           'created_at', to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'family_member', CASE WHEN m.id IS NULL THEN NULL ELSE jsonb_build_object('id', m.id, 'name', m.name, 'relationship', m.relationship) END
         ) AS answer
    FROM activities a LEFT JOIN family_members m ON m.id = a.family_member_id;

CREATE OR REPLACE VIEW important_date_rows AS
  SELECT d.id, d.title, d.date_value AS day, d.recurring_yearly, d.reminder_days_before,
         jsonb_build_object(
           'id', d.id, 'family_member_id', d.family_member_id, 'title', d.title, 'date_value', d.date_value::text,
           'recurring_yearly', d.recurring_yearly, 'reminder_days_before', d.reminder_days_before, 'notes', d.notes,
           'created_at', to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'family_member', CASE WHEN m.id IS NULL THEN NULL ELSE jsonb_build_object('id', m.id, 'name', m.name, 'relationship', m.relationship) END
         ) AS answer
    FROM important_dates d LEFT JOIN family_members m ON m.id = d.family_member_id;
