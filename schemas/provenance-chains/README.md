# Provenance Chains

> Adds derivation-tracking columns and helper SQL functions so Open Brain can cite the atomic thoughts that produced each derived artifact.

## What It Does

Open Brain captures atomic thoughts, but as soon as you start synthesizing — weekly digests, wikis, lint reports, research summaries — you lose the link between the synthesis and the evidence. This schema makes that link first-class:

- `derived_from` (JSONB): array of parent thought IDs (UUID strings) that fed into this thought.
- `derivation_method` (TEXT): how the thought was produced. Constrained to `'synthesis'` or `NULL` on install; extend the check constraint to add methods.
- `derivation_layer` (TEXT): `'primary'` (atomic capture) or `'derived'` (regenerable artifact). Defaults to `'primary'` so all existing rows keep working.
- `supersedes` (UUID): optional pointer to a prior thought this one replaces — e.g., a regenerated digest replacing yesterday's.

Upstream's file also installs four helper functions (all `SECURITY DEFINER`, all **granted to `service_role` only** — call them from your edge function, not from client code). **On this fork the first two are migrations 025 and 026's** — the same names and argument lists, so the calls below run, but they return the fork's columns (no `derivation_layer`, `sensitivity_tier` or `restricted` flag), are `SECURITY INVOKER` and ungranted, and redact nothing by tier (025's header, departures 1 and 2) — and the file installs only the last two (SMD-1250; the note at the top of `schema.sql` says why):

- `trace_provenance(thought_id UUID, max_depth INT, node_cap INT)` — upstream's walks `derived_from` upward and returns a flat ancestor rowset with depth, cycle detection, and restricted-tier redaction; the fork's (026) is a bounded walk-global BFS with the same depth and cycle columns and no redaction.
- `find_derivatives(thought_id UUID, limit INT)` — reverse lookup via the GIN index; "what derived artifacts cite this atomic thought?" Upstream's always filters restricted rows out; the fork's (025) returns every derivative.
- `merge_thought_provenance_metadata(thought_id UUID, provenance JSONB)` — atomically merges a provenance subtree into `metadata.provenance` server-side. The recipe uses this to avoid read-modify-write races with other writers (e.g., `eval.mjs`) that update the same `metadata` blob.
- `merge_thought_eval_metadata(thought_id UUID, eval JSONB)` — is the race-free sibling for `eval.mjs`, avoiding stale-write conflicts with backfill's provenance merge. It performs a flat top-level `||` concat so eval's flat keys (`eval_score`, `eval_dimensions`, `eval_rationale`, `eval_graded_at`, `eval_grader`) replace their own values while preserving everything else (including `metadata.provenance`).

These functions power the **Provenance Chains Pipeline** recipe (backfill, eval, and MCP tool handlers).

### Provenance round-trip for stock RPC

The canonical `upsert_thought` RPC only preserves the `metadata` blob on `content_fingerprint` conflicts — not the new top-level `derived_from` / `derivation_layer` / `derivation_method` columns. To keep provenance durable across re-captures, the recipe mirrors those fields into `metadata.provenance`. That mirror is applied via `merge_thought_provenance_metadata`, which atomically merges the subtree into `metadata.provenance` server-side, avoiding read-modify-write races with other writers (e.g., `eval.mjs` storing `eval_score`).

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- Access to the Supabase SQL Editor or CLI

### Canonical-schema compatibility

The helpers `trace_provenance` and `find_derivatives` surface three fields — `type`, `source_type`, and `sensitivity_tier` — that the canonical `public.thoughts` table stores inside `metadata`, not as top-level columns. This migration reads them via `metadata->>'…'` so it installs cleanly on a stock OB1 setup. No extra `ADD COLUMN` is required. If your fork has already promoted any of these to real columns, edit the metadata reads inside `schema.sql` to direct column reads before you run the migration.

### RLS compatibility

