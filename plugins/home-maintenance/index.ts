// The home maintenance tracker (SMD-2311): the house's maintenance tasks,
// one-time or recurring every so many days, and the log of work done on
// them, in tables of the plugin's own (migrations/001_home_maintenance.sql).
// Ported from the standalone server extensions/home-maintenance/index.ts, its
// four tools kept as four operations under the same names, and a fifth,
// list_maintenance_tasks, so an agent can find a task's id. Each task is an
// open item in the brain (SMD-3665 PR 3b), kept through the core as the
// caller (keepRowItem): proposed when the task is added, due at its next_due,
// moved on or settled done when work is logged, and sync_open_items keeps
// every task's at once; its priority is stated on that item (SMD-3666 PR 3,
// keepItemPriority), its default medium unknown unless the caller chose it.
// Nothing else of the core's is reached.

import { definePlugin, keepItemPriority, keepRowItem, ok, operation, refuse, RowItemAnswer, z } from "../../server-portable/plugin-sdk.ts";
import type { PluginSql, RowItem } from "../../server-portable/plugin-sdk.ts";

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

/**
 * A task as the open item it stands for: its name, due at its next_due, settled done once a one-time task's work is
 * logged. A recurring task comes round again: its item, settled done by a key, is reopened at its next due day.
 */
const taskItem = (t: { id: string; name: string; frequency_days: number | null; next_due: string | null; done: boolean; last_completed: string | null }): RowItem => ({
  row: t.id, text: t.name, due: t.next_due,
  ...(t.done ? { done: { reason: `home-maintenance: work logged on ${t.last_completed}` } } : {}),
  ...(t.frequency_days !== null ? { reopenDone: { reason: `home-maintenance: a recurring task, due again on ${t.next_due}` } } : {}),
});

/**
 * A task's priority as its item states it (SMD-3666 PR 3): its word on home-maintenance's row of docs/priority.md's
 * table, the column's default medium unknown unless the caller chose it (002's priority_chosen). On a live item
 * alone: a settled one's priority would say nothing.
 */
async function keepTaskPriority(ctx: Parameters<typeof keepItemPriority>[0], item: { id: string; status: string } | null, priority: string, chosen: boolean) {
  if (!item || (item.status !== "proposed" && item.status !== "open")) return null;
  return keepItemPriority(ctx, item.id, { scale: "home-maintenance", value: priority, chosen });
}

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
/**
 * The day an agent says is the user's today, or the date in UTC without one:
 * days_until and the like count from it. Within a day of the date in UTC
 * either way, as every time zone's date is (UTC-12 to UTC+14): a date
 * further off is a typo that would date a stored row wrongly for good.
 */
