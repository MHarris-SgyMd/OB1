# OB1 Local HTTP

Skill pack that lets Claude Code (or any skill-aware AI coding tool) capture, search and browse thoughts in an Open Brain over plain HTTP, with no MCP transport involved. It calls the brain's REST core — every operation the MCP tools expose, as JSON — at `/api` on the brain's origin, on the stack [`SETUP.md`](../../SETUP.md) builds.

> The skill called the `open-brain-rest` gateway until SMD-1931 retired it in favour of the REST core, and a self-hosted Supabase stack's Edge Functions (the `local-brain-no-mcp` recipe) before SMD-1800. Its job is unchanged: three `curl` calls, an access key in a header.

## What it does

Tells the AI coding tool, in `SKILL.md`, how to:

1. Recognize when the user wants to capture, search, or browse thoughts.
2. Translate those intents into authenticated HTTP calls (`curl`) against the REST core: `POST /v1/thoughts`, `POST /v1/search`, `GET /v1/thoughts`.
3. Surface results, ranked for searches, time-ordered for browses, and the id for captures.

No MCP server is started, registered, or referenced. The skill is pure bash-via-curl.

## Prerequisites

- A brain built as `SETUP.md` describes, with the REST core's `/api` route on: the operator names `deploy/compose.api-public.yaml` beside `compose.yaml` ([`deploy/README.md`](../../deploy/README.md), "The REST core and its opt-in `/api`"). Without it the proxy answers `/api` with an empty 404.
- The brain's origin reachable from this dev host — over TLS if the network is not yours, since the key rides every request.
- Claude Code (or a compatible skill-aware AI tool) installed on this dev host.
- `curl` installed (default on every Linux and macOS).

## Setup

1. Get the brain's URL and a key. The brain admin mints one key per dev host with `cd server-portable && bun keygen.ts --name <host> --scope write`, adds the printed line to the brain's `MCP_ACCESS_KEYS` and hands the raw key to that host — the brain holds only the hash. A `read` key searches and browses only; a `capture` key captures only.

2. On this dev host, export both as environment variables (add them to your shell rc file so they persist):

   ```sh
   export BRAIN_URL="https://brain.example.com/api"
   export BRAIN_KEY="<the raw key>"
   ```

3. Install the skill into your AI tool's skills directory. For Claude Code:

   ```sh
   mkdir -p ~/.claude/skills
   cp -r skills/ob1-local-http ~/.claude/skills/
   ```

   For other tools, copy the directory into wherever they read skills from.

4. Verify reachability and the key:

   ```sh
   curl -sS "$BRAIN_URL/v1/whoami" -H "x-brain-key: $BRAIN_KEY"
   ```

   Expected: HTTP 200 with the key's `name`, its `scope` and the `operations` it may call — `capture_thought`, `search_thoughts` and `list_thoughts` among them for a write key.

## Expected outcome

When asking Claude Code things like "remember that the Q3 sales review is on the 14th" or "what did I note about the Apex deal", the tool calls the REST core over curl and confirms or returns matches, without ever invoking an MCP feature.

## Troubleshooting

- **Skill not picked up**: confirm Claude Code's skills directory and that `SKILL.md` is at `<skills-dir>/ob1-local-http/SKILL.md`.
- **`BRAIN_URL` or `BRAIN_KEY` not set**: re-source your shell rc or export them in the current shell.
- **HTTP 401 (`UNAUTHORIZED`, `REVOKED`)**: the key is wrong or was revoked. Ask the brain admin for a new one.
- **HTTP 403 (`FORBIDDEN`)**: the key's scope does not reach the operation; the body's `needs` names the scope it takes.
- **HTTP 404 with an empty body on every route**: `/api` is off on this brain (Prerequisites).
- **HTTP 500 (`FAILED`)**: the body carries the brain's message. A provider the brain could not reach is the brain admin's to fix, not this dev host's.
