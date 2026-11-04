# Job Hunt Plugin

A job search's companies, their postings, the applications made, the interviews they bring, and the people met along the way, kept in the brain itself (SMD-2311). An agent can say where every application stands, which interview is next, which ones still wait for notes, and who is who. It is the learning path's [Extension 6](../../extensions/job-hunt/), which was a standalone MCP server with its own keys until it became this plugin.

## What it does

Five tables of its own, in the schema `plugin_job_hunt`, made by `migrations/001_job_hunt.sql`:

- `companies`: each company in the search, with its industry, website, size, location, remote policy, notes and Glassdoor rating.
- `job_postings`: each role at a company, with its salary range and currency, requirements, nice-to-haves, where it was found, and the days it was posted and closes.
- `applications`: each application to a posting, with its status, the days you applied and the company answered, and the resume, cover letter and referral used.
- `interviews`: each interview for an application, when and how long, with whom, its prep notes, and afterwards its feedback, rating and status.
- `job_contacts`: each recruiter, hiring manager, referral, interviewer or other person met, at a company or none, and the professional CRM contact they are, once linked.

| Operation | MCP tool | REST route | Scope | Input | Output |
|---|---|---|---|---|---|
| Add a company | `job_hunt_add_company` | `POST /v1/plugins/job-hunt/companies` | `write` | `name`; `industry`, `website`, `size`, `location`, `remote_policy`, `notes`, `glassdoor_rating` optional | `{ company }` |
| List companies | `job_hunt_list_companies` | `GET /v1/plugins/job-hunt/companies` | `read` | `query` optional; `limit`, 1 to 200, default 50 | `{ companies, truncated }` |
| Change a company | `job_hunt_update_company` | `PATCH /v1/plugins/job-hunt/companies/{company_id}` | `write` | `company_id`; any of `add_company`'s fields | `{ company }` |
| Add a job posting | `job_hunt_add_job_posting` | `POST /v1/plugins/job-hunt/job-postings` | `write` | `company_id`, `title`; `url`, `salary_min`, `salary_max`, `salary_currency`, `requirements`, `nice_to_haves`, `notes`, `source`, `posted_date`, `closing_date` optional | `{ job_posting }` |
| List job postings | `job_hunt_list_job_postings` | `GET /v1/plugins/job-hunt/job-postings` | `read` | `company_id`, `query`, `open`, `closing_by`, `today` optional; `limit`, 1 to 200, default 50 | `{ job_postings, truncated }` |
| Change a job posting | `job_hunt_update_job_posting` | `PATCH /v1/plugins/job-hunt/job-postings/{job_posting_id}` | `write` | `job_posting_id`; any of `add_job_posting`'s fields but `company_id` | `{ job_posting }` |
| Add a job contact | `job_hunt_add_job_contact` | `POST /v1/plugins/job-hunt/job-contacts` | `write` | `name`; `company_id`, `title`, `email`, `phone`, `linkedin_url`, `role_in_process`, `notes`, `last_contacted` optional | `{ job_contact }` |
| Search job contacts | `job_hunt_search_job_contacts` | `GET /v1/plugins/job-hunt/job-contacts` | `read` | `query`, `company_id`, `role_in_process`, `only_unlinked` optional; `limit`, 1 to 200, default 50 | `{ contacts, truncated }` |
| Change a job contact | `job_hunt_update_job_contact` | `PATCH /v1/plugins/job-hunt/job-contacts/{job_contact_id}` | `write` | `job_contact_id`; any of `add_job_contact`'s fields | `{ job_contact }` |
| Link a job contact to the CRM | `job_hunt_link_contact_to_professional_crm` | `POST /v1/plugins/job-hunt/job-contacts/{job_contact_id}/crm-link` | `write` | `job_contact_id`, `professional_crm_contact_id` (null unlinks) | `{ job_contact, already_linked }` |
| Record an application | `job_hunt_submit_application` | `POST /v1/plugins/job-hunt/applications` | `write` | `job_posting_id`; `status`, `applied_date`, `resume_version`, `cover_letter_notes`, `referral_contact`, `notes`, `today` optional | `{ application }` |
| List applications | `job_hunt_list_applications` | `GET /v1/plugins/job-hunt/applications` | `read` | `status`, `company_id`, `job_posting_id` optional; `limit`, 1 to 200, default 50 | `{ applications, truncated }` |
| Change an application | `job_hunt_update_application` | `PATCH /v1/plugins/job-hunt/applications/{application_id}` | `write` | `application_id`; any of `submit_application`'s fields but `job_posting_id`, and `response_date` | `{ application }` |
| Schedule an interview | `job_hunt_schedule_interview` | `POST /v1/plugins/job-hunt/interviews` | `write` | `application_id`, `interview_type`; `scheduled_at`, `duration_minutes`, `interviewer_name`, `interviewer_title`, `notes` optional | `{ interview }` |
| List interviews | `job_hunt_list_interviews` | `GET /v1/plugins/job-hunt/interviews` | `read` | `application_id`, `company_id`, `status` optional; `limit`, 1 to 200, default 50 | `{ interviews, truncated }` |
| Change an interview | `job_hunt_update_interview` | `PATCH /v1/plugins/job-hunt/interviews/{interview_id}` | `write` | `interview_id`; any of `schedule_interview`'s fields but `application_id`, and `status` | `{ interview }` |
| Log how an interview went | `job_hunt_log_interview_notes` | `PATCH /v1/plugins/job-hunt/interviews/{interview_id}/notes` | `write` | `interview_id`; `feedback`, `rating`, `status` optional | `{ interview }` |
| The pipeline at a glance | `job_hunt_get_pipeline_overview` | `GET /v1/plugins/job-hunt/pipeline` | `read` | `days_ahead`, 1 to 365, default 7; `limit` of each list, 1 to 200, default 50 | `{ total_applications, status_breakdown, upcoming_interviews, upcoming_count, awaiting_notes, awaiting_notes_count, unscheduled_count, truncated }` |
| Upcoming interviews | `job_hunt_get_upcoming_interviews` | `GET /v1/plugins/job-hunt/upcoming-interviews` | `read` | `days_ahead`, 1 to 365, default 14; `limit`, 1 to 200, default 50 | `{ interviews, truncated }` |

