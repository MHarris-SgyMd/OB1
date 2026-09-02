-- 001 — core schema: the thoughts table, its indexes, and the updated_at trigger
--
-- Source: docs/01-getting-started.md step 2.2, which exists only as prose inside a
-- markdown guide. This is that DDL made applicable: idempotent, with named indexes,
-- and with the Supabase-specific pieces removed (see ../README.md).
--
-- Requires: the `vector` extension (001 creates it). NOT pgcrypto — gen_random_uuid()
-- has been a Postgres built-in since 13 and sha256() since 11.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS thoughts (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  content     text        NOT NULL,
  embedding   vector({{EMBEDDING_DIM}}),
  metadata    jsonb       DEFAULT '{}'::jsonb,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- The guide creates these anonymously (`create index on thoughts …`), which cannot
-- be made idempotent. Named explicitly so re-running this file is a no-op. The names
-- match what Postgres would have auto-assigned, so an existing database created from
-- the guide already satisfies these and will not build duplicates.
CREATE INDEX IF NOT EXISTS thoughts_embedding_idx
  ON thoughts USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS thoughts_metadata_idx
  ON thoughts USING gin (metadata);

CREATE INDEX IF NOT EXISTS thoughts_created_at_idx
  ON thoughts (created_at DESC);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$ LANGUAGE plpgsql;

-- CREATE TRIGGER has no IF NOT EXISTS before PG 14 and no OR REPLACE for row
-- triggers, so drop-then-create is the portable idempotent form.
DROP TRIGGER IF EXISTS thoughts_updated_at ON thoughts;
CREATE TRIGGER thoughts_updated_at
  BEFORE UPDATE ON thoughts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
