-- Smart ingest's jobs and their items (SMD-2690): one job per document sent to
-- ingest, and one item per thought the model extracted from it, with what the
-- dry run decided for it and what its execute did. Ported from
-- schemas/smart-ingest's public tables, which the plugin does not adopt (the
-- README's copy block moves an old brain's rows). The thoughts themselves are
-- the core's: an item names the thought it matched or wrote by id, with no
-- foreign key into the core, and keeps what capture_thought's metadata has no
-- room for (the extracted type, importance, tags and the passage it came from).

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id               bigserial   PRIMARY KEY,
  -- The text's sha256, hex; a reprocess of the same text adds -v2, -v3 …
  input_hash       text        NOT NULL UNIQUE,
  -- The caller's session key (source_metadata.import_key): one job per key unless reprocess.
  import_key       text,
  source_label     text,
  source_type      text,
  input_length     integer     NOT NULL CHECK (input_length >= 0),
  status           text        NOT NULL DEFAULT 'extracting'
                     CHECK (status IN ('extracting', 'dry_run_complete', 'executing', 'complete', 'failed')),
  dry_run          boolean     NOT NULL,
  -- What the text is, as the caller declared it (capture_thought's trust), for the execute; null for none.
  trust            text        CHECK (trust IN ('operator', 'agent', 'ingested')),
  -- The key that sent it.
  created_by       text        NOT NULL,
  extracted_count  integer     NOT NULL DEFAULT 0,
  added_count      integer     NOT NULL DEFAULT 0,
  skipped_count    integer     NOT NULL DEFAULT 0,
  appended_count   integer     NOT NULL DEFAULT 0,
  revised_count    integer     NOT NULL DEFAULT 0,
  -- An add whose text was a thought by the execute, or an append the thought already held (SMD-2154).
  existed_count    integer     NOT NULL DEFAULT 0,
  failed_count     integer     NOT NULL DEFAULT 0,
  -- How many model calls the extraction made.
  model_calls      integer     NOT NULL DEFAULT 0,
  error_message    text,
  -- The caller's source_metadata, as it sent it.
  source_metadata  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);

CREATE INDEX IF NOT EXISTS ingestion_jobs_by_import_key ON ingestion_jobs (import_key, created_at DESC) WHERE import_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ingestion_jobs_by_time ON ingestion_jobs (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS ingestion_items (
  id                  bigserial   PRIMARY KEY,
  job_id              bigint      NOT NULL REFERENCES ingestion_jobs (id) ON DELETE CASCADE,
  -- Its place in the job, from 0: the order the model extracted it in.
  position            integer     NOT NULL CHECK (position >= 0),
  content             text        NOT NULL,
  type                text        NOT NULL,
  importance          smallint    NOT NULL CHECK (importance BETWEEN 1 AND 5),
  tags                text[]      NOT NULL DEFAULT '{}',
  source_snippet      text        NOT NULL DEFAULT '',
  action              text        NOT NULL CHECK (action IN ('add', 'skip', 'append_evidence', 'create_revision')),
  reason              text        NOT NULL,
  -- ready: decided, not yet executed; executed: done; existed: an add whose text was already a thought, or an
  -- append the thought already held, so nothing was written; failed: error_message says why.
  status              text        NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'executed', 'existed', 'failed')),
  matched_thought_id  uuid,
  similarity_score    real,
  result_thought_id   uuid,
  error_message       text,
  executed_at         timestamptz,
  UNIQUE (job_id, position)
);
