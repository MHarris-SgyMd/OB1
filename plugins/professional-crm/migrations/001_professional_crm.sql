-- The professional CRM's tables (SMD-2311): the people in a professional
-- network, each touchpoint with them, the opportunities they bring, and the
-- brain's thoughts linked to them. Ported from extensions/professional-crm/
-- schema.sql, which applied the first three to the public schema by hand.
--
-- Runs as the plugin's role, ob1_plugin_professional_crm, with its schema,
-- plugin_professional_crm, first on the path: each table here is the
-- plugin's own, and nothing in the core is referenced. A linked thought is
-- named by its id alone; the operation reads it through the core as the
-- caller (ctx.call("fetch")), never from the core's tables.
--
-- The old file's triggers (updated_at, and a contact's last_contacted set by
-- each interaction logged) are the operations' own statements now, and its
-- full-text column and search function went with the search they served: a
-- query is matched word by word, by part of a word, as the other plugins'
-- are. No function lives in this schema.
--
-- user_id is upstream's multi-user column, kept nullable and ignored: the
-- fork is one operator's brain (SMD-1716), so no operation writes or reads it
-- (decided 2026-11-02).

CREATE TABLE IF NOT EXISTS professional_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  company         text,
  title           text,
  email           text,
  phone           text,
  linkedin_url    text,
  how_we_met      text,
  -- Lower-case, each once.
  tags            text[] NOT NULL DEFAULT '{}',
  notes           text,
  -- The latest interaction logged with them.
  last_contacted  timestamptz,
  -- The day to get back in touch, if one is set.
  follow_up_date  date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contact_interactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        uuid NOT NULL REFERENCES professional_contacts (id),
  user_id           uuid,
  interaction_type  text NOT NULL CHECK (interaction_type IN ('meeting', 'email', 'call', 'coffee', 'event', 'linkedin', 'other')),
  occurred_at       timestamptz NOT NULL,
  summary           text NOT NULL CHECK (length(summary) BETWEEN 1 AND 5000),
  follow_up_needed  boolean NOT NULL DEFAULT false,
  follow_up_notes   text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS opportunities (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid,
  contact_id           uuid REFERENCES professional_contacts (id),
  title                text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description          text,
  stage                text NOT NULL DEFAULT 'identified' CHECK (stage IN ('identified', 'in_conversation', 'proposal', 'negotiation', 'won', 'lost')),
  -- What it is worth, in the user's currency.
  value                numeric(12, 2) CHECK (value >= 0),
  expected_close_date  date,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- A thought of the brain's linked to a contact: once each, its text appended
-- to the contact's notes when it was linked.
CREATE TABLE IF NOT EXISTS contact_thoughts (
  contact_id  uuid NOT NULL REFERENCES professional_contacts (id),
  thought_id  uuid NOT NULL,
  linked_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, thought_id)
);

CREATE INDEX IF NOT EXISTS professional_contacts_by_follow_up ON professional_contacts (follow_up_date) WHERE follow_up_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS professional_contacts_by_last_contacted ON professional_contacts (last_contacted);
CREATE INDEX IF NOT EXISTS professional_contacts_by_tags ON professional_contacts USING gin (tags);
CREATE INDEX IF NOT EXISTS contact_interactions_by_contact ON contact_interactions (contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS opportunities_by_contact ON opportunities (contact_id);
CREATE INDEX IF NOT EXISTS opportunities_by_stage ON opportunities (stage);

-- What the operations answer, one jsonb object a row (`answer`): dates as
-- YYYY-MM-DD text, timestamps as ISO text in UTC, user_id left out. Beside
-- it, the raw values the operations filter and order by. An operation selects
-- named columns, never `*`, so a column added here later changes no prepared
-- statement's result (check 41).
CREATE OR REPLACE VIEW contact_rows AS
  SELECT c.id, c.name, c.tags, c.last_contacted, c.follow_up_date, c.created_at,
         -- What a query reads: every text field and the tags.
         concat_ws(' ', c.name, c.company, c.title, c.email, c.phone, c.linkedin_url, c.how_we_met, c.notes, array_to_string(c.tags, ' ')) AS search_text,
         jsonb_build_object(
           'id', c.id, 'name', c.name, 'company', c.company, 'title', c.title, 'email', c.email, 'phone', c.phone,
           'linkedin_url', c.linkedin_url, 'how_we_met', c.how_we_met, 'tags', to_jsonb(c.tags), 'notes', c.notes,
           'last_contacted', to_char(c.last_contacted AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'follow_up_date', c.follow_up_date::text,
           'created_at', to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'updated_at', to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ) AS answer
    FROM professional_contacts c;

CREATE OR REPLACE VIEW interaction_rows AS
  SELECT i.id, i.contact_id, i.occurred_at, i.created_at, i.follow_up_needed,
         jsonb_build_object(
           'id', i.id, 'contact_id', i.contact_id, 'interaction_type', i.interaction_type,
           'occurred_at', to_char(i.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'summary', i.summary, 'follow_up_needed', i.follow_up_needed, 'follow_up_notes', i.follow_up_notes,
           'created_at', to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ) AS answer
    FROM contact_interactions i;

-- An opportunity, with its contact's id and name, or null.
CREATE OR REPLACE VIEW opportunity_rows AS
  SELECT o.id, o.contact_id, o.stage, o.value, o.expected_close_date, o.created_at,
         o.stage NOT IN ('won', 'lost') AS open,
         jsonb_build_object(
           'id', o.id, 'contact_id', o.contact_id,
           'contact', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id', c.id, 'name', c.name) END,
           'title', o.title, 'description', o.description, 'stage', o.stage, 'open', o.stage NOT IN ('won', 'lost'),
           'value', o.value, 'expected_close_date', o.expected_close_date::text, 'notes', o.notes,
           'created_at', to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'updated_at', to_char(o.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ) AS answer
    FROM opportunities o LEFT JOIN professional_contacts c ON c.id = o.contact_id;

CREATE OR REPLACE VIEW linked_thought_rows AS
  SELECT t.contact_id, t.thought_id, t.linked_at,
         jsonb_build_object('thought_id', t.thought_id, 'linked_at', to_char(t.linked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS answer
    FROM contact_thoughts t;
