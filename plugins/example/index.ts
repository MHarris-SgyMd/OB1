// The example plugin (SMD-2310): the template a plugin starts from. It reaches
// the brain's thoughts the only way a plugin may — through a core operation,
// as the caller (ctx.call) — and keeps one table of its own (ctx.db), made by
// its migration in migrations/.

import { definePlugin, hmacSha256Hex, ok, operation, refuse, safeEqual, z } from "../../server-portable/plugin-sdk.ts";

/** A note as both operations answer it. */
const Note = z.object({ id: z.string(), thought_id: z.string(), note: z.string(), written_by: z.string(), created_at: z.string() });
type NoteRow = { id: string; thought_id: string; note: string; written_by: string; created_at: Date | string };
const asNote = (r: NoteRow) => ({ ...r, created_at: new Date(r.created_at).toISOString() });

export default definePlugin({
  name: "example",
  title: "Example plugin",
  description: "The plugin template: a read operation over the core, and notes pinned to thoughts in a table of its own. Copy the directory to start a plugin.",
  // The operator GUI's nav entry (SMD-2280 renders the page): a thought's notes.
  gui: { pages: [{ path: "/notes", label: "Notes" }] },
  // A capture source's inbound webhook, as a Slack or Telegram plugin's would
  // be: POST /hooks/example/capture with {"text": "…"}, signed with the
  // operator's secret (x-example-signature: hex HMAC-SHA256 of the raw body).
  hooks: {
    capture: {
      description: "Captures the delivery's text as a thought of trust ingested, when its signature matches the secret OB1_HOOK_SECRETS gives the example.",
      async handler(ctx, request) {
        if (!ctx.secret) return { status: 503, body: { code: "HOOK_NOT_CONFIGURED", retryable: false } };
        const signature = request.headers["x-example-signature"] ?? "";
        if (!safeEqual(signature, hmacSha256Hex(ctx.secret, request.body))) return { status: 401, body: { code: "BAD_SIGNATURE", retryable: false } };
        let text: unknown;
        try {
          text = (JSON.parse(request.body) as { text?: unknown }).text;
        } catch {
          return { status: 400, body: { code: "NOT_JSON", retryable: false } };
        }
        if (typeof text !== "string" || !text.trim()) return { status: 400, body: { code: "NO_TEXT", retryable: false } };
        const captured = await ctx.call("capture_thought", { content: text, source: "example-hook", trust: "ingested" });
        if (!captured.ok) return { status: 422, body: { code: "CORE_REFUSED", retryable: false, refused: captured.refusal.code } };
        return { status: 202, body: { id: captured.value.id } };
      },
    },
  },
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
