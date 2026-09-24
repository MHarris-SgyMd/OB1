# Entity Extraction Schema

> Tables, trigger, and queue for **automatic** entity and relationship extraction from thoughts. Complements the community [`recipes/ob-graph/`](../../recipes/ob-graph/) manual graph layer — this is the extraction side.

## Positioning

`ob-graph` gives you a clean 2-table manual graph (`graph_nodes`, `graph_edges`) that you build up via MCP calls. It's the right choice if you want to sketch relationships by hand.

`entity-extraction` is the other half of the story: automatic extraction from the `thoughts` content you already have. It adds a typed entity table, an edges table with evidence + confidence, a queue for async processing, and a trigger that enqueues new thoughts for you. Pair it with the companion `integrations/entity-extraction-worker/` edge function (opens in a separate PR) to actually run the extraction.

The two schemas are independent — you can install either, both, or neither. They don't share tables or functions.

## What It Does

- **`entities`** — Canonical nodes: people, projects, topics, tools, organizations, places. Deduplicates by normalized name within each type.
- **`edges`** — Typed relationships (`co_occurs_with`, `works_on`, `uses`, `related_to`, `member_of`, `located_in`) with support counts and confidence scores.
- **`thought_entities`** — Evidence-bearing links: which thought mentions which entity, in what role, with what extraction confidence, from which source.
- **`entity_extraction_queue`** — Async work queue. Tracks attempt counts, errors, and content fingerprints so the worker can skip no-op updates.
- **`consolidation_log`** — Audit trail for dedup merges, metadata fixes, and bio synthesis.
- A trigger on `thoughts` enqueues new/updated rows automatically, skipping system-generated artifacts and fingerprint no-ops.

## Prerequisites

- Working Open Brain setup (see [`docs/01-getting-started.md`](../../docs/01-getting-started.md))
- A Postgres with the `thoughts` table, `match_thoughts` and `upsert_thought` — the fork's stack, or a Supabase project
- The `content_fingerprint` column on `thoughts` (`db/migrations/003`, applied by the core setup)
- **Optional but recommended:** [`schemas/enhanced-thoughts/`](../enhanced-thoughts/) for the `type` / `sensitivity_tier` / `source_type` columns the extraction worker uses for gating

## Credential Tracker

```text
ENTITY EXTRACTION -- CREDENTIAL TRACKER
--------------------------------------

SUPABASE (from your Open Brain setup)
  Project URL:           ____________
  Secret key:            ____________

--------------------------------------
```

## Steps

