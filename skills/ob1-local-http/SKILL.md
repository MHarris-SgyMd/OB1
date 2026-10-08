---
name: ob1-local-http
description: |
  Capture, search and browse thoughts in an Open Brain over plain HTTP, with
  no MCP transport involved. Use this skill where Claude Code's MCP feature
  is disabled or the network blocks remote MCP endpoints, but the brain's
  REST core (`/api` on the brain's origin, as this skill's README says) is
  reachable. Triggers: prompts like "remember this", "save that for later",
  "what did I note about X", "search my brain for Y", "what thoughts touched
  on Z", or any explicit request to record or recall personal memory.
author: dhanjit
version: 0.3.0
---

# OB1 Local HTTP

## Problem

The canonical Open Brain path is a remote MCP server. In environments that
disable MCP entirely -- corporate networks, air-gapped offices, restricted
Claude Code builds -- that path is not available. This skill replaces it with
`curl` calls to the brain's REST core, the same operations the MCP tools
expose, as JSON. (It called the `open-brain-rest` gateway until SMD-1931
retired it, and a self-hosted Supabase stack's Edge Functions before
SMD-1800.)

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
  follow this skill's README first.

## Required Environment

On each dev host that will use this skill, the user must export:

```sh
export BRAIN_URL="https://<brain-host>/api"   # the brain's origin with /api
export BRAIN_KEY="<the raw access key>"        # a write-scoped key minted for this host
```

If either is missing, stop and tell the user. Do not guess values. A
read-scoped key can search and browse but every capture answers HTTP 403; a
capture-scoped key can capture but not search or browse.

## Process

Every call presents the key as `x-brain-key` (the REST core also takes
`x-access-key` and a bearer token, never `?key=`). The commands use `curl -sS`,
not `-f`: a refusal's JSON body (`{"code":"…", …}`) is what tells you why, and
`-f` would hide it.

### Capture

When the user says something like "remember X" or "save this thought":

```sh
curl -sS -X POST "$BRAIN_URL/v1/thoughts" \
  -H "x-brain-key: $BRAIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"<the thought>","source":"claude-code"}'
```

Answers 201 with the thought's `id`. `existed: true` means the same text was
already a thought and that one is the answer. Optional fields: `metadata`
(at most eight lower-case keys with string, number or boolean values; the
brain's own keys such as `type` and `topics` are refused -- its extractor sets
them), `trust` (`ingested` for text copied in from elsewhere), `supersedes`
(the id of a thought this one replaces).

### Search

When the user wants to recall:

```sh
curl -sS -X POST "$BRAIN_URL/v1/search" \
  -H "x-brain-key: $BRAIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"<what to find>","limit":10}'
```

Search is by meaning, with the identifiers in the query matched exactly. The
reply is `{"query":…,"hits":[…],…}`; each hit carries `id`, `content`,
`metadata`, `created_at`, `similarity` and `supersededBy` (the id of a newer
thought that replaced it, or null). `limit` is clamped to 1-100; `threshold`
(0-1) drops hits below that similarity. For every thought containing an exact
string, page through `POST $BRAIN_URL/v1/search/keyword` with
`{"query":"<text>","limit":20,"offset":0}`; its reply carries `total`.

### Browse recent

When the user asks "what have I been thinking about" or wants a list rather
than a similarity search:

```sh
curl -sS "$BRAIN_URL/v1/thoughts?limit=20" \
  -H "x-brain-key: $BRAIN_KEY"
```

Optional filters: `type=task`, `topic=…`, `person=…`, `days=7`. The reply is
`{"thoughts":[…]}`, newest first.

## Output

- For captures: confirm the `id`, and say when `existed` is true (the text was
  already captured), in one sentence. Don't paraphrase the captured content
  back at them.
- For searches: surface the top hits with similarity scores and created_at
  timestamps, in the order given. Mention a hit's `supersededBy` when it is
  set. If there are no hits, say so plainly and suggest rephrasing.
- For browse: a compact bullet list with truncated content (first ~120
  chars) and timestamps.

## Failure Modes

- HTTP 401 `UNAUTHORIZED` or `REVOKED`: `BRAIN_KEY` is wrong or was revoked.
  Tell the user to ask the brain admin for a key.
- HTTP 403 `FORBIDDEN` (with `needs`): the key's scope does not reach the
  operation -- a read key capturing, or a capture key searching. Tell the user
  which scope `needs` names.
- HTTP 400 `REFUSED_INPUT` or another `REFUSED_*` code: the request's shape;
  the body names the field. Fix it and retry once.
- HTTP 404 with an empty body on every route: `/api` is off on this brain (the
  stack's proxy answers 404 until the operator turns it on). Tell the user.
- HTTP 503 with `Retry-After`: retry after that many seconds.
- Connection refused or a network timeout: the brain is down or the host is
  unreachable. Tell the user to check it from this dev host.

## Notes

- Never log or echo `BRAIN_KEY`.
- This skill never installs or invokes any MCP server, by design.
- The brain embeds and extracts on its own host; this dev host needs no model.
