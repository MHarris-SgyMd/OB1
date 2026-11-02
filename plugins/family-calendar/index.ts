// The family calendar (SMD-2311): the household's members, their activities
// — one-time, or weekly on a day — and the dates to remember, in tables of
// the plugin's own (migrations/001_family_calendar.sql). Ported from the
// standalone server extensions/family-calendar/index.ts, its six tools kept
// as six operations under the same names. It reaches nothing of the core's.

import { definePlugin, ok, operation, refuse, z } from "../../server-portable/plugin-sdk.ts";
import type { PluginSql } from "../../server-portable/plugin-sdk.ts";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
/** A calendar date as the tables hold it, YYYY-MM-DD, from the year 0001: Postgres has no year 0000, which zod's ISO date accepts. */
const Day = z.iso.date().refine((d) => !d.startsWith("0000-"), "a date from the year 0001");
/** A time of day, HH:MM on the 24-hour clock. */
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time of day, HH:MM");
/** Free text a person types: trimmed, and at most `max` characters. */
const text = (max: number) => z.string().trim().max(max);

/** The member an activity or a date belongs to, or null for the whole family's. */
const MemberRef = z.object({ id: z.string(), name: z.string(), relationship: z.string().nullable() }).nullable();
const Member = z.object({
  id: z.string(), name: z.string(), relationship: z.string().nullable(), birth_date: z.string().nullable(), notes: z.string().nullable(), created_at: z.string(),
});
const Activity = z.object({
  id: z.string(), family_member_id: z.string().nullable(), title: z.string(), activity_type: z.string().nullable(), day_of_week: z.enum(DAYS).nullable(),
  start_time: z.string().nullable(), end_time: z.string().nullable(), start_date: z.string().nullable(), end_date: z.string().nullable(),
  location: z.string().nullable(), notes: z.string().nullable(), created_at: z.string(), family_member: MemberRef,
});
const ImportantDate = z.object({
  id: z.string(), family_member_id: z.string().nullable(), title: z.string(), date_value: z.string(), recurring_yearly: z.boolean(),
  reminder_days_before: z.number().int(), notes: z.string().nullable(), created_at: z.string(), family_member: MemberRef,
});
const UpcomingDate = ImportantDate.extend({ next_date: z.string(), days_until: z.number().int(), remind: z.boolean() });

/** A row's answer as the migration's views build it (activity_rows, important_date_rows): one jsonb object, the shape the output declares. */
type Answer<T> = { answer: T };

/** Whether a member is there: an activity or a date may name only one that is. */
async function memberExists(sql: PluginSql, id: string): Promise<boolean> {
  const [row] = await sql<{ n: number }>`SELECT count(*)::int AS n FROM family_members WHERE id = ${id}`;
  return row.n > 0;
}

