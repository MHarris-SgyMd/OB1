-- Provenance Chains — Derivation tracking for Open Brain thoughts
--
-- Adds four columns plus helper SQL functions so Open Brain can answer
-- "show me the atomic thoughts that produced this derived artifact" and
-- "what downstream artifacts cite this atomic thought?" at the database layer.
--
-- Columns added to public.thoughts:
--   derived_from         JSONB   — array of parent thought IDs (as JSON strings,
--                                  since public.thoughts.id is UUID in the
--                                  canonical Open Brain setup). NULL for primary
--                                  thoughts.
--   derivation_method    TEXT    — how the thought was derived. Currently
--                                  constrained to 'synthesis' or NULL.
--   derivation_layer     TEXT    — 'primary' (atomic capture) or 'derived'
--                                  (regenerable artifact). Defaults to 'primary'.
--   supersedes           UUID    — optional pointer to a prior thought this one
--                                  replaces (e.g., an updated digest).
--
-- Helper functions (this fork, SMD-1250): upstream's file defined
--   trace_provenance(p_thought_id UUID, p_max_depth INT, p_node_cap INT) and
--   find_derivatives(p_thought_id UUID, p_limit INT) here, under the same
--   signatures migrations 025 and 026 give them — so on a brain built by
--   db/migrate.ts the two CREATE OR REPLACEs put upstream's per-path recursive
--   walk back over 026's bounded one (the timeout SMD-1288 removed) and
--   upstream's find_derivatives over 025's, with no error. Sections 5 and 6
--   are removed; the two functions the README's examples call are 025's and
--   026's — the same argument lists, so the calls run, but the fork's columns
--   (no derivation_layer, sensitivity_tier or restricted flag), SECURITY
--   INVOKER and ungranted, with no redaction by tier: 025's header,
--   departures 1 and 2. Section 2's CHECK on derived_from is removed as well:
--   025's thoughts_derived_from_is_array is the same expression, and a second
--   copy under another name is two constraints to fire on every write.
--   Section 4's comments on derived_from and
--   supersedes are removed too — 025 writes those columns' comments, and a
--   COMMENT ON here would overwrite them as silently. The metadata-merge
--   helpers in sections 7 and 8 have no counterpart in the migrations and stay.
--   scripts/check-fork-consistency.mjs check 7 fails the build if the two
--   return.
--
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE).
-- See README.md for rollback instructions.

-- ============================================================
-- 1. COLUMNS
-- ============================================================

ALTER TABLE public.thoughts
  ADD COLUMN IF NOT EXISTS derived_from JSONB;

ALTER TABLE public.thoughts
  ADD COLUMN IF NOT EXISTS derivation_method TEXT;

ALTER TABLE public.thoughts
  ADD COLUMN IF NOT EXISTS derivation_layer TEXT NOT NULL DEFAULT 'primary';

ALTER TABLE public.thoughts
  ADD COLUMN IF NOT EXISTS supersedes UUID REFERENCES public.thoughts(id) ON DELETE SET NULL;

-- ============================================================
-- 2. CONSTRAINTS (drop-then-add for idempotency)
-- ============================================================

ALTER TABLE public.thoughts
  DROP CONSTRAINT IF EXISTS thoughts_derivation_layer_check;
ALTER TABLE public.thoughts
  ADD CONSTRAINT thoughts_derivation_layer_check
  CHECK (derivation_layer IN ('primary', 'derived'));

ALTER TABLE public.thoughts
  DROP CONSTRAINT IF EXISTS thoughts_derivation_method_check;
ALTER TABLE public.thoughts
  ADD CONSTRAINT thoughts_derivation_method_check
  CHECK (derivation_method IS NULL OR derivation_method = 'synthesis');

