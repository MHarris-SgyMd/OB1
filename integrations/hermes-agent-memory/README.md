# Hermes Agent Memory (OB1)

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@MicScalise](https://github.com/MicScalise)**

> Native Hermes `MemoryProvider` for the OB1 governed memory system. Gives Hermes agents the same auto-recall, auto-writeback, and governance that OpenClaw agents get from `integrations/openclaw-agent-memory`.

## What It Does

Plugs Hermes Agent into the brain's [agent-memory plugin](../../plugins/agent-memory/), whose REST routes serve the OB1 v1 memory contract, so every Hermes turn does three things automatically:

1. **Recall** — Before the LLM call, recent and relevant memories are pulled from OB1 (filtered by `use_policy` — `[instruction]` items are treated as binding rules, `[evidence]` as supporting context only).
2. **Writeback** — After the turn, a structured summary lands in the plugin's memories, its text captured as a thought, tagged with `runtime=hermes`, the actual model + provider that ran the turn, and the `task_id` linkage.
3. **Govern** — Memories default to review status `pending` with `requires_user_confirmation=true` so nothing is promoted to instruction-grade until a human (or the `ob1_review_memory` tool) confirms it.

The same backend serves both runtimes — OpenClaw agents and Hermes agents share **one** governed memory.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- The brain's [agent-memory plugin](../../plugins/agent-memory/) turned on, with `/api` published (its README's "Turn it on"). A brain on 2.0.0 or earlier runs the standalone Agent Memory API server instead, whose routes this client no longer calls: keep version 0.1.0 of this client there, or move to the plugin first (its README's "Moving from the standalone server").
- A key with write scope for Hermes (the plugin README's "Prerequisites"): recall reads, and usage and review write. A capture-only key can write back alone.
- Hermes Agent 0.13.0+ installed
- Python 3.11+

## Credential Tracker

```text
HERMES AGENT MEMORY -- CREDENTIAL TRACKER
-----------------------------------------

FROM OB1
  Agent-memory plugin URL:  https://<host>/api/v1/plugins/agent-memory
  Brain key (write scope):  ____________

HERMES
  Plugin path (~/.hermes/plugins/ob1):  ____________
  Default workspace ID:                 ____________
  Default project ID (optional):        ____________

-----------------------------------------
```

## Steps

![Step 1](https://img.shields.io/badge/Step_1-Prepare_OB1_Agent_Memory-1E88E5?style=for-the-badge)

Turn the brain's agent-memory plugin on and publish `/api`, as [its README](../../plugins/agent-memory/README.md) says ("Turn it on"), and make Hermes a key with write scope.

> [!IMPORTANT]
> The plugin's routes must be reachable on the URL you'll configure below: `https://<host>/api/v1/plugins/agent-memory` through your TLS proxy or tunnel, or `http://127.0.0.1:8000/api/v1/plugins/agent-memory` on the brain's own machine. The provider asks nothing when it starts; a recall or write-back that fails is logged as it fails.

**Done when:** the write-back and recall in the plugin README's "Check it" answer with your key.

![Step 2](https://img.shields.io/badge/Step_2-Install_the_Plugin-1E88E5?style=for-the-badge)

Hermes plugins live under `$HERMES_HOME/plugins/<name>/`. The default `$HERMES_HOME` is `~/.hermes`.

```bash
mkdir -p ~/.hermes/plugins/ob1
cp plugin/__init__.py     ~/.hermes/plugins/ob1/__init__.py
cp plugin/plugin.yaml     ~/.hermes/plugins/ob1/plugin.yaml
```

> [!NOTE]
> The plugin uses Python's stdlib only — no `pip install` required. PyYAML ships with Hermes.

**Done when:** `ls ~/.hermes/plugins/ob1/` shows both files.

![Step 3](https://img.shields.io/badge/Step_3-Configure_Hermes-1E88E5?style=for-the-badge)

The plugin reads non-secret config from `~/.hermes/ob1.json` and the access key from the `OPENBRAIN_KEY` environment variable.

**1. Write the config file:**

```bash
cat > ~/.hermes/ob1.json <<'EOF'
{
  "endpoint": "https://<host>/api/v1/plugins/agent-memory",
  "workspace_id": "default",
  "project_id": null,
  "auto_recall": true,
  "auto_capture": true,
  "max_recall_results": 10,
  "api_timeout": 8,
  "writeback_timeout": 60,
  "default_confidence": 0.7,
  "require_review_by_default": true
}
EOF
```

`api_timeout` bounds a recall and the other reads (8 s; 1 to 30). `writeback_timeout` bounds each write-back request, and exit's wait for write-backs (60 s; 8 to 255): each memory written back is a capture with its model calls, one after another.

**2. Set the access key in `~/.hermes/.env`:**

```bash
echo 'OPENBRAIN_KEY=<your-brain-key>' >> ~/.hermes/.env
echo 'OPENBRAIN_URL=https://<host>/api/v1/plugins/agent-memory' >> ~/.hermes/.env
```

**3. Tell Hermes to use the provider:**

```bash
hermes config set memory.provider ob1
```

> [!TIP]
> Environment variables override `ob1.json` — useful for switching workspaces per shell (`OPENBRAIN_WORKSPACE_ID=staging hermes ...`).

**Done when:** `hermes -z "Tell me what memory provider is active."` mentions OpenBrain in its response.

![Step 4](https://img.shields.io/badge/Step_4-Verify_End_to_End-1E88E5?style=for-the-badge)

Drive a real turn and confirm the writeback lands:

```bash
hermes -z "Decision: we will use Postgres for the queue. Lesson: always run migrations off-hours."
```

Then list Hermes' memories in the workspace (`default` unless you set another):

```bash
curl -sS "https://<host>/api/v1/plugins/agent-memory/memories?workspace_id=default&runtime_name=hermes&limit=5" \
  -H "x-brain-key: $OPENBRAIN_KEY"
```

**Done when:** You see memories whose `provenance.runtime` is `hermes`, whose `provenance.model` is the model your Hermes is configured to use (e.g. `anthropic/claude-opus-4.6`), and whose content matches your test turn.

## Expected Outcome

Once installed and configured:

- **Every Hermes turn auto-recalls.** When the LLM is reasoning, recent and similar OB1 memories are silently injected as `<ob1-context>` in the system prompt.
- **Every meaningful turn auto-writes.** The user's question + a summary of the assistant's response lands in the plugin's memories as a turn-summary `output`. Trivial messages (`ok`, `thanks`) and short replies are skipped.
- **Session end produces structured findings.** When Hermes exits, conversation lines matching decision / lesson / constraint / next_step / question / failure patterns are extracted into OB1's structured payload categories, up to ten of each, and written back in parts of ten. Exit waits for them at most `writeback_timeout` (60 s), shared with any background write-back still running; findings not sent by then are dropped and logged at warning.
- **Compression preserves findings.** When Hermes hits a context-compression boundary, structured findings from the about-to-be-compressed messages are extracted, written back to OB1, and folded into the compression summary.
- **Seven tools are available** to the agent for explicit memory ops:
  - `ob1_recall` — task-scoped recall
  - `ob1_writeback` — structured store
  - `ob1_search` — alias for recall
  - `ob1_report_usage` — close the loop on which recalled memories were useful
  - `ob1_list_review_queue` — what's pending review
  - `ob1_review_memory` — confirm / reject / edit / evidence-only
  - `ob1_get_recall_trace` — debug what came back

## Troubleshooting

### `hermes -z` returns instantly but no memory is written

The provider silently no-ops when `OPENBRAIN_KEY` is not set or the endpoint is empty. Verify both:

```bash
hermes config get memory.provider     # must be: ob1
cat ~/.hermes/ob1.json | grep endpoint  # must be your plugin URL, ending /api/v1/plugins/agent-memory
grep OPENBRAIN_KEY ~/.hermes/.env       # must be present
```

### Writebacks land but `provenance.model` is blank

Hermes' `run_agent.py` doesn't pass `model` to `on_turn_start`, so the provider falls back to reading `~/.hermes/config.yaml`. Confirm the config has a real model:

```bash
grep -A2 '^model:' ~/.hermes/config.yaml
```

If the value is `auto` for the provider field, the plugin derives the provider from the model prefix (`anthropic/...` → `anthropic`, `openrouter/...` → `openrouter`). For provider-less model names, the provider will read `unknown` — set an explicit `model.provider` in `config.yaml` if you need accuracy.

### Recall returns 0 memories even when matches obviously exist

The plugin leaves out memories outside the recall's scope: another project's, stale or rejected ones, and those still waiting for a person's confirmation unless `include_unconfirmed_recall` is on (it is by default). Its README's Troubleshooting ("A recall answers no memories") lists each and the flag that lets it in.

### `HTTP 4xx` or `503` errors in Hermes logs

Each names the plugin's refusal code (`OB1 POST /recall failed: HTTP 400 REFUSED_INPUT`), which [its README's Troubleshooting](../../plugins/agent-memory/README.md#troubleshooting) explains. `REFUSED_INPUT` means the body was not the contract's: the plugin refuses a field it does not know. `401` is the key, `403 FORBIDDEN` a key whose scope does not reach the route, and `503 PROVIDER_UNAVAILABLE` the brain's embedding provider not answering a recall (send it again). If you're modifying the provider, run the test suite (below) before installing.

### Subagent runs are corrupting the parent agent's task_id

The provider auto-disables writes when invoked with `agent_context in ("subagent", "cron", "flush")`. Hermes sets `agent_context` automatically for these cases — if you're driving the provider from a custom runner, set it yourself when calling `initialize()`.

## Repository Layout

```
integrations/hermes-agent-memory/
├── README.md            # this file
├── metadata.json        # OB1 contribution metadata
├── CHANGELOG.md         # release notes
└── plugin/
    ├── __init__.py      # OB1MemoryProvider implementation
    ├── plugin.yaml      # Hermes plugin metadata
    └── tests/
        ├── __init__.py
        └── test_ob1_provider.py
```

## Tests

```bash
pytest plugin/tests/
```

Run them in Hermes' Python environment, which has the `agent` and `tools` modules the plugin imports. 105 tests cover pure helpers, schema shapes and routes on the wire, the plugin's refusal codes, a write-back sent in parts and exit's deadline, lifecycle, prefetch + cache TTL, sync_turn, session-end, pre-compress, and the seven tool handlers. Network is mocked at `urllib.request.urlopen` — tests run offline.
