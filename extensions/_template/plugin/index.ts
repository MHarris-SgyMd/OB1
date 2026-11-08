// TEMPLATE: an extension's code, as a plugin of the brain's (SMD-2310; the
// extension template since SMD-3747). Copy this directory to plugins/<name>/,
// <name> being lower-case words joined by hyphens, and then:
//   1. set `name` below to the directory's name, and `title` and `description`;
//   2. rename `entries` here and in migrations/001_entries.sql to your table,
//      and shape its columns and the operations to what the extension keeps;
//   3. import the manifest in plugins/registry.ts and add it to PLUGINS;
//   4. write README.md and metadata.json from this directory's.
// The import below is written for plugins/<name>/index.ts. plugins/README.md
// holds the rules a plugin is held to (check 31 reads its code on every
// push); plugins/example/ adds a call into the core (ctx.call), a GUI page and
// a webhook, which this template leaves out. Replace this comment with one
// saying what the plugin keeps.

import { definePlugin, ok, operation, refuse, z } from "../../server-portable/plugin-sdk.ts";

/** Free text a person types: trimmed, at most `max` characters, and no NUL, which Postgres will not store in text. */
const text = (max: number) => z.string().trim().max(max).refine((s) => !s.includes("\u0000"), "no NUL character");

/** An entry as every operation answers it: timestamps as ISO text in UTC. */
const Entry = z.object({ id: z.string(), name: z.string(), notes: z.string().nullable(), created_at: z.string() });
type EntryRow = { id: string; name: string; notes: string | null; created_at: Date | string };
const asEntry = (r: EntryRow) => ({ ...r, created_at: new Date(r.created_at).toISOString() });

/** MCP hints: every operation reaches the plugin's own tables alone, and an add destroys nothing. A read is read-only already. */
const CLOSED = { openWorldHint: false } as const;
const ADDS = { destructiveHint: false, openWorldHint: false } as const;

/** A person's search text as an ILIKE pattern: `%`, `_` and the backslash match themselves, so "50%" finds "50%". */
const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export default definePlugin({
  name: "extension-name",
  title: "Extension Name",
  description: "What the plugin keeps and what an agent can ask of it, in a sentence or two: an MCP client shows it beside the tools.",
  operations: {
    add_entry: operation({
      title: "Add an entry",
      // Say when an agent should call it, not how it works: the agent reads this to choose a tool.
      description: "Adds an entry and answers it with its id. Use it when the person tells you something to keep.",
      scope: "write",
      annotations: ADDS,
      method: "POST",
      path: "/entries",
      input: {
        name: text(200).min(1).describe("What the entry is, 1 to 200 characters"),
        notes: text(2000).optional().describe("Anything else worth keeping, up to 2000 characters"),
      },
      output: { entry: Entry },
      async handler(ctx, { name, notes }) {
        const [row] = await ctx.db.tx((sql) => sql<EntryRow>`
          INSERT INTO entries (name, notes) VALUES (${name}, ${notes ?? null})
          RETURNING id, name, notes, created_at`);
        return ok({ entry: asEntry(row) });
      },
    }),
    search_entries: operation({
      title: "Search entries",
      description: "The entries whose name or notes hold the query, newest first; no query lists them all. Use it to find an entry or its id.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/entries",
      input: {
        query: text(200).default("").describe("Words to find in the name or notes; empty lists every entry"),
        limit: z.number().int().min(1).max(200).default(50).describe("How many entries, 1 to 200"),
      },
      output: { entries: z.array(Entry), truncated: z.boolean() },
      async handler(ctx, { query, limit }) {
        // One row past the limit says whether more matched.
        const rows = await ctx.db.tx((sql) => sql<EntryRow>`
          SELECT id, name, notes, created_at FROM entries
           WHERE ${query} = '' OR name ILIKE ${likePattern(query)} OR notes ILIKE ${likePattern(query)}
           ORDER BY created_at DESC, id LIMIT ${limit + 1}`);
        return ok({ entries: rows.slice(0, limit).map(asEntry), truncated: rows.length > limit });
      },
    }),
    get_entry: operation({
      title: "An entry",
      description: "One entry in full, by its id.",
      scope: "read",
      annotations: CLOSED,
      method: "GET",
      path: "/entries/{entry_id}",
      input: { entry_id: z.string().uuid().describe("The entry's id, as search_entries answers it") },
      output: { entry: Entry },
      async handler(ctx, { entry_id }) {
        const [row] = await ctx.db.tx((sql) => sql<EntryRow>`
          SELECT id, name, notes, created_at FROM entries WHERE id = ${entry_id}`);
        // A refusal is 400, 403, 404, 409 or 422 with an UPPER_CASE code, and says what to do next (503 is for a service that did not answer).
        if (!row) return refuse(404, "NO_SUCH_ENTRY", { entry_id, message: "No entry has that id: search_entries lists them." });
        return ok({ entry: asEntry(row) });
      },
    }),
  },
});
