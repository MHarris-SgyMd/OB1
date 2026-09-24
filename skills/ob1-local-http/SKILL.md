---
name: ob1-local-http
description: |
  Capture, search and browse thoughts in an Open Brain over plain HTTP, with
  no MCP transport involved. Use this skill where Claude Code's MCP feature
  is disabled or the network blocks remote MCP endpoints, but the brain's
  REST gateway (`integrations/open-brain-rest`, on the stack `SETUP.md`
  builds) is reachable. Triggers: prompts like "remember this", "save that
  for later", "what did I note about X", "search my brain for Y", "what
  thoughts touched on Z", or any explicit request to record or recall
  personal memory.
author: dhanjit
version: 0.2.0
---

# OB1 Local HTTP

## Problem

The canonical Open Brain path is a remote MCP server. In environments that
disable MCP entirely -- corporate networks, air-gapped offices, restricted
Claude Code builds -- that path is not available. This skill replaces it with
`curl` calls to the brain's REST gateway, `integrations/open-brain-rest`,
keeping the same capture-and-recall behavior without any MCP protocol
involvement. (Until SMD-1800 the skill called a self-hosted Supabase stack's
Edge Functions, the retired `local-brain-no-mcp` recipe; the gateway runs on
the fork's own stack, no Supabase.)

## When to Use

- The user wants to remember, record, save, capture, or note something.
- The user wants to search, recall, retrieve, find, or look up something
  they previously captured.
- The user wants to see recent thoughts (e.g. "what have I been thinking
  about", "show me today's notes").

## When Not to Use

- The environment has a working remote Open Brain MCP connection -- prefer
  the canonical MCP-based capture/search tools.
- The required environment variables `BRAIN_URL` and `BRAIN_KEY` are not set
  on the dev host -- this skill cannot function without them; ask the user to
  follow this skill's README first (the brain must be built at the gateway's
  embedding width and carry the two schemas the README names, or capture,
  search and browse answer 500).

## Required Environment

On each dev host that will use this skill, the user must export:

```sh
export BRAIN_URL="http://<brain-host>:8787"   # where open-brain-rest listens
export BRAIN_KEY="<the raw access key>"        # a write-scoped key minted for this host
```

If either is missing, stop and tell the user. Do not guess values. A
read-scoped key can search and browse but every capture answers HTTP 403.

## Process

Every call presents the key as `x-brain-key`. The gateway also accepts
`x-access-key`, `?key=` and a bearer token. The commands use `curl -sS`, not
`-f`: a refusal's JSON body (`{"error":"…"}`) is what tells you why, and `-f`
would hide it.

### Capture

When the user says something like "remember X" or "save this thought":

```sh
curl -sS -X POST "$BRAIN_URL/capture" \
  -H "x-brain-key: $BRAIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"<the thought>","source_type":"claude-code"}'
```

Optional fields: `type` (any string; the gateway's extractor uses
`observation`, `task`, `idea`, `reference`, `person_note` among others),
`metadata` (an object; when given, the gateway stores it as is instead of
extracting metadata with its model), `importance` and `quality_score` (0-100),
`sensitivity_tier`, `status`. The brain fingerprints content and de-duplicates
-- re-capturing identical text answers `"action":"updated"` with the existing
`thought_id`.

### Search

When the user wants to recall:

```sh
curl -sS -X POST "$BRAIN_URL/search" \
  -H "x-brain-key: $BRAIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"<what to find>","limit":10,"threshold":0.3}'
```

`mode` defaults to `semantic` (by meaning); `"mode":"text"` matches words.
`threshold` defaults to 0.35. Lower it to 0.2-0.3 for broader recall; raise to
0.5+ for precision. Cap `limit` at 100. The reply is
`{"results":[…],"count":N,"total":M,"page":1,"per_page":10,"total_pages":…}`;
each result carries `id`, `content`, `type`, `metadata`, `created_at` and, in
semantic mode, `similarity`.

### Browse recent

When the user asks "what have I been thinking about" or wants a list rather
than a similarity search:

```sh
curl -sS "$BRAIN_URL/thoughts?per_page=20&page=1" \
  -H "x-brain-key: $BRAIN_KEY"
```

Optional filters: `type=task`, `source_type=claude-code`, `status=new`. The
reply is `{"data":[…],"total":N,"page":1,"per_page":20}`, newest first.

## Output

- For captures: confirm the `thought_id` and whether it was `created` or
  `updated` (already captured) to the user in one sentence. Don't paraphrase
  the captured content back at them.
- For searches: surface the top results with similarity scores and
  created_at timestamps. Order by similarity descending. If no results
  cross the threshold, say so plainly and suggest lowering it.
- For browse: a compact bullet list with truncated content (first ~120
  chars) and timestamps.

## Failure Modes

- HTTP 401 `Invalid or missing access key`: `BRAIN_KEY` is wrong or was
  revoked. Tell the user to check the key against the gateway's
  `MCP_ACCESS_KEYS`.
- HTTP 403 `Forbidden: this key is read-scoped and this route writes`: the
  key can search and browse but not capture. Tell the user to mint a
  write-scoped key.
- HTTP 500 on capture or semantic search: the gateway could not reach
  OpenRouter (`OPENROUTER_API_KEY` unset or wrong), or the brain was built at
  another embedding width than the gateway's model (1536) and refused the
  vector. Tell the user to check the gateway's log; `"mode":"text"` search
  works without a provider.
- HTTP 500 on browse (`/thoughts`): the brain lacks the columns the two
  schemas in the README add. Tell the user to apply them.
- Connection refused or a network timeout: the gateway is down or the host is
  unreachable. Tell the user to check the process and ping the brain host from
  this dev host.

## Notes

- Never log or echo `BRAIN_KEY`.
- This skill never installs or invokes any MCP server, by design.
- The gateway generates embeddings itself; this dev host needs no model.
