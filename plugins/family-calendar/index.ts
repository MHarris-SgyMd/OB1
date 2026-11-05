// The family calendar (SMD-2311): the household's members, their activities
// — one-time, or weekly on a day — and the dates to remember, in tables of
// the plugin's own (migrations/001_family_calendar.sql). Ported from the
// standalone server extensions/family-calendar/index.ts, its six tools kept
// as six operations under the same names, and a seventh, list_family_members,
// so an agent can find a member's id. A one-time date to remember still to
// come — a deadline — is an open item in the brain (SMD-3665 PR 3b), kept
// through the core as the caller (keepRowItem): proposed when it is added, due
// that day, its member its owner, and sync_open_items keeps every such date's
// at once. Birthdays, anniversaries and activities stay the calendar's alone
// (the maintainer, 2026-11-04). Nothing else of the core's is reached.

import { definePlugin, keepRowItem, ok, operation, refuse, RowItemAnswer, z } from "../../server-portable/plugin-sdk.ts";
import type { PluginSql, RowItem } from "../../server-portable/plugin-sdk.ts";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
/** A calendar date as the tables hold it, YYYY-MM-DD, from the year 0001: Postgres has no year 0000, which zod's ISO date accepts. */
const Day = z.iso.date().refine((d) => !d.startsWith("0000-"), "a date from the year 0001");
/** A time of day, HH:MM on the 24-hour clock. */
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time of day, HH:MM");
/** Free text a person types: trimmed, at most `max` characters, and no NUL, which Postgres will not store in text. */
const text = (max: number) => z.string().trim().max(max).refine((s) => !s.includes("\u0000"), "no NUL character");

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
/** An activity in a week: the date it falls on there, its first day in the week for a span. */
const WeekActivity = Activity.extend({ on_date: z.string() });
const ImportantDate = z.object({
  id: z.string(), family_member_id: z.string().nullable(), title: z.string(), date_value: z.string(), recurring_yearly: z.boolean(),
  reminder_days_before: z.number().int(), notes: z.string().nullable(), created_at: z.string(), family_member: MemberRef,
});
/** A date as added: when it next comes, or null for a one-time date already past, which get_upcoming_dates never lists. */
const AddedDate = ImportantDate.extend({ next_date: z.string().nullable() });
const UpcomingDate = ImportantDate.extend({ next_date: z.string(), days_until: z.number().int(), remind: z.boolean() });

/** MCP hints: every operation reaches the plugin's own tables alone, and an add adds a row, destroying nothing. A read is read-only already. */
const CLOSED = { openWorldHint: false } as const;
const ADDS = { destructiveHint: false, openWorldHint: false } as const;

/** A row's answer as the migration's views build it (activity_rows, important_date_rows): one jsonb object, the shape the output declares. */
type Answer<T> = { answer: T };

/**
 * A one-time date as the open item it stands for: its title, due that day, its member (by name) the owner. A whole
 * family's date names no owner, so one a key gave its item is kept (review pass 1: a sync cleared it).
 */
const dateItem = (d: { id: string; title: string; date_value: string; family_member: { name: string } | null }): RowItem => ({
  row: d.id, text: d.title, due: d.date_value, ...(d.family_member ? { owner: d.family_member.name } : {}),
});

/** Whether a member is there: an activity or a date may name only one that is, and a read filters by one that is. */
async function memberExists(sql: PluginSql, id: string): Promise<boolean> {
  const [row] = await sql<{ n: number }>`SELECT count(*)::int AS n FROM family_members WHERE id = ${id}`;
  return row.n > 0;
}
/** The refusal of a member id that names no one, saying where the ids are. */
const noSuchMember = (family_member_id: string | null) =>
  refuse(404, "NO_SUCH_MEMBER", { family_member_id, message: "no family member has this id: list_family_members gives each member's id, and add_family_member adds one" });

