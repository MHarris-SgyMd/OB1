# Extension N: Extension Name

<!--
=============================================================================
TEMPLATE INSTRUCTIONS (for contributors and AI assistants)
=============================================================================

An extension is a guide plus a plugin (SMD-2311; this template since
SMD-3747). The guide, this file, goes to extensions/<name>/README.md with
metadata.json beside it: it walks a person through turning the plugin on and
using it, and teaches the concepts. The plugin, the plugin/ directory here,
goes to plugins/<name>/: the code (index.ts), its tables (migrations/), its
reference README and its metadata. AGENT_SPEC.md says how the pieces fit.

Extensions are curated: discuss a new one with the maintainers first
(extensions/README.md, "Contributing").

REPLACE all instances of:
  - "Extension Name" with the extension's name
  - "extension-name" with its slug (lower-case words joined by hyphens), the
    plugin's directory and OB1_PLUGINS name
  - "extension_name" with the tool prefix: the slug, hyphens as underscores
  - "N" with its place in the learning path

DELETE this comment block before submitting your PR.
=============================================================================
-->

## Why This Matters

Lead with the human pain point. What real-life moment makes this worth building? Use specific, relatable examples, not tech specs.

## Learning Path: Extension N of 6

| Extension | Name | Status |
|-----------|------|--------|
| 1 | [Household Knowledge Base](../household-knowledge/) | |
| 2 | [Home Maintenance Tracker](../home-maintenance/) | |
| 3 | [Family Calendar](../family-calendar/) | |
| 4 | [Meal Planning & Recipes](../meal-planning/) | |
| 5 | [Professional CRM](../professional-crm/) | |
| 6 | [Job Hunt Pipeline](../job-hunt/) | |

> Mark this extension's row in bold with **<-- You are here**.

## What It Does

One or two sentences on what this adds to the brain.

On this fork the extension is a **plugin**: [`plugins/extension-name`](../../plugins/extension-name/). It runs inside the brain's own servers, behind the brain's own keys, and its tools appear on the MCP connector you already have. There is no separate server, key list or connector to set up. Its tables live in a schema of its own, `plugin_extension_name`, which the brain's migrator makes when you turn the plugin on.

**Tables:**
- `entries`: what each row holds

**Tools** (each also a REST route under `/v1/plugins/extension-name/`):
- `extension_name_add_entry`: when an agent uses it
- `extension_name_search_entries`: when an agent uses it
- `extension_name_get_entry`: when an agent uses it

The plugin's [README](../../plugins/extension-name/README.md) gives each one's input, output and refusals.

## What You'll Learn

- Concept or technique 1
- Concept or technique 2
- How a brain's plugin serves tools behind the brain's own keys

## Prerequisites

- Working Open Brain setup: the compose stack ([`SETUP.md`](../../SETUP.md)) and an MCP client connected to it ([Getting Started](../../docs/01-getting-started.md), Steps 6 and 7)
- Any earlier extensions this one builds on

## Steps

### 1. Turn on the Plugin

Add the plugin to `deploy/.env`, with the secret the plugins' database logins are derived from (skip the second line if another plugin already set it):

```
OB1_PLUGINS=extension-name
OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
```

Names are comma-separated: keep the plugins already turned on in the list.

Then recreate the migrator and the servers from `deploy/`, naming the stack's other `-f` files as you brought it up:

```bash
docker compose up -d migrate api mcp
docker compose up -d --force-recreate --no-deps app   # the operator GUI, so it reaches the recreated REST core; it signs everyone out
```

The migrator makes the plugin's tables, and the servers start with its tools.

### 2. Check Your AI Sees It

Your MCP client lists the `extension_name_*` tools on the brain's own connector, once it refreshes its tool list. A read key sees the tools that read. A write key sees them all.

### 3. Test It

Try these prompts, each one exercising a tool:

```
A prompt that adds something
```

```
A prompt that finds it again
```

```
A prompt that asks for one in full
```

## Cross-Extension Integration

How this extension connects to the others: which patterns it reuses or introduces, and which of its tools another extension's prompts reach. This is the proof that extensions compound.

## Expected Outcome

After completing this extension, you should be able to:

1. What a person can now do
2. What a person can now ask

## Troubleshooting

For common issues (connection errors, 401s), see [Common Troubleshooting](../../primitives/troubleshooting/). The plugin's own troubleshooting is in [its README](../../plugins/extension-name/README.md#troubleshooting).

**Extension-specific issues:**

**No `extension_name_*` tools**
- Check that `OB1_PLUGINS` in `deploy/.env` names `extension-name`, and that the migrator and servers were recreated after it was set
- Refresh your client's tool list

**A second issue a person is likely to meet**
- Its fix

## Next Steps

**Extension N+1: Its Name**: what it adds, in a sentence or two.

[Continue to Extension N+1 →](../next-extension/README.md)

> **As you add extensions**, each one adds tool definitions to your AI's context window. It's worth thinking about which plugins you keep turned on. See the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) for strategies.

<!--
REQUIRED: every extension links docs/05-tool-audit.md in its README; the
automated review checks for it. Keep the link when you reword the blockquote.
-->
