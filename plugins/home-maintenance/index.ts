// The home maintenance tracker (SMD-2311): the house's maintenance tasks,
// one-time or recurring every so many days, and the log of work done on
// them, in tables of the plugin's own (migrations/001_home_maintenance.sql).
// Ported from the standalone server extensions/home-maintenance/index.ts, its
// four tools kept as four operations under the same names, and a fifth,
// list_maintenance_tasks, so an agent can find a task's id. It reaches
// nothing of the core's.

import { definePlugin, ok, operation, refuse, z } from "../../server-portable/plugin-sdk.ts";
import type { PluginSql } from "../../server-portable/plugin-sdk.ts";

const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
/** A calendar date as the tables hold it, YYYY-MM-DD, from the year 0001: Postgres has no year 0000, which zod's ISO date accepts. */
const Day = z.iso.date().refine((d) => !d.startsWith("0000-"), "a date from the year 0001");
/** Free text a person types: trimmed, at most `max` characters, and no NUL, which Postgres will not store in text. */
const text = (max: number) => z.string().trim().max(max).refine((s) => !s.includes("\u0000"), "no NUL character");

const Task = z.object({
  id: z.string(), name: z.string(), category: z.string().nullable(), frequency_days: z.number().int().nullable(),
  last_completed: z.string().nullable(), next_due: z.string().nullable(), priority: z.enum(PRIORITIES), notes: z.string().nullable(),
  done: z.boolean(), days_until: z.number().int().nullable(), created_at: z.string(), updated_at: z.string(),
});
const Log = z.object({
  id: z.string(), task_id: z.string(), completed_on: z.string(), performed_by: z.string().nullable(), cost: z.number().nullable(),
  notes: z.string().nullable(), next_action: z.string().nullable(), created_at: z.string(),
  task: z.object({ id: z.string(), name: z.string(), category: z.string().nullable() }),
});

/** MCP hints: every operation reaches the plugin's own tables alone, and a write adds or moves a task on, destroying nothing. A read is read-only already. */
const CLOSED = { openWorldHint: false } as const;
const ADDS = { destructiveHint: false, openWorldHint: false } as const;

/** A row's answer as the migration's views build it (task_rows, log_rows): one jsonb object, the shape the output declares. */
type Answer<T> = { answer: T };

/** The refusal of a task id that names no task, saying where the ids are. */
const noSuchTask = (task_id: string) =>
  refuse(404, "NO_SUCH_TASK", { task_id, message: "no maintenance task has this id: list_maintenance_tasks gives each task's id, and add_maintenance_task adds one" });

/** Whether a task is there. */
async function taskExists(sql: PluginSql, id: string): Promise<boolean> {
  const [row] = await sql<{ n: number }>`SELECT count(*)::int AS n FROM maintenance_tasks WHERE id = ${id}`;
  return row.n > 0;
}

/** A person's search text as an ILIKE pattern: `%`, `_` and the backslash match themselves, so "50%" finds "50%". */
const likePattern = (s: string) => `%${likeText(s)}%`;
/**
 * A person's search text with `%`, `_` and the backslash escaped for ILIKE,
 * for a query matched word by word: the SQL splits it on spaces and asks each
 * word apart ("HVAC filter change" finds a task named "Change the HVAC
 * filter"), so a phrase an agent types never misses for its word order.
 */
const likeText = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** The day an agent says is the user's today, or the date in UTC: a read's days_until counts from it. */
const TodayInput = z.iso.date().refine((d) => !d.startsWith("0000-"), "a date from the year 0001").optional()
  .describe("The user's own date today, YYYY-MM-DD; the date in UTC unless given, which is a day off for part of each day in most time zones");