/** A person's search text as an ILIKE pattern: `%`, `_` and the backslash match themselves, so "50%" finds "50%". */
const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export default definePlugin({
  name: "family-calendar",
  title: "Family calendar",
  description: "The household's members, their activities (one-time, or weekly on a day) and the dates to remember (birthdays, anniversaries, deadlines), so an agent can read the week's schedule and what is coming up.",
  operations: {
    add_family_member: operation({
      title: "Add a family member",
      description: "Adds a person to the household roster. An activity or an important date names a member by the id this answers.",
      scope: "write",
      method: "POST",
      path: "/members",
      input: {
        name: text(200).min(1).describe("The person's name"),
        relationship: text(100).min(1).nullish().describe("Their relationship to you: 'self', 'spouse', 'child', 'parent', …"),
        birth_date: Day.nullish().describe("Their birth date, YYYY-MM-DD"),
        notes: text(5000).nullish().describe("Anything else worth keeping"),
      },
      output: { member: Member },
      async handler(ctx, { name, relationship, birth_date, notes }) {
        const [row] = await ctx.db.tx((sql) => sql<Answer<z.input<typeof Member>>>`
          INSERT INTO family_members (name, relationship, birth_date, notes)
          VALUES (${name}, ${relationship ?? null}, ${birth_date ?? null}::date, ${notes ?? null})
          RETURNING jsonb_build_object('id', id, 'name', name, 'relationship', relationship, 'birth_date', birth_date::text, 'notes', notes,
                                       'created_at', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS answer`);
        return ok({ member: row.answer });
      },
    }),
    add_activity: operation({
      title: "Schedule an activity",
      description: "Schedules an activity: weekly on day_of_week, or dated alone, from start_date to end_date (no end_date: it runs on). family_member_id names whose it is; without one it is the whole family's. One with neither a day nor a start date is refused (NO_WHEN), as is a member that is not there (NO_SUCH_MEMBER) and an end_date before the start_date (BAD_DATES).",
      scope: "write",
      method: "POST",
      path: "/activities",
      input: {
        title: text(200).min(1).describe("What it is"),
        family_member_id: z.string().uuid().nullish().describe("Whose it is; leave it out for the whole family's"),
        activity_type: text(100).min(1).nullish().describe("Its kind: 'sports', 'medical', 'school', 'social', …"),
        day_of_week: z.enum(DAYS).nullish().describe("The day a weekly activity falls on, lower-case; leave it out for one dated alone"),
        start_time: Time.nullish().describe("When it starts, HH:MM"),
        end_time: Time.nullish().describe("When it ends, HH:MM"),
        start_date: Day.nullish().describe("Its first day (a weekly one's first week), YYYY-MM-DD"),
        end_date: Day.nullish().describe("Its last day, YYYY-MM-DD; leave it out for one that runs on"),
        location: text(500).nullish().describe("Where"),
        notes: text(5000).nullish().describe("Anything else worth keeping"),
      },
      output: { activity: Activity },
      async handler(ctx, a) {
        if (!a.day_of_week && !a.start_date) return refuse(422, "NO_WHEN", { message: "give day_of_week for a weekly activity or start_date for a dated one: one with neither is in no week" });
        if (a.start_date && a.end_date && a.end_date < a.start_date) return refuse(422, "BAD_DATES", { message: `end_date ${a.end_date} is before start_date ${a.start_date}` });
        const memberId = a.family_member_id ?? null;
        const row = await ctx.db.tx(async (sql) => {
          if (memberId && !(await memberExists(sql, memberId))) return null;
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO activities (family_member_id, title, activity_type, day_of_week, start_time, end_time, start_date, end_date, location, notes)
            VALUES (${memberId}, ${a.title}, ${a.activity_type ?? null}, ${a.day_of_week ?? null}, ${a.start_time ?? null}::time, ${a.end_time ?? null}::time,
                    ${a.start_date ?? null}::date, ${a.end_date ?? null}::date, ${a.location ?? null}, ${a.notes ?? null})
            RETURNING id`;
          const [full] = await sql<Answer<z.input<typeof Activity>>>`SELECT answer FROM activity_rows WHERE id = ${id}`;
          return full;
        });
        if (!row) return refuse(404, "NO_SUCH_MEMBER", { family_member_id: memberId });
        return ok({ activity: row.answer });
      },
    }),
    get_week_schedule: operation({
      title: "The week's schedule",
      description: "The activities of the seven days from week_start (a Monday, say): each weekly activity whose day in that week falls within its own start_date and end_date, where it has them, and each dated one whose start_date to end_date (no end_date: running on) overlaps the week. Ordered by start time; each carries its member, or null for the whole family's.",
      scope: "read",
      method: "GET",
      path: "/week",
      input: {
        week_start: Day.describe("The week's first day, YYYY-MM-DD"),
        family_member_id: z.string().uuid().optional().describe("One member's activities alone (the whole family's are left out)"),
      },
      output: { week_start: z.string(), week_end: z.string(), activities: z.array(Activity) },
      async handler(ctx, { week_start, family_member_id }) {
        const member = family_member_id ?? null;
        const { weekEnd, rows } = await ctx.db.tx(async (sql) => {
          const [{ weekEnd }] = await sql<{ weekEnd: string }>`SELECT (${week_start}::date + 6)::text AS "weekEnd"`;
          // A weekly activity falls once in any seven days: on `on`, its
          // day's offset from week_start's. It is listed when that day is
          // within its own dates; a dated one when its span meets the week.
          const rows = await sql<Answer<z.input<typeof Activity>>>`
            SELECT a.answer FROM activity_rows a
              CROSS JOIN LATERAL (
                SELECT ${week_start}::date + ((array_position(ARRAY['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'], a.day_of_week)
                                               - extract(isodow FROM ${week_start}::date)::int + 7) % 7) AS on_day) w
             WHERE CASE WHEN a.day_of_week IS NOT NULL
                        THEN (a.starts IS NULL OR a.starts <= w.on_day) AND (a.ends IS NULL OR a.ends >= w.on_day)
                        ELSE a.starts IS NOT NULL AND a.starts <= ${weekEnd}::date AND (a.ends IS NULL OR a.ends >= ${week_start}::date) END
               AND (${member}::uuid IS NULL OR a.family_member_id = ${member}::uuid)
             ORDER BY a.starts_at NULLS LAST, a.title, a.id`;
          return { weekEnd, rows };
        });
        return ok({ week_start, week_end: weekEnd, activities: rows.map((r) => r.answer) });
      },
    }),
    search_activities: operation({
      title: "Search activities",
      description: "Activities whose title or member's name holds the query (any case), of one type, or one member's: each filter optional, and those given all apply. Latest start date first, then those with none.",
      scope: "read",
      method: "GET",
      path: "/activities",
      input: {
        query: text(200).min(1).optional().describe("Text in the title or the member's name"),
        activity_type: text(100).min(1).optional().describe("One type alone, as it was given"),
        family_member_id: z.string().uuid().optional().describe("One member's activities alone"),
        limit: z.number().int().min(1).max(200).default(50).describe("How many at most, 1 to 200"),
      },
      output: { activities: z.array(Activity) },
      async handler(ctx, { query, activity_type, family_member_id, limit }) {
        const pattern = query === undefined ? null : likePattern(query);
        const type = activity_type ?? null;
        const member = family_member_id ?? null;
        const rows = await ctx.db.tx((sql) => sql<Answer<z.input<typeof Activity>>>`
          SELECT answer FROM activity_rows
           WHERE (${pattern}::text IS NULL OR title ILIKE ${pattern}::text OR member_name ILIKE ${pattern}::text)
             AND (${type}::text IS NULL OR activity_type = ${type}::text)
             AND (${member}::uuid IS NULL OR family_member_id = ${member}::uuid)
           ORDER BY starts DESC NULLS LAST, created_at DESC, id
           LIMIT ${limit}`);
        return ok({ activities: rows.map((r) => r.answer) });
      },
    }),
    add_important_date: operation({
      title: "Add a date to remember",
      description: "Adds a birthday, an anniversary or a deadline. recurring_yearly makes it come round each year on the same day (29 February on the 28th in other years); reminder_days_before is how far ahead get_upcoming_dates flags it, 7 unless given. A member that is not there is refused (NO_SUCH_MEMBER).",
      scope: "write",
      method: "POST",
      path: "/dates",
      input: {
        title: text(200).min(1).describe("What the date is"),
        date_value: Day.describe("The date, YYYY-MM-DD; for a yearly one, any year's (a birth date, say)"),
        family_member_id: z.string().uuid().nullish().describe("Whose it is; leave it out for the whole family's"),
        recurring_yearly: z.boolean().default(false).describe("Whether it comes round each year"),
        reminder_days_before: z.number().int().min(0).max(365).default(7).describe("How many days ahead to flag it, 0 to 365"),
        notes: text(5000).nullish().describe("Anything else worth keeping"),
      },
      output: { important_date: ImportantDate },
      async handler(ctx, d) {
        const memberId = d.family_member_id ?? null;
        const row = await ctx.db.tx(async (sql) => {
          if (memberId && !(await memberExists(sql, memberId))) return null;
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO important_dates (family_member_id, title, date_value, recurring_yearly, reminder_days_before, notes)
            VALUES (${memberId}, ${d.title}, ${d.date_value}::date, ${d.recurring_yearly}, ${d.reminder_days_before}, ${d.notes ?? null})
            RETURNING id`;
          const [full] = await sql<Answer<z.input<typeof ImportantDate>>>`SELECT answer FROM important_date_rows WHERE id = ${id}`;
          return full;
        });
        if (!row) return refuse(404, "NO_SUCH_MEMBER", { family_member_id: memberId });
        return ok({ important_date: row.answer });
      },
    }),
    get_upcoming_dates: operation({
      title: "Upcoming dates",
      description: "The important dates from today to days_ahead days on (30 unless given), soonest first. A yearly one counts on its next anniversary: next_date gives it and days_until how far off it is, and remind says whether that is within its reminder_days_before. Today is the database's date.",
      scope: "read",
      method: "GET",
      path: "/dates",
      input: { days_ahead: z.number().int().min(0).max(366).default(30).describe("How many days ahead to look, 0 to 366") },
      output: { today: z.string(), dates: z.array(UpcomingDate) },
      async handler(ctx, { days_ahead }) {
        const { today, rows } = await ctx.db.tx(async (sql) => {
          const [{ today }] = await sql<{ today: string }>`SELECT current_date::text AS today`;
          // A yearly date's next anniversary on or after today: the date moved
          // on by the whole years since, and by one more if that is past.
          // Postgres moves 29 February to the 28th in a year without one.
          const rows = await sql<Answer<z.input<typeof UpcomingDate>>>`
            SELECT d.answer || jsonb_build_object('next_date', n.next_date::text, 'days_until', n.next_date - ${today}::date,
                                                  'remind', n.next_date - ${today}::date <= d.reminder_days_before) AS answer
              FROM important_date_rows d
              CROSS JOIN LATERAL (SELECT extract(year FROM age(${today}::date, d.day))::int AS years) y
              CROSS JOIN LATERAL (
                SELECT CASE
                         WHEN NOT d.recurring_yearly OR d.day >= ${today}::date THEN d.day
                         WHEN (d.day + make_interval(years => y.years))::date >= ${today}::date THEN (d.day + make_interval(years => y.years))::date
                         ELSE (d.day + make_interval(years => y.years + 1))::date
                       END AS next_date) n
             WHERE n.next_date BETWEEN ${today}::date AND ${today}::date + ${days_ahead}::int
             ORDER BY n.next_date, d.title, d.id`;
          return { today, rows };
        });
        return ok({ today, dates: rows.map((r) => r.answer) });
      },
    }),
  },
});
