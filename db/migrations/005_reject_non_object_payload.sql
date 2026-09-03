-- 005 — make a malformed payload loud instead of silent
--
-- Both upsert_thought overloads read metadata as COALESCE(p_payload->'metadata', '{}').
-- The `->` operator returns NULL for any payload that is not a JSON object, so a
-- caller that accidentally passes a JSON *string* stores empty metadata and gets a
-- success back. The content and embedding are written correctly; only the metadata
-- vanishes, which makes it hard to notice and hard to attribute later.
--
-- This is not hypothetical. Client libraries differ on how a JS string binds to a
-- jsonb parameter — Bun.sql double-encodes it, so `'{"metadata":{...}}'` arrives as
-- jsonb_typeof = 'string', not 'object'. Upstream has already fixed this same class
-- twice (double-encoded metadata in thought-enrichment; escaped-JSON details in
-- add_household_item).
--
-- Fix: reject a non-object payload with a message that names the cause. Valid calls
-- are unaffected — an object, NULL, and the '{}' default all behave exactly as before.
--
-- Safe to run more than once. Adds no columns and alters no table structure.

CREATE OR REPLACE FUNCTION upsert_thought(p_content text, p_payload jsonb DEFAULT '{}')
RETURNS jsonb AS $$
DECLARE
  v_fingerprint text;
  v_id          uuid;
BEGIN
  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_payload);
  END IF;

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

CREATE OR REPLACE FUNCTION upsert_thought(
  p_content   text,
  p_payload   jsonb,
  p_embedding vector({{EMBEDDING_DIM}})
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_fingerprint text;
  v_id          uuid;
BEGIN
  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_payload);
  END IF;

  v_fingerprint := encode(sha256(convert_to(
    lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))),
    'UTF8'
  )), 'hex');

  INSERT INTO thoughts (content, content_fingerprint, metadata, embedding)
  VALUES (p_content, v_fingerprint, COALESCE(p_payload->'metadata', '{}'::jsonb), p_embedding)
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
    SET updated_at = now(),
        metadata   = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
        embedding  = COALESCE(EXCLUDED.embedding, thoughts.embedding)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$;
