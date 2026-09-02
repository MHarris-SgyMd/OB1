-- 006 — record the embedding contract in the database
--
-- The vector column's width was fixed when migration 001 ran, and the model that
-- fills it must produce exactly that many numbers. Nothing in Postgres ties those
-- two facts together, so a model change is silent: inserts start failing with a
-- dimension error, or worse, a same-width model from a different family produces
-- vectors that are numerically valid and semantically meaningless. Search quietly
-- degrades and nothing reports an error.
--
-- Recording the choice here gives preflight something to compare against, so a
-- mismatch fails at deploy instead of surfacing as bad search results.
--
-- Idempotent, and updatable: re-running with a different configuration overwrites
-- the row, which is what a deliberate re-embed looks like.

CREATE TABLE IF NOT EXISTS ob1_config (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ob1_config (key, value) VALUES
  ('embedding_dim',   '{{EMBEDDING_DIM}}'),
  ('embedding_model', '{{EMBEDDING_MODEL}}')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();

-- Cross-check against the column itself rather than trusting the substitution:
-- pgvector stores the declared width in atttypmod.
DO $$
DECLARE
  v_actual int;
  v_declared int := {{EMBEDDING_DIM}};
BEGIN
  SELECT atttypmod INTO v_actual
  FROM pg_attribute
  WHERE attrelid = 'thoughts'::regclass AND attname = 'embedding';

  IF v_actual IS NOT NULL AND v_actual <> v_declared THEN
    RAISE EXCEPTION
      'embedding dimension mismatch: thoughts.embedding is vector(%) but OB1_EMBEDDING_DIM is %. The column was created by an earlier run with a different setting; changing it now requires re-embedding every row.',
      v_actual, v_declared;
  END IF;
END $$;
