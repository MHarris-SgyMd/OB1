-- Agent memory (SMD-2690): what an agent runtime wrote back after a task, its
-- provenance, its review, and which recalls returned it and whether the agent
-- used it. Ported from schemas/agent-memory, whose eight public tables were
-- agent_memories and seven agent_memory_* beside it: the same columns here, in
-- the plugin's own schema, the prefix dropped. Each memory's text is also a
-- thought, captured through the core (capture_thought), which search_thoughts
-- finds by meaning; thought_id names it. There is no foreign key into the core:
-- a deleted thought leaves its memory here, never recalled again (a recall
-- finds memories through their thoughts).

CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The thought the memory's text was captured as (or the one already holding that text).
  thought_id UUID,
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  channel_kind TEXT,
  channel_id TEXT,
  channel_thread_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'project' CHECK (
    visibility IN ('personal', 'channel', 'project', 'workspace', 'organization')
  ),
  memory_type TEXT NOT NULL CHECK (
    memory_type IN ('decision', 'output', 'lesson', 'constraint', 'open_question', 'failure', 'artifact_reference', 'work_log')
  ),
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (
    lifecycle_status IN ('active', 'stale', 'superseded', 'disputed', 'rejected')
  ),
  provenance_status TEXT NOT NULL DEFAULT 'generated' CHECK (
    provenance_status IN ('observed', 'inferred', 'user_confirmed', 'imported', 'generated', 'superseded', 'disputed')
  ),
  confidence NUMERIC(3,2) NOT NULL DEFAULT 0.50 CHECK (confidence >= 0 AND confidence <= 1),
  created_by TEXT NOT NULL DEFAULT 'agent' CHECK (created_by IN ('user', 'agent', 'system', 'import')),
  runtime_name TEXT,
  runtime_version TEXT,
  provider TEXT,
  model TEXT,
  task_id TEXT,
  flow_id TEXT,
  can_use_as_instruction BOOLEAN NOT NULL DEFAULT false,
  can_use_as_evidence BOOLEAN NOT NULL DEFAULT true,
  requires_user_confirmation BOOLEAN NOT NULL DEFAULT true,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    review_status IN ('pending', 'confirmed', 'evidence_only', 'restricted', 'rejected', 'stale', 'merged')
  ),
  last_confirmed_at TIMESTAMPTZ,
  stale_after TIMESTAMPTZ,
  idempotency_key TEXT,
  -- The write-back's hash of its type and text, kept through an edit: the same write-back sent again answers the memory.
  content_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Only what a person confirmed, or imported, may be followed as an instruction.
  CHECK (can_use_as_instruction = false OR provenance_status IN ('user_confirmed', 'imported'))
);

-- A workspace's own: the same key in another workspace is another memory (the old schema's index was global, so a
-- write-back to one workspace was answered another's memory, or refused, by a key the two happened to share).
-- The key by its md5: a default key holds four ids of up to 200 characters, past what a btree row may hold beside the workspace.
CREATE UNIQUE INDEX IF NOT EXISTS memories_idempotency_key ON memories (workspace_id, md5(idempotency_key)) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_scope ON memories (workspace_id, project_id, visibility);
CREATE INDEX IF NOT EXISTS memories_review ON memories (review_status, lifecycle_status, created_at DESC);
CREATE INDEX IF NOT EXISTS memories_runtime_task ON memories (runtime_name, task_id, flow_id);
CREATE INDEX IF NOT EXISTS memories_thought ON memories (thought_id) WHERE thought_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_workspace_time ON memories (workspace_id, created_at DESC);

-- Where a write-back said its memories came from.
CREATE TABLE IF NOT EXISTS source_refs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  uri TEXT,
  title TEXT,
  source_timestamp TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS source_refs_memory ON source_refs (memory_id);

-- The artifact an artifact_reference memory names.
CREATE TABLE IF NOT EXISTS artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS artifacts_memory ON artifacts (memory_id);

-- A review's merge or supersede: one memory into or over another.
CREATE TABLE IF NOT EXISTS relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('related_to', 'supersedes', 'superseded_by', 'conflicts_with', 'merged_into')),
  confidence NUMERIC(3,2) DEFAULT 0.50 CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_memory_id, to_memory_id, relation),
  CHECK (from_memory_id <> to_memory_id)
);

-- Each review, with the memory before and after it.
CREATE TABLE IF NOT EXISTS review_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (
    action IN ('confirm', 'edit', 'evidence_only', 'restrict_scope', 'mark_stale', 'merge', 'reject', 'dispute', 'supersede')
  ),
  -- The key that reviewed (the old server took it from the request body).
  actor_id TEXT,
  actor_label TEXT,
  notes TEXT,
  before JSONB,
  after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS review_actions_memory ON review_actions (memory_id, created_at DESC);

-- A recall made with a write key, so the agent can say which memories it used.
CREATE TABLE IF NOT EXISTS recall_traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  runtime_name TEXT,
  runtime_version TEXT,
  task_id TEXT,
  flow_id TEXT,
  channel_kind TEXT,
  channel_id TEXT,
  query TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id)
);

CREATE INDEX IF NOT EXISTS recall_traces_scope ON recall_traces (workspace_id, project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS recall_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id UUID NOT NULL REFERENCES recall_traces(id) ON DELETE CASCADE,
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  similarity NUMERIC(5,4),
  ranking_score NUMERIC(7,4),
  returned BOOLEAN NOT NULL DEFAULT true,
  used BOOLEAN,
  ignored_reason TEXT,
  use_policy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trace_id, memory_id)
);

CREATE INDEX IF NOT EXISTS recall_items_trace ON recall_items (trace_id, rank);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'recall_requested', 'memory_returned', 'memory_used', 'memory_ignored', 'memory_written',
      'memory_confirmed', 'memory_edited', 'memory_rejected', 'memory_superseded', 'memory_disputed'
    )
  ),
  workspace_id TEXT,
  project_id TEXT,
  memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
  trace_id UUID REFERENCES recall_traces(id) ON DELETE SET NULL,
  actor_kind TEXT NOT NULL DEFAULT 'system' CHECK (actor_kind IN ('user', 'agent', 'system', 'import')),
  actor_label TEXT,
  runtime_name TEXT,
  task_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_scope ON audit_events (workspace_id, project_id, created_at DESC);
