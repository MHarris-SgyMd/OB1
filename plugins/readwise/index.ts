// Readwise (SMD-2690): Readwise's highlight webhook as a plugin's hook, ported
// from integrations/readwise-capture's standalone server. Readwise signs nothing
// and sends no time: it echoes the webhook's secret in the body, so the secret
// is a bearer secret (README), compared here digest to digest. Each highlight is
// captured once, by its id (onceById, kept for good), through the core as the
// hook's capture-only caller; what Readwise sent beside the text is kept in the
// plugin's highlights table, which list_highlights reads.

import { definePlugin, hmacSha256Hex, ok, onceById, operation, safeEqual, z } from "../../server-portable/plugin-sdk.ts";

/** The one event the hook captures; any other Readwise sends is answered 200 and ignored. */
const HIGHLIGHT_CREATED = "readwise.highlight.created";

/** A text Postgres stores: no NUL. */
const stored = (s: string) => !s.includes("\u0000");
/** A time Readwise sent, read by Date.parse; Postgres takes the ISO form it is stored as. */
const when = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not a time");

/** A highlight-created event's fields the hook reads; anything else Readwise sends is left. */
const HighlightEvent = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  text: z.string().refine((s) => s.trim().length > 0, "no text").refine(stored, "a NUL character"),
  note: z.string().refine(stored, "a NUL character").nullish(),
  location: z.number().nullish(),
  location_type: z.string().refine(stored, "a NUL character").nullish(),
  highlighted_at: when.nullish(),
  url: z.string().refine(stored, "a NUL character").nullish(),
  color: z.string().refine(stored, "a NUL character").nullish(),
  updated: when.nullish(),
  book_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tags: z.array(z.object({ name: z.string().refine(stored, "a NUL character") })).nullish(),
});
type HighlightEvent = z.output<typeof HighlightEvent>;

/** The secret as compared: a digest of fixed length, so the compare's time says nothing of either's length. */
const digest = (s: string) => hmacSha256Hex("readwise-webhook-secret", s);

/** A highlight as list_highlights answers it. */
const Highlight = z.object({
  highlight_id: z.number().int(),
  thought_id: z.string(),
  book_id: z.number().int(),
  note: z.string().nullable(),
  location: z.number().nullable(),
  location_type: z.string().nullable(),
  color: z.string().nullable(),
  url: z.string().nullable(),
  tags: z.array(z.string()),
  highlighted_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  captured_at: z.string(),
});
type HighlightRow = {
  highlight_id: number; thought_id: string; book_id: number; note: string | null; location: number | null; location_type: string | null;
  color: string | null; url: string | null; tags: string[]; highlighted_at: Date | null; updated_at: Date | null; captured_at: Date;
};
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
const asHighlight = (r: HighlightRow) => ({ ...r, highlighted_at: iso(r.highlighted_at), updated_at: iso(r.updated_at), captured_at: iso(r.captured_at)! });

/** A highlight's thought text: the passage, and the reader's note after it as the old server wrote it. */
const contentOf = (e: HighlightEvent) => (e.note ? `${e.text}\n\n— ${e.note}` : e.text);