The four new columns (`derived_from`, `derivation_method`, `derivation_layer`, `supersedes`) are plain columns on `public.thoughts`. Row-level security operates at the row granularity, not the column granularity, so any policies you already have on `public.thoughts` continue to apply unchanged — the new columns are simply returned or withheld alongside the rest of the row. If you need to hide specific columns from certain roles, use PostgREST's `select` column grants or a dedicated view. Upstream's helper functions are `SECURITY DEFINER` and granted to `service_role` only, so they run outside the caller's RLS context by design; on this fork that describes the two merge helpers this file installs, while `trace_provenance` and `find_derivatives` are 025's — `SECURITY INVOKER`, callable by the connecting role.

### `derived_from` validation

The migration only enforces that `derived_from` is NULL or a JSON array (`thoughts_derived_from_is_array_check`). Element-level UUID validation is **not** a database constraint — PostgreSQL forbids subqueries in `CHECK` predicates, so a per-element type/format check cannot live on the table. Validation is split across two application-layer choke points instead:

- **Write time:** `recipes/provenance-chains/backfill.mjs` rejects any non-UUID ref (e.g., legacy `#123` integer references) with a clear error before it calls PATCH, so nothing malformed reaches PostgREST.
- **Read time:** `trace_provenance` casts each element to `::uuid` inside its walk (upstream's recursive CTE; the fork's 026 keeps only UUID-shaped elements before the cast) and `find_derivatives` compares against a UUID-typed needle, so any non-UUID element that slips in surfaces as a `22P02 invalid_text_representation` error instead of silent bad output.

If you write to `derived_from` from code outside this recipe, mirror the UUID check before the PATCH.

## Credential Tracker

```text
PROVENANCE CHAINS -- CREDENTIAL TRACKER
--------------------------------------

SUPABASE (from your Open Brain setup)
  Project URL:           ____________
  Secret key:            ____________

--------------------------------------
```

## Steps