export default definePlugin({
  name: "home-maintenance",
  title: "Home maintenance",
  description: "The house's maintenance tasks, one-time or recurring every so many days, and the log of work done on them, so an agent can say what is due or overdue and what was done when.",
  operations: {
    add_maintenance_task: operation({
      title: "Add a maintenance task",
      description: "Adds a maintenance task and answers it with its id, which log_maintenance names it by. A recurring one gives frequency_days (90 for quarterly, 365 for yearly); without next_due it falls due frequency_days from today. If it was last done on a known day, log_maintenance that day after adding it, and its next_due follows from that day. A one-time one gives no frequency_days, and next_due if it has a date. list_maintenance_tasks lists every task, so check it first rather than adding one twice.",
      scope: "write",
      annotations: ADDS,
      method: "POST",
      path: "/tasks",
      input: {
        name: text(200).min(1).describe("What the task is"),
        category: text(100).min(1).nullish().describe("Its kind: 'hvac', 'plumbing', 'exterior', 'appliance', 'landscaping', …"),
        frequency_days: z.number().int().min(1).max(3650).nullish().describe("How often it comes round, in days, 1 to 3650; leave it out for a one-time task"),
        next_due: Day.nullish().describe("The day it is next due, YYYY-MM-DD"),
        priority: z.enum(PRIORITIES).default("medium").describe("How much it matters: low, medium (unless given), high or urgent"),
        notes: text(5000).nullish().describe("Anything else worth keeping (the filter size, say)"),
        today: TodayInput,
      },
      output: { task: Task },
      async handler(ctx, t) {
        const [row] = await ctx.db.tx(async (sql) => {
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO maintenance_tasks (name, category, frequency_days, next_due, priority, notes)
            VALUES (${t.name}, ${t.category ?? null}, ${t.frequency_days ?? null}::int,
                    coalesce(${t.next_due ?? null}::date, coalesce(${t.today ?? null}::date, (now() AT TIME ZONE 'UTC')::date) + ${t.frequency_days ?? null}::int),
                    ${t.priority}, ${t.notes ?? null})
            RETURNING id`;
          return sql<Answer<z.input<typeof Task>>>`
            SELECT answer || jsonb_build_object('days_until', next_due - coalesce(${t.today ?? null}::date, (now() AT TIME ZONE 'UTC')::date)) AS answer
              FROM task_rows WHERE id = ${id}`;
        });
        return ok({ task: row.answer });
      },
    }),
    list_maintenance_tasks: operation({
      title: "The maintenance tasks",
      description: "The maintenance tasks with their ids: those whose name, category or notes hold every word of the query (any case, any order), or of one category, each filter optional. Soonest due first, then those with no date, by priority within a day; done one-time tasks are left out unless include_done. truncated says whether more matched than limit.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/tasks",
      input: {
        query: text(200).min(1).optional().describe("Words in the name, the category or the notes, each matched apart"),
        category: text(100).min(1).optional().describe("Text in the category, any case"),
        include_done: z.boolean().default(false).describe("Whether done one-time tasks are listed too"),
        limit: z.number().int().min(1).max(500).default(100).describe("How many at most, 1 to 500"),
        today: TodayInput,
      },
      output: { tasks: z.array(Task), truncated: z.boolean() },
      async handler(ctx, { query, category, include_done, limit, today }) {
        const words = query === undefined ? null : likeText(query);
        const kind = category === undefined ? null : likePattern(category);
        const rows = await ctx.db.tx((sql) => sql<Answer<z.input<typeof Task>>>`
          SELECT answer || jsonb_build_object('days_until', next_due - coalesce(${today ?? null}::date, (now() AT TIME ZONE 'UTC')::date)) AS answer
            FROM task_rows
           WHERE (${words}::text IS NULL OR (SELECT bool_and(concat_ws(' ', name, category, notes) ILIKE '%' || w || '%')
                                             FROM unnest(regexp_split_to_array(${words}::text, '[[:space:]]+')) w))
             AND (${kind}::text IS NULL OR category ILIKE ${kind}::text)
             AND (${include_done}::boolean OR NOT done)
           ORDER BY done, next_due NULLS LAST, priority_rank, name, id
           LIMIT ${limit + 1}`);
        return ok({ tasks: rows.slice(0, limit).map((r) => r.answer), truncated: rows.length > limit });
      },
    }),
    log_maintenance: operation({
      title: "Log maintenance done",
      description: "Logs work done on a task (task_id, from list_maintenance_tasks or get_upcoming_maintenance) on completed_on, the day it was done in the user's own calendar, and moves the task on: its last_completed is the latest day logged, a recurring task falls due frequency_days after it, and a one-time task is done. A log of older work is kept without moving the task back. Answers the log and the task as it now is. Refused: a task that is not there (NO_SUCH_TASK), and a completed_on more than a day past today in UTC (FUTURE_DATE), which would hold the task's dates in the future for good.",
      scope: "write",
      annotations: ADDS,
      method: "POST",
      path: "/logs",
      input: {
        task_id: z.string().uuid().describe("The task's id"),
        completed_on: Day.describe("The day the work was done, YYYY-MM-DD, in the user's own calendar"),
        performed_by: text(200).min(1).nullish().describe("Who did it: 'self', a vendor's name, …"),
        cost: z.number().min(0).max(99999999.99).nullish().describe("What it cost, in your currency, kept to two decimal places"),
        notes: text(5000).nullish().describe("What was done"),
        next_action: text(2000).nullish().describe("What the person who did it recommended for next time"),
      },
      output: { log: Log, task: Task },
      async handler(ctx, l) {
        const done = await ctx.db.tx(async (sql) => {
          const [held] = await sql<{ id: string; future: boolean }>`
            SELECT id, ${l.completed_on}::date > (now() AT TIME ZONE 'UTC')::date + 1 AS future FROM maintenance_tasks WHERE id = ${l.task_id}`;
          if (!held) return null;
          if (held.future) return "future" as const;
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO maintenance_logs (task_id, completed_on, performed_by, cost, notes, next_action)
            VALUES (${l.task_id}, ${l.completed_on}::date, ${l.performed_by ?? null},
                    ${l.cost ?? null}::numeric, ${l.notes ?? null}, ${l.next_action ?? null})
            RETURNING id`;
          // The task moved on to the later of its last day and this log's,
          // read from the row the UPDATE writes and nowhere else: an UPDATE
          // that waited on another log's re-reads that row as the other left
          // it and computes its SET again (Postgres re-reads the target row
          // alone, not a subquery's), so two logs at once keep the latest
          // day in either order. A max over the logs, read before the wait,
          // could miss the other's.
          await sql`
            UPDATE maintenance_tasks t
               SET last_completed = greatest(t.last_completed, ${l.completed_on}::date),
                   next_due = CASE WHEN t.frequency_days IS NULL THEN NULL
                                   ELSE greatest(t.last_completed, ${l.completed_on}::date) + t.frequency_days END,
                   updated_at = now()
             WHERE t.id = ${l.task_id}`;
          const [log] = await sql<Answer<z.input<typeof Log>>>`SELECT answer FROM log_rows WHERE id = ${id}`;
          const [task] = await sql<Answer<z.input<typeof Task>>>`SELECT answer FROM task_rows WHERE id = ${l.task_id}`;
          return { log: log.answer, task: task.answer };
        });
        if (!done) return noSuchTask(l.task_id);
        if (done === "future") return refuse(422, "FUTURE_DATE", { completed_on: l.completed_on, message: `completed_on ${l.completed_on} is more than a day past today in UTC: give the day the work was done` });
        return ok(done);
      },
    }),
    get_upcoming_maintenance: operation({
      title: "Upcoming maintenance",
      description: "The tasks due from today to days_ahead days on (30 unless given), and every one already overdue, soonest first and by priority within a day. Each carries days_until, negative when it is overdue. A one-time task with no date or done is not listed; list_maintenance_tasks lists every task. Today is the user's date when given, else the date in UTC; the answer says which day it counted from.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/upcoming",
      input: {
        days_ahead: z.number().int().min(0).max(366).default(30).describe("How many days ahead to look, 0 to 366"),
        today: TodayInput,
      },
      output: { today: z.string(), tasks: z.array(Task) },
      async handler(ctx, { days_ahead, today: given }) {
        const { today, rows } = await ctx.db.tx(async (sql) => {
          const [{ today }] = await sql<{ today: string }>`SELECT coalesce(${given ?? null}::date, (now() AT TIME ZONE 'UTC')::date)::text AS today`;
          const rows = await sql<Answer<z.input<typeof Task>>>`
            SELECT answer || jsonb_build_object('days_until', next_due - ${today}::date) AS answer FROM task_rows
             WHERE NOT done AND next_due IS NOT NULL AND next_due - ${today}::date <= ${days_ahead}::int
             ORDER BY next_due, priority_rank, name, id`;
          return { today, rows };
        });
        return ok({ today, tasks: rows.map((r) => r.answer) });
      },
    }),
    search_maintenance_history: operation({
      title: "Search maintenance history",
      description: "The work logged: on one task (task_id), on tasks whose name or category holds the text given (any case), and from date_from to date_to, each filter optional and those given all applying. Latest first, each with its task, at most limit of them; count and total_cost are over every log that matched, so a sum of what was spent needs no paging, and truncated says whether more matched than were listed. A task_id that names no task is refused (NO_SUCH_TASK), as is a date_to before date_from (BAD_DATES).",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/history",
      input: {
        task_id: z.string().uuid().optional().describe("One task's log alone, by the id list_maintenance_tasks gives"),
        task_name: text(200).min(1).optional().describe("Text in the task's name"),
        category: text(100).min(1).optional().describe("Text in the task's category"),
        date_from: Day.optional().describe("The first day, YYYY-MM-DD"),
        date_to: Day.optional().describe("The last day, YYYY-MM-DD"),
        limit: z.number().int().min(1).max(200).default(50).describe("How many at most, 1 to 200"),
      },
      output: { logs: z.array(Log), count: z.number().int(), total_cost: z.number(), truncated: z.boolean() },
      async handler(ctx, f) {
        if (f.date_from && f.date_to && f.date_to < f.date_from) return refuse(422, "BAD_DATES", { message: `date_to ${f.date_to} is before date_from ${f.date_from}` });
        const task = f.task_id ?? null;
        const name = f.task_name === undefined ? null : likePattern(f.task_name);
        const kind = f.category === undefined ? null : likePattern(f.category);
        const found = await ctx.db.tx(async (sql) => {
          if (task && !(await taskExists(sql, task))) return null;
          // The filtered logs once, as a CTE: the page of them, and the count and the cost over all of them.
          const rows = await sql<{ answer: z.input<typeof Log>; count: number; total_cost: string | number }>`
            WITH matched AS (
              SELECT answer, completed_on, created_at, id, cost FROM log_rows
               WHERE (${task}::uuid IS NULL OR task_id = ${task}::uuid)
                 AND (${name}::text IS NULL OR task_name ILIKE ${name}::text)
                 AND (${kind}::text IS NULL OR task_category ILIKE ${kind}::text)
                 AND (${f.date_from ?? null}::date IS NULL OR completed_on >= ${f.date_from ?? null}::date)
                 AND (${f.date_to ?? null}::date IS NULL OR completed_on <= ${f.date_to ?? null}::date))
            SELECT m.answer, t.count, t.total_cost
              FROM (SELECT count(*)::int AS count, coalesce(sum(cost), 0)::float8 AS total_cost FROM matched) t
              LEFT JOIN LATERAL (SELECT answer, completed_on, created_at, id FROM matched ORDER BY completed_on DESC, created_at DESC, id LIMIT ${f.limit}) m ON true
             ORDER BY m.completed_on DESC, m.created_at DESC, m.id`;
          return rows;
        });
        if (!found) return noSuchTask(task!);
        const count = found[0]?.count ?? 0;
        const logs = found.filter((r) => r.answer !== null).map((r) => r.answer);
        return ok({ logs, count, total_cost: Number(found[0]?.total_cost ?? 0), truncated: count > logs.length });
      },
    }),
  },
});