- **Names.** The old server's ten tools keep their names, which the plugin's own name prefixes now: `add_company` is `job_hunt_add_company`. Nine are new. Four lists (`list_companies`, `list_job_postings`, `list_applications`, `list_interviews`) let an agent find the ids the others take: the old server answered a row's id when it was added, and listed only job contacts, with their companies, and the interviews still ahead, with their applications, postings and companies. A change of each kind of row (`update_company`, `update_job_posting`, `update_job_contact`, `update_application`, `update_interview`) moves an application or interview on and mends a typo, which with no delete was for good.
- **Formats.** Dates are `YYYY-MM-DD` from the year 0001, and timestamps are ISO text in UTC. `scheduled_at` and `last_contacted` are moments with seconds and their offset (`2026-11-03T15:00:00Z`, `…-05:00`). An email must be an email address, and a website, posting or LinkedIn URL a URL starting `http://` or `https://`; anything else belongs in notes. Text is trimmed and holds no NUL, and blank notes are none. Salaries are whole amounts from 0, the minimum no more than the maximum, in `salary_currency`, ISO 4217's three letters (`USD` unless given, kept upper-case). A Glassdoor rating is 1.0 to 5.0 with one decimal. Requirements and nice-to-haves are kept trimmed, each once, in the order given.
- **The user's today.** `submit_application`, `update_application` and `list_job_postings` take `today`, the user's own date, within a day of the date in UTC: an application's day defaults to it, a day after it is refused (`FUTURE_DATE`, naming the today used and saying to pass the user's), and a posting closing on it is still open. Without it they use the date in UTC, a day off for part of each day in most time zones.
- **Searching.** `query` matches word by word: every word must be in the row, in any case and as part of a word ("tech" finds TechCorp). Commas and semicolons split words too. A company matches on its name, industry, location, website or notes; a posting on its title, its company's name, notes, requirements or nice-to-haves; a job contact on their name, title, email, phone, notes, role or company's name. The other filters given all apply. `list_job_postings` with `closing_by` lists the postings closing from today to that day, the soonest first ("which close this week?").
- **Changing a row.** Each `update_` operation changes only the fields given; one given as `null` is cleared (a company's or contact's name, a posting's title, its currency or its two lists, a status or an interview's type cannot be), and no field at all is `NOTHING_TO_CHANGE`. A posting's requirements or nice-to-haves, when given, replace the list. A posting's salary range and dates, and an application's days, are checked as they will stand, against what is stored. `update_job_contact` sets when you last spoke (`last_contacted`); the CRM link stays the link's to change.
- **Applications.** `submit_application` records an application as `applied` unless `status` says otherwise, dated today unless `applied_date` is given; a draft or a withdrawn one is undated unless given. A posting holds one open application, one not rejected or withdrawn: another is `409 ALREADY_APPLIED`, naming the one there, whether submitted or reopened by `update_application`, until it ends; an ended one can always be recorded beside it. `update_application` moves it on: a draft sent (to any status but withdrawn) with no `applied_date` is dated today, unless a response recorded earlier says otherwise; a withdrawn one reopened stays undated, so give `applied_date`; and a response before the application is `BAD_DATES`. `list_applications` lists the latest applied first, the undated last.
- **Interviews.** `schedule_interview` refuses an application rejected or withdrawn (`422 APPLICATION_ENDED`), reading its status under a lock, so a withdrawal at the same moment either comes first or waits. `update_interview` reschedules one (a cancelled or no-show one given a new time is scheduled again, unless its application has ended, when `status: scheduled` is `APPLICATION_ENDED` here and in `log_interview_notes` alike), sets a time for one scheduled without, changes its prep notes or who interviews, or sets it scheduled, cancelled or no-show. `log_interview_notes` records how it went: its feedback and your rating of 1 to 5, only the fields given (the old tool cleared the feedback or rating left out). A `scheduled` interview whose time has come becomes `completed` unless `status` says otherwise; one still ahead or with no time stays `scheduled`, and a cancelled or no-show one stays as it was (the old tool marked every one logged completed). `list_interviews` lists them, those with no time yet first, then the latest first; `get_upcoming_interviews` those scheduled from now to `days_ahead` days on (1 is the next 24 hours), the soonest first; each with its application's status, its posting's title and its company's name.
- **The pipeline.** `get_pipeline_overview` answers "how's it going?" in one call: every application counted, each status counted (every status, none as 0), the interviews scheduled within `days_ahead` days, the interviews still `scheduled` whose time has passed (`awaiting_notes`, the latest first), which want `log_interview_notes`, and how many scheduled interviews have no time yet (`unscheduled_count`), each of an application still open: a rejected or withdrawn one's interviews leave it, and `get_upcoming_interviews`, though `list_interviews` keeps them. The counts are of all of them, and `limit` cuts each list.
- **Linking a job contact to the professional CRM.** A recruiter met in the search is a professional contact worth keeping after it. The link is two steps, since no plugin calls another and this one reaches nothing outside its own schema:
  1. The agent looks for them in the CRM with `professional_crm_search_contacts`, and only if they are not there adds them with `professional_crm_add_contact`: their name, the company's name as `company`, title, email, phone, LinkedIn URL, `how_we_met` "Job search: <their role>", and tags `job-hunt` and their role.
  2. It calls `link_contact_to_professional_crm` with that contact's id, which records it on the job contact.

  The link records the id alone: it cannot check the CRM has that contact, and works with the CRM plugin off. Linking a contact to the id it holds already answers `already_linked`, and unlinking one not linked writes nothing; one linked to another is refused (`ALREADY_LINKED`, naming it in its message), and `professional_crm_contact_id: null` unlinks it first. Two links at once decide in turn. `search_job_contacts` with `only_unlinked` lists the contacts not yet linked. The old tool wrote the CRM's table itself.
