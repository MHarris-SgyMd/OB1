// The job hunt pipeline (SMD-2311): the companies in a job search, their
// postings, the applications made, the interviews they bring, and the people
// met along the way, in tables of the plugin's own (migrations/001_job_hunt.sql).
// Ported from the standalone server extensions/job-hunt/index.ts, its ten
// tools kept as ten operations under the same names, and nine more: a list of
// companies, postings, applications and interviews, so an agent can find the
// ids the others take, and a change of each of the five kinds of row, so a
// typo is not for good and an application or an interview can move on. Its link to the professional CRM records the CRM contact's id,
// which the client gets from professional_crm_add_contact first: no plugin
// calls another, and this one reaches nothing outside its own schema
// (decided 2026-11-02).

import { definePlugin, ok, operation, refuse, z } from "../../server-portable/plugin-sdk.ts";
import type { PluginSql } from "../../server-portable/plugin-sdk.ts";

const SIZES = ["startup", "mid-market", "enterprise"] as const;
const REMOTE = ["remote", "hybrid", "onsite"] as const;
const SOURCES = ["linkedin", "company-site", "referral", "recruiter", "other"] as const;
const STATUSES = ["draft", "applied", "screening", "interviewing", "offer", "accepted", "rejected", "withdrawn"] as const;
const INTERVIEW_TYPES = ["phone_screen", "technical", "behavioral", "system_design", "hiring_manager", "team", "final"] as const;
const INTERVIEW_STATUSES = ["scheduled", "completed", "cancelled", "no_show"] as const;
const ROLES = ["recruiter", "hiring_manager", "referral", "interviewer", "other"] as const;
/** A calendar date as the tables hold it, YYYY-MM-DD, from the year 0001: Postgres has no year 0000, which zod's ISO date accepts. */
const Day = z.iso.date().refine((d) => !d.startsWith("0000-"), "a date from the year 0001");
/** A moment, ISO 8601 with seconds and its offset ("2026-11-03T15:00:00Z", "…-05:00"), from the year 0001. */
const Moment = z.iso.datetime({ offset: true }).refine((d) => Date.parse(d) >= Date.parse("0001-01-01T00:00:00Z"), "a time from the year 0001, in UTC");
/** Free text a person types: trimmed, at most `max` characters, and no NUL, which Postgres will not store in text. */
const text = (max: number) => z.string().trim().max(max).refine((s) => !s.includes("\u0000"), "no NUL character");
const email = () => z.email("an email address, name@example.com; keep anything else in notes").max(320);
const webUrl = (what: string) => z.url({ protocol: /^https?$/, error: `${what} as a URL starting http:// or https://; keep anything else in notes` }).max(2000);
/**
 * The day an agent says is the user's today, or the date in UTC without one:
 * an application's day defaults to it, and a day after it is refused. Within a
 * day of the date in UTC either way, as every time zone's date is (UTC-12 to
 * UTC+14): a date further off is a typo.
 */
