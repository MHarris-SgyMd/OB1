# NBJ OB1 Agent Memory for OpenClaw 0.2.0

The client calls the brain's agent-memory plugin (`plugins/agent-memory`),
which replaces the standalone Agent Memory API server after the brain's 2.0.0
(SMD-2690). On a brain still running that server, keep 0.1.6.

## Changed

- `endpoint` is the plugin's routes, `https://<host>/api/v1/plugins/agent-memory`
  (`http://127.0.0.1:8000/api/v1/plugins/agent-memory` on the brain's machine).
  The key is still sent as `x-brain-key`. A key with write scope reaches every
  tool; a read key recall, inspection, the queue and the trace; a capture-only
  key the write-back alone, answered each memory's ids alone.
- Routes: usage is `POST /recalls/{request_id}/usage`, a recall trace
  `GET /recalls/{request_id}`, and the review queue `GET /review-queue`. The
  `content-type` header goes only with a body, and an id in a path is encoded.
- A refusal throws `AgentMemoryError`, whose message, `code` and `status` name
  the plugin's refusal code (`OB1 agent-memory POST /recall 400 REFUSED_INPUT`);
  a retryable 503 carries its `Retry-After`. A body that is not JSON (a
  proxy's error page, or a 2xx from an endpoint that is not the plugin's) and
  a 2xx that is no JSON object, an empty one among them, throw one too, never
  a bare parse error.
- Each call passes on only the fields its route takes: the plugin refuses a
  field it does not name, so one a model adds to a tool's arguments is
  dropped rather than failing the call.
- `openbrain_review_memory` no longer takes `actor_id`, which the plugin
  refuses, and its `visibility` is one of the plugin's five.
- `openbrain_inspect_memory` answers the plugin's
  `{memory, source_refs, models_used, relations}`, and the memory corpus reads
  the memory from it, its id from `memory_id` and its time from `freshness`
  (the mapping is `corpusHits` and `corpusDocument` in `src/client.ts`).
- `dist/index.js` ships the explicit tool schemas of 0.1.5
  (`src/tool-schemas.js`, the ones `schema:check` reads): `src/index.ts`
  declared its own copies beside the import, and the build kept those, so the
  record schemas 0.1.5 replaced were what shipped.

## Verification Target

Against a brain with the agent-memory plugin on, `npm run smoke:native`
calls every `openbrain_*` tool with no failures, and runtime inspect shows
version `0.2.0`. The repository's `server-portable/test-plugin-ports.ts` drives
the client against the plugin's routes.
