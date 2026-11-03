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
const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export default definePlugin({
  name: "home-maintenance",
  title: "Home maintenance",
  description: "The house's maintenance tasks, one-time or recurring every so many days, and the log of work done on them, so an agent can say what is due or overdue and what was done when.",
  operations: {
    add_maintenance_task: operation({
      title: "Add a maintenance task",
      description: "Adds a maintenance task and answers it with its id, which log_maintenance names it by. A recurring one gives frequency_days (90 for quarterly, 365 for yearly); without next_due it falls due frequency_days from today. A one-time one gives no frequency_days, and next_due if it has a date. list_maintenance_tasks lists every task, so check it first rather than adding one twice.",
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
      },
      output: { task: Task },
      async handler(ctx, t) {
        const [row] = await ctx.db.tx(async (sql) => {
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO maintenance_tasks (name, category, frequency_days, next_due, priority, notes)
            VALUES (${t.name}, ${t.category ?? null}, ${t.frequency_days ?? null}::int,
                    coalesce(${t.next_due ?? null}::date, (now() AT TIME ZONE 'UTC')::date + ${t.frequency_days ?? null}::int),
                    ${t.priority}, ${t.notes ?? null})
            RETURNING id`;
          return sql<Answer<z.input<typeof Task>>>`SELECT answer FROM task_rows WHERE id = ${id}`;
        });
        return ok({ task: row.answer });
      },
    }),
    list_maintenance_tasks: operation({
      title: "The maintenance tasks",
      description: "The maintenance tasks with their ids: those whose name, category or notes hold the query (any case), or of one category, each filter optional. Soonest due first, then those with no date, by priority within a day; done one-time tasks are left out unless include_done.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/tasks",
      input: {
        query: text(200).min(1).optional().describe("Text in the name, the category or the notes"),
        category: text(100).min(1).optional().describe("Text in the category, any case"),
        include_done: z.boolean().default(false).describe("Whether done one-time tasks are listed too"),
        limit: z.number().int().min(1).max(500).default(100).describe("How many at most, 1 to 500"),
      },
      output: { tasks: z.array(Task) },
      async handler(ctx, { query, category, include_done, limit }) {
        const pattern = query === undefined ? null : likePattern(query);
        const kind = category === undefined ? null : likePattern(category);
        const rows = await ctx.db.tx((sql) => sql<Answer<z.input<typeof Task>>>`
          SELECT answer FROM task_rows
           WHERE (${pattern}::text IS NULL OR name ILIKE ${pattern}::text OR category ILIKE ${pattern}::text OR notes ILIKE ${pattern}::text)
             AND (${kind}::text IS NULL OR category ILIKE ${kind}::text)
             AND (${include_done}::boolean OR NOT done)
           ORDER BY done, next_due NULLS LAST, priority_rank, name, id
           LIMIT ${limit}`);
        return ok({ tasks: rows.map((r) => r.answer) });
      },
    }),
    log_maintenance: operation({
      title: "Log maintenance done",
      description: "Logs work done on a task (task_id, from list_maintenance_tasks or get_upcoming_maintenance), on completed_on (today in UTC unless given), and moves the task on: its last_completed is the latest day logged, a recurring task falls due frequency_days after it, and a one-time task is done. A log of older work is kept without moving the task back. Answers the log and the task as it now is. A task that is not there is refused (NO_SUCH_TASK).",
      scope: "write",
      annotations: ADDS,
      method: "POST",
      path: "/logs",
      input: {
        task_id: z.string().uuid().describe("The task's id"),
        completed_on: Day.nullish().describe("The day the work was done, YYYY-MM-DD; today in UTC unless given"),
        performed_by: text(200).min(1).nullish().describe("Who did it: 'self', a vendor's name, …"),
        cost: z.number().min(0).max(99999999.99).nullish().describe("What it cost, in your currency, kept to two decimal places"),
        notes: text(5000).nullish().describe("What was done"),
        next_action: text(2000).nullish().describe("What the person who did it recommended for next time"),
      },
      output: { log: Log, task: Task },
      async handler(ctx, l) {
        const done = await ctx.db.tx(async (sql) => {
          // The task locked, so two logs at once move it on one after the other.
          const [held] = await sql<{ id: string }>`SELECT id FROM maintenance_tasks WHERE id = ${l.task_id} FOR UPDATE`;
          if (!held) return null;
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO maintenance_logs (task_id, completed_on, performed_by, cost, notes, next_action)
            VALUES (${l.task_id}, coalesce(${l.completed_on ?? null}::date, (now() AT TIME ZONE 'UTC')::date), ${l.performed_by ?? null},
                    ${l.cost ?? null}::numeric, ${l.notes ?? null}, ${l.next_action ?? null})
            RETURNING id`;
          await sql`
            UPDATE maintenance_tasks t
               SET last_completed = m.last,
                   next_due = CASE WHEN t.frequency_days IS NULL THEN NULL ELSE m.last + t.frequency_days END,
                   updated_at = now()
              FROM (SELECT max(completed_on) AS last FROM maintenance_logs WHERE task_id = ${l.task_id}) m
             WHERE t.id = ${l.task_id}`;
          const [log] = await sql<Answer<z.input<typeof Log>>>`SELECT answer FROM log_rows WHERE id = ${id}`;
          const [task] = await sql<Answer<z.input<typeof Task>>>`SELECT answer FROM task_rows WHERE id = ${l.task_id}`;
          return { log: log.answer, task: task.answer };
        });
        if (!done) return noSuchTask(l.task_id);
        return ok(done);
      },
    }),
    get_upcoming_maintenance: operation({
      title: "Upcoming maintenance",
      description: "The tasks due from now to days_ahead days on (30 unless given), and every one already overdue, soonest first and by priority within a day. Each carries days_until, negative when it is overdue. A one-time task with no date or done is not listed; list_maintenance_tasks lists every task. Today is the date in UTC, given as today.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/upcoming",
      input: { days_ahead: z.number().int().min(0).max(366).default(30).describe("How many days ahead to look, 0 to 366") },
      output: { today: z.string(), tasks: z.array(Task) },
      async handler(ctx, { days_ahead }) {
        const { today, rows } = await ctx.db.tx(async (sql) => {
          const [{ today }] = await sql<{ today: string }>`SELECT (now() AT TIME ZONE 'UTC')::date::text AS today`;
          const rows = await sql<Answer<z.input<typeof Task>>>`
            SELECT answer FROM task_rows
             WHERE NOT done AND next_due IS NOT NULL AND days_until <= ${days_ahead}::int
             ORDER BY next_due, priority_rank, name, id`;
          return { today, rows };
        });
        return ok({ today, tasks: rows.map((r) => r.answer) });
      },
    }),
    search_maintenance_history: operation({
      title: "Search maintenance history",
      description: "The work logged: on one task (task_id), on tasks whose name or category holds the text given (any case), and from date_from to date_to, each filter optional and those given all applying. Latest first, each with its task. A task_id that names no task is refused (NO_SUCH_TASK), as is a date_to before date_from (BAD_DATES).",
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
      output: { logs: z.array(Log) },
      async handler(ctx, f) {
        if (f.date_from && f.date_to && f.date_to < f.date_from) return refuse(422, "BAD_DATES", { message: `date_to ${f.date_to} is before date_from ${f.date_from}` });
        const task = f.task_id ?? null;
        const name = f.task_name === undefined ? null : likePattern(f.task_name);
        const kind = f.category === undefined ? null : likePattern(f.category);
        const rows = await ctx.db.tx(async (sql) => {
          if (task && !(await taskExists(sql, task))) return null;
          return sql<Answer<z.input<typeof Log>>>`
            SELECT answer FROM log_rows
             WHERE (${task}::uuid IS NULL OR task_id = ${task}::uuid)
               AND (${name}::text IS NULL OR task_name ILIKE ${name}::text)
               AND (${kind}::text IS NULL OR task_category ILIKE ${kind}::text)
               AND (${f.date_from ?? null}::date IS NULL OR completed_on >= ${f.date_from ?? null}::date)
               AND (${f.date_to ?? null}::date IS NULL OR completed_on <= ${f.date_to ?? null}::date)
             ORDER BY completed_on DESC, created_at DESC, id
             LIMIT ${f.limit}`;
        });
        if (!rows) return noSuchTask(task!);
        return ok({ logs: rows.map((r) => r.answer) });
      },
    }),
  },
});
