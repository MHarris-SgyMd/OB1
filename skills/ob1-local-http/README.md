# OB1 Local HTTP

Skill pack that lets Claude Code (or any skill-aware AI coding tool) capture, search and browse thoughts in an Open Brain over plain HTTP, with no MCP transport involved. Pairs with the brain's REST gateway, [`integrations/open-brain-rest`](../../integrations/open-brain-rest/), running on the stack [`SETUP.md`](../../SETUP.md) builds.

> Until SMD-1800 this skill paired with the `local-brain-no-mcp` recipe — a self-hosted Supabase stack whose three Edge Functions it called through Kong. That recipe is retired: the fork's own stack already runs without a cloud, and the gateway is its HTTP surface without MCP. The skill's job is unchanged; its three `curl` calls now name the gateway's routes and present an access key instead of a Supabase anon JWT.

## What it does

Tells the AI coding tool, in `SKILL.md`, how to:

1. Recognize when the user wants to capture, search, or browse thoughts.
2. Translate those intents into authenticated HTTP calls (`curl`) against the gateway: `POST /capture`, `POST /search`, `GET /thoughts`.
3. Surface results, score-ordered for searches, time-ordered for browses, and confirmation ids for captures.

No MCP server is started, registered, or referenced. The skill is pure bash-via-curl.

## Prerequisites

- A brain built as `SETUP.md` describes, with two conditions the gateway adds. **Its embedding width:** the gateway embeds through OpenRouter with `openai/text-embedding-3-small` (1536 wide, fixed in its code), so build the brain at `OB1_EMBEDDING_MODEL=openai/text-embedding-3-small` and `OB1_EMBEDDING_DIM=1536` — `SETUP.md`'s local default (1024) makes every capture and semantic search answer 500, since `upsert_thought` refuses another width (the gateway's README says the same). **Its columns:** apply `schemas/enhanced-thoughts/schema.sql` and `schemas/workflow-status/migration.sql` after the migrations; every read selects them.
- The gateway running against that brain on a host this dev host can reach — from a checkout of this repository, on the brain host, after `cd extensions && bun install` (the vendored servers resolve their packages from that install):

  ```sh
  PORT=8787 NODE_PATH=extensions/node_modules \
    SUPABASE_URL='postgres://user:password@host:5432/openbrain' \
    MCP_ACCESS_KEYS='laptop:write:<sha256-of-the-key>' OPENROUTER_API_KEY='…' \
    bun integrations/open-brain-rest/index.ts
  ```

  The gateway's [README](../../integrations/open-brain-rest/README.md) has the variables and how to mint a key; bind it to an address the office network reaches, behind TLS if the network is not yours. Captures and semantic searches leave the brain host for OpenRouter (the text they embed); `"mode":"text"` searches and browsing do not.
- Claude Code (or a compatible skill-aware AI tool) installed on this dev host.
- `curl` installed (default on every Linux and macOS).

## Setup

1. Get the gateway's URL and a key. The brain admin mints one `name:scope:sha256` entry per dev host into the gateway's `MCP_ACCESS_KEYS` (`write` scope to capture; `read` to search and browse only) and hands the raw key to that host — the gateway holds only the hash.

2. On this dev host, export both as environment variables (add them to your shell rc file so they persist):

   ```sh
   export BRAIN_URL="http://brain.local:8787"
   export BRAIN_KEY="<the raw key>"
   ```

3. Install the skill into your AI tool's skills directory. For Claude Code:

   ```sh
   mkdir -p ~/.claude/skills
   cp -r skills/ob1-local-http ~/.claude/skills/
   ```

   For other tools, copy the directory into wherever they read skills from.

4. Verify reachability:

   ```sh
   curl -fsS "$BRAIN_URL/health" -H "x-brain-key: $BRAIN_KEY"
   ```

   Expected: HTTP 200 with `{"ok":true,"status":"ok","service":"open-brain-rest",…}`.

## Expected outcome

When asking Claude Code things like "remember that the Q3 sales review is on the 14th" or "what did I note about the Apex deal", the tool calls the gateway over curl and confirms or returns matches, without ever invoking an MCP feature.

## Troubleshooting

- **Skill not picked up**: confirm Claude Code's skills directory and that `SKILL.md` is at `<skills-dir>/ob1-local-http/SKILL.md`.
- **`BRAIN_URL` or `BRAIN_KEY` not set**: re-source your shell rc or export them in the current shell.
- **HTTP 401**: the key is wrong or was revoked. Ask the brain admin for the entry in the gateway's `MCP_ACCESS_KEYS`.
- **HTTP 403 on capture**: the key is read-scoped. Ask for a `write` key.
- **HTTP 500 on capture or search**: OpenRouter unreachable or the key unset, or the brain built at another embedding width than 1536 — gateway-side, not this dev host's; see the failure modes in `SKILL.md`.
- **HTTP 500 on browse**: the two schemas above are not applied.