const TodayInput = z.iso.date()
  .refine((d) => Math.abs(Date.parse(`${d}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) <= 86_400_000,
    "the user's own date today, within a day of the date in UTC")
  .optional()
  .describe("The user's own date today, YYYY-MM-DD; the date in UTC unless given, which is a day off for part of each day in most time zones");
/** The user's today, as TodayInput gives it, or the date in UTC. */
const todayOf = (today: string | undefined) => today ?? new Date().toISOString().slice(0, 10);

const Ref = z.object({ id: z.string(), name: z.string() });
/** A posting's requirements or nice-to-haves, each a short text. */
const Items = z.array(text(500).min(1)).max(50);
const Currency = z.string().trim().regex(/^[A-Za-z]{3}$/, "a currency's three letters: USD, EUR, GBP").transform((s) => s.toUpperCase());
const Company = z.object({
  id: z.string(), name: z.string(), industry: z.string().nullable(), website: z.string().nullable(), size: z.enum(SIZES).nullable(), location: z.string().nullable(),
  remote_policy: z.enum(REMOTE).nullable(), notes: z.string().nullable(), glassdoor_rating: z.number().nullable(), created_at: z.string(), updated_at: z.string(),
});
const Posting = z.object({
  id: z.string(), company_id: z.string(), company: Ref, title: z.string(), url: z.string().nullable(), salary_min: z.number().int().nullable(),
  salary_max: z.number().int().nullable(), salary_currency: z.string(), requirements: z.array(z.string()), nice_to_haves: z.array(z.string()),
  notes: z.string().nullable(), source: z.enum(SOURCES).nullable(), posted_date: z.string().nullable(), closing_date: z.string().nullable(), created_at: z.string(),
  updated_at: z.string(),
});
const Application = z.object({
  id: z.string(), job_posting_id: z.string(), posting: z.object({ id: z.string(), title: z.string() }), company: Ref, status: z.enum(STATUSES),
  applied_date: z.string().nullable(), response_date: z.string().nullable(), resume_version: z.string().nullable(), cover_letter_notes: z.string().nullable(),
  referral_contact: z.string().nullable(), notes: z.string().nullable(), created_at: z.string(), updated_at: z.string(),
});
const Interview = z.object({
  id: z.string(), application_id: z.string(), application: z.object({ id: z.string(), status: z.enum(STATUSES) }), posting: z.object({ id: z.string(), title: z.string() }),
  company: Ref, interview_type: z.enum(INTERVIEW_TYPES), scheduled_at: z.string().nullable(), duration_minutes: z.number().int().nullable(),
  interviewer_name: z.string().nullable(), interviewer_title: z.string().nullable(), status: z.enum(INTERVIEW_STATUSES), notes: z.string().nullable(),
  feedback: z.string().nullable(), rating: z.number().int().nullable(), created_at: z.string(), updated_at: z.string(),
});
const JobContact = z.object({
  id: z.string(), company_id: z.string().nullable(), company: Ref.nullable(), name: z.string(), title: z.string().nullable(), email: z.string().nullable(),
  phone: z.string().nullable(), linkedin_url: z.string().nullable(), role_in_process: z.enum(ROLES).nullable(), professional_crm_contact_id: z.string().nullable(),
  notes: z.string().nullable(), last_contacted: z.string().nullable(), created_at: z.string(), updated_at: z.string(),
});

/** MCP hints: every operation reaches the plugin's own tables alone. An add destroys nothing; a change overwrites what was there. A read is read-only already. */
const CLOSED = { openWorldHint: false } as const;
const ADDS = { destructiveHint: false, openWorldHint: false } as const;
const CHANGES = { destructiveHint: true, openWorldHint: false } as const;

/** A row's answer as the migration's views build it: one jsonb object, the shape the output declares. */
type Answer<T> = { answer: T };

/** A person's search text with `%`, `_` and the backslash escaped for ILIKE. */
const likeText = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** A query's words: split on any whitespace (a no-break space included) and on commas and semicolons, joined by one space, each escaped for ILIKE. */
const wordsOf = (q: string) => likeText(q.split(/[\s,;]+/).filter(Boolean).join(" "));
/** A list of short texts as stored: trimmed, each once, in the order given. */
const listOf = (items: string[]) => [...new Set(items.map((t) => t.trim()).filter(Boolean))];

/** The refusal of an id that names no row, saying what the thing is and where the ids are. */
const missing = (code: string, field: string, id: string, thing: string, where: string) =>
  refuse(404, code, { [field]: id, message: `no ${thing} has this id: ${where}` });
const noSuchCompany = (id: string) => missing("NO_SUCH_COMPANY", "company_id", id, "company", "list_companies gives each company's id, and add_company adds one");
const noSuchPosting = (id: string) => missing("NO_SUCH_POSTING", "job_posting_id", id, "job posting", "list_job_postings gives each posting's id, and add_job_posting adds one");
const noSuchApplication = (id: string) => missing("NO_SUCH_APPLICATION", "application_id", id, "application", "list_applications gives each application's id");
const noSuchInterview = (id: string) => missing("NO_SUCH_INTERVIEW", "interview_id", id, "interview", "get_upcoming_interviews and get_pipeline_overview give the interviews' ids");
const noSuchContact = (id: string) => missing("NO_SUCH_JOB_CONTACT", "job_contact_id", id, "job contact", "search_job_contacts gives each contact's id, and add_job_contact adds one");
/** A day after the user's today, refused: the day it happened has come. */
const futureDay = (field: string, day: string, today: string) =>
  refuse(422, "FUTURE_DATE", { [field]: day, today, message: `${field} is after today (${today}): it is the day it happened. Where the user's date is ahead of UTC's, pass today, the user's own date` });
/** A last contact more than a day ahead, refused: it is when you last spoke. */
const futureMoment = (moment: string) =>
  refuse(422, "FUTURE_DATE", { last_contacted: moment, message: "last_contacted is more than a day ahead: it is when you last spoke" });
const isFutureMoment = (moment: string | null | undefined) => !!moment && Date.parse(moment) > Date.now() + 86_400_000;
/** Whether an update gave a field: absent is kept, null clears. */
const givenIn = <T extends object>(u: T) => (k: keyof T) => u[k] !== undefined;
const nothingToChange = (field: string, id: string) => refuse(422, "NOTHING_TO_CHANGE", { [field]: id, message: "give at least one field to change" });
const badSalary = (min: number, max: number) => refuse(422, "BAD_SALARY", { salary_min: min, salary_max: max, message: "the minimum is above the maximum" });
const badDates = (first: string, firstDay: string, second: string, secondDay: string) =>
  refuse(422, "BAD_DATES", { [first]: firstDay, [second]: secondDay, message: `${second} is before ${first}` });

/** Whether a row with this id is in a table of the plugin's (a fixed name, never a caller's). */
async function exists(sql: PluginSql, table: "companies" | "applications", id: string): Promise<boolean> {
  const rows = table === "companies" ? await sql<{ n: number }>`SELECT count(*)::int AS n FROM companies WHERE id = ${id}`
    : await sql<{ n: number }>`SELECT count(*)::int AS n FROM applications WHERE id = ${id}`;
  return rows[0].n > 0;
}
const companyOf = async (sql: PluginSql, id: string) => (await sql<Answer<z.input<typeof Company>>>`SELECT answer FROM company_rows WHERE id = ${id}`)[0]?.answer ?? null;
const postingOf = async (sql: PluginSql, id: string) => (await sql<Answer<z.input<typeof Posting>>>`SELECT answer FROM posting_rows WHERE id = ${id}`)[0]?.answer ?? null;
const applicationOf = async (sql: PluginSql, id: string) => (await sql<Answer<z.input<typeof Application>>>`SELECT answer FROM application_rows WHERE id = ${id}`)[0]?.answer ?? null;
const interviewOf = async (sql: PluginSql, id: string) => (await sql<Answer<z.input<typeof Interview>>>`SELECT answer FROM interview_rows WHERE id = ${id}`)[0]?.answer ?? null;
const contactOf = async (sql: PluginSql, id: string) => (await sql<Answer<z.input<typeof JobContact>>>`SELECT answer FROM job_contact_rows WHERE id = ${id}`)[0]?.answer ?? null;
/** The scheduled interviews from now to `days` days on, the soonest first, at most `limit` and one more. */
const upcoming = (sql: PluginSql, days: number, limit: number) => sql<Answer<z.input<typeof Interview>>>`
  SELECT answer FROM interview_rows
   WHERE status = 'scheduled' AND scheduled_at >= now() AND scheduled_at <= now() + make_interval(days => ${days}::int)
   ORDER BY scheduled_at, id
   LIMIT ${limit + 1}`;

export default definePlugin({
  name: "job-hunt",
  title: "Job hunt",
  description: "A job search's companies, postings, applications, interviews and contacts, so an agent can say where every application stands, what interview is next, and who is who.",
  operations: {
    add_company: operation({
      title: "Add a company",
      description: "Adds a company to the search and answers it with its id, which add_job_posting and add_job_contact take. list_companies lists them, so check it first rather than adding one twice. A website that is not a URL is refused; keep it in notes instead.",
      scope: "write",
      annotations: ADDS,
      method: "POST",
      path: "/companies",
      input: {
        name: text(200).min(1).describe("The company's name"),
        industry: text(200).min(1).nullish().describe("Its industry"),
        website: webUrl("a website").nullish().describe("Its website, a URL starting http:// or https://"),
        size: z.enum(SIZES).nullish().describe("startup, mid-market or enterprise"),
        location: text(200).min(1).nullish().describe("Where it is"),
        remote_policy: z.enum(REMOTE).nullish().describe("remote, hybrid or onsite"),
        notes: text(10000).nullish().describe("Anything else worth keeping"),
        glassdoor_rating: z.number().min(1).max(5).multipleOf(0.1).nullish().describe("Its Glassdoor rating, 1.0 to 5.0, one decimal"),
      },
      output: { company: Company },
      async handler(ctx, c) {
        const company = await ctx.db.tx(async (sql) => {
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO companies (name, industry, website, size, location, remote_policy, notes, glassdoor_rating)
            VALUES (${c.name}, ${c.industry ?? null}, ${c.website ?? null}, ${c.size ?? null}, ${c.location ?? null}, ${c.remote_policy ?? null},
                    nullif(${c.notes ?? null}::text, ''), ${c.glassdoor_rating ?? null}::numeric)
            RETURNING id`;
          return companyOf(sql, id);
        });
        return ok({ company: company! });
      },
    }),
    list_companies: operation({
      title: "List companies",
      description: "The companies in the search, by name, with their ids: those holding every word of the query (any case, part of a word) in their name, industry, location, website or notes, or all of them. truncated says whether more matched than limit.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/companies",
      input: {
        query: text(200).min(1).optional().describe("Words anywhere in the company, each matched apart"),
        limit: z.number().int().min(1).max(200).default(50).describe("How many at most, 1 to 200"),
      },
      output: { companies: z.array(Company), truncated: z.boolean() },
      async handler(ctx, { query, limit }) {
        const words = query === undefined ? null : wordsOf(query);
        const rows = await ctx.db.tx((sql) => sql<Answer<z.input<typeof Company>>>`
          SELECT answer FROM company_rows
           WHERE ${words}::text IS NULL OR (SELECT bool_and(search_text ILIKE '%' || w || '%') FROM unnest(regexp_split_to_array(${words}::text, ' ')) w)
           ORDER BY lower(name), created_at, id
           LIMIT ${limit + 1}`);
        return ok({ companies: rows.slice(0, limit).map((r) => r.answer), truncated: rows.length > limit });
      },
    }),
    update_company: operation({
      title: "Change a company",
      description: "Changes the fields given of a company (company_id, from list_companies), leaving the rest: a renamed company, a typo, its size or rating. A field given as null is cleared (the name cannot be). Refused: a company that is not there (NO_SUCH_COMPANY), and no field to change (NOTHING_TO_CHANGE).",
      scope: "write",
      annotations: CHANGES,
      method: "PATCH",
      path: "/companies/{company_id}",
      input: {
        company_id: z.string().uuid().describe("The company's id"),
        name: text(200).min(1).optional().describe("The company's name"),
        industry: text(200).min(1).nullish().describe("Its industry; null clears it"),
        website: webUrl("a website").nullish().describe("Its website, a URL starting http:// or https://; null clears it"),
        size: z.enum(SIZES).nullish().describe("startup, mid-market or enterprise; null clears it"),
        location: text(200).min(1).nullish().describe("Where it is; null clears it"),
        remote_policy: z.enum(REMOTE).nullish().describe("remote, hybrid or onsite; null clears it"),
        notes: text(10000).nullish().describe("Its notes, replacing them; null clears them"),
        glassdoor_rating: z.number().min(1).max(5).multipleOf(0.1).nullish().describe("Its Glassdoor rating, 1.0 to 5.0, one decimal; null clears it"),
      },
      output: { company: Company },
      async handler(ctx, u) {
        const given = givenIn(u);
        if (!(["name", "industry", "website", "size", "location", "remote_policy", "notes", "glassdoor_rating"] as const).some(given)) return nothingToChange("company_id", u.company_id);
        const company = await ctx.db.tx(async (sql) => {
          const changed = await sql<{ id: string }>`
            UPDATE companies SET
              name = CASE WHEN ${given("name")} THEN ${u.name ?? null} ELSE name END,
              industry = CASE WHEN ${given("industry")} THEN ${u.industry ?? null} ELSE industry END,
              website = CASE WHEN ${given("website")} THEN ${u.website ?? null} ELSE website END,
              size = CASE WHEN ${given("size")} THEN ${u.size ?? null} ELSE size END,
              location = CASE WHEN ${given("location")} THEN ${u.location ?? null} ELSE location END,
              remote_policy = CASE WHEN ${given("remote_policy")} THEN ${u.remote_policy ?? null} ELSE remote_policy END,
              notes = CASE WHEN ${given("notes")} THEN nullif(${u.notes ?? null}::text, '') ELSE notes END,
              glassdoor_rating = CASE WHEN ${given("glassdoor_rating")} THEN ${u.glassdoor_rating ?? null}::numeric ELSE glassdoor_rating END,
              updated_at = now()
            WHERE id = ${u.company_id}
            RETURNING id`;
          return changed.length === 0 ? null : companyOf(sql, u.company_id);
        });
        if (!company) return noSuchCompany(u.company_id);
        return ok({ company });
      },
    }),
    add_job_posting: operation({
      title: "Add a job posting",
      description: "Adds a posting at a company (company_id, from list_companies) and answers it with its id, which submit_application takes. list_job_postings lists them, so check it first rather than adding one twice. Salaries are whole amounts in salary_currency (ISO 4217, USD unless given), the minimum no more than the maximum; the closing date no earlier than the posted one. Refused: a company that is not there (NO_SUCH_COMPANY), a minimum above the maximum (BAD_SALARY), and a closing date before the posted one (BAD_DATES).",
      scope: "write",
      annotations: ADDS,
      method: "POST",
      path: "/job-postings",
      input: {
        company_id: z.string().uuid().describe("The company's id"),
        title: text(200).min(1).describe("The job's title"),
        url: webUrl("the posting").nullish().describe("The posting's URL"),
        salary_min: z.number().int().min(0).max(100_000_000).nullish().describe("The least it pays, a whole amount"),
        salary_max: z.number().int().min(0).max(100_000_000).nullish().describe("The most it pays, a whole amount"),
        salary_currency: Currency.default("USD").describe("Its currency, ISO 4217: USD unless given"),
        requirements: Items.default([]).describe("What it requires"),
        nice_to_haves: Items.default([]).describe("What it would like"),
        notes: text(10000).nullish().describe("Anything else worth keeping"),
        source: z.enum(SOURCES).nullish().describe("Where you found it: linkedin, company-site, referral, recruiter or other"),
        posted_date: Day.nullish().describe("The day it was posted, YYYY-MM-DD"),
        closing_date: Day.nullish().describe("The last day to apply, YYYY-MM-DD"),
      },
      output: { job_posting: Posting },
      async handler(ctx, p) {
        if (p.salary_min != null && p.salary_max != null && p.salary_min > p.salary_max) return badSalary(p.salary_min, p.salary_max);
        if (p.posted_date && p.closing_date && p.closing_date < p.posted_date) return badDates("posted_date", p.posted_date, "closing_date", p.closing_date);
        const posting = await ctx.db.tx(async (sql) => {
          if (!(await exists(sql, "companies", p.company_id))) return null;
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO job_postings (company_id, title, url, salary_min, salary_max, salary_currency, requirements, nice_to_haves, notes, source, posted_date, closing_date)
            VALUES (${p.company_id}, ${p.title}, ${p.url ?? null}, ${p.salary_min ?? null}::int, ${p.salary_max ?? null}::int, ${p.salary_currency},
                    (SELECT coalesce(array_agg(t ORDER BY n), '{}') FROM jsonb_array_elements_text((${JSON.stringify(listOf(p.requirements))}::text)::jsonb) WITH ORDINALITY AS x(t, n)),
                    (SELECT coalesce(array_agg(t ORDER BY n), '{}') FROM jsonb_array_elements_text((${JSON.stringify(listOf(p.nice_to_haves))}::text)::jsonb) WITH ORDINALITY AS x(t, n)),
                    nullif(${p.notes ?? null}::text, ''), ${p.source ?? null}, ${p.posted_date ?? null}::date, ${p.closing_date ?? null}::date)
            RETURNING id`;
          return postingOf(sql, id);
        });
        if (!posting) return noSuchCompany(p.company_id);
        return ok({ job_posting: posting });
      },
    }),
    list_job_postings: operation({
      title: "List job postings",
      description: "The postings, newest first, with their ids and companies: a company's (company_id), those holding every word of the query (any case, part of a word) in their title, company, notes, requirements or nice-to-haves, open ones alone (open true: closing today or later, or with no closing date), and those closing from today to closing_by (\"which close this week?\"), the soonest first, each filter optional and those given all applying. today is the user's own date. truncated says whether more matched than limit.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/job-postings",
      input: {
        company_id: z.string().uuid().optional().describe("Only this company's"),
        query: text(200).min(1).optional().describe("Words anywhere in the posting, each matched apart"),
        open: z.boolean().optional().describe("true: only those still open to apply; false: only those closed"),
        closing_by: Day.optional().describe("Only those closing from today to this day, YYYY-MM-DD, the soonest first"),
        today: TodayInput,
        limit: z.number().int().min(1).max(200).default(50).describe("How many at most, 1 to 200"),
      },
      output: { job_postings: z.array(Posting), truncated: z.boolean() },
      async handler(ctx, { company_id, query, open, closing_by, today, limit }) {
        const words = query === undefined ? null : wordsOf(query);
        const day = todayOf(today);
        const rows = await ctx.db.tx((sql) => sql<Answer<z.input<typeof Posting>>>`
          SELECT answer FROM posting_rows
           WHERE (${company_id ?? null}::uuid IS NULL OR company_id = ${company_id ?? null}::uuid)
             AND (${words}::text IS NULL OR (SELECT bool_and(search_text ILIKE '%' || w || '%') FROM unnest(regexp_split_to_array(${words}::text, ' ')) w))
             AND (${open ?? null}::boolean IS NULL OR (closing_date IS NULL OR closing_date >= ${day}::date) = ${open ?? null}::boolean)
             AND (${closing_by ?? null}::date IS NULL OR closing_date BETWEEN ${day}::date AND ${closing_by ?? null}::date)
           ORDER BY CASE WHEN ${closing_by ?? null}::date IS NOT NULL THEN closing_date END, created_at DESC, id
           LIMIT ${limit + 1}`);
        return ok({ job_postings: rows.slice(0, limit).map((r) => r.answer), truncated: rows.length > limit });
      },
    }),
    update_job_posting: operation({
      title: "Change a job posting",
      description: "Changes the fields given of a posting (job_posting_id, from list_job_postings), leaving the rest: a salary range or closing date learnt later, a typo. A field given as null is cleared (the title cannot be); requirements and nice_to_haves, when given, replace the list. The salary range and the dates are checked as they will stand. Refused: a posting that is not there (NO_SUCH_POSTING), a minimum above the maximum (BAD_SALARY), a closing date before the posted one (BAD_DATES), and no field to change (NOTHING_TO_CHANGE).",
      scope: "write",
      annotations: CHANGES,
      method: "PATCH",
      path: "/job-postings/{job_posting_id}",
      input: {
        job_posting_id: z.string().uuid().describe("The posting's id"),
        title: text(200).min(1).optional().describe("The job's title"),
        url: webUrl("the posting").nullish().describe("The posting's URL; null clears it"),
        salary_min: z.number().int().min(0).max(100_000_000).nullish().describe("The least it pays, a whole amount; null clears it"),
        salary_max: z.number().int().min(0).max(100_000_000).nullish().describe("The most it pays, a whole amount; null clears it"),
        salary_currency: Currency.optional().describe("Its currency, ISO 4217"),
        requirements: Items.optional().describe("What it requires, replacing the list"),
        nice_to_haves: Items.optional().describe("What it would like, replacing the list"),
        notes: text(10000).nullish().describe("Its notes, replacing them; null clears them"),
        source: z.enum(SOURCES).nullish().describe("Where you found it; null clears it"),
        posted_date: Day.nullish().describe("The day it was posted; null clears it"),
        closing_date: Day.nullish().describe("The last day to apply; null clears it"),
      },
      output: { job_posting: Posting },
      async handler(ctx, u) {
        const given = givenIn(u);
        const fields = ["title", "url", "salary_min", "salary_max", "salary_currency", "requirements", "nice_to_haves", "notes", "source", "posted_date", "closing_date"] as const;
        if (!fields.some(given)) return nothingToChange("job_posting_id", u.job_posting_id);
        return ctx.db.tx(async (sql) => {
          // The row locked, so the range and the dates are checked against what they will be.
          const [held] = await sql<{ salary_min: number | null; salary_max: number | null; posted_date: string | null; closing_date: string | null }>`
            SELECT salary_min, salary_max, posted_date::text AS posted_date, closing_date::text AS closing_date FROM job_postings WHERE id = ${u.job_posting_id} FOR UPDATE`;
          if (!held) return noSuchPosting(u.job_posting_id);
          const min = given("salary_min") ? u.salary_min ?? null : held.salary_min;
          const max = given("salary_max") ? u.salary_max ?? null : held.salary_max;
          if (min !== null && max !== null && min > max) return badSalary(min, max);
          const posted = given("posted_date") ? u.posted_date ?? null : held.posted_date;
          const closing = given("closing_date") ? u.closing_date ?? null : held.closing_date;
          if (posted && closing && closing < posted) return badDates("posted_date", posted, "closing_date", closing);
          await sql`
            UPDATE job_postings SET
              title = CASE WHEN ${given("title")} THEN ${u.title ?? null} ELSE title END,
              url = CASE WHEN ${given("url")} THEN ${u.url ?? null} ELSE url END,
              salary_min = ${min}::int,
              salary_max = ${max}::int,
              salary_currency = coalesce(${u.salary_currency ?? null}, salary_currency),
              requirements = CASE WHEN ${given("requirements")}
                THEN (SELECT coalesce(array_agg(t ORDER BY n), '{}') FROM jsonb_array_elements_text((${JSON.stringify(listOf(u.requirements ?? []))}::text)::jsonb) WITH ORDINALITY AS x(t, n))
                ELSE requirements END,
              nice_to_haves = CASE WHEN ${given("nice_to_haves")}
                THEN (SELECT coalesce(array_agg(t ORDER BY n), '{}') FROM jsonb_array_elements_text((${JSON.stringify(listOf(u.nice_to_haves ?? []))}::text)::jsonb) WITH ORDINALITY AS x(t, n))
                ELSE nice_to_haves END,
              notes = CASE WHEN ${given("notes")} THEN nullif(${u.notes ?? null}::text, '') ELSE notes END,
              source = CASE WHEN ${given("source")} THEN ${u.source ?? null} ELSE source END,
              posted_date = ${posted}::date,
              closing_date = ${closing}::date,
              updated_at = now()
            WHERE id = ${u.job_posting_id}`;
          return ok({ job_posting: (await postingOf(sql, u.job_posting_id))! });
        });
      },
    }),
    add_job_contact: operation({
      title: "Add a job contact",
      description: "Adds a recruiter, hiring manager, referral, interviewer or other person met in the search, and answers them with their id, which link_contact_to_professional_crm takes. search_job_contacts finds them, so check it first rather than adding someone twice. company_id (from list_companies) names where they work, if known. An email or a LinkedIn URL that is not in its form is refused; keep it in notes instead. Refused: a company that is not there (NO_SUCH_COMPANY), and a last contact more than a day ahead (FUTURE_DATE).",
      scope: "write",
      annotations: ADDS,
      method: "POST",
      path: "/job-contacts",
      input: {
        company_id: z.string().uuid().nullish().describe("Where they work: the company's id"),
        name: text(200).min(1).describe("Their full name"),
        title: text(200).min(1).nullish().describe("Their job title"),
        email: email().nullish().describe("Their email address, name@example.com"),
        phone: text(50).min(1).nullish().describe("Their phone number"),
        linkedin_url: webUrl("a profile").nullish().describe("Their LinkedIn profile, a URL starting http:// or https://"),
        role_in_process: z.enum(ROLES).nullish().describe("recruiter, hiring_manager, referral, interviewer or other"),
        notes: text(10000).nullish().describe("Anything else worth keeping"),
        last_contacted: Moment.nullish().describe("When you last spoke, ISO 8601 with seconds and its offset"),
      },
      output: { job_contact: JobContact },
      async handler(ctx, j) {
        if (isFutureMoment(j.last_contacted)) return futureMoment(j.last_contacted!);
        const contact = await ctx.db.tx(async (sql) => {
          if (j.company_id && !(await exists(sql, "companies", j.company_id))) return null;
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO job_contacts (company_id, name, title, email, phone, linkedin_url, role_in_process, notes, last_contacted)
            VALUES (${j.company_id ?? null}::uuid, ${j.name}, ${j.title ?? null}, ${j.email ?? null}, ${j.phone ?? null}, ${j.linkedin_url ?? null},
                    ${j.role_in_process ?? null}, nullif(${j.notes ?? null}::text, ''), ${j.last_contacted ?? null}::timestamptz)
            RETURNING id`;
          return contactOf(sql, id);
        });
        if (!contact) return noSuchCompany(j.company_id!);
        return ok({ job_contact: contact });
      },
    }),
    search_job_contacts: operation({
      title: "Search job contacts",
      description: "The job contacts, by name, with their ids and companies: those holding every word of the query (any case, part of a word) in their name, title, email, phone, notes, role or company's name; of a company (company_id); in a role; or not yet linked to the professional CRM (only_unlinked), each filter optional and those given all applying. truncated says whether more matched than limit.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/job-contacts",
      input: {
        query: text(200).min(1).optional().describe("Words anywhere in the contact or their company's name, each matched apart"),
        company_id: z.string().uuid().optional().describe("Only this company's"),
        role_in_process: z.enum(ROLES).optional().describe("Only this role"),
        only_unlinked: z.boolean().optional().describe("true: only those not yet linked to the professional CRM"),
        limit: z.number().int().min(1).max(200).default(50).describe("How many at most, 1 to 200"),
      },
      output: { contacts: z.array(JobContact), truncated: z.boolean() },
      async handler(ctx, { query, company_id, role_in_process, only_unlinked, limit }) {
        const words = query === undefined ? null : wordsOf(query);
        const rows = await ctx.db.tx((sql) => sql<Answer<z.input<typeof JobContact>>>`
          SELECT answer FROM job_contact_rows
           WHERE (${words}::text IS NULL OR (SELECT bool_and(search_text ILIKE '%' || w || '%') FROM unnest(regexp_split_to_array(${words}::text, ' ')) w))
             AND (${company_id ?? null}::uuid IS NULL OR company_id = ${company_id ?? null}::uuid)
             AND (${role_in_process ?? null}::text IS NULL OR role_in_process = ${role_in_process ?? null}::text)
             AND (${only_unlinked ?? false} = false OR professional_crm_contact_id IS NULL)
           ORDER BY lower(name), created_at, id
           LIMIT ${limit + 1}`);
        return ok({ contacts: rows.slice(0, limit).map((r) => r.answer), truncated: rows.length > limit });
      },
    }),
    update_job_contact: operation({
      title: "Change a job contact",
      description: "Changes the fields given of a job contact (job_contact_id, from search_job_contacts), leaving the rest: when you last spoke (\"I just talked to Jane\": last_contacted), a new email or title, where they work now. A field given as null is cleared (the name cannot be). The CRM link is link_contact_to_professional_crm's. Refused: a job contact that is not there (NO_SUCH_JOB_CONTACT), a company that is not there (NO_SUCH_COMPANY), a last contact more than a day ahead (FUTURE_DATE), and no field to change (NOTHING_TO_CHANGE).",
      scope: "write",
      annotations: CHANGES,
      method: "PATCH",
      path: "/job-contacts/{job_contact_id}",
      input: {
        job_contact_id: z.string().uuid().describe("The job contact's id"),
        company_id: z.string().uuid().nullish().describe("Where they work: the company's id; null clears it"),
        name: text(200).min(1).optional().describe("Their full name"),
        title: text(200).min(1).nullish().describe("Their job title; null clears it"),
        email: email().nullish().describe("Their email address; null clears it"),
        phone: text(50).min(1).nullish().describe("Their phone number; null clears it"),
        linkedin_url: webUrl("a profile").nullish().describe("Their LinkedIn profile; null clears it"),
        role_in_process: z.enum(ROLES).nullish().describe("recruiter, hiring_manager, referral, interviewer or other; null clears it"),
        notes: text(10000).nullish().describe("Their notes, replacing them; null clears them"),
        last_contacted: Moment.nullish().describe("When you last spoke, ISO 8601 with seconds and its offset; null clears it"),
      },
      output: { job_contact: JobContact },
      async handler(ctx, u) {
        const given = givenIn(u);
        const fields = ["company_id", "name", "title", "email", "phone", "linkedin_url", "role_in_process", "notes", "last_contacted"] as const;
        if (!fields.some(given)) return nothingToChange("job_contact_id", u.job_contact_id);
        if (isFutureMoment(u.last_contacted)) return futureMoment(u.last_contacted!);
        return ctx.db.tx(async (sql) => {
          if (u.company_id && !(await exists(sql, "companies", u.company_id))) return noSuchCompany(u.company_id);
          const changed = await sql<{ id: string }>`
            UPDATE job_contacts SET
              company_id = CASE WHEN ${given("company_id")} THEN ${u.company_id ?? null}::uuid ELSE company_id END,
              name = CASE WHEN ${given("name")} THEN ${u.name ?? null} ELSE name END,
              title = CASE WHEN ${given("title")} THEN ${u.title ?? null} ELSE title END,
              email = CASE WHEN ${given("email")} THEN ${u.email ?? null} ELSE email END,
              phone = CASE WHEN ${given("phone")} THEN ${u.phone ?? null} ELSE phone END,
              linkedin_url = CASE WHEN ${given("linkedin_url")} THEN ${u.linkedin_url ?? null} ELSE linkedin_url END,
              role_in_process = CASE WHEN ${given("role_in_process")} THEN ${u.role_in_process ?? null} ELSE role_in_process END,
              notes = CASE WHEN ${given("notes")} THEN nullif(${u.notes ?? null}::text, '') ELSE notes END,
              last_contacted = CASE WHEN ${given("last_contacted")} THEN ${u.last_contacted ?? null}::timestamptz ELSE last_contacted END,
              updated_at = now()
            WHERE id = ${u.job_contact_id}
            RETURNING id`;
          return changed.length === 0 ? noSuchContact(u.job_contact_id) : ok({ job_contact: (await contactOf(sql, u.job_contact_id))! });
        });
      },
    }),
    link_contact_to_professional_crm: operation({
      title: "Link a job contact to the professional CRM",
      description: "Records which professional CRM contact a job contact is (job_contact_id, from search_job_contacts), so the relationship lasts past the search. Two steps: first find them in the CRM with professional_crm_search_contacts, and only if they are not there add them with professional_crm_add_contact (their name, the company's name as company, title, email, phone, linkedin_url, how_we_met 'Job search: <their role>', tags ['job-hunt', <their role>]); then call this with that contact's id. This records the id only: it cannot check that the CRM has that contact. A contact linked to the same id is already_linked; one linked to another is refused (ALREADY_LINKED, naming it), and professional_crm_contact_id null unlinks first. Refused: a job contact that is not there (NO_SUCH_JOB_CONTACT).",
      scope: "write",
      annotations: CHANGES,
      method: "POST",
      path: "/job-contacts/{job_contact_id}/crm-link",
      input: {
        job_contact_id: z.string().uuid().describe("The job contact's id"),
        professional_crm_contact_id: z.string().uuid().nullable().describe("The CRM contact's id, from professional_crm_add_contact; null unlinks"),
      },
      output: { job_contact: JobContact, already_linked: z.boolean() },
      async handler(ctx, { job_contact_id, professional_crm_contact_id: given }) {
        // Postgres answers a uuid in lower case; one given in capitals is the same id.
        const crm = given === null ? null : given.toLowerCase();
        const done = await ctx.db.tx(async (sql) => {
          // The contact's row locked, so two links at once decide in turn.
          const [held] = await sql<{ crm: string | null }>`SELECT professional_crm_contact_id::text AS crm FROM job_contacts WHERE id = ${job_contact_id} FOR UPDATE`;
          if (!held) return { missing: true as const };
          if (crm !== null && held.crm === crm) return { contact: (await contactOf(sql, job_contact_id))!, already_linked: true };
          if (crm !== null && held.crm !== null) return { taken: held.crm };
          await sql`UPDATE job_contacts SET professional_crm_contact_id = ${crm}::uuid, updated_at = now() WHERE id = ${job_contact_id}`;
          return { contact: (await contactOf(sql, job_contact_id))!, already_linked: false };
        });
        if ("missing" in done) return noSuchContact(job_contact_id);
        if ("taken" in done) {
          return refuse(409, "ALREADY_LINKED", { job_contact_id, professional_crm_contact_id: done.taken, message: `the job contact is linked to another CRM contact, ${done.taken}: link null first to change it` });
        }
        return ok({ job_contact: done.contact, already_linked: done.already_linked });
      },
    }),
    submit_application: operation({
      title: "Record an application",
      description: "Records an application to a posting (job_posting_id, from list_job_postings) and answers it with its id, which schedule_interview and update_application take. status is applied unless given; applied_date is today (the user's own date) unless given, or none for a draft. A posting holds one open application: one rejected or withdrawn makes room for another, and update_application moves an open one on. Refused: a posting that is not there (NO_SUCH_POSTING), a posting with an open application (ALREADY_APPLIED, naming it), and an applied_date after today (FUTURE_DATE).",
      scope: "write",
      annotations: ADDS,
      method: "POST",
      path: "/applications",
      input: {
        job_posting_id: z.string().uuid().describe("The posting's id"),
        status: z.enum(STATUSES).default("applied").describe("draft, applied, screening, interviewing, offer, accepted, rejected or withdrawn"),
        applied_date: Day.nullish().describe("The day you applied, YYYY-MM-DD; today unless given, none for a draft"),
        resume_version: text(200).min(1).nullish().describe("Which resume you sent"),
        cover_letter_notes: text(5000).min(1).nullish().describe("What the cover letter said"),
        referral_contact: text(200).min(1).nullish().describe("Who referred you"),
        notes: text(10000).nullish().describe("Anything else worth keeping"),
        today: TodayInput,
      },
      output: { application: Application },
      async handler(ctx, a) {
        const day = todayOf(a.today);
        const applied = a.applied_date !== undefined ? a.applied_date : a.status === "draft" ? null : day;
        if (applied && applied > day) return futureDay("applied_date", applied, day);
        return ctx.db.tx(async (sql) => {
          // The posting locked, so two applications to it at once decide in turn.
          const [posting] = await sql<{ id: string }>`SELECT id FROM job_postings WHERE id = ${a.job_posting_id} FOR UPDATE`;
          if (!posting) return noSuchPosting(a.job_posting_id);
          const [open] = await sql<{ id: string; status: string }>`
            SELECT id, status FROM applications WHERE job_posting_id = ${a.job_posting_id} AND status NOT IN ('rejected', 'withdrawn') ORDER BY created_at, id LIMIT 1`;
          if (open) {
            return refuse(409, "ALREADY_APPLIED", {
              job_posting_id: a.job_posting_id, application_id: open.id, application_status: open.status,
              message: `this posting has an open application, ${open.id} (${open.status}): update_application moves it on`,
            });
          }
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO applications (job_posting_id, status, applied_date, resume_version, cover_letter_notes, referral_contact, notes)
            VALUES (${a.job_posting_id}, ${a.status}, ${applied}::date, ${a.resume_version ?? null}, ${a.cover_letter_notes ?? null}, ${a.referral_contact ?? null},
                    nullif(${a.notes ?? null}::text, ''))
            RETURNING id`;
          return ok({ application: (await applicationOf(sql, id))! });
        });
      },
    }),
    list_applications: operation({
      title: "List applications",
      description: "The applications, with their ids, postings and companies: of a status, a company or a posting, each filter optional and those given all applying. The latest applied first (none last), then the newest. truncated says whether more matched than limit.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/applications",
      input: {
        status: z.enum(STATUSES).optional().describe("Only this status"),
        company_id: z.string().uuid().optional().describe("Only this company's"),
        job_posting_id: z.string().uuid().optional().describe("Only this posting's"),
        limit: z.number().int().min(1).max(200).default(50).describe("How many at most, 1 to 200"),
      },
      output: { applications: z.array(Application), truncated: z.boolean() },
      async handler(ctx, { status, company_id, job_posting_id, limit }) {
        const rows = await ctx.db.tx((sql) => sql<Answer<z.input<typeof Application>>>`
          SELECT answer FROM application_rows
           WHERE (${status ?? null}::text IS NULL OR status = ${status ?? null}::text)
             AND (${company_id ?? null}::uuid IS NULL OR company_id = ${company_id ?? null}::uuid)
             AND (${job_posting_id ?? null}::uuid IS NULL OR job_posting_id = ${job_posting_id ?? null}::uuid)
           ORDER BY applied_date DESC NULLS LAST, created_at DESC, id
           LIMIT ${limit + 1}`);
        return ok({ applications: rows.slice(0, limit).map((r) => r.answer), truncated: rows.length > limit });
      },
    }),
    update_application: operation({
      title: "Change an application",
      description: "Changes the fields given of an application (application_id, from list_applications), leaving the rest: its status as it moves on, the day the company answered (response_date), and its other fields. A field given as null is cleared. A draft moved on with no applied_date is dated today, the user's own date. Refused: an application that is not there (NO_SUCH_APPLICATION), a day after today (FUTURE_DATE), a response before the application (BAD_DATES), and no field to change (NOTHING_TO_CHANGE).",
      scope: "write",
      annotations: CHANGES,
      method: "PATCH",
      path: "/applications/{application_id}",
      input: {
        application_id: z.string().uuid().describe("The application's id"),
        status: z.enum(STATUSES).optional().describe("draft, applied, screening, interviewing, offer, accepted, rejected or withdrawn"),
        applied_date: Day.nullish().describe("The day you applied; null clears it"),
        response_date: Day.nullish().describe("The day the company answered; null clears it"),
        resume_version: text(200).min(1).nullish().describe("Which resume you sent; null clears it"),
        cover_letter_notes: text(5000).min(1).nullish().describe("What the cover letter said; null clears it"),
        referral_contact: text(200).min(1).nullish().describe("Who referred you; null clears it"),
        notes: text(10000).nullish().describe("Its notes, replacing them; null clears them"),
        today: TodayInput,
      },
      output: { application: Application },
      async handler(ctx, u) {
        const given = givenIn(u);
        const fields = ["status", "applied_date", "response_date", "resume_version", "cover_letter_notes", "referral_contact", "notes"] as const;
        if (!fields.some(given)) return nothingToChange("application_id", u.application_id);
        const day = todayOf(u.today);
        for (const field of ["applied_date", "response_date"] as const) {
          const value = u[field];
          if (value && value > day) return futureDay(field, value, day);
        }
        return ctx.db.tx(async (sql) => {
          // The row locked, so the dates are checked against what they will be.
          const [held] = await sql<{ applied_date: string | null; response_date: string | null }>`
            SELECT applied_date::text AS applied_date, response_date::text AS response_date FROM applications WHERE id = ${u.application_id} FOR UPDATE`;
          if (!held) return noSuchApplication(u.application_id);
          const applied = given("applied_date") ? u.applied_date ?? null
            : held.applied_date === null && u.status !== undefined && u.status !== "draft" ? day : held.applied_date;
          const response = given("response_date") ? u.response_date ?? null : held.response_date;
          if (applied && response && response < applied) return badDates("applied_date", applied, "response_date", response);
          await sql`
            UPDATE applications SET
              status = CASE WHEN ${given("status")} THEN ${u.status ?? null} ELSE status END,
              applied_date = ${applied}::date,
              response_date = ${response}::date,
              resume_version = CASE WHEN ${given("resume_version")} THEN ${u.resume_version ?? null} ELSE resume_version END,
              cover_letter_notes = CASE WHEN ${given("cover_letter_notes")} THEN ${u.cover_letter_notes ?? null} ELSE cover_letter_notes END,
              referral_contact = CASE WHEN ${given("referral_contact")} THEN ${u.referral_contact ?? null} ELSE referral_contact END,
              notes = CASE WHEN ${given("notes")} THEN nullif(${u.notes ?? null}::text, '') ELSE notes END,
              updated_at = now()
            WHERE id = ${u.application_id}`;
          return ok({ application: (await applicationOf(sql, u.application_id))! });
        });
      },
    }),
    schedule_interview: operation({
      title: "Schedule an interview",
      description: "Schedules an interview for an application (application_id, from list_applications) and answers it with its id, which update_interview and log_interview_notes take. scheduled_at is ISO 8601 with seconds and its offset; one with no time yet is listed by list_interviews until update_interview sets it. Refused: an application that is not there (NO_SUCH_APPLICATION).",
      scope: "write",
      annotations: ADDS,
      method: "POST",
      path: "/interviews",
      input: {
        application_id: z.string().uuid().describe("The application's id"),
        interview_type: z.enum(INTERVIEW_TYPES).describe("phone_screen, technical, behavioral, system_design, hiring_manager, team or final"),
        scheduled_at: Moment.nullish().describe("When it is, ISO 8601 with seconds and its offset"),
        duration_minutes: z.number().int().min(1).max(1440).nullish().describe("How long, in minutes"),
        interviewer_name: text(200).min(1).nullish().describe("Who interviews"),
        interviewer_title: text(200).min(1).nullish().describe("Their title"),
        notes: text(10000).nullish().describe("Prep notes"),
      },
      output: { interview: Interview },
      async handler(ctx, i) {
        const interview = await ctx.db.tx(async (sql) => {
          if (!(await exists(sql, "applications", i.application_id))) return null;
          const [{ id }] = await sql<{ id: string }>`
            INSERT INTO interviews (application_id, interview_type, scheduled_at, duration_minutes, interviewer_name, interviewer_title, notes)
            VALUES (${i.application_id}, ${i.interview_type}, ${i.scheduled_at ?? null}::timestamptz, ${i.duration_minutes ?? null}::int, ${i.interviewer_name ?? null},
                    ${i.interviewer_title ?? null}, nullif(${i.notes ?? null}::text, ''))
            RETURNING id`;
          return interviewOf(sql, id);
        });
        if (!interview) return noSuchApplication(i.application_id);
        return ok({ interview });
      },
    }),
    list_interviews: operation({
      title: "List interviews",
      description: "The interviews, with their ids, applications, postings and companies: of an application, a company or a status, each filter optional and those given all applying. Those with no time yet first, then the latest first: what feedback was logged, what was cancelled, what is still to set a time for. truncated says whether more matched than limit.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/interviews",
      input: {
        application_id: z.string().uuid().optional().describe("Only this application's"),
        company_id: z.string().uuid().optional().describe("Only this company's"),
        status: z.enum(INTERVIEW_STATUSES).optional().describe("Only this status: scheduled, completed, cancelled or no_show"),
        limit: z.number().int().min(1).max(200).default(50).describe("How many at most, 1 to 200"),
      },
      output: { interviews: z.array(Interview), truncated: z.boolean() },
      async handler(ctx, { application_id, company_id, status, limit }) {
        const rows = await ctx.db.tx((sql) => sql<Answer<z.input<typeof Interview>>>`
          SELECT answer FROM interview_rows
           WHERE (${application_id ?? null}::uuid IS NULL OR application_id = ${application_id ?? null}::uuid)
             AND (${company_id ?? null}::uuid IS NULL OR company_id = ${company_id ?? null}::uuid)
             AND (${status ?? null}::text IS NULL OR status = ${status ?? null}::text)
           ORDER BY scheduled_at DESC NULLS FIRST, created_at DESC, id
           LIMIT ${limit + 1}`);
        return ok({ interviews: rows.slice(0, limit).map((r) => r.answer), truncated: rows.length > limit });
      },
    }),
    update_interview: operation({
      title: "Change an interview",
      description: "Changes the fields given of an interview (interview_id, from list_interviews or get_upcoming_interviews), leaving the rest: a new time (rescheduled), its prep notes, who interviews, or its status (cancelled, no_show). A field given as null is cleared. How it went is log_interview_notes'. Refused: an interview that is not there (NO_SUCH_INTERVIEW), and no field to change (NOTHING_TO_CHANGE).",
      scope: "write",
      annotations: CHANGES,
      method: "PATCH",
      path: "/interviews/{interview_id}",
      input: {
        interview_id: z.string().uuid().describe("The interview's id"),
        interview_type: z.enum(INTERVIEW_TYPES).optional().describe("phone_screen, technical, behavioral, system_design, hiring_manager, team or final"),
        scheduled_at: Moment.nullish().describe("When it is, ISO 8601 with seconds and its offset; null clears it"),
        duration_minutes: z.number().int().min(1).max(1440).nullish().describe("How long, in minutes; null clears it"),
        interviewer_name: text(200).min(1).nullish().describe("Who interviews; null clears it"),
        interviewer_title: text(200).min(1).nullish().describe("Their title; null clears it"),
        notes: text(10000).nullish().describe("Prep notes, replacing them; null clears them"),
        status: z.enum(INTERVIEW_STATUSES).optional().describe("scheduled, completed, cancelled or no_show"),
      },
      output: { interview: Interview },
      async handler(ctx, u) {
        const given = givenIn(u);
        const fields = ["interview_type", "scheduled_at", "duration_minutes", "interviewer_name", "interviewer_title", "notes", "status"] as const;
        if (!fields.some(given)) return nothingToChange("interview_id", u.interview_id);
        const interview = await ctx.db.tx(async (sql) => {
          const changed = await sql<{ id: string }>`
            UPDATE interviews SET
              interview_type = CASE WHEN ${given("interview_type")} THEN ${u.interview_type ?? null} ELSE interview_type END,
              scheduled_at = CASE WHEN ${given("scheduled_at")} THEN ${u.scheduled_at ?? null}::timestamptz ELSE scheduled_at END,
              duration_minutes = CASE WHEN ${given("duration_minutes")} THEN ${u.duration_minutes ?? null}::int ELSE duration_minutes END,
              interviewer_name = CASE WHEN ${given("interviewer_name")} THEN ${u.interviewer_name ?? null} ELSE interviewer_name END,
              interviewer_title = CASE WHEN ${given("interviewer_title")} THEN ${u.interviewer_title ?? null} ELSE interviewer_title END,
              notes = CASE WHEN ${given("notes")} THEN nullif(${u.notes ?? null}::text, '') ELSE notes END,
              status = CASE WHEN ${given("status")} THEN ${u.status ?? null} ELSE status END,
              updated_at = now()
            WHERE id = ${u.interview_id}
            RETURNING id`;
          return changed.length === 0 ? null : interviewOf(sql, u.interview_id);
        });
        if (!interview) return noSuchInterview(u.interview_id);
        return ok({ interview });
      },
    }),
    log_interview_notes: operation({
      title: "Log how an interview went",
      description: "After an interview (interview_id, from get_pipeline_overview's awaiting_notes, list_interviews or get_upcoming_interviews): its feedback and your rating of it, 1 to 5. Only the fields given change: a field given as null is cleared, and one left out is kept. A scheduled interview whose time has come (or that has none) becomes completed unless status says otherwise; one still ahead stays scheduled, and a cancelled or no-show one stays as it is. Prep notes before it, a new time or a cancellation are update_interview's. Refused: an interview that is not there (NO_SUCH_INTERVIEW), and no field to change (NOTHING_TO_CHANGE).",
      scope: "write",
      annotations: CHANGES,
      method: "PATCH",
      path: "/interviews/{interview_id}/notes",
      input: {
        interview_id: z.string().uuid().describe("The interview's id"),
        feedback: text(10000).nullish().describe("How it went, in your words; null clears it"),
        rating: z.number().int().min(1).max(5).nullish().describe("How it went, 1 to 5; null clears it"),
        status: z.enum(INTERVIEW_STATUSES).optional().describe("Its status, if not the one above: completed, cancelled, no_show or scheduled"),
      },
      output: { interview: Interview },
      async handler(ctx, n) {
        if (n.feedback === undefined && n.rating === undefined && n.status === undefined) return nothingToChange("interview_id", n.interview_id);
        const interview = await ctx.db.tx(async (sql) => {
          const changed = await sql<{ id: string }>`
            UPDATE interviews SET
              feedback = CASE WHEN ${n.feedback !== undefined} THEN nullif(${n.feedback ?? null}::text, '') ELSE feedback END,
              rating = CASE WHEN ${n.rating !== undefined} THEN ${n.rating ?? null}::int ELSE rating END,
              status = CASE WHEN ${n.status !== undefined} THEN ${n.status ?? null}
                            WHEN status = 'scheduled' AND (scheduled_at IS NULL OR scheduled_at <= now()) THEN 'completed'
                            ELSE status END,
              updated_at = now()
            WHERE id = ${n.interview_id}
            RETURNING id`;
          return changed.length === 0 ? null : interviewOf(sql, n.interview_id);
        });
        if (!interview) return noSuchInterview(n.interview_id);
        return ok({ interview });
      },
    }),
    get_pipeline_overview: operation({
      title: "The pipeline at a glance",
      description: "Where the search stands: how many applications in all, how many at each status (every status, none as 0), the interviews scheduled from now to days_ahead days on (the soonest first), the scheduled interviews already past, still waiting for log_interview_notes, and how many scheduled interviews have no time yet (list_interviews lists them). The lists stop at limit; truncated says whether one was cut, and the counts are of all of them.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/pipeline",
      input: {
        days_ahead: z.number().int().min(1).max(365).default(7).describe("How many days ahead count as upcoming, 1 to 365: 1 is the next 24 hours"),
        limit: z.number().int().min(1).max(200).default(50).describe("How many of each list at most, 1 to 200"),
      },
      output: {
        total_applications: z.number().int(), status_breakdown: z.record(z.enum(STATUSES), z.number().int()),
        upcoming_interviews: z.array(Interview), upcoming_count: z.number().int(), awaiting_notes: z.array(Interview), awaiting_notes_count: z.number().int(),
        unscheduled_count: z.number().int(), truncated: z.boolean(),
      },
      async handler(ctx, { days_ahead, limit }) {
        const found = await ctx.db.tx(async (sql) => {
          const counts = await sql<{ status: string; n: number }>`SELECT status, count(*)::int AS n FROM applications GROUP BY status`;
          const [{ up, unscheduled }] = await sql<{ up: number; unscheduled: number }>`
            SELECT count(*) FILTER (WHERE scheduled_at >= now() AND scheduled_at <= now() + make_interval(days => ${days_ahead}::int))::int AS up,
                   count(*) FILTER (WHERE scheduled_at IS NULL)::int AS unscheduled
              FROM interviews WHERE status = 'scheduled'`;
          const soon = await upcoming(sql, days_ahead, limit);
          const past = await sql<Answer<z.input<typeof Interview>> & { n: number }>`
            SELECT answer, count(*) OVER ()::int AS n FROM interview_rows WHERE status = 'scheduled' AND scheduled_at < now()
             ORDER BY scheduled_at DESC, id LIMIT ${limit + 1}`;
          return { counts, up, unscheduled, soon, past };
        });
        const breakdown = Object.fromEntries(STATUSES.map((s) => [s, found.counts.find((c) => c.status === s)?.n ?? 0])) as Record<(typeof STATUSES)[number], number>;
        const awaiting = found.past[0]?.n ?? 0;
        return ok({
          total_applications: found.counts.reduce((sum, c) => sum + c.n, 0), status_breakdown: breakdown,
          upcoming_interviews: found.soon.slice(0, limit).map((r) => r.answer), upcoming_count: found.up,
          awaiting_notes: found.past.slice(0, limit).map((r) => r.answer), awaiting_notes_count: awaiting, unscheduled_count: found.unscheduled,
          truncated: found.soon.length > limit || found.past.length > limit,
        });
      },
    }),
    get_upcoming_interviews: operation({
      title: "Upcoming interviews",
      description: "The interviews scheduled from now to days_ahead days on, the soonest first, each with its application, posting and company. truncated says whether more were scheduled than limit.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/upcoming-interviews",
      input: {
        days_ahead: z.number().int().min(1).max(365).default(14).describe("How many days ahead, 1 to 365: 1 is the next 24 hours"),
        limit: z.number().int().min(1).max(200).default(50).describe("How many at most, 1 to 200"),
      },
      output: { interviews: z.array(Interview), truncated: z.boolean() },
      async handler(ctx, { days_ahead, limit }) {
        const rows = await ctx.db.tx((sql) => upcoming(sql, days_ahead, limit));
        return ok({ interviews: rows.slice(0, limit).map((r) => r.answer), truncated: rows.length > limit });
      },
    }),
  },
});
