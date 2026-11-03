-- The home maintenance tracker's tables (SMD-2311): the house's maintenance
-- tasks, one-time or recurring every so many days, and the log of work done
-- on them. Ported from extensions/home-maintenance/schema.sql, which applied
-- them to the public schema by hand.
--
-- Runs as the plugin's role, ob1_plugin_home_maintenance, with its schema,
-- plugin_home_maintenance, first on the path: each table here is the
-- plugin's own, and nothing in the core is referenced.
--
-- The old file's two triggers (updated_at, and a task's dates moved on when
-- work is logged) are the log_maintenance operation's own statements now,
-- in its one transaction: no function lives in this schema.
--
-- user_id is upstream's multi-user column, kept nullable and ignored: the
-- fork is one operator's brain (SMD-1716), so no operation writes or reads it
-- (decided 2026-11-02).

CREATE TABLE IF NOT EXISTS maintenance_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- 'hvac', 'plumbing', 'exterior', 'appliance', 'landscaping', …
  category        text,
  -- How often it comes round, in days; null for a one-time task.
  frequency_days  integer CHECK (frequency_days BETWEEN 1 AND 3650),
  -- The latest day work on it was logged.
  last_completed  date,
  -- The day it is next due; null for a one-time task with no date, or one done.
  next_due        date,
  priority        text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS maintenance_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES maintenance_tasks (id),
  user_id       uuid,
  completed_on  date NOT NULL,
  -- Who did the work: 'self', a vendor's name, …
  performed_by  text,
  cost          numeric(10, 2) CHECK (cost >= 0),
  notes         text,
  -- What the person who did it recommended for next time.
  next_action   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS maintenance_tasks_by_due ON maintenance_tasks (next_due);
CREATE INDEX IF NOT EXISTS maintenance_logs_by_task ON maintenance_logs (task_id, completed_on DESC);
CREATE INDEX IF NOT EXISTS maintenance_logs_by_day ON maintenance_logs (completed_on DESC);

-- What the operations answer, one jsonb object a row (`answer`): dates as
-- YYYY-MM-DD text, timestamps as ISO text in UTC, user_id left out. Beside
-- it, the raw values the operations filter and order by. An operation selects
-- named columns, never `*`, so a column added here later changes no prepared
-- statement's result (check 41). "Today" is the date in UTC.
--
-- A task is done when it is one-time and work on it has been logged.
-- days_until is next_due less today: negative when it is overdue, null with
-- no next_due.
CREATE OR REPLACE VIEW task_rows AS
  SELECT t.id, t.name, t.category, t.notes, t.next_due, t.created_at,
         (t.frequency_days IS NULL AND t.last_completed IS NOT NULL) AS done,
         CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END AS priority_rank,
         t.next_due - d.today AS days_until,
         jsonb_build_object(
           'id', t.id, 'name', t.name, 'category', t.category, 'frequency_days', t.frequency_days,
           'last_completed', t.last_completed::text, 'next_due', t.next_due::text, 'priority', t.priority, 'notes', t.notes,
           'done', (t.frequency_days IS NULL AND t.last_completed IS NOT NULL), 'days_until', t.next_due - d.today,
           'created_at', to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'updated_at', to_char(t.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ) AS answer
    FROM maintenance_tasks t
    CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE 'UTC')::date AS today) d;

CREATE OR REPLACE VIEW log_rows AS
  SELECT l.id, l.task_id, l.completed_on, l.created_at, t.name AS task_name, t.category AS task_category,
         jsonb_build_object(
           'id', l.id, 'task_id', l.task_id, 'completed_on', l.completed_on::text, 'performed_by', l.performed_by,
           'cost', l.cost, 'notes', l.notes, 'next_action', l.next_action,
           'created_at', to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'task', jsonb_build_object('id', t.id, 'name', t.name, 'category', t.category)
         ) AS answer
    FROM maintenance_logs l JOIN maintenance_tasks t ON t.id = l.task_id;
