# Enhanced Thoughts Columns and Utility RPCs

<div align="center">

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@alanshurafa](https://github.com/alanshurafa)**

</div>

> Adds structured columns and utility functions to the Open Brain thoughts table for richer classification, full-text search, statistics, and connection discovery.

## What It Does

This schema extension adds six new columns to the `thoughts` table (`type`, `sensitivity_tier`, `importance`, `quality_score`, `source_type`, `enriched`) so thoughts can be classified, filtered, and ranked without parsing the metadata JSONB every time. It also installs four RPC functions:

- **`search_thoughts_text`** -- Full-text search with boolean operators, ILIKE fallback, pagination, and result counts.
- **`brain_stats_aggregate`** -- Returns total thought count, top types, and top topics as a single JSONB payload.
- **`get_thought_connections`** -- Finds thoughts that share metadata topics or people with a given thought.
- **`backfill_thought_types(p_allowed_types TEXT[])`** -- Populates the new top-level `type` column from `metadata->>'type'`. The default allowlist covers the canonical eight values (`idea`, `task`, `person_note`, `reference`, `decision`, `lesson`, `meeting`, `journal`). Pass a custom array to accept additional values, or pass `NULL` to backfill whatever `metadata->>'type'` contains.

> **This fork (SMD-1250):** upstream's `schema.sql` ended with a section that redefined `upsert_thought(text, jsonb)` so these columns were mirrored on every write. On a brain built by `db/migrate.ts` that statement replaces the body migration 005 installed, silently, so it is removed here: the columns are filled by `backfill_thought_types()` and the `UPDATE` in the script, and a capture does not update them. Two more things on a migrated brain: the script's backfill moves `updated_at` on every row with a `type` or `source` in its metadata, which on this fork gates the accepted-vector caveat and the edited-since rules — run it between re-embed passes; and its `GRANT`s to Supabase's roles are gone too (SMD-1796) — they failed on plain Postgres (`role "authenticated" does not exist`), and execute is `PUBLIC`'s by default. `scripts/check-fork-consistency.ts` check 7 keeps the upsert out, check 12 the grants.

## Prerequisites

- Working Open Brain setup (see the getting-started guide in `docs/01-getting-started.md`)
- Supabase project with the `thoughts` table, `match_thoughts` function, and `upsert_thought` function already created

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

```text
ENHANCED THOUGHTS -- CREDENTIAL TRACKER
--------------------------------------

SUPABASE (from your Open Brain setup)
  Project URL:           ____________
  Secret key:            ____________

--------------------------------------
```

## Steps

1. Apply `schema.sql` to your brain: `psql "$DATABASE_URL" -f schema.sql` (or paste it into your SQL console).
2. Nothing to grant (this fork, SMD-1796): the file adds columns to `thoughts` and four functions executable by any role by default — the two `SECURITY DEFINER` ones read `thoughts` as their owner, see Security below (upstream's `GRANT EXECUTE … TO authenticated, service_role` lines are gone — those roles do not exist off Supabase, and execute is `PUBLIC`'s by default).
3. Open **Table Editor** and select the `thoughts` table to confirm the new columns appear: `type`, `sensitivity_tier`, `importance`, `quality_score`, `source_type`, `enriched`
4. Navigate to **Database > Functions** and verify the new functions exist: `search_thoughts_text`, `brain_stats_aggregate`, `get_thought_connections`, `backfill_thought_types`
5. If you have existing thoughts with `type` or `source` values stored in the metadata JSONB, the script automatically calls `backfill_thought_types()` with the default canonical allowlist. If your brain uses non-canonical `type` values, re-run `SELECT backfill_thought_types(ARRAY['your','custom','types']);` or `SELECT backfill_thought_types(NULL);` to accept any value

## Expected Outcome

After running the migration:

- The `thoughts` table has six new columns with sensible defaults:
  - `sensitivity_tier TEXT DEFAULT 'standard'` (canonical values: `'standard'`, `'personal'`, `'restricted'`)
  - `importance SMALLINT DEFAULT 3` (scale: 1-5, where 3 is the default)
  - `quality_score NUMERIC(5,2) DEFAULT 50` (scale: 0-100, where 50 is the default)
  - `enriched BOOLEAN DEFAULT false`
  - `type TEXT` (nullable; populated by backfill or writers)
  - `source_type TEXT` (nullable; populated by backfill or writers)
- New indexes on `type`, `importance`, `source_type`, and a GIN tsvector index on `content` for fast full-text search.
- Four new RPC functions callable via the Supabase client or REST API (`search_thoughts_text`, `brain_stats_aggregate`, `get_thought_connections`, `backfill_thought_types`).
- Any existing thoughts with `type` or `source` in their metadata JSONB will have those values copied into the new top-level columns (via `backfill_thought_types()` for `type` with the canonical allowlist, plus an inline `UPDATE` for `source_type`).

## Security

Upstream's file followed stock Open Brain's "service_role only" posture; on this fork its grants are gone (SMD-1796) and what remains is:

- `brain_stats_aggregate` and `get_thought_connections` are `SECURITY DEFINER` with `SET search_path = public` (defense in depth against search-path hijacks). They can read the full `thoughts` table regardless of RLS.
- `search_thoughts_text` is `SECURITY INVOKER` and respects RLS.
- **No grant to any Supabase role.** Upstream limited execute to `authenticated` and `service_role`; those roles do not exist off Supabase, so the file no longer grants, and execute is `PUBLIC`'s by default — on a single-operator brain (SMD-1716), the roles you created. The two `SECURITY DEFINER` RPCs therefore read the whole `thoughts` table for any role that can connect, as they did upstream (its grants never revoked `PUBLIC`); if that is not your trust boundary, `REVOKE EXECUTE … FROM PUBLIC` and grant the roles you mean.

If you want to expose any of these to `anon` (for example, a public-read dashboard), add your own `GRANT EXECUTE ... TO anon;` in a follow-up migration and confirm that `p_exclude_restricted := true` (the default) plus your sensitivity-tier hygiene gives you the exposure surface you actually want. This is an explicit opt-in: the default stance is private.

## Troubleshooting

**Issue: "column already exists" warnings**
Solution: These are safe to ignore. The `ADD COLUMN IF NOT EXISTS` syntax prevents errors but may log informational notices.

**Issue: search_thoughts_text returns no results**
Solution: Confirm your thoughts have content populated. Try a simple query first (single word, no operators). If using boolean operators, ensure the syntax matches websearch format ("quoted phrases", word AND word, -excluded).

**Issue: brain_stats_aggregate returns empty types or topics**
Solution: The function filters by `created_at`. Pass `p_since_days := 0` for all-time stats. Also confirm that your thoughts have the `type` column populated. If you use non-canonical type values in `metadata->>'type'` (anything outside `idea`, `task`, `person_note`, `reference`, `decision`, `lesson`, `meeting`, `journal`), call the backfill RPC with your own allowlist, e.g. `SELECT backfill_thought_types(ARRAY['idea','task','article','quote']);`, or `SELECT backfill_thought_types(NULL);` to accept whatever is present.
