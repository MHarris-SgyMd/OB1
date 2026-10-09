-- The example plugin's one table (SMD-2310): a note pinned to a thought.
--
-- Runs as the plugin's role, ob1_plugin_example, with its schema,
-- plugin_example, first on the path: `notes` here is plugin_example.notes, and
-- the role holds nothing on the core's tables, so a reference to one is
-- refused. The thought is named by its id alone — no foreign key into the
-- core's table, which the role may not reference; the add_note operation
-- checks the thought through the core (ctx.call("fetch")) before it writes.

CREATE TABLE IF NOT EXISTS notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thought_id  uuid NOT NULL,
  note        text NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
  -- The key that wrote it (its name), as the caller the REST core or the MCP server authenticated.
  written_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notes_by_thought ON notes (thought_id, created_at);
