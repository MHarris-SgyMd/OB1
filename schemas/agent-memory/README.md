# Agent Memory

> Governed operational memory for agent runtimes, with provenance, review, recall traces, and audit trails.

```mermaid
flowchart LR
  Runtime["Agent runtime<br/>OpenClaw, Codex, local agents"] --> Recall["Recall request"]
  Recall --> OB1["OB1 Agent Memory"]
  OB1 --> Memories["Scoped memories<br/>provenance + use policy"]
  Memories --> Runtime
  Runtime --> Writeback["Compact write-back"]
  Writeback --> Review["Human review"]
  Review --> Future["Future recall"]
  Future --> Runtime
```

## What It Does

This schema adds sidecar tables that let Open Brain store agent-created operational memory safely. The core `thoughts` table remains the content store; agent memory records add provenance, confidence, scope, use policy, review status, source references, recall traces, and audit events.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- A Postgres with the core `thoughts` table — the fork's stack, or a Supabase project
- The core dedupe setup (`db/migrations/003`–`005`, applied by the core setup) is recommended

## Credential Tracker

```text
AGENT MEMORY -- CREDENTIAL TRACKER
--------------------------------------

SUPABASE (from your Open Brain setup)
  Project URL:           ____________
  Secret key:            ____________

--------------------------------------
```

## Steps

![Step 1](https://img.shields.io/badge/Step_1-Run_the_Agent_Memory_Schema-1E88E5?style=for-the-badge)

Apply [`schema.sql`](./schema.sql) to your brain: `psql "$DATABASE_URL" -f schema.sql` (or paste it into your SQL console). Then, from `db/`, run `bun migrate.ts --url "$DATABASE_URL" --grant <role>` so the role your server connects as can use what the file creates — the file itself grants nothing (this fork, SMD-1796: upstream's `GRANT … TO service_role` lines and its row-level security are gone; `db/README.md`, "Grants for a capturing role", lists the `community` group).

**Done when:** Table Editor shows `agent_memories`, `agent_memory_recall_traces`, `agent_memory_recall_items`, and `agent_memory_audit_events`.

![Step 2](https://img.shields.io/badge/Step_2-Verify_the_Trust_Defaults-1E88E5?style=for-the-badge)

Run this query:

```sql
SELECT column_name, column_default
FROM information_schema.columns
WHERE table_name = 'agent_memories'
  AND column_name IN (
    'can_use_as_instruction',
    'can_use_as_evidence',
    'requires_user_confirmation',
    'review_status'
  );
```

**Done when:** instruction defaults to `false`, evidence defaults to `true`, confirmation defaults to `true`, and review defaults to `pending`.

![Step 3](https://img.shields.io/badge/Step_3-Install_the_API-1E88E5?style=for-the-badge)

Deploy the runtime API from [`../../integrations/agent-memory-api/`](../../integrations/agent-memory-api/).

**Done when:** `GET /health` on the deployed API returns `{"ok":true}`.

## Expected Outcome

After applying this schema, OB1 can store agent memories as governed records instead of raw transcript dumps. Agent-written memories start as evidence-only pending review. Only `user_confirmed` or trusted `imported` memories can become instruction-grade.

Use [Safe Agent Memory and Provenance](../../docs/safe-agent-memory-provenance.md) as the operating guide for provenance, review status, use policy, and scope decisions.

## Troubleshooting

**Issue: `agent-memory requires public.thoughts`**
Solution: Run the core Open Brain setup first.

**Issue: instruction-grade write fails**
Solution: This is usually correct. `can_use_as_instruction` is only allowed for `user_confirmed` or `imported` memory.

**Issue: API cannot read tables**
Solution: Re-run the GRANT section at the bottom of `schema.sql` as the table owner; it takes effect on the next request — no restart.