const TodayInput = z.iso.date()
  .refine((d) => Math.abs(Date.parse(`${d}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) <= 86_400_000,
    "the user's own date today, within a day of the date in UTC")
  .optional()
  .describe("The user's own date today, YYYY-MM-DD; the date in UTC unless given, which is a day off for part of each day in most time zones");
/** A query's words: split on any whitespace (a no-break space included), joined by one space, each escaped for ILIKE. */
const wordsOf = (q: string) => likeText(q.split(/\s+/).filter(Boolean).join(" "));

export default definePlugin({
  name: "home-maintenance",
  title: "Home maintenance",
  description: "The house's maintenance tasks, one-time or recurring every so many days, and the log of work done on them, so an agent can say what is due or overdue and what was done when.",
  operations: {
    add_maintenance_task: operation({
      title: "Add a maintenance task",
      description: "Adds a maintenance task and answers it with its id, which log_maintenance names it by. A recurring one gives frequency_days (90 for quarterly, 365 for yearly); without next_due it falls due frequency_days from today. If it was last done on a known day, log_maintenance that day after adding it, and its next_due follows from that day. A one-time one gives no frequency_days, and next_due if it has a date. list_maintenance_tasks lists every task, so check it first rather than adding one twice. The task is an open item in the brain too, answered as item: proposed, due at next_due, until a write key confirms it (set_item_status); its priority is stated on that item at your key's tier, a priority not given reading as unknown there (the task's own is medium).",
      scope: "write",
      annotations: ADDS,
      method: "POST",
      path: "/tasks",
      input: {
        name: text(200).min(1).describe("What the task is"),
        category: text(100).min(1).nullish().describe("Its kind: 'hvac', 'plumbing', 'exterior', 'appliance', 'landscaping', …"),
        frequency_days: z.number().int().min(1).max(3650).nullish().describe("How often it comes round, in days, 1 to 3650; leave it out for a one-time task"),
        next_due: Day.nullish().describe("The day it is next due, YYYY-MM-DD"),
        // Not defaulted here: whether it was given is what the brain is told (SMD-3666 PR 3); the row's default is SQL's.
        priority: z.enum(PRIORITIES).optional().describe("How much it matters: low, medium, high or urgent; medium unless given, which the brain reads as unknown"),
        notes: text(5000).nullish().describe("Anything else worth keeping (the filter size, say)"),
        today: TodayInput,
      },
      output: { task: Task, item: RowItemAnswer.describe("The task's open item in the brain, proposed until a write key confirms it; null when the brain did not keep it, which sync_open_items repairs") },
      async handler(ctx, t) {
        const [row] = await ctx.db.tx(async (sql) => {
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO maintenance_tasks (name, category, frequency_days, next_due, priority, priority_chosen, notes)
            VALUES (${t.name}, ${t.category ?? null}, ${t.frequency_days ?? null}::int,
                    coalesce(${t.next_due ?? null}::date, coalesce(${t.today ?? null}::date, (now() AT TIME ZONE 'UTC')::date) + ${t.frequency_days ?? null}::int),
                    ${t.priority ?? "medium"}, ${t.priority !== undefined}, ${t.notes ?? null})
            RETURNING id`;
          return sql<Answer<z.input<typeof Task>>>`
            SELECT answer || jsonb_build_object('days_until', next_due - coalesce(${t.today ?? null}::date, (now() AT TIME ZONE 'UTC')::date)) AS answer
              FROM task_rows WHERE id = ${id}`;
        });
        const { item } = await keepRowItem(ctx, taskItem(row.answer));
        await keepTaskPriority(ctx, item, row.answer.priority, t.priority !== undefined);
        return ok({ task: row.answer, item });
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
        const words = query === undefined ? null : wordsOf(query);
        const kind = category === undefined ? null : likePattern(category);
        const rows = await ctx.db.tx((sql) => sql<Answer<z.input<typeof Task>>>`
          SELECT answer || jsonb_build_object('days_until', next_due - coalesce(${today ?? null}::date, (now() AT TIME ZONE 'UTC')::date)) AS answer
            FROM task_rows
           WHERE (${words}::text IS NULL OR (SELECT bool_and(concat_ws(' ', name, category, notes) ILIKE '%' || w || '%')
                                             FROM unnest(regexp_split_to_array(${words}::text, ' ')) w))
             AND (${kind}::text IS NULL OR category ILIKE ${kind}::text)
             AND (${include_done}::boolean OR NOT done)
           ORDER BY done, next_due NULLS LAST, priority_rank, name, id
           LIMIT ${limit + 1}`);
        return ok({ tasks: rows.slice(0, limit).map((r) => r.answer), truncated: rows.length > limit });
      },
    }),
    log_maintenance: operation({
      title: "Log maintenance done",
      description: "Logs work done on a task (task_id, from list_maintenance_tasks or get_upcoming_maintenance) on completed_on, the day it was done in the user's own calendar, and moves the task on: its last_completed is the latest day logged, a recurring task falls due frequency_days after it, and a one-time task is done. A log of older work is kept without moving the task back. Answers the log, the task as it now is, and its open item (item): a recurring task's moved to its new next_due, reopened if a key had settled it done; a one-time task's settled done. Refused: a task that is not there (NO_SUCH_TASK), and a completed_on more than a day past today in UTC (FUTURE_DATE), which would hold the task's dates in the future for good.",
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
        today: TodayInput,
      },
      output: { log: Log, task: Task, item: RowItemAnswer.describe("The task's open item as the log left it: due at the task's next_due, or settled done for a one-time task; null when the brain did not keep it") },
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
          const [task] = await sql<Answer<z.input<typeof Task>>>`
            SELECT answer || jsonb_build_object('days_until', next_due - coalesce(${l.today ?? null}::date, (now() AT TIME ZONE 'UTC')::date)) AS answer
              FROM task_rows WHERE id = ${l.task_id}`;
          return { log: log.answer, task: task.answer };
        });
        if (!done) return noSuchTask(l.task_id);
        if (done === "future") return refuse(422, "FUTURE_DATE", { completed_on: l.completed_on, message: `completed_on ${l.completed_on} is more than a day past today in UTC: give the day the work was done` });
        return ok({ ...done, item: (await keepRowItem(ctx, taskItem(done.task))).item });
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
      description: "The work logged: on one task (task_id), on tasks whose name holds every word of task_name (any case, any order) or whose category holds the text given, and from date_from to date_to, each filter optional and those given all applying. Latest first, each with its task, at most limit of them; count and total_cost are over every log that matched, so a sum of what was spent needs no paging, and truncated says whether more matched than were listed. A task_id that names no task is refused (NO_SUCH_TASK), as is a date_to before date_from (BAD_DATES).",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/history",
      input: {
        task_id: z.string().uuid().optional().describe("One task's log alone, by the id list_maintenance_tasks gives"),
        task_name: text(200).min(1).optional().describe("Words in the task's name, each matched apart"),
        category: text(100).min(1).optional().describe("Text in the task's category"),
        date_from: Day.optional().describe("The first day, YYYY-MM-DD"),
        date_to: Day.optional().describe("The last day, YYYY-MM-DD"),
        limit: z.number().int().min(1).max(200).default(50).describe("How many at most, 1 to 200"),
      },
      output: { logs: z.array(Log), count: z.number().int(), total_cost: z.number(), truncated: z.boolean() },
      async handler(ctx, f) {
        if (f.date_from && f.date_to && f.date_to < f.date_from) return refuse(422, "BAD_DATES", { message: `date_to ${f.date_to} is before date_from ${f.date_from}` });
        const task = f.task_id ?? null;
        const name = f.task_name === undefined ? null : wordsOf(f.task_name);
        const kind = f.category === undefined ? null : likePattern(f.category);
        const found = await ctx.db.tx(async (sql) => {
          if (task && !(await taskExists(sql, task))) return null;
          // The filtered logs once, as a CTE: the page of them, and the count and the cost over all of them.
          const rows = await sql<{ answer: z.input<typeof Log>; count: number; total_cost: string | number }>`
            WITH matched AS (
              SELECT answer, completed_on, created_at, id, cost FROM log_rows
               WHERE (${task}::uuid IS NULL OR task_id = ${task}::uuid)
                 AND (${name}::text IS NULL OR (SELECT bool_and(task_name ILIKE '%' || w || '%') FROM unnest(regexp_split_to_array(${name}::text, ' ')) w))
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
    sync_open_items: operation({
      title: "Keep the tasks' open items",
      description: "Keeps every task's open item in the brain as add_maintenance_task and log_maintenance do: opens the item of a task that has none (proposed), moves an item's text or due day to its task's, settles done the item of a one-time task whose work is logged, and reopens a recurring task's item a key settled done, since the task comes round again. A done task with no live item opens none, and an item a key dropped is left so. Safe to run again; run it once after turning on items (SMD-3665), and after an add or a log whose item came back null. States each live item's priority as add_maintenance_task does, at your key's tier: priorities_stated counts those written or cleared, the same again writing nothing. Answers how many items it opened, updated, settled, reopened and left unchanged, and each task whose item or priority the brain refused with its code. items_truncated: the brain held more than 1000 live items of this plugin's, so a done one-time task's item past them may be left live.",
      scope: "write",
      annotations: { ...ADDS, idempotentHint: true },
      method: "POST",
      path: "/items/sync",
      input: {},
      output: {
        opened: z.number().int(), updated: z.number().int(), settled: z.number().int(), reopened: z.number().int(), unchanged: z.number().int(),
        priorities_stated: z.number().int(),
        failed: z.array(z.object({ task_id: z.string(), code: z.string() })), items_truncated: z.boolean(),
      },
      async handler(ctx) {
        const tasks = await ctx.db.tx((sql) => sql<Answer<z.input<typeof Task>> & { priority_chosen: boolean }>`SELECT answer, priority_chosen FROM task_rows ORDER BY created_at, id`);
        // The tasks whose item is live (proposed or open): a done task's item is settled only if it has one.
        const live = await ctx.call("list_items", { plugin: "home-maintenance", status: "unsettled", limit: 1000 });
        if (!live.ok) return refuse(409, "ITEMS_UNREADABLE", { cause: live.refusal.code, message: `the brain's open items could not be read (${live.refusal.code}); nothing was kept` });
        const liveRows = new Set(live.value.items.flatMap((i) => (i.plugin ? [i.plugin.row] : [])));
        const tally = { opened: 0, updated: 0, settled: 0, reopened: 0, unchanged: 0 };
        let prioritiesStated = 0;
        const failed: { task_id: string; code: string }[] = [];
        for (const { answer: t, priority_chosen } of tasks) {
          if (t.done && !liveRows.has(t.id)) continue;
          const kept = await keepRowItem(ctx, taskItem(t));
          if (kept.did === "failed") { failed.push({ task_id: t.id, code: kept.code }); continue; }
          tally[kept.did]++;
          const said = await keepTaskPriority(ctx, kept.item, t.priority, priority_chosen);
          if (said?.did === "failed") failed.push({ task_id: t.id, code: `priority ${said.code}` });
          else if (said?.did === "asserted" || said?.did === "cleared") prioritiesStated++;
        }
        return ok({ ...tally, priorities_stated: prioritiesStated, failed, items_truncated: live.value.truncated });
      },
    }),
  },
});
