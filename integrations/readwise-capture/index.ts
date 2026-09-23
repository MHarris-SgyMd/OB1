// MIGRATED OFF SUPABASE: imports compat/supabase-sql instead of @supabase/supabase-js.
// Same API, but it speaks SQL directly. The environment variable NAMES are
// unchanged — set SUPABASE_URL to a postgres:// connection string, and
// SUPABASE_SERVICE_ROLE_KEY is ignored (credentials live in the URL).
// ob1-original-import: https://esm.sh/@supabase/supabase-js@2
// Revert with: bun scripts/migrate-to-sql-shim.ts --revert <file>
// ob1-fork (SMD-1524): a captured thought — content and vector — is written through
// the 3-argument upsert_thought, which writes the content fingerprint (003), the
// vector's model label (021) in the same statement; a raw insert left both NULL, and
// 016's trigger fills neither. No audit actor is named: the receiver holds a shared
// secret, not a key, and 008 keeps a NULL actor for a write without one. The enhanced-thoughts
// columns the function does not know follow by an update carrying neither content nor
// vector, where they are NULL — a fresh row's, or a half-shaped row's on re-capture. FORK.md
// change 71; extensions/test-writes.ts drives it
// against Postgres, and scripts/check-fork-consistency.ts check 10 holds it.
// ob1-fork (SMD-1455): the webhook secret Readwise echoes is compared timing-safe,
// digest to digest, through ../_shared/auth.ts — the core server's
// server-portable/auth.ts, copied so Supabase bundles it with the function.
// FORK.md change 67; extensions/test-auth.ts exercises it.
// readwise-capture / index.ts
//
// Supabase Edge Function that receives Readwise highlight webhooks,
// embeds the highlight text, and inserts it into the `thoughts` table
// with source_type='readwise'. Uses a write-through cache in the
// `readwise_books` table so highlights can carry book title/author
// without one Readwise API call per highlight.

import { createClient } from "../../compat/supabase-sql/index.ts";
import { secretMatches } from "../_shared/auth.ts";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const READWISE_ACCESS_TOKEN = process.env.READWISE_ACCESS_TOKEN!;
const READWISE_WEBHOOK_SECRET = process.env.READWISE_WEBHOOK_SECRET!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
// The label written beside every vector (021): the model as OB1_EMBEDDING_MODEL spells it.
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const READWISE_BASE = "https://readwise.io/api/v2";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

interface HighlightEvent {
  id: number;
  text: string;
  note: string;
  location: number | null;
  location_type: string;
  highlighted_at: string | null;
  url: string | null;
  color: string;
  updated: string;
  book_id: number;
  tags: Array<{ id: number; name: string }>;
  event_type: string;
  secret: string;
}

interface ReadwiseBook {
  id: number;
  title: string;
  author: string | null;
  category: string;
  source: string | null;
  source_url: string | null;
  cover_image_url: string | null;
  num_highlights: number;
  last_highlight_at: string | null;
  tags: Array<{ id: number; name: string }>;
}

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  const d = await r.json();
  return d.data[0].embedding;
}

async function fetchBook(bookId: number): Promise<ReadwiseBook | null> {
  const r = await fetch(`${READWISE_BASE}/books/${bookId}/`, {
    headers: { "Authorization": `Token ${READWISE_ACCESS_TOKEN}` },
  });
  if (!r.ok) {
    console.error(`Readwise book fetch failed (${bookId}): ${r.status}`);
    return null;
  }
  return await r.json();
}

async function resolveBook(bookId: number): Promise<ReadwiseBook | null> {
  const { data: cached } = await supabase
    .from("readwise_books")
    .select("book_id, title, author, category, source")
    .eq("book_id", bookId)
    .maybeSingle();

  if (cached) {
    return {
      id: cached.book_id,
      title: cached.title,
      author: cached.author,
      category: cached.category,
      source: cached.source,
      source_url: null,
      cover_image_url: null,
      num_highlights: 0,
      last_highlight_at: null,
      tags: [],
    };
  }

  const book = await fetchBook(bookId);
  if (!book) return null;

  await supabase.from("readwise_books").upsert({
    book_id: book.id,
    title: book.title,
    author: book.author,
    category: book.category,
    source: book.source,
    source_url: book.source_url,
    cover_image_url: book.cover_image_url,
    num_highlights: book.num_highlights,
    last_highlight_at: book.last_highlight_at,
    tags: book.tags ?? [],
    updated_at: new Date().toISOString(),
  });

  return book;
}

