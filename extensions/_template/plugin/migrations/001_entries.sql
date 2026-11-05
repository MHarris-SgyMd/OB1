-- TEMPLATE: the plugin's tables (SMD-2310; the extension template since
-- SMD-3747). Rename this file and `entries` to what the extension keeps.
--
-- The brain's migrator runs it as the plugin's own role, with the plugin's
-- schema (plugin_<name>) first on the path, once the plugin is named in
-- OB1_PLUGINS: name tables bare, reference nothing of the core's (a row that
-- names a thought holds its id, with no foreign key), and never DROP,
-- TRUNCATE or DELETE without a WHERE. A later change is a new file,
-- 002_….sql: a file once applied is never edited.

CREATE TABLE IF NOT EXISTS entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  notes       text CHECK (length(notes) <= 2000),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- search_entries lists newest first.
CREATE INDEX IF NOT EXISTS entries_by_created ON entries (created_at DESC, id);
