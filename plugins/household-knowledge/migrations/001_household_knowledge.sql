-- The household knowledge base's tables (SMD-2311): facts about the things in
-- the home (a paint colour, an appliance's model, a measurement) and the
-- vendors who work on it. Ported from extensions/household-knowledge/
-- schema.sql, which applied them to the public schema by hand.
--
-- Runs as the plugin's role, ob1_plugin_household_knowledge, with its schema,
-- plugin_household_knowledge, first on the path: each table here is the
-- plugin's own, and nothing in the core is referenced. No operation updates a
-- row, so the old file's updated_at trigger is gone; the column stays, as
-- written.
--
-- user_id is upstream's multi-user column, kept nullable and ignored: the
-- fork is one operator's brain (SMD-1716), so no operation writes or reads it
-- (decided 2026-11-02).

CREATE TABLE IF NOT EXISTS household_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- 'paint', 'appliance', 'measurement', 'document', …
  category    text,
  -- Where in the home it is.
  location    text,
  -- Its particulars as an object: a brand, a model, a colour code, a serial.
  details     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS household_vendors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- 'plumber', 'electrician', 'landscaper', …
  service_type  text,
  phone         text,
  email         text,
  website       text,
  notes         text,
  rating        integer CHECK (rating BETWEEN 1 AND 5),
  last_used     date,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS household_items_by_category ON household_items (category);
CREATE INDEX IF NOT EXISTS household_vendors_by_service ON household_vendors (service_type);

-- What the operations answer, one jsonb object a row (`answer`): dates as
-- YYYY-MM-DD text, timestamps as ISO text in UTC, user_id left out. Beside
-- it, the raw values the operations filter and order by. An operation selects
-- named columns, never `*`, so a column added here later changes no prepared
-- statement's result (check 41).
CREATE OR REPLACE VIEW item_rows AS
  SELECT i.id, i.name, i.category, i.location, i.notes, i.details::text AS details_text, i.created_at,
         jsonb_build_object(
           'id', i.id, 'name', i.name, 'category', i.category, 'location', i.location, 'details', i.details, 'notes', i.notes,
           'created_at', to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'updated_at', to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ) AS answer
    FROM household_items i;

CREATE OR REPLACE VIEW vendor_rows AS
  SELECT v.id, v.name, v.service_type, v.notes, v.phone, v.email, v.website, v.created_at,
         jsonb_build_object(
           'id', v.id, 'name', v.name, 'service_type', v.service_type, 'phone', v.phone, 'email', v.email, 'website', v.website,
           'notes', v.notes, 'rating', v.rating, 'last_used', v.last_used::text,
           'created_at', to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ) AS answer
    FROM household_vendors v;
