-- The job hunt pipeline's tables (SMD-2311): the companies in a job search,
-- their postings, the applications made, the interviews they bring, and the
-- people met along the way. Ported from extensions/job-hunt/schema.sql, which
-- applied them to the public schema by hand.
--
-- Runs as the plugin's role, ob1_plugin_job_hunt, with its schema,
-- plugin_job_hunt, first on the path: each table here is the plugin's own,
-- and nothing in the core or in another plugin is referenced. A job contact's
-- link to the professional CRM is the CRM contact's id alone, which this
-- schema cannot check: the CRM's tables are its plugin's (decided 2026-11-02).
--
-- The old file's updated_at triggers are the operations' own statements now:
-- no function lives in this schema.
--
-- user_id is upstream's multi-user column, kept nullable and ignored: the
-- fork is one operator's brain (SMD-1716), so no operation writes or reads it
-- (decided 2026-11-02).

CREATE TABLE IF NOT EXISTS companies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid,
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  industry          text,
  website           text,
  size              text CHECK (size IN ('startup', 'mid-market', 'enterprise')),
  location          text,
  remote_policy     text CHECK (remote_policy IN ('remote', 'hybrid', 'onsite')),
  notes             text,
  glassdoor_rating  numeric(2, 1) CHECK (glassdoor_rating BETWEEN 1.0 AND 5.0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_postings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies (id),
  user_id          uuid,
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  url              text,
  salary_min       integer CHECK (salary_min >= 0),
  salary_max       integer CHECK (salary_max >= 0),
  -- ISO 4217, three capital letters.
  salary_currency  text NOT NULL DEFAULT 'USD' CHECK (salary_currency ~ '^[A-Z]{3}$'),
  requirements     text[] NOT NULL DEFAULT '{}',
  nice_to_haves    text[] NOT NULL DEFAULT '{}',
  notes            text,
  source           text CHECK (source IN ('linkedin', 'company-site', 'referral', 'recruiter', 'other')),
  posted_date      date,
  closing_date     date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_postings_salary_range CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max),
  CONSTRAINT job_postings_dates CHECK (posted_date IS NULL OR closing_date IS NULL OR posted_date <= closing_date)
);

