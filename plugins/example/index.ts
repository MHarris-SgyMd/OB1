// The example plugin (SMD-2310): the template a plugin starts from. It reaches
// the brain's thoughts the only way a plugin may — through a core operation,
// as the caller (ctx.call) — and keeps one table of its own (ctx.db), made by
// its migration in migrations/.

import { definePlugin, ok, operation, refuse, z } from "../../server-portable/plugin-sdk.ts";

/** A note as both operations answer it. */
const Note = z.object({ id: z.string(), thought_id: z.string(), note: z.string(), written_by: z.string(), created_at: z.string() });
type NoteRow = { id: string; thought_id: string; note: string; written_by: string; created_at: Date | string };
const asNote = (r: NoteRow) => ({ ...r, created_at: new Date(r.created_at).toISOString() });

export default definePlugin({
  name: "example",
  title: "Example plugin",
  description: "The plugin template: a read operation over the core, and notes pinned to thoughts in a table of its own. Copy the directory to start a plugin.",
  operations: {
    recent: operation({
      title: "Recent thought ids",
      description: "The ids, types and capture times of the most recent thoughts, newest first — read through the core's list_thoughts as the caller, so a key that cannot read cannot call it.",
      scope: "read",
      method: "GET",
      path: "/recent",
      input: { limit: z.number().int().min(1).max(20).default(5).describe("How many thoughts, 1 to 20") },
      output: {
        thoughts: z.array(z.object({ id: z.string(), type: z.string().nullable(), created_at: z.string().nullable() })),
      },
      async handler(ctx, { limit }) {
        const listed = await ctx.call("list_thoughts", { limit });
        if (!listed.ok) return refuse(422, "CORE_REFUSED", { message: `list_thoughts refused: ${listed.refusal.code}` });
        return ok({
          thoughts: listed.value.thoughts.map((t) => ({
            id: t.id,
            type: typeof t.metadata.type === "string" ? t.metadata.type : null,
            created_at: t.created_at,
          })),
        });
      },
    }),
    add_note: operation({
      title: "Pin a note to a thought",
      description: "Pins a short note to a thought. The thought is looked up through the core as the caller first, so a thought the caller cannot read, or one that is not there, is refused (NO_SUCH_THOUGHT).",
      scope: "write",
      method: "POST",
      path: "/notes",
      input: {
        thought_id: z.string().uuid().describe("The thought's id"),
        note: z.string().trim().min(1).max(2000).describe("The note, 1 to 2000 characters"),
      },
      output: { note: Note },
      async handler(ctx, { thought_id, note }) {
        const thought = await ctx.call("fetch", { id: thought_id });
        if (!thought.ok) return refuse(404, "NO_SUCH_THOUGHT", { thought_id, message: `fetch refused: ${thought.refusal.code}` });
        const [row] = await ctx.db.tx((sql) => sql<NoteRow>`
          INSERT INTO notes (thought_id, note, written_by) VALUES (${thought_id}, ${note}, ${ctx.caller.name})
          RETURNING id, thought_id, note, written_by, created_at`);
        return ok({ note: asNote(row) });
      },
    }),
    list_notes: operation({
      title: "A thought's notes",
      description: "The notes pinned to a thought, oldest first.",
      scope: "read",
      method: "GET",
      path: "/notes",
      input: { thought_id: z.string().uuid().describe("The thought's id") },
      output: { notes: z.array(Note) },
      async handler(ctx, { thought_id }) {
        const rows = await ctx.db.tx((sql) => sql<NoteRow>`
          SELECT id, thought_id, note, written_by, created_at FROM notes
           WHERE thought_id = ${thought_id} ORDER BY created_at, id`);
        return ok({ notes: rows.map(asNote) });
      },
    }),
  },
});