-- derived_from must be NULL or a JSON array. PostgreSQL forbids subqueries in
-- CHECK constraints, so element-level UUID validation cannot live here — it is
-- enforced by the recipe scripts (backfill.mjs rejects non-UUID refs loudly
-- before writing) and, at read time, by the ::uuid casts inside
-- trace_provenance / find_derivatives, which surface any non-UUID element as
-- a 22P02 error. See schemas/provenance-chains/README.md for details.
-- (This fork: the array CHECK is migration 025's thoughts_derived_from_is_array,
--  the same expression; upstream's copy of it is not added again.)

-- Drop the legacy element-level check if it exists from an older install —
-- PostgreSQL rejects its subquery predicate and the migration would fail.
ALTER TABLE public.thoughts
  DROP CONSTRAINT IF EXISTS thoughts_derived_from_uuid_elements_check;

-- ============================================================
-- 3. INDEXES
-- ============================================================

-- GIN index for "find_derivatives" containment queries (derived_from @> '["<uuid>"]')
CREATE INDEX IF NOT EXISTS idx_thoughts_derived_from
  ON public.thoughts USING gin (derived_from);

-- Btree on layer for "give me all derived artifacts" browse queries
CREATE INDEX IF NOT EXISTS idx_thoughts_derivation_layer
  ON public.thoughts (derivation_layer);

-- Partial index on supersedes — most rows are NULL, only track the active ones
CREATE INDEX IF NOT EXISTS idx_thoughts_supersedes
  ON public.thoughts (supersedes)
  WHERE supersedes IS NOT NULL;

-- ============================================================
-- 4. COLUMN COMMENTS (discoverable via \d+ thoughts)
-- ============================================================

COMMENT ON COLUMN public.thoughts.derivation_method IS
  'How this thought was derived. Currently: ''synthesis'' or NULL. Extend the check constraint to add methods.';
COMMENT ON COLUMN public.thoughts.derivation_layer IS
  '''primary'' (atomic capture) or ''derived'' (regenerable artifact). Defaults to ''primary''.';

-- ============================================================
-- 7. HELPER: merge_thought_provenance_metadata
--    Atomic server-side merge of a provenance subtree into
--    thoughts.metadata.provenance. Use this instead of a
--    client-side GET metadata -> mutate in JS -> PATCH metadata
--    round trip, which is a read-modify-write race: any other
--    writer (e.g., recipes/provenance-chains/eval.mjs, which
--    writes eval_score / eval_dimensions / eval_rationale into
--    the same metadata blob) that lands between the GET and the
--    PATCH would be silently overwritten.
--
--    The function only touches metadata->'provenance'; all other
--    keys in metadata are preserved via the `||` jsonb concat,
--    which is right-biased on conflicts (so `provenance` is the
--    only key that gets replaced wholesale).
-- ============================================================

CREATE OR REPLACE FUNCTION public.merge_thought_provenance_metadata(
  p_thought_id UUID,
  p_provenance JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rows_affected INT;
BEGIN
  IF p_thought_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.thoughts
  SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                 jsonb_build_object(
                   'provenance',
                   COALESCE(metadata->'provenance', '{}'::jsonb) || COALESCE(p_provenance, '{}'::jsonb)
                 )
  WHERE id = p_thought_id;

  -- Raise if the target row does not exist. Silent zero-row updates used to
  -- make stale score files / mistyped ids look "applied" to callers even
  -- though nothing was written. Surface it as a 22023 no_data_found so
  -- PostgREST returns a structured error the caller can classify.
  GET DIAGNOSTICS rows_affected = ROW_COUNT;
  IF rows_affected = 0 THEN
    RAISE EXCEPTION 'Thought % not found', p_thought_id USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

-- Service-role-only (same reasoning as the other provenance RPCs: the edge
-- function authenticates callers and reaches PostgREST as service_role;
-- letting `authenticated` invoke this directly would let signed-in users
-- rewrite arbitrary rows' metadata.provenance subtree).
REVOKE EXECUTE ON FUNCTION public.merge_thought_provenance_metadata(UUID, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.merge_thought_provenance_metadata(UUID, JSONB) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.merge_thought_provenance_metadata(UUID, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.merge_thought_provenance_metadata(UUID, JSONB)
  TO service_role;

-- ============================================================
-- 8. HELPER: merge_thought_eval_metadata
--    Race-free sibling of merge_thought_provenance_metadata for
--    eval.mjs. eval writes flat top-level metadata keys
--    (eval_score, eval_dimensions, eval_rationale, eval_graded_at,
--    eval_grader); previously it did GET metadata → mutate in JS →
--    PATCH whole metadata, which is a read-modify-write race
--    against backfill's provenance merge. If backfill's RPC lands
--    between eval's GET and PATCH, eval's stale snapshot would
--    silently overwrite metadata.provenance.
--
--    This RPC performs a flat top-level merge via `||` concat, so
--    eval's keys replace their own values while all other keys
--    (including metadata.provenance written by backfill) are
--    preserved server-side. Idempotent re-running produces the
--    same blob.
-- ============================================================

CREATE OR REPLACE FUNCTION public.merge_thought_eval_metadata(
  p_thought_id UUID,
  p_eval JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rows_affected INT;
BEGIN
  IF p_thought_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.thoughts
  SET metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_eval, '{}'::jsonb)
  WHERE id = p_thought_id;

  -- Raise if the target row does not exist. Silent zero-row updates used to
  -- make stale score files / mistyped ids look "applied" to callers even
  -- though nothing was written. Surface it as a 22023 no_data_found so
  -- PostgREST returns a structured error the caller can classify.
  GET DIAGNOSTICS rows_affected = ROW_COUNT;
  IF rows_affected = 0 THEN
    RAISE EXCEPTION 'Thought % not found', p_thought_id USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

-- Service-role-only (same reasoning as the other provenance RPCs).
REVOKE EXECUTE ON FUNCTION public.merge_thought_eval_metadata(UUID, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.merge_thought_eval_metadata(UUID, JSONB) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.merge_thought_eval_metadata(UUID, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.merge_thought_eval_metadata(UUID, JSONB)
  TO service_role;

-- ============================================================
-- 9. RELOAD PostgREST SCHEMA CACHE
-- ============================================================

NOTIFY pgrst, 'reload schema';
