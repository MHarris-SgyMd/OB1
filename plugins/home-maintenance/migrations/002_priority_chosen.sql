-- Whether a task's priority was chosen (SMD-3666 PR 3). The column's default,
-- medium, is no statement: docs/priority.md's decision 3 reads a source's
-- default as unknown unless the source can tell a choice from it. So a task
-- records whether the caller gave its priority; a task added before this
-- migration was never asked, and reads as not chosen — its medium unknown, its
-- low, high or urgent stated all the same (none of them is the default).
--
-- Runs as the plugin's role, its schema first on the path, as 001 does.

ALTER TABLE maintenance_tasks ADD COLUMN IF NOT EXISTS priority_chosen boolean NOT NULL DEFAULT false;

-- task_rows as 001 made it, the new column after the rest (a view replaced in
-- place keeps its columns, in order, and may only add more at the end). It is
-- beside `answer`, not in it: the operations' answers are unchanged.
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
         ) AS answer,
         t.priority_chosen
    FROM maintenance_tasks t
    CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE 'UTC')::date AS today) d;