CREATE TABLE IF NOT EXISTS applications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_posting_id      uuid NOT NULL REFERENCES job_postings (id),
  user_id             uuid,
  status              text NOT NULL DEFAULT 'applied' CHECK (status IN ('draft', 'applied', 'screening', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn')),
  applied_date        date,
  -- The day the company last answered.
  response_date       date,
  resume_version      text,
  cover_letter_notes  text,
  -- Who referred you, as written; a job contact is job_contacts'.
  referral_contact    text,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- The company answers after you applied, never before.
  CONSTRAINT applications_dates CHECK (applied_date IS NULL OR response_date IS NULL OR applied_date <= response_date)
);

CREATE TABLE IF NOT EXISTS interviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id     uuid NOT NULL REFERENCES applications (id),
  user_id            uuid,
  interview_type     text NOT NULL CHECK (interview_type IN ('phone_screen', 'technical', 'behavioral', 'system_design', 'hiring_manager', 'team', 'final')),
  scheduled_at       timestamptz,
  duration_minutes   integer CHECK (duration_minutes BETWEEN 1 AND 1440),
  interviewer_name   text,
  interviewer_title  text,
  status             text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  -- Prep before it.
  notes              text,
  -- Reflection after it.
  feedback           text,
  -- How it went, 1 to 5, in your own judgement.
  rating             integer CHECK (rating BETWEEN 1 AND 5),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_contacts (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                      uuid,
  company_id                   uuid REFERENCES companies (id),
  name                         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  title                        text,
  email                        text,
  phone                        text,
  linkedin_url                 text,
  role_in_process              text CHECK (role_in_process IN ('recruiter', 'hiring_manager', 'referral', 'interviewer', 'other')),
  -- The professional CRM's contact for them, by its id: the CRM's tables are its
  -- plugin's, so this is not a foreign key, and nothing here checks it.
  professional_crm_contact_id  uuid,
  notes                        text,
  last_contacted               timestamptz,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_postings_by_company ON job_postings (company_id);
CREATE INDEX IF NOT EXISTS applications_by_posting ON applications (job_posting_id);
CREATE INDEX IF NOT EXISTS applications_by_status ON applications (status);
CREATE INDEX IF NOT EXISTS interviews_by_application ON interviews (application_id, scheduled_at);
CREATE INDEX IF NOT EXISTS interviews_by_time ON interviews (scheduled_at) WHERE scheduled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS job_contacts_by_company ON job_contacts (company_id);

-- What the operations answer, one jsonb object a row (`answer`): dates as
-- YYYY-MM-DD text, timestamps as ISO text in UTC, user_id left out. Beside
-- it, the raw values the operations filter and order by. An operation selects
-- named columns, never `*`, so a column added here later changes no prepared
-- statement's result (check 41).
CREATE OR REPLACE VIEW company_rows AS
  SELECT c.id, c.name, c.created_at,
         concat_ws(' ', c.name, c.industry, c.location, c.website, c.notes) AS search_text,
         jsonb_build_object(
           'id', c.id, 'name', c.name, 'industry', c.industry, 'website', c.website, 'size', c.size, 'location', c.location,
           'remote_policy', c.remote_policy, 'notes', c.notes, 'glassdoor_rating', c.glassdoor_rating,
           'created_at', to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'updated_at', to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ) AS answer
    FROM companies c;

-- A posting, with its company's id and name.
CREATE OR REPLACE VIEW posting_rows AS
  SELECT p.id, p.company_id, p.closing_date, p.created_at,
         concat_ws(' ', p.title, c.name, p.notes, array_to_string(p.requirements, ' '), array_to_string(p.nice_to_haves, ' ')) AS search_text,
         jsonb_build_object(
           'id', p.id, 'company_id', p.company_id, 'company', jsonb_build_object('id', c.id, 'name', c.name), 'title', p.title, 'url', p.url,
           'salary_min', p.salary_min, 'salary_max', p.salary_max, 'salary_currency', p.salary_currency,
           'requirements', to_jsonb(p.requirements), 'nice_to_haves', to_jsonb(p.nice_to_haves), 'notes', p.notes, 'source', p.source,
           'posted_date', p.posted_date::text, 'closing_date', p.closing_date::text,
           'created_at', to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'updated_at', to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ) AS answer
    FROM job_postings p JOIN companies c ON c.id = p.company_id;

-- An application, with its posting's id and title and its company's id and name.
CREATE OR REPLACE VIEW application_rows AS
  SELECT a.id, a.job_posting_id, p.company_id, a.status, a.applied_date, a.created_at,
         jsonb_build_object(
           'id', a.id, 'job_posting_id', a.job_posting_id,
           'posting', jsonb_build_object('id', p.id, 'title', p.title), 'company', jsonb_build_object('id', c.id, 'name', c.name),
           'status', a.status, 'applied_date', a.applied_date::text, 'response_date', a.response_date::text,
           'resume_version', a.resume_version, 'cover_letter_notes', a.cover_letter_notes, 'referral_contact', a.referral_contact, 'notes', a.notes,
           'created_at', to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'updated_at', to_char(a.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ) AS answer
    FROM applications a JOIN job_postings p ON p.id = a.job_posting_id JOIN companies c ON c.id = p.company_id;

-- An interview, with its application's id and status, its posting's title and its company's name.
CREATE OR REPLACE VIEW interview_rows AS
  SELECT i.id, i.application_id, p.company_id, i.status, i.scheduled_at, i.created_at,
         jsonb_build_object(
           'id', i.id, 'application_id', i.application_id,
           'application', jsonb_build_object('id', a.id, 'status', a.status), 'posting', jsonb_build_object('id', p.id, 'title', p.title),
           'company', jsonb_build_object('id', c.id, 'name', c.name),
           'interview_type', i.interview_type, 'scheduled_at', to_char(i.scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'duration_minutes', i.duration_minutes, 'interviewer_name', i.interviewer_name, 'interviewer_title', i.interviewer_title,
           'status', i.status, 'notes', i.notes, 'feedback', i.feedback, 'rating', i.rating,
           'created_at', to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'updated_at', to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ) AS answer
    FROM interviews i JOIN applications a ON a.id = i.application_id JOIN job_postings p ON p.id = a.job_posting_id JOIN companies c ON c.id = p.company_id;

-- A job contact, with their company's id and name, or null.
CREATE OR REPLACE VIEW job_contact_rows AS
  SELECT j.id, j.name, j.company_id, j.role_in_process, j.professional_crm_contact_id, j.created_at,
         concat_ws(' ', j.name, j.title, j.email, j.phone, j.notes, j.role_in_process, c.name) AS search_text,
         jsonb_build_object(
           'id', j.id, 'company_id', j.company_id, 'company', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id', c.id, 'name', c.name) END,
           'name', j.name, 'title', j.title, 'email', j.email, 'phone', j.phone, 'linkedin_url', j.linkedin_url,
           'role_in_process', j.role_in_process, 'professional_crm_contact_id', j.professional_crm_contact_id, 'notes', j.notes,
           'last_contacted', to_char(j.last_contacted AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'created_at', to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'updated_at', to_char(j.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ) AS answer
    FROM job_contacts j LEFT JOIN companies c ON c.id = j.company_id;