1. Apply `schema.sql` to your brain: `psql "$DATABASE_URL" -f schema.sql` (or paste it into your SQL console).
2. From `db/`, run `bun migrate.ts --url "$DATABASE_URL" --grant <role>` so the role your server connects as can use what the file creates — the file itself grants nothing (this fork, SMD-1796: upstream's `GRANT … TO service_role` lines and its row-level security are gone; `db/README.md`, "Grants for a capturing role", lists the `community` group).
3. Open **Table Editor** and confirm five new tables appear: `entities`, `edges`, `thought_entities`, `entity_extraction_queue`, `consolidation_log`
4. Navigate to **Database > Functions** and verify the `queue_entity_extraction` function exists
5. Navigate to **Database > Triggers** on the `thoughts` table and verify `trg_queue_entity_extraction` is attached
6. Test the trigger by capturing a new thought (via the MCP server or direct insert) and checking the queue:

   ```sql
   SELECT count(*) FROM entity_extraction_queue WHERE status = 'pending';
   -- Should return at least 1 after capturing a thought
   ```

7. *(Optional — existing brains only)* To backfill the extraction queue with pre-existing thoughts, uncomment and run the backfill section at the bottom of `schema.sql`
8. Install the companion [`integrations/entity-extraction-worker/`](../../integrations/entity-extraction-worker/) edge function to actually process the queue (separate PR)

## Expected Outcome

After running the migration:

- Five new tables with appropriate columns, constraints, and defaults.
- Eight indexes for efficient querying: entity type and normalized name lookups, edge traversal by source/target/relation, thought-entity joins, and a partial index on pending queue items.
- One trigger function (`queue_entity_extraction`) that automatically enqueues thoughts for extraction on insert or content/metadata change, with guards for system-generated artifacts and no-op fingerprint changes.
- One trigger (`trg_queue_entity_extraction`) attached to the `thoughts` table firing after insert or update of content/metadata.
- No row-level security and no grants in the file (this fork, SMD-1796): upstream enabled RLS on all five tables with a full-access policy for Supabase's `service_role` and a `SELECT` scaffold for `authenticated`, roles that do not exist off Supabase, and RLS with no policy for the role you connect as denies it every row. `bun migrate.ts --grant <role>` gives the role your server and workers connect as the five tables and their three sequences (the `community` group in `db/README.md`). Upstream's posture, for the record: `service_role` bypasses RLS (used by the MCP server and workers via the service-role key server-side) and has a full-access policy. `authenticated` has a minimum `SELECT`-only policy as a scaffold for future multi-tenant dashboards -- when per-user ownership is wired, tighten to `auth.uid() = user_id`. `anon` has no access: stock Open Brain's MCP path is an Edge Function using the service-role key, not the anon key, so no anon grant is needed.
- New thoughts are automatically queued for entity extraction. Pre-existing thoughts require the optional backfill step.

## How This Differs From `ob-graph`

| Aspect | `recipes/ob-graph/` | `schemas/entity-extraction/` (this PR) |
|---|---|---|
| Build mode | Manual via MCP calls | Automatic extraction from thought content |
| Tables | 2 (`graph_nodes`, `graph_edges`) | 5 (`entities`, `edges`, `thought_entities`, `entity_extraction_queue`, `consolidation_log`) |
| Primary use | Sketch entities by hand, query graph paths | Turn accumulated thoughts into a queryable entity index |
| Paired with | 10 MCP tools for building/querying | `integrations/entity-extraction-worker/` + `graph_search` in enhanced-mcp |

Install whichever matches your workflow. They don't conflict.

## Pruning and Retention

`entity_extraction_queue` and `consolidation_log` are both unbounded by default -- neither has a TTL and both grow with the size of the brain. For a personal install this is usually fine for years. For brains with hundreds of thousands of thoughts, or as a matter of hygiene, operators may want to prune terminal-state queue rows and archive old consolidation records periodically.

We deliberately do not ship automatic pruning. Retention is an operator choice: you know your audit requirements better than the schema does.

**Queue pruning** -- `entity_extraction_queue` keeps one row per thought for the thought's lifetime. Rows in terminal states (`complete`, `skipped`, `failed`) are safe to delete; the trigger will re-queue the thought if it's later edited. Example: drop terminal-state rows older than 30 days.

```sql
DELETE FROM public.entity_extraction_queue
WHERE status IN ('complete', 'skipped', 'failed')
  AND processed_at < now() - interval '30 days';
```

**Consolidation log** -- `consolidation_log` is an append-only audit trail. It has no TTL by design. Typical operators either (a) archive and truncate yearly, or (b) prune rows beyond a retention window. Example: drop log rows older than 90 days.

```sql
DELETE FROM public.consolidation_log
WHERE created_at < now() - interval '90 days';
```

Wire either of these into a scheduled Edge Function or a `pg_cron` job if you want them to run automatically. For most personal brains, running them ad hoc when the tables get large is sufficient.

## Troubleshooting

**Issue: "relation already exists" warnings**
Solution: These are safe to ignore. The `CREATE TABLE IF NOT EXISTS` syntax prevents errors but may log informational notices. The migration is fully idempotent.

**Issue: trigger not firing on new thoughts**
Solution: The trigger fires `AFTER INSERT OR UPDATE OF content, metadata` on the `thoughts` table. Confirm the trigger exists by querying `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.thoughts'::regclass;`. If missing, re-run the trigger section of the migration.

**Issue: queue not populating for existing thoughts**
Solution: The trigger only fires on new inserts or updates. For pre-existing thoughts, run the optional backfill query at the bottom of `schema.sql`. This safely inserts with `ON CONFLICT DO NOTHING`.

**Issue: "column content_fingerprint does not exist" error in trigger**
Solution: The trigger function reads `NEW.content_fingerprint` from the thoughts table. This column is `db/migrations/003`'s, applied by the core setup. If missing, run the core migrations (`bun db/migrate.ts`) first, then re-run this migration.

**Issue: entities table has duplicate entries**
Solution: The `UNIQUE (entity_type, normalized_name)` constraint prevents exact duplicates. If you see near-duplicates (e.g., "JavaScript" and "javascript"), these have different canonical names but the same normalized name should be caught. The extraction worker is responsible for consistent normalization.