- **Refusals.**
  - A company, posting, application, interview or job contact that is not there: `404 NO_SUCH_COMPANY`, `NO_SUCH_POSTING`, `NO_SUCH_APPLICATION`, `NO_SUCH_INTERVIEW` or `NO_SUCH_JOB_CONTACT`, saying where the ids are.
  - A salary minimum above the maximum: `422 BAD_SALARY`. A closing date before the posted one, or a response before the application: `422 BAD_DATES`.
  - An applied or response date after today, a posted date after every time zone's today, or a last contact more than a day ahead: `422 FUTURE_DATE`.
  - A second open application to a posting: `409 ALREADY_APPLIED`. An interview for an application rejected or withdrawn, or one of its interviews set scheduled again: `422 APPLICATION_ENDED`. A job contact linked to another CRM contact: `409 ALREADY_LINKED`.
  - A change or a log with no field: `422 NOTHING_TO_CHANGE`.
  - Any input out of its form or range: `400`, before anything is stored.
- **MCP hints.** Every tool is closed-world, and a read is read-only. The five `update_` operations, `log_interview_notes` and the link overwrite what was there, so they are marked destructive; the adds are not.

**`user_id`.** Each table keeps upstream's multi-user `user_id` column, nullable, and nothing writes or reads it. The fork is one operator's brain (SMD-1716), so every key that may read sees every row (decided 2026-11-02). `DEFAULT_USER_ID` is gone.

