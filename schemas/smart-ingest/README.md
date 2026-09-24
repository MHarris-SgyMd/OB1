# Smart Ingest Pipeline Tables

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@alanshurafa](https://github.com/alanshurafa)**

> Adds pipeline tables for tracking bulk text ingestion through the extract, deduplicate, and execute lifecycle.

## What It Does

This schema adds two tables and one RPC function that together support a structured ingestion pipeline for Open Brain:

- **`ingestion_jobs`** -- Tracks each ingest invocation from submission through extraction, deduplication, and execution. Stores input hash for idempotency, status lifecycle, and per-action counters (added, skipped, appended, revised).
- **`ingestion_items`** -- Stores individual extracted thoughts within a job. Each item records the reconciliation action chosen during dedup (add, skip, append_evidence, create_revision), the reason for that choice, any matched existing thought, and the execution result.
- **`append_thought_evidence`** -- An RPC function that appends evidence entries to a thought's `metadata.evidence[]` array. Uses SHA256 identity hashing to prevent duplicate evidence, making it safe to call repeatedly.

## Prerequisites

- Working Open Brain setup (see the getting-started guide in `docs/01-getting-started.md`)
- Supabase project with the core `thoughts` table created (the SQL only reads and writes `thoughts.id` and `thoughts.metadata`, so no additional schema extensions are required)

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

```text
SMART INGEST -- CREDENTIAL TRACKER
-----------------------------------

SUPABASE (from your Open Brain setup)
  Project URL:           ____________
  Secret key:            ____________

-----------------------------------
```

## Steps

1. Apply `schema.sql` to your brain: `psql "$DATABASE_URL" -f schema.sql` (or paste it into your SQL console).
2. From `db/`, run `bun migrate.ts --url "$DATABASE_URL" --grant <role>` so the role your server connects as can use what the file creates — the file itself grants nothing (this fork, SMD-1796: upstream's `GRANT … TO service_role` lines and its row-level security are gone; `db/README.md`, "Grants for a capturing role", lists the `community` group).
3. Open **Table Editor** and confirm two new tables appear: `ingestion_jobs` and `ingestion_items`
4. Navigate to **Database > Functions** and verify the `append_thought_evidence` function exists
5. Test the function by running a quick validation query in the SQL Editor:

   ```sql
   SELECT count(*) FROM ingestion_jobs;
   -- Should return 0 for a fresh install
   ```

## Expected Outcome

After running the migration:

- Two new tables: `ingestion_jobs` (tracks job lifecycle with status, counters, and metadata) and `ingestion_items` (stores extracted thoughts with action codes, dedup reasons, and execution results). Both tables include a nullable `user_id uuid` column (upstream's foreign key into Supabase's `auth.users` is gone on this fork — SMD-1796).
- Three indexes: `ingestion_items_job_idx` on `ingestion_items(job_id)` for fast job-to-item lookups, plus partial indexes `idx_ingestion_jobs_pending` (jobs in `status = 'pending'`) and `idx_ingestion_items_pending` (items in `status IN ('pending','ready')`) to keep the worker's queue polling small.
- No row-level security in the file (this fork, SMD-1796): upstream enabled RLS on both tables with a `service_role ALL` policy and, on Supabase, an `authenticated SELECT` policy scoped to `user_id = auth.uid()`; neither role exists off Supabase, and RLS with no policy for the role you connect as denies it every row.
- One RPC function `append_thought_evidence(bigint, jsonb)` that idempotently appends evidence entries to a thought's metadata.
- The file grants nothing; `bun migrate.ts --grant <role>` gives the role your worker connects as both tables, their two sequences (an `INSERT` into a `bigserial` table needs `USAGE` on its sequence) and `EXECUTE` on `append_thought_evidence`, which stays `REVOKE`d `FROM PUBLIC` — it is `SECURITY DEFINER` and writes `thoughts.metadata`, so only a role granted it may call it (upstream granted Supabase's `service_role`; the companion Edge Function called it with that key).

## Job Claim Semantics

This schema intentionally does **not** ship a SQL-side `claim_next_ingestion_job()` RPC. Job claiming and item claiming live in the companion server under `integrations/smart-ingest/`, which reads and mutates `ingestion_jobs` / `ingestion_items` directly as the role its connection string names.

Any worker that claims a job or an item **must** use `FOR UPDATE SKIP LOCKED` semantics so two concurrent workers cannot grab the same row. The recommended pattern is a single `UPDATE ... RETURNING *` statement against a sub-select that does the locking:

```sql
UPDATE public.ingestion_jobs
   SET status = 'extracting'
 WHERE id = (
   SELECT id
     FROM public.ingestion_jobs
    WHERE status = 'pending'
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
 )
RETURNING *;
```

The same shape (with `status IN ('pending','ready')` and an appropriate next-state) applies to claiming the next item within a job. The partial indexes added by this migration (`idx_ingestion_jobs_pending`, `idx_ingestion_items_pending`) are designed for exactly this query.

If you are building a custom worker, do not replace `FOR UPDATE SKIP LOCKED` with a plain `SELECT`-then-`UPDATE` — that is a lost-update race under concurrency, and the whole ingest pipeline assumes at-most-one-worker-per-row semantics.

## Troubleshooting

**Issue: "relation already exists" warnings**
Solution: These are safe to ignore. The `CREATE TABLE IF NOT EXISTS` syntax prevents errors but may log informational notices. The migration is fully idempotent.

**Issue: append_thought_evidence raises "thought not found"**
Solution: The function requires a valid thought ID. Confirm the thought exists in the `thoughts` table before calling the function. This error means the referenced thought was deleted or the ID is incorrect.

**Issue: ingestion_items not linked to a job**
Solution: Items require a valid `job_id` foreign key referencing `ingestion_jobs`. Create the job first, then insert items with the returned job ID. The foreign key uses `ON DELETE CASCADE`, so deleting a job automatically removes its items.

**Issue: duplicate input_hash error on ingestion_jobs insert**
Solution: The `input_hash` column has a `UNIQUE` constraint to prevent processing the same text twice. If you need to reprocess the same input, delete the existing job first or use a different hash (e.g., by appending a timestamp to the input before hashing).