/**
 * A person's search text with `%`, `_` and the backslash escaped for ILIKE,
 * for a query matched word by word: the SQL splits it on spaces and asks each
 * word apart, so "swim Ada" finds Ada's swimming, and "50%" finds "50%".
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
  name: "family-calendar",
  title: "Family calendar",
  description: "The household's members, their activities (one-time, or weekly on a day) and the dates to remember (birthdays, anniversaries, deadlines), so an agent can read the week's schedule and what is coming up.",
  operations: {
    add_family_member: operation({
      title: "Add a family member",
      description: "Adds a person to the household roster and answers their id, which an activity or an important date names them by. list_family_members gives every member's id later, so check it first rather than adding someone twice.",
      scope: "write",
      annotations: ADDS,
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
    list_family_members: operation({
      title: "The family members",
      description: "Every member of the household, by name, with the id an activity, an important date or a member filter names them by.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/members",
      input: {},
      output: { members: z.array(Member) },
      async handler(ctx) {
        const rows = await ctx.db.tx((sql) => sql<Answer<z.input<typeof Member>>>`
          SELECT jsonb_build_object('id', id, 'name', name, 'relationship', relationship, 'birth_date', birth_date::text, 'notes', notes,
                                    'created_at', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS answer
            FROM family_members ORDER BY name, created_at, id`);
        return ok({ members: rows.map((r) => r.answer) });
      },
    }),
    add_activity: operation({
      title: "Schedule an activity",
      description: "Schedules an activity. A one-off (an appointment) gives start_date alone: with no end_date it is that one day. A span (a camp) gives start_date and end_date. A weekly one gives day_of_week, and start_date and end_date to bound it if it has them; with no end_date it runs on. family_member_id names whose it is (list_family_members gives the ids); without one it is the whole family's. Refused: one with neither a day nor a start date (NO_WHEN), a member that is not there (NO_SUCH_MEMBER), an end_date before the start_date (BAD_DATES).",
      scope: "write",
      annotations: ADDS,
      method: "POST",
      path: "/activities",
      input: {
        title: text(200).min(1).describe("What it is"),
        family_member_id: z.string().uuid().nullish().describe("Whose it is, by the id list_family_members gives; leave it out for the whole family's"),
        activity_type: text(100).min(1).nullish().describe("Its kind: 'sports', 'medical', 'school', 'social', …"),
        day_of_week: z.enum(DAYS).nullish().describe("The day a weekly activity falls on, lower-case; leave it out for a one-off or a span, or it repeats every week"),
        start_time: Time.nullish().describe("When it starts, HH:MM"),
        end_time: Time.nullish().describe("When it ends, HH:MM"),
        start_date: Day.nullish().describe("A one-off's day, a span's first day, or the first week a weekly one runs; YYYY-MM-DD"),
        end_date: Day.nullish().describe("A span's last day, or the last week a weekly one runs; YYYY-MM-DD. Leave it out for a one-off (that one day) or a weekly one that runs on"),
        location: text(500).nullish().describe("Where"),
        notes: text(5000).nullish().describe("Anything else worth keeping"),
      },
      output: { activity: Activity },
      async handler(ctx, a) {
        if (!a.day_of_week && !a.start_date) return refuse(422, "NO_WHEN", { message: "give start_date for a one-off or a span, or day_of_week for a weekly activity: one with neither is in no week" });
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
        if (!row) return noSuchMember(memberId);
        return ok({ activity: row.answer });
      },
    }),
    get_week_schedule: operation({
      title: "The week's schedule",
      description: "The activities of the seven days from week_start (a Monday, say), in date order and by start time within a day, each with on_date, the date it falls on that week. A weekly one is listed where its day in the week falls within its own dates, if it has them. A one-off is listed in the week of its day; a span in each week it overlaps, once, on its first day in the week. Each carries its member, or null for the whole family's.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/week",
      input: {
        week_start: Day.describe("The week's first day, YYYY-MM-DD"),
        family_member_id: z.string().uuid().optional().describe("One member's activities alone, by the id list_family_members gives (the whole family's are left out)"),
      },
      output: { week_start: z.string(), week_end: z.string(), activities: z.array(WeekActivity) },
      async handler(ctx, { week_start, family_member_id }) {
        const member = family_member_id ?? null;
        const found = await ctx.db.tx(async (sql) => {
          if (member && !(await memberExists(sql, member))) return null;
          const [{ weekEnd }] = await sql<{ weekEnd: string }>`SELECT (${week_start}::date + 6)::text AS "weekEnd"`;
          // A weekly activity falls once in any seven days: on on_day, its
          // day's offset from week_start's. It is listed when that day is
          // within its own dates. A dated one, its end its start when it has
          // none, is listed when its span meets the week, on its first day in it.
          const rows = await sql<Answer<z.input<typeof WeekActivity>>>`
            SELECT a.answer || jsonb_build_object('on_date', w.on_date::text) AS answer
              FROM activity_rows a
              CROSS JOIN LATERAL (
                SELECT CASE WHEN a.day_of_week IS NOT NULL
                            THEN ${week_start}::date + ((array_position(ARRAY['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'], a.day_of_week)
                                                         - extract(isodow FROM ${week_start}::date)::int + 7) % 7)
                            ELSE greatest(a.starts, ${week_start}::date) END AS on_date) w
             WHERE CASE WHEN a.day_of_week IS NOT NULL
                        THEN (a.starts IS NULL OR a.starts <= w.on_date) AND (a.ends IS NULL OR a.ends >= w.on_date)
                        ELSE a.starts <= ${weekEnd}::date AND coalesce(a.ends, a.starts) >= ${week_start}::date END
               AND (${member}::uuid IS NULL OR a.family_member_id = ${member}::uuid)
             ORDER BY w.on_date, a.starts_at NULLS LAST, a.title, a.id`;
          return { weekEnd, rows };
        });
        if (!found) return noSuchMember(member);
        return ok({ week_start, week_end: found.weekEnd, activities: found.rows.map((r) => r.answer) });
      },
    }),
    search_activities: operation({
      title: "Search activities",
      description: "Activities holding every word of the query in their title, member's name, location or notes (any case, any order; a short word finds more, as \"swim\" finds \"Swimming\"), of one type (any case), or one member's: each filter optional, and those given all apply. Latest start date first, then those with none, newest first; truncated says whether more matched than limit.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/activities",
      input: {
        query: text(200).min(1).optional().describe("Words in the title, the member's name, the location or the notes, each matched apart"),
        activity_type: text(100).min(1).optional().describe("One type alone, in any case"),
        family_member_id: z.string().uuid().optional().describe("One member's activities alone, by the id list_family_members gives"),
        limit: z.number().int().min(1).max(200).default(50).describe("How many at most, 1 to 200"),
      },
      output: { activities: z.array(Activity), truncated: z.boolean() },
      async handler(ctx, { query, activity_type, family_member_id, limit }) {
        const words = query === undefined ? null : wordsOf(query);
        const type = activity_type ?? null;
        const member = family_member_id ?? null;
        const rows = await ctx.db.tx(async (sql) => {
          if (member && !(await memberExists(sql, member))) return null;
          return sql<Answer<z.input<typeof Activity>>>`
            SELECT answer FROM activity_rows
             WHERE (${words}::text IS NULL OR (SELECT bool_and(concat_ws(' ', title, member_name, location, notes) ILIKE '%' || w || '%')
                                               FROM unnest(regexp_split_to_array(${words}::text, ' ')) w))
               AND (${type}::text IS NULL OR lower(activity_type) = lower(${type}::text))
               AND (${member}::uuid IS NULL OR family_member_id = ${member}::uuid)
             ORDER BY starts DESC NULLS LAST, created_at DESC, id
             LIMIT ${limit + 1}`;
        });
        if (!rows) return noSuchMember(member);
        return ok({ activities: rows.slice(0, limit).map((r) => r.answer), truncated: rows.length > limit });
      },
    }),
    add_important_date: operation({
      title: "Add a date to remember",
      description: "Adds a date to remember. A birthday or an anniversary needs recurring_yearly true: it then comes round each year on its month and day, whatever year date_value is given in (29 February on the 28th in other years). A one-time date (a deadline) before today is kept but never listed by get_upcoming_dates: the answer's next_date is null then. reminder_days_before is how far ahead it is flagged, 7 unless given. A member that is not there is refused (NO_SUCH_MEMBER).",
      scope: "write",
      annotations: ADDS,
      method: "POST",
      path: "/dates",
      input: {
        title: text(200).min(1).describe("What the date is"),
        date_value: Day.describe("The date, YYYY-MM-DD; for a yearly one, any year's (a birth date, say)"),
        family_member_id: z.string().uuid().nullish().describe("Whose it is, by the id list_family_members gives; leave it out for the whole family's"),
        recurring_yearly: z.boolean().default(false).describe("Whether it comes round each year: true for a birthday or an anniversary"),
        reminder_days_before: z.number().int().min(0).max(365).default(7).describe("How many days ahead to flag it, 0 to 365"),
        notes: text(5000).nullish().describe("Anything else worth keeping"),
        today: TodayInput,
      },
      output: { important_date: AddedDate, item: RowItemAnswer.describe("A one-time date's open item in the brain, proposed until a write key confirms it; null for a yearly date or a one-time date already past, which have none, or when the brain did not keep it (sync_open_items repairs that)") },
      async handler(ctx, d) {
        const memberId = d.family_member_id ?? null;
        const row = await ctx.db.tx(async (sql) => {
          if (memberId && !(await memberExists(sql, memberId))) return null;
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO important_dates (family_member_id, title, date_value, recurring_yearly, reminder_days_before, notes)
            VALUES (${memberId}, ${d.title}, ${d.date_value}::date, ${d.recurring_yearly}, ${d.reminder_days_before}, ${d.notes ?? null})
            RETURNING id`;
          // next_date from the user's today, by the view's own rule (as get_upcoming_dates reckons it).
          const [full] = await sql<Answer<z.input<typeof AddedDate>>>`
            SELECT d.answer || jsonb_build_object('next_date', n.next_date::text) AS answer
              FROM important_date_rows d
              CROSS JOIN LATERAL (SELECT coalesce(${d.today ?? null}::date, (now() AT TIME ZONE 'UTC')::date) AS today) td
              CROSS JOIN LATERAL (SELECT (d.answer->>'date_value')::date AS day, extract(year FROM td.today)::int AS year) t
              CROSS JOIN LATERAL (
                SELECT CASE
                         WHEN NOT d.recurring_yearly THEN CASE WHEN t.day >= td.today THEN t.day END
                         WHEN (t.day + make_interval(years => t.year - extract(year FROM t.day)::int))::date >= td.today
                           THEN (t.day + make_interval(years => t.year - extract(year FROM t.day)::int))::date
                         ELSE (t.day + make_interval(years => t.year - extract(year FROM t.day)::int + 1))::date
                       END AS next_date) n
             WHERE d.id = ${id}`;
          return full;
        });
        if (!row) return noSuchMember(memberId);
        const date = row.answer;
        const item = !date.recurring_yearly && date.next_date !== null ? (await keepRowItem(ctx, dateItem(date))).item : null;
        return ok({ important_date: date, item });
      },
    }),
    get_upcoming_dates: operation({
      title: "Upcoming dates",
      description: "The important dates coming in the next days_ahead days (30 unless given), today included, and any further off whose reminder_days_before has already begun; soonest first. A yearly one counts on its next anniversary. Each has next_date, days_until it, and remind: whether it is within its reminder_days_before. Today is the user's date when given, else the date in UTC; the answer says which day it counted from.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/dates",
      input: {
        days_ahead: z.number().int().min(0).max(366).default(30).describe("How many days ahead to look, 0 to 366"),
        today: TodayInput,
      },
      output: { today: z.string(), dates: z.array(UpcomingDate) },
      async handler(ctx, { days_ahead, today: given }) {
        const { today, rows } = await ctx.db.tx(async (sql) => {
          const [{ today }] = await sql<{ today: string }>`SELECT coalesce(${given ?? null}::date, (now() AT TIME ZONE 'UTC')::date)::text AS today`;
          // Each date's next coming from this today: the view's next_date
          // reckons from today in UTC, so it is reckoned again here, by the
          // view's own rule (migrations/001: a yearly date moved to this year,
          // and to next if that is past; a one-time date already past, none).
          const rows = await sql<Answer<z.input<typeof UpcomingDate>>>`
            SELECT d.answer || jsonb_build_object('next_date', n.next_date::text, 'days_until', n.next_date - ${today}::date,
                                                  'remind', n.next_date - ${today}::date <= d.reminder_days_before) AS answer
              FROM important_date_rows d
              CROSS JOIN LATERAL (SELECT (d.answer->>'date_value')::date AS day, extract(year FROM ${today}::date)::int AS year) t
              CROSS JOIN LATERAL (
                SELECT CASE
                         WHEN NOT d.recurring_yearly THEN CASE WHEN t.day >= ${today}::date THEN t.day END
                         WHEN (t.day + make_interval(years => t.year - extract(year FROM t.day)::int))::date >= ${today}::date
                           THEN (t.day + make_interval(years => t.year - extract(year FROM t.day)::int))::date
                         ELSE (t.day + make_interval(years => t.year - extract(year FROM t.day)::int + 1))::date
                       END AS next_date) n
             WHERE n.next_date IS NOT NULL AND n.next_date - ${today}::date <= greatest(${days_ahead}::int, d.reminder_days_before)
             ORDER BY n.next_date, d.title, d.id`;
          return { today, rows };
        });
        return ok({ today, dates: rows.map((r) => r.answer) });
      },
    }),
    sync_open_items: operation({
      title: "Keep the dates' open items",
      description: "Keeps the open item of every one-time date from today on, as add_important_date does: opens the item of a date that has none (proposed), and moves an item's text, due day or owner to its date's. A yearly date has no item, and a one-time date already past is left as it is: its item, if it has one, stays for a key to settle. An item a key dropped or settled is left so. Safe to run again; run it once after turning on items (SMD-3665), and after an add whose item came back null. Answers how many items it opened, updated and left unchanged, and each date whose item the brain refused with its code.",
      scope: "write",
      annotations: { ...ADDS, idempotentHint: true },
      method: "POST",
      path: "/items/sync",
      input: { today: TodayInput },
      output: {
        opened: z.number().int(), updated: z.number().int(), unchanged: z.number().int(),
        failed: z.array(z.object({ important_date_id: z.string(), code: z.string() })),
      },
      async handler(ctx, { today }) {
        const dates = await ctx.db.tx((sql) => sql<Answer<z.input<typeof ImportantDate>>>`
          SELECT answer FROM important_date_rows
           WHERE NOT recurring_yearly AND (answer->>'date_value')::date >= coalesce(${today ?? null}::date, (now() AT TIME ZONE 'UTC')::date)
           ORDER BY (answer->>'date_value')::date, id`);
        const tally = { opened: 0, updated: 0, unchanged: 0 };
        const failed: { important_date_id: string; code: string }[] = [];
        for (const { answer: d } of dates) {
          const kept = await keepRowItem(ctx, dateItem(d));
          if (kept.did === "failed") failed.push({ important_date_id: d.id, code: kept.code });
          // A date is never done and never comes round, so its item is neither settled nor reopened here.
          else if (kept.did !== "settled" && kept.did !== "reopened") tally[kept.did]++;
        }
        return ok({ ...tally, failed });
      },
    }),
  },
});