## Prerequisites

- A working Open Brain stack (`deploy/compose.yaml`).
- A key with read scope (`bun keygen.ts --name me --scope read` in `server-portable/`), and one with write scope (`--scope write`) to add, change, log and link.
- The [professional-crm plugin](../professional-crm/), to link job contacts into a CRM. The rest works without it.

## Turn it on

1. Add the plugin to `deploy/.env`, with the secret each plugin's login role's password is derived from. If `OB1_PLUGIN_DB_PASSWORD` is already set for another plugin, keep it: one secret serves them all.

   ```
   OB1_PLUGINS=job-hunt
   OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
   ```

   Names are comma-separated: `OB1_PLUGINS=professional-crm,job-hunt` runs both.
2. Recreate the migrator and the servers so they read it: `docker compose up -d migrate api mcp` from `deploy/`, then `docker compose up -d --force-recreate --no-deps app`, so the operator GUI reaches the recreated REST core at once. Name the stack's other `-f` files in both. Recreating `app` signs everyone out of the GUI. The migrator makes the plugin's role, its schema and its login role `ob1_plugins_job_hunt`, and applies `001_job_hunt.sql`.
3. Check it:
   - preflight's `plugin tables` row says the role, schema and migrations are in place;
   - `GET /v1/whoami` lists the seven reads for a read key, and all nineteen tools for a write key;
   - your MCP client sees the same tools on the brain's own connector, with no new connector or key.

Remove the name from `OB1_PLUGINS` and recreate the same services to turn it off. Its tools and routes go, while its tables and rows stay and come back when it is turned on again.

## Moving from the standalone server

The standalone server kept its rows in `public.companies`, `public.job_postings`, `public.applications`, `public.interviews` and `public.job_contacts`. A plugin's migrations run as its own role in its own schema, and cannot adopt them. Neither dogfood brain held them. On a brain that does:

