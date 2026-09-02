-- ============================================================================
-- 004 — upsert_thought(text, jsonb, vector): atomic capture
--
-- Why
--   capture_thought previously wrote in two steps: upsert_thought(content,
--   payload) to create the row, then a separate UPDATE to attach the embedding.
--   If the second call failed, the row stayed committed with a NULL embedding —
--   stored, but invisible to every semantic search, with nothing surfacing the
--   problem afterwards. This overload does both in one statement.
--
-- Safety
--   * Additive only. The existing 2-arg upsert_thought(text, jsonb) is left
--     untouched and keeps working; this is a Postgres overload, not a
--     replacement. Deployments that skip this migration fall back to the
--     two-step path automatically.
--   * p_embedding has NO DEFAULT. That is deliberate: a default would make
--     upsert_thought('x', '{}') ambiguous between the two overloads and break
--     every existing caller with "function is not unique".
--   * Adds no columns and alters no existing ones, so it satisfies the core
--     "never modify the thoughts table structure" rule.
--   * Idempotent — safe to run more than once.
--
-- Prerequisites
--   Migration 003. Applied by `bun db/migrate.ts`, or by hand in any SQL client.
--
-- Expected outcome
--   Database → Functions lists two upsert_thought entries: (text, jsonb) and
--   (text, jsonb, vector). capture_thought stops logging the
--   "falling back to the non-atomic two-step write" warning.
--
-- Adapted from recipes/edge-function-cost-optimization, which introduced this
-- overload but which the core server never called.
-- ============================================================================

CREATE OR REPLACE FUNCTION upsert_thought(
  p_content   text,
  p_payload   jsonb,
  p_embedding vector(1536)
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_fingerprint text;
  v_id          uuid;
BEGIN
  v_fingerprint := encode(
    sha256(convert_to(
      lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))),
      'UTF8'
    )),
    'hex'
  );

  INSERT INTO thoughts (content, content_fingerprint, metadata, embedding)
  VALUES (
    p_content,
    v_fingerprint,
    COALESCE(p_payload->'metadata', '{}'::jsonb),
    p_embedding
  )
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
    SET updated_at = now(),
        metadata   = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
        -- Keep the existing embedding when the caller supplies none, so a
        -- metadata-only re-capture cannot blank out a good vector.
        embedding  = COALESCE(EXCLUDED.embedding, thoughts.embedding)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector) IS
  'Atomic capture: content + metadata + embedding in one statement. Overload of upsert_thought(text, jsonb); no default on p_embedding so the 2-arg form stays unambiguous.';

-- No GRANT here. `service_role` is a Supabase-managed role that does not exist
-- off Supabase; grant to whichever role your application connects as.
