-- 003 — content fingerprinting and the idempotent upsert
--
-- Source: docs/01-getting-started.md step 2.6. Guarded with IF NOT EXISTS, which
-- upstream omits — applying core setup and then recipes/content-fingerprint-dedup
-- (the same DDL) errors on an unguarded ALTER and CREATE UNIQUE INDEX.

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS content_fingerprint text;

-- Partial index: rows predating fingerprinting have NULL and must not collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_fingerprint
  ON thoughts (content_fingerprint)
  WHERE content_fingerprint IS NOT NULL;

CREATE OR REPLACE FUNCTION upsert_thought(p_content text, p_payload jsonb DEFAULT '{}')
RETURNS jsonb AS $$
DECLARE
  v_fingerprint text;
  v_id          uuid;
BEGIN
  -- Normalise before hashing so "Hello  World" and "hello world" collapse.
  v_fingerprint := encode(sha256(convert_to(
    lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))),
    'UTF8'
  )), 'hex');

  INSERT INTO thoughts (content, content_fingerprint, metadata)
  VALUES (p_content, v_fingerprint, COALESCE(p_payload->'metadata', '{}'::jsonb))
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
  SET updated_at = now(),
      metadata   = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$ LANGUAGE plpgsql;
