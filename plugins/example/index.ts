// The example plugin (SMD-2310): the template a plugin starts from. It reaches
// the brain's thoughts the only way a plugin may — through a core operation,
// as the caller (ctx.call) — and keeps tables of its own (ctx.db), made by
// its migrations in migrations/.

import { definePlugin, ok, operation, refuse, verifyTimestamped, z } from "../../server-portable/plugin-sdk.ts";

/** A note as both operations answer it. */
const Note = z.object({ id: z.string(), thought_id: z.string(), note: z.string(), written_by: z.string(), created_at: z.string() });
type NoteRow = { id: string; thought_id: string; note: string; written_by: string; created_at: Date | string };
const asNote = (r: NoteRow) => ({ ...r, created_at: new Date(r.created_at).toISOString() });
/** How far a delivery's timestamp may be from now, in seconds — and so how long its id is kept: twice it, after which a resend is refused as stale whatever its id. */
const TOLERANCE_S = 300;

export default definePlugin({
  name: "example",
  title: "Example plugin",
  description: "The plugin template: a read operation over the core, and notes pinned to thoughts in a table of its own. Copy the directory to start a plugin.",
  // The operator GUI's nav entry (SMD-2280 renders the page): a thought's notes.
  gui: { pages: [{ path: "/notes", label: "Notes" }] },
  // A capture source's inbound webhook, as a Slack or Telegram plugin's would
  // be: POST /hooks/example/capture with {"text": "…"}, and an "id" if the
  // sender names its deliveries. It is signed with the operator's secret over
  // the time and the body — x-example-timestamp, Unix seconds, and
  // x-example-signature, the hex HMAC-SHA256 of "<timestamp>.<body>" — so a
  // recorded delivery verifies for five minutes, not forever, and inside them
  // its id runs it once (SMD-2755).
  hooks: {
    capture: {
      description: "Captures the delivery's text as a thought of trust ingested, when it is signed with the secret OB1_HOOK_SECRETS gives the example within five minutes; a delivery whose id it has seen is answered with that thought and runs nothing.",
      async handler(ctx, request) {
        // Over the bytes sent; the REST core has refused already if no secret is set.
        const verdict = verifyTimestamped(request, ctx.secret, { signatureHeader: "x-example-signature", timestampHeader: "x-example-timestamp", toleranceSeconds: TOLERANCE_S });
        if (!verdict.ok) return { status: 401, body: { code: verdict.code, retryable: false } };
        let text: unknown;
        let id: unknown;
        try {
          ({ text, id } = JSON.parse(request.text) as { text?: unknown; id?: unknown });
        } catch {
          return { status: 400, body: { code: "NOT_JSON", retryable: false } };
        }
        if (typeof text !== "string" || !text.trim()) return { status: 400, body: { code: "NO_TEXT", retryable: false } };
        if (id !== undefined && (typeof id !== "string" || id.length < 1 || id.length > 200)) return { status: 400, body: { code: "BAD_ID", retryable: false } };
        const content = text;
        const capture = () => ctx.call("capture_thought", { content, source: "example-hook", trust: "ingested" });
        if (id === undefined) {
          const captured = await capture();
          if (!captured.ok) return { status: 422, body: { code: "CORE_REFUSED", retryable: false, refused: captured.refusal.code } };
          return { status: 202, body: { id: captured.value.id } };
        }
        // Claimed before the capture, in a transaction of its own: the claim
        // is not held across the model calls, which would hold one of the
        // plugin's two connections for as long. A resend waits for the first
        // claim to commit, then finds it — done, or still running.
        const claim = await ctx.db.tx(async (sql) => {
          await sql`DELETE FROM deliveries WHERE claimed_at < now() - ${2 * TOLERANCE_S} * interval '1 second'`;
          const [mine] = await sql<{ id: string }>`INSERT INTO deliveries (id) VALUES (${id}) ON CONFLICT (id) DO NOTHING RETURNING id`;
          if (mine) return { claimed: true as const };
          const [held] = await sql<{ thought_id: string | null }>`SELECT thought_id FROM deliveries WHERE id = ${id}`;
          return { claimed: false as const, thoughtId: held?.thought_id ?? null };
        });
        if (!claim.claimed) {
          return claim.thoughtId
            ? { status: 200, body: { id: claim.thoughtId, duplicate: true } }
            : { status: 409, body: { code: "IN_FLIGHT", retryable: true } };
        }
        // A capture that fails gives the claim back, so the sender's retry
        // runs; one that cannot be given back lapses with the prune.
        const release = () => ctx.db.tx((sql) => sql`DELETE FROM deliveries WHERE id = ${id} AND thought_id IS NULL`).catch(() => undefined);
        let captured;
        try {
          captured = await capture();
        } catch (err) {
          await release();
          throw err;
        }
        if (!captured.ok) {
          await release();
          return { status: 422, body: { code: "CORE_REFUSED", retryable: false, refused: captured.refusal.code } };
        }
        const thoughtId = captured.value.id;
        await ctx.db.tx((sql) => sql`UPDATE deliveries SET thought_id = ${thoughtId} WHERE id = ${id}`);
        return { status: 202, body: { id: thoughtId } };
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