export default definePlugin({
  name: "readwise",
  title: "Readwise",
  description: "Readwise's highlights as thoughts: a webhook Readwise posts each new highlight to, captured once by its id as outside text, and the highlights it captured, by book.",
  hooks: {
    highlight: {
      description: "Captures a readwise.highlight.created event's passage (and its note) as a thought of trust ingested, when the body carries the secret OB1_HOOK_SECRETS gives readwise; a highlight whose id it has captured is answered with that thought and runs nothing. An empty body (Readwise's Test Endpoint) and any other event are answered 200 and change nothing.",
      async handler(ctx, request) {
        // Readwise's Test Endpoint posts nothing; webhook creation waits on its 2xx. Nothing is read or written.
        if (request.text.trim() === "") return { status: 200, body: { test: true } };
        let body: unknown;
        try {
          body = JSON.parse(request.text);
        } catch {
          return { status: 400, body: { code: "NOT_JSON", retryable: false } };
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { code: "NOT_JSON", retryable: false } };
        const { secret, event_type } = body as { secret?: unknown; event_type?: unknown };
        if (typeof secret !== "string" || !safeEqual(digest(secret), digest(ctx.secret))) return { status: 401, body: { code: "BAD_SECRET", retryable: false } };
        if (event_type !== HIGHLIGHT_CREATED) return { status: 200, body: { ignored: true } };
        const parsed = HighlightEvent.safeParse(body);
        if (!parsed.success) {
          return { status: 400, body: { code: "BAD_HIGHLIGHT", retryable: false, fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))] } };
        }
        const e = parsed.data;
        const once = await onceById(ctx, String(e.id), async () => {
          // Two metadata keys tie the thought back; the rest of what Readwise sent is the highlights row's.
          const captured = await ctx.call("capture_thought", {
            content: contentOf(e),
            source: "readwise",
            trust: "ingested",
            metadata: { readwise_highlight_id: e.id, readwise_book_id: e.book_id },
          });
          // A refusal hands back no thought: the id is given back, so a resend captures.
          const thoughtId = captured.ok ? captured.value.id : null;
          const tags = (e.tags ?? []).map((t) => t.name);
          // Before onceById records the id: a row that fails to write throws, the id is given back, and a resend captures again (the same text: the same thought).
          if (thoughtId !== null) await ctx.db.tx((sql) => sql`
            INSERT INTO highlights (highlight_id, thought_id, book_id, note, location, location_type, color, url, tags, highlighted_at, updated_at)
            VALUES (${e.id}, ${thoughtId}, ${e.book_id}, ${e.note || null}, ${e.location ?? null}, ${e.location_type || null}, ${e.color || null}, ${e.url || null},
                    (SELECT coalesce(array_agg(t ORDER BY n), '{}') FROM jsonb_array_elements_text((${JSON.stringify(tags)}::text)::jsonb) WITH ORDINALITY AS x(t, n)),
                    ${e.highlighted_at ? new Date(e.highlighted_at).toISOString() : null}::timestamptz, ${e.updated ? new Date(e.updated).toISOString() : null}::timestamptz)
            ON CONFLICT (highlight_id) DO UPDATE SET thought_id = excluded.thought_id, book_id = excluded.book_id, note = excluded.note, location = excluded.location,
              location_type = excluded.location_type, color = excluded.color, url = excluded.url, tags = excluded.tags, highlighted_at = excluded.highlighted_at,
              updated_at = excluded.updated_at`);
          return { value: captured, thoughtId };
        }, { keepSeconds: Infinity });
        if ("duplicate" in once) return { status: 200, body: { id: once.duplicate, duplicate: true } };
        if ("inFlight" in once) return { status: 409, body: { code: "IN_FLIGHT", retryable: true } };
        const captured = once.ran;
        // The core's refusal: one it says is worth retrying is a 503 Readwise may send again.
        if (!captured.ok) return { status: captured.refusal.retryable ? 503 : 422, body: { code: "CORE_REFUSED", retryable: captured.refusal.retryable, refused: captured.refusal.code } };
        return { status: 200, body: { id: captured.value.id } };
      },
    },
  },
  operations: {
    list_highlights: operation({
      title: "Readwise highlights",
      description: "The highlights the Readwise webhook captured, newest highlighted first (those with no highlight time last): each one's thought id (fetch reads its text), Readwise's book id, and the note, location, colour, url and tags Readwise sent. book_id narrows to one book. truncated says there are more than limit.",
      scope: "read",
      // It reads the plugin's own table alone.
      annotations: { openWorldHint: false },
      method: "GET",
      path: "/highlights",
      input: {
        book_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().describe("Readwise's book id, to list one book's highlights"),
        limit: z.number().int().min(1).max(200).default(50).describe("How many, 1 to 200"),
      },
      output: { highlights: z.array(Highlight), truncated: z.boolean() },
      async handler(ctx, { book_id, limit }) {
        const rows = await ctx.db.tx((sql) => sql<HighlightRow>`
          SELECT highlight_id::float8 AS highlight_id, thought_id::text AS thought_id, book_id::float8 AS book_id, note, location, location_type, color, url, tags,
                 highlighted_at, updated_at, captured_at
            FROM highlights
           WHERE ${book_id ?? null}::bigint IS NULL OR book_id = ${book_id ?? null}::bigint
           ORDER BY highlighted_at DESC NULLS LAST, highlight_id DESC
           LIMIT ${limit + 1}`);
        return ok({ highlights: rows.slice(0, limit).map(asHighlight), truncated: rows.length > limit });
      },
    }),
  },
});