const handler = async (req: Request): Promise<Response> => {
  try {
    // Readwise's "Test Webhook" button hits the URL with an empty body
    // (and some infra health checks probe with GET). Respond 200 so the
    // webhook setup flow can pass without us pretending to process
    // missing data.
    if (req.method === "GET") {
      return new Response("readwise-capture is live", { status: 200 });
    }

    const bodyText = await req.text();
    // Deliberate no-op: Readwise's "Test Webhook" sends an empty body during
    // setup, so return 200 without processing. The secret check below gates
    // every side effect, so this short-circuit can't be abused.
    if (!bodyText) {
      return new Response("ok (empty body)", { status: 200 });
    }

    let body: any;
    try {
      body = JSON.parse(bodyText);
    } catch {
      console.error("Invalid JSON body:", bodyText.slice(0, 500));
      return new Response("invalid json", { status: 400 });
    }

    // Readwise echoes the webhook secret in the payload; reject anything that
    // does not match the configured value — compared timing-safe, digest to
    // digest, so the response time says nothing about the secret.
    if (!secretMatches(body.secret, READWISE_WEBHOOK_SECRET)) {
      return new Response("unauthorized", { status: 401 });
    }

    // This function only handles highlight-created events. Any other
    // event type (Reader document events, tag updates, etc.) is ignored
    // so subscribing to more events on the Readwise side won't break us.
    if (body.event_type !== "readwise.highlight.created") {
      return new Response("ignored", { status: 200 });
    }

    const event = body as HighlightEvent;

    // Deduplicate: if Readwise retries the webhook we mustn't create
    // two thoughts. Filter on source_type first so the query uses the
    // idx_thoughts_source_type index from enhanced-thoughts.
    const { data: existing } = await supabase
      .from("thoughts")
      .select("id")
      .eq("source_type", "readwise")
      .contains("metadata", { readwise_highlight_id: event.id })
      .limit(1);
    if (existing && existing.length > 0) {
      return new Response("duplicate", { status: 200 });
    }

    const book = await resolveBook(event.book_id);

    const noteSuffix = event.note ? `\n\n— ${event.note}` : "";
    const content = `${event.text}${noteSuffix}`;
    const embedding = await getEmbedding(content);

    // The row through the 3-argument upsert_thought (db/migrations/033): the
    // text, its fingerprint, the vector and the vector's label in one statement.
    // The raw insert this replaced left the fingerprint and the label NULL — the
    // row invisible to dedup until 023's backfill, its vector of unknown model to
    // the re-embed pass. A text the brain already holds comes back `existed`:
    // metadata merged (this highlight's id over the earlier one's), vector
    // replaced. No actor is named: this receiver holds a shared secret, not a
    // key, and 008 keeps a NULL actor for a write without one.
    const { data, error } = await supabase.rpc("upsert_thought", {
      p_content: content,
      p_payload: {
        metadata: {
          source: "readwise",
          readwise_highlight_id: event.id,
          readwise_book_id: event.book_id,
          book_title: book?.title ?? null,
          book_author: book?.author ?? null,
          book_category: book?.category ?? null,
          highlighted_at: event.highlighted_at,
          note: event.note,
          location: event.location,
          location_type: event.location_type,
          color: event.color,
          url: event.url,
          tags: event.tags?.map((t) => t.name) ?? [],
        },
        embedding_model: EMBEDDING_MODEL,
      },
      p_embedding: embedding,
    });

    if (error) {
      console.error("upsert_thought error:", error);
      return new Response("error", { status: 500 });
    }
    const result = (data ?? {}) as { id?: string; existed?: boolean };

    // The enhanced-thoughts columns the function does not know, by raw updates
    // that carry neither content nor vector, so nothing they write goes stale —
    // each column WHERE it IS NULL: a fresh row takes both; a row whose first
    // write was interrupted between the function and these updates (a crash, a
    // 500 and Readwise's retry) takes them on the re-capture, which the dedupe
    // above cannot see (it filters on source_type) and the function answers
    // `existed`; a column already set is left as it is — a hand-set type on a
    // row another path captured first keeps it while source_type is filled, so
    // the dedupe sees the row from now on (the third review pass).
    if (result.id) {
      for (const [column, value] of [["source_type", "readwise"], ["type", "reference"]] as const) {
        const { error: sidecarError } = await supabase
          .from("thoughts")
          .update({ [column]: value })
          .eq("id", result.id)
          .is(column, null);
        if (sidecarError) {
          console.error("Supabase update error:", sidecarError);
          return new Response("error", { status: 500 });
        }
      }
    }

    // The book's counter counts highlights, as Readwise does — an `existed` row is still one.
    if (book) {
      await supabase.rpc("increment_book_highlight_count", {
        p_book_id: event.book_id,
        p_highlighted_at: event.highlighted_at,
      });
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("Function error:", err);
    return new Response("error", { status: 500 });
  }
};

export default {
  port: Number(process.env.PORT ?? 8000),
  fetch: handler,
};