1. Turn the plugin on (above).
2. Copy the rows across as the database owner, in `psql`. It is one transaction, so a refused row copies nothing and the whole block can be run again. A row already copied is left as it is, so running it again later copies only what is new:

   ```sql
   \set ON_ERROR_STOP on
   BEGIN;
   INSERT INTO plugin_job_hunt.companies (id, user_id, name, industry, website, size, location, remote_policy, notes, glassdoor_rating, created_at, updated_at)
     SELECT id, user_id, btrim(name), nullif(btrim(industry), ''), nullif(btrim(website), ''), size, nullif(btrim(location), ''), remote_policy,
            nullif(btrim(notes), ''), glassdoor_rating, created_at, updated_at
       FROM public.companies
   ON CONFLICT (id) DO NOTHING;
   INSERT INTO plugin_job_hunt.job_postings (id, company_id, user_id, title, url, salary_min, salary_max, salary_currency, requirements, nice_to_haves, notes, source,
                                             posted_date, closing_date, created_at, updated_at)
     SELECT id, company_id, user_id, btrim(title), nullif(btrim(url), ''), salary_min, salary_max, upper(coalesce(nullif(btrim(salary_currency), ''), 'USD')),
            coalesce(requirements, '{}'), coalesce(nice_to_haves, '{}'), nullif(btrim(notes), ''), source, posted_date, closing_date, created_at, created_at
       FROM public.job_postings
   ON CONFLICT (id) DO NOTHING;
   INSERT INTO plugin_job_hunt.applications (id, job_posting_id, user_id, status, applied_date, response_date, resume_version, cover_letter_notes, referral_contact,
                                             notes, created_at, updated_at)
     SELECT id, job_posting_id, user_id, coalesce(status, 'applied'), applied_date, response_date, nullif(btrim(resume_version), ''),
            nullif(btrim(cover_letter_notes), ''), nullif(btrim(referral_contact), ''), nullif(btrim(notes), ''), created_at, updated_at
       FROM public.applications
   ON CONFLICT (id) DO NOTHING;
   INSERT INTO plugin_job_hunt.interviews (id, application_id, user_id, interview_type, scheduled_at, duration_minutes, interviewer_name, interviewer_title, status,
                                           notes, feedback, rating, created_at, updated_at)
     SELECT id, application_id, user_id, interview_type, scheduled_at, duration_minutes, nullif(btrim(interviewer_name), ''), nullif(btrim(interviewer_title), ''),
            coalesce(status, 'scheduled'), nullif(btrim(notes), ''), nullif(btrim(feedback), ''), rating, created_at, created_at
       FROM public.interviews
   ON CONFLICT (id) DO NOTHING;
   INSERT INTO plugin_job_hunt.job_contacts (id, user_id, company_id, name, title, email, phone, linkedin_url, role_in_process, professional_crm_contact_id, notes,
                                             last_contacted, created_at, updated_at)
     SELECT id, user_id, company_id, btrim(name), nullif(btrim(title), ''), nullif(btrim(email), ''), nullif(btrim(phone), ''), nullif(btrim(linkedin_url), ''),
            role_in_process, professional_crm_contact_id, nullif(btrim(notes), ''), last_contacted, created_at, created_at
       FROM public.job_contacts
   ON CONFLICT (id) DO NOTHING;
   COMMIT;
   ```

   - **`user_id`.** Each row keeps its `user_id`, in the column the plugin keeps and ignores.
   - **`updated_at`.** The old postings, interviews and job contacts had none: theirs is when they were added.
   - **A blank text field** is copied as none. A posting with no currency is in `USD`, and its currency is kept upper-case. An application with no status is `applied`, and an interview with none `scheduled`, as the old tables' defaults said.
   - **An email, a website, a posting or a LinkedIn URL** is copied as it was, even one the tools would refuse; so are requirements and nice-to-haves, untrimmed and repeats kept. A list holding a NULL item copies, and the posting's answers then fail: remove the item in `public` first.
   - **A second open application** to one posting, which the old server allowed, copies; `update_application` can withdraw one.
   - **Links to the CRM.** The old link wrote a contact into `public.professional_contacts` and recorded its id. The CRM plugin's own copy ([its README](../professional-crm/README.md#moving-from-the-standalone-server)) keeps each contact's id, so, in either order, the job contacts' links then name the CRM plugin's contacts.
   - **A refused copy.** The plugin's tables check what the old ones did not:
     - a company's name, a posting's title or a contact's name of 1 to 200 characters;
     - salaries of 0 or more, the minimum no more than the maximum, in three letters of a currency;
     - a closing date no earlier than the posted one, and a response no earlier than the application;
     - an interview with its type, of 1 to 1,440 minutes.

     If a row breaks one of these, the copy names the check (or, for an interview with no type, the column) and nothing is copied. Fix that row in `public` and run the block again.
   - **Leftover tables.** Once the plugin's answers look right, the old tables can be dropped by hand.

## Troubleshooting

- **The server refuses to start: "OB1_PLUGINS names … which is no plugin in this build".** The running image predates the plugin. Pull or rebuild it.
- **Preflight's `plugin tables` row says the server "cannot log in as ob1_plugins_job_hunt".** `OB1_PLUGIN_DB_PASSWORD` is not the secret the role was made with. [The example plugin's troubleshooting](../example/README.md#troubleshooting) says how to set it back or change both.
- **`403 FORBIDDEN` with `needs: "write"`.** A read key cannot add, change, log or link. Over MCP, a read key's tool list has no write tools at all.
- **`ALREADY_LINKED`.** The job contact is linked to another CRM contact. Link it with `professional_crm_contact_id: null` first, then to the one meant.
- **An agent cannot find a company it added.** `list_companies` matches every word of the query; ask with fewer words, or part of the name.
