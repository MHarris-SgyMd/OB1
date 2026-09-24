# Readwise Books Cache

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@mlava](https://github.com/mlava)**

> Side-table cache of Readwise book-level metadata so highlights stored in `thoughts` can reference a `book_id` without denormalising title and author into every highlight row.

## What It Does

This schema extension creates a single new table, `readwise_books`, keyed by Readwise's `user_book_id`, plus two RPC functions:

- **`get_book_highlights(p_book_id, p_limit)`** — Returns all highlights for a book from the `thoughts` table, ordered by in-source location so you can re-read them the way you originally encountered them.
- **`increment_book_highlight_count(p_book_id, p_highlighted_at)`** — Bumps `num_highlights` and refreshes `last_highlight_at` on the book row. Called by the readwise-capture server on each new highlight insert to avoid running `COUNT(*)` against the `thoughts` table.

The table stays small (one row per book, typically a few hundred rows per user), so it's primarily a convenience cache for cover images, category, and source attribution that would otherwise need to be fetched from the Readwise API on every UI render.

This schema is required by:

- [integrations/readwise-capture](../../integrations/readwise-capture/) — webhook receiver for live highlight capture
- [recipes/readwise-import](../../recipes/readwise-import/) — one-shot backfill of your Readwise history

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- A Postgres with the `thoughts` table already created (from the core setup) — the fork's stack, or a Supabase project
- Recommended: [enhanced-thoughts](../enhanced-thoughts/) schema applied first — `get_book_highlights` filters on `source_type = 'readwise'`, which is a top-level column added by that extension. Without it, the RPC will not return rows.

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

```text
READWISE BOOKS -- CREDENTIAL TRACKER
--------------------------------------

SUPABASE (from your Open Brain setup)
  Project URL:           ____________
  Secret key:            ____________

--------------------------------------
```

## Steps

1. Apply `schema.sql` to your brain: `psql "$DATABASE_URL" -f schema.sql` (or paste it into your SQL console).
2. From `db/`, run `bun migrate.ts --url "$DATABASE_URL" --grant <role>` so the role your server connects as can use what the file creates — the file itself grants nothing (this fork, SMD-1796: upstream's `GRANT … TO service_role` lines and its row-level security are gone; `db/README.md`, "Grants for a capturing role", lists the `community` group).
3. Open **Table Editor** and confirm the `readwise_books` table appears with the expected columns
4. Navigate to **Database > Functions** and verify two new functions exist: `get_book_highlights`, `increment_book_highlight_count`

## Expected Outcome

After running the migration:

- A new `readwise_books` table with `book_id` as the primary key and indexes on `title`, `author`, and `category`.
- Two new RPC functions callable via the Supabase client or REST API.
- No impact on the existing `thoughts` table. Highlights you import later will live in `thoughts` with `source_type = 'readwise'` and `metadata.readwise_book_id` pointing into this table.

Once the schema is in place, you can install either the backfill recipe, the webhook integration, or both.

## Troubleshooting

**Issue: "relation thoughts does not exist"**
Solution: Run the core Open Brain setup first — the `get_book_highlights` function references the `thoughts` table. Follow [docs/01-getting-started.md](../../docs/01-getting-started.md) through Step 4, which applies the core migrations.

**Issue: `get_book_highlights` returns no rows after importing highlights**
Solution: The function filters on `source_type = 'readwise'` (a column added by the [enhanced-thoughts](../enhanced-thoughts/) schema). If you skipped that schema, your highlights will be in `thoughts` but without the top-level `source_type` column set. Either install `enhanced-thoughts` and run its backfill, or modify your import to set `source_type` explicitly.

**Issue: `increment_book_highlight_count` runs but counts stay at 0**
Solution: Confirm the book row exists in `readwise_books` before the first highlight arrives. The readwise-capture server handles this automatically via a write-through cache lookup; if you're calling the RPC manually, you'll need to `INSERT` the book row first.
