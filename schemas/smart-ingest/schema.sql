-- Smart Ingest Pipeline Tables
-- Adds ingestion_jobs and ingestion_items tables for tracking
-- the extract-deduplicate-execute lifecycle of bulk text ingestion.
-- Safe to run multiple times (fully idempotent).

-- ============================================================
-- 1. INGESTION JOBS
--    One row per ingest invocation. Tracks status through:
--    pending -> extracting -> dry_run_complete -> executing -> complete
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ingestion_jobs (
  id bigserial PRIMARY KEY,
  source_label text,
  input_hash text NOT NULL UNIQUE,
  input_length int,
  status text DEFAULT 'pending',        -- pending, extracting, dry_run_complete, executing, complete, failed
  extracted_count int DEFAULT 0,
  added_count int DEFAULT 0,
  skipped_count int DEFAULT 0,
  appended_count int DEFAULT 0,
  revised_count int DEFAULT 0,
  error_message text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

-- ============================================================
-- 2. INGESTION ITEMS
--    Individual extracted thoughts within a job. Each item gets
--    a reconciliation action (add, skip, append_evidence,
--    create_revision) during dedup, then executes independently.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ingestion_items (
  id bigserial PRIMARY KEY,
  job_id bigint REFERENCES public.ingestion_jobs(id) ON DELETE CASCADE,
  extracted_content text NOT NULL,
  action text NOT NULL DEFAULT 'pending',   -- pending, add, skip, append_evidence, create_revision
  status text NOT NULL DEFAULT 'pending',   -- pending, ready, executed, failed
  reason text,
  matched_thought_id bigint,
  similarity_score numeric(5,4),
  result_thought_id bigint,
  error_message text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- Index for fast job-item lookups
CREATE INDEX IF NOT EXISTS ingestion_items_job_idx
  ON public.ingestion_items(job_id);

-- Partial indexes that keep the worker's hot path ("next pending job"
-- and "next pending/ready item") O(small) even as the historical tail
-- of completed rows grows unbounded.
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_pending
  ON public.ingestion_jobs (created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_ingestion_items_pending
  ON public.ingestion_items (job_id, created_at)
  WHERE status IN ('pending', 'ready');

-- ============================================================
-- 2a. MULTI-TENANT SCOPING (optional)
--     Add a nullable user_id to both tables so shared (multi-tenant)
--     deployments can isolate ingestion history per user. Stock
--     single-tenant OB1 setups can leave user_id NULL on every row.
--
--     This fork (SMD-1796): upstream's file went on to add a foreign key
--     from user_id to Supabase's auth.users(id), inside a DO block that
--     ran only where the auth schema exists. Guarded or not, it is a
--     reference into GoTrue's schema, which the fork's SQL rule refuses
--     (scripts/check-fork-consistency.ts check 12); a single-operator
--     brain (SMD-1716) has no auth.users to point at, so the column
--     stays a plain nullable uuid and the block is gone.
-- ============================================================

ALTER TABLE public.ingestion_jobs
  ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.ingestion_items
  ADD COLUMN IF NOT EXISTS user_id uuid;

-- ============================================================
-- 3. APPEND THOUGHT EVIDENCE RPC
--    Appends an evidence entry to thoughts.metadata.evidence[].
--    Idempotent via SHA256 identity of (source_label + excerpt + thought_id).
--    Returns { thought_id, evidence_count, action: 'appended' | 'already_exists' }.
-- ============================================================

CREATE OR REPLACE FUNCTION public.append_thought_evidence(
  p_thought_id bigint,
  p_evidence jsonb  -- {source, extracted_at, excerpt, source_label}
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_identity text;
  v_current_evidence jsonb;
  v_entry jsonb;
  v_count int;
BEGIN
  -- Compute a stable identity for this evidence entry
  v_identity := encode(
    sha256(
      convert_to(
        coalesce(p_evidence->>'source_label', '') ||
        coalesce(p_evidence->>'excerpt', '') ||
        p_thought_id::text,
        'UTF8'
      )
    ),
    'hex'
  );

  -- Fetch current evidence array
  SELECT coalesce(metadata->'evidence', '[]'::jsonb)
    INTO v_current_evidence
    FROM public.thoughts
   WHERE id = p_thought_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'thought % not found', p_thought_id;
  END IF;

  -- Check for duplicate by scanning existing identities
  FOR v_entry IN SELECT jsonb_array_elements(v_current_evidence)
  LOOP
    IF v_entry->>'_identity' = v_identity THEN
      RETURN jsonb_build_object(
        'thought_id', p_thought_id,
        'evidence_count', jsonb_array_length(v_current_evidence),
        'action', 'already_exists'
      );
    END IF;
  END LOOP;

  -- Append new evidence entry with identity tag
  UPDATE public.thoughts
     SET metadata = jsonb_set(
           coalesce(metadata, '{}'::jsonb),
           '{evidence}',
           v_current_evidence || jsonb_build_object(
             '_identity', v_identity,
             'source', p_evidence->'source',
             'extracted_at', p_evidence->'extracted_at',
             'excerpt', p_evidence->'excerpt',
             'source_label', p_evidence->'source_label'
           )
         )
   WHERE id = p_thought_id;

  v_count := jsonb_array_length(v_current_evidence) + 1;

  RETURN jsonb_build_object(
    'thought_id', p_thought_id,
    'evidence_count', v_count,
    'action', 'appended'
  );
END;
$$;

-- ============================================================
-- 4. GRANTS
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.append_thought_evidence(bigint, jsonb) FROM public;

-- This fork (SMD-1796): upstream's section 4 also GRANTed ALL on both tables,
-- USAGE, SELECT on their two sequences and EXECUTE on the append TO
-- service_role, and a section 5 ENABLEd ROW LEVEL SECURITY on both tables with
-- a policy FOR service_role and, where Supabase's auth.uid() exists, a SELECT
-- policy FOR authenticated scoped to it. Those are Supabase's: on plain
-- Postgres the first GRANT stops the file (`role "service_role" does not
-- exist`), and the section's own comment says what RLS then does — "deny-by-
-- default for anyone except service_role", which on this fork is the role you
-- connect as. Removed; the REVOKE above stays, so the SECURITY DEFINER append
-- is callable only by a role granted it.
-- Grant the role your server connects as instead — from db/:
--   bun migrate.ts --url postgres://… --grant <role>
-- issues db/config.mjs ROLE_GRANTS' `community` group, which covers this file's
-- two tables (SELECT, INSERT, UPDATE, DELETE), the two bigserial sequences
-- (USAGE, SELECT — an INSERT needs the sequence) and EXECUTE on
-- append_thought_evidence(bigint, jsonb). Row-level security: SMD-1716.

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