![Step 1](https://img.shields.io/badge/Step_1-Run_Migration-1E88E5?style=for-the-badge)

1. Open your **Supabase SQL Editor** (Dashboard > SQL Editor)
2. Paste the contents of [`schema.sql`](./schema.sql) and run it.

The migration is idempotent — safe to re-run. It uses `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, and `CREATE INDEX IF NOT EXISTS` throughout.

Or via the Supabase CLI:

```bash
supabase db push
```

(if you have the migration file in `supabase/migrations/`).

![Step 2](https://img.shields.io/badge/Step_2-Verify-1E88E5?style=for-the-badge)

1. Verify the columns exist:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'thoughts'
  AND column_name IN ('derived_from', 'derivation_method', 'derivation_layer', 'supersedes');
```

1. Verify every existing row has `derivation_layer = 'primary'`:

```sql
SELECT derivation_layer, count(*) FROM public.thoughts GROUP BY 1;
```

1. Sanity-check the helper functions:

```sql
-- Should return one row with depth=0 when the thought exists.
SELECT * FROM public.trace_provenance(
  (SELECT id FROM public.thoughts LIMIT 1),
  3,   -- max_depth
  250  -- node_cap
);

-- Should return 0 rows on a fresh install (nothing has been marked derived yet).
-- Note: upstream's helpers are service_role-only, so run these in the Supabase
-- SQL Editor (which uses the service role) or via an edge function; PostgREST
-- calls as `authenticated` return 42501 permission denied there. On this fork
-- the two are 025's and run as the connecting role.
SELECT * FROM public.find_derivatives(
  (SELECT id FROM public.thoughts LIMIT 1),
  50
);
```

## Expected Outcome

After running the migration:

- `public.thoughts` has four new columns: `derived_from JSONB`, `derivation_method TEXT`, `derivation_layer TEXT NOT NULL DEFAULT 'primary'`, `supersedes UUID`.
- Every existing row has `derivation_layer = 'primary'` and the three other columns NULL — no data loss, no behavior change for existing MCP tools.
- Four helper SQL functions exist: `trace_provenance` and `find_derivatives` are migrations 025 and 026's, already there on a migrated brain; `merge_thought_provenance_metadata` and `merge_thought_eval_metadata` come from this file, `SECURITY DEFINER`, **granted to `service_role` only** (clients must reach them via the open-brain edge function, not PostgREST as `authenticated`).
- Three indexes exist: `idx_thoughts_derived_from` (GIN), `idx_thoughts_derivation_layer` (btree), and `idx_thoughts_supersedes` (partial btree).
- PostgREST schema cache has been reloaded (`NOTIFY pgrst, 'reload schema'`).

## ID Type Note

This migration assumes `public.thoughts.id` is a `UUID` — the canonical Open Brain setup described in [`docs/01-getting-started.md`](../../docs/01-getting-started.md). If you have modified your schema so `thoughts.id` is a `BIGINT` (non-canonical), you will need to change:

- `supersedes UUID` → `supersedes BIGINT`
- Function parameter types (`p_thought_id UUID` → `BIGINT`)
- Inside `trace_provenance`, `jsonb_array_elements_text(...)::uuid` → `::bigint`
- Inside `find_derivatives`, `jsonb_build_array(p_thought_id::text)` → `jsonb_build_array(p_thought_id)` (so GIN containment matches a JSON number instead of a JSON string)

`derived_from` stays JSONB in either case, but element storage format changes (string UUIDs vs JSON numbers).

## Rollback

If you need to remove everything this migration added, run the block below. The rollback is lossy — any recorded provenance will be permanently dropped.

```sql
-- This fork: trace_provenance and find_derivatives are migrations 025/026's
-- here and are not dropped — nor are the derived_from and supersedes columns,
-- which 025 owns and upsert_thought writes, nor 025's two indexes on them,
-- idx_thoughts_derived_from and idx_thoughts_supersedes (SMD-1250).

-- Drop the index this file added
DROP INDEX IF EXISTS public.idx_thoughts_derivation_layer;

-- Drop constraints
ALTER TABLE public.thoughts DROP CONSTRAINT IF EXISTS thoughts_derived_from_uuid_elements_check;
ALTER TABLE public.thoughts DROP CONSTRAINT IF EXISTS thoughts_derived_from_is_array_check;
ALTER TABLE public.thoughts DROP CONSTRAINT IF EXISTS thoughts_derivation_method_check;
ALTER TABLE public.thoughts DROP CONSTRAINT IF EXISTS thoughts_derivation_layer_check;

-- Drop the two columns this file added (IRREVERSIBLE — any recorded layer or
-- method is lost). derived_from and supersedes stay: they are migration 025's.
ALTER TABLE public.thoughts DROP COLUMN IF EXISTS derivation_layer;
ALTER TABLE public.thoughts DROP COLUMN IF EXISTS derivation_method;

NOTIFY pgrst, 'reload schema';
```

> [!CAUTION]
> `DROP COLUMN` permanently removes the column and all recorded values. If you want to keep the data but disable the helpers, drop only the functions and indexes.

## Next Steps

Once the schema is installed, apply the companion [Provenance Chains Pipeline](../../recipes/provenance-chains/) recipe to get the backfill script, nightly quality evaluator, and MCP tool handlers (`trace_provenance`, `find_derivatives`) for your `open-brain-mcp` Edge Function.

## Troubleshooting

**Issue: "column already exists" error on re-run**
Solution: Expected — the migration uses `ADD COLUMN IF NOT EXISTS`. The message is informational only. No harm done.

**Issue: "operator does not exist: uuid = text" inside `trace_provenance`**
Solution: Your `thoughts.id` is not a UUID. See the [ID Type Note](#id-type-note) above — you need to change function parameter types to match your schema.

**Issue: `find_derivatives` returns zero rows even when derivatives exist**
Solution: The function builds its GIN needle as a JSON **string** (`["<uuid>"]`). If you populated `derived_from` with JSON numbers (e.g., BIGINT IDs serialized as numbers), containment will not match. Either store UUIDs as JSON strings consistently, or modify the function per the [ID Type Note](#id-type-note).

**Issue: PostgREST still returns old schema after migration**
Solution: The migration emits `NOTIFY pgrst, 'reload schema'` at the end. If your Supabase instance does not pick it up, go to Dashboard → Project Settings → API → Reload schema, or restart the REST service.
