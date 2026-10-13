# rest-client — the REST core's typed client

The brain's REST core (`server-portable/api.ts`, SMD-2284) is its contract: every
operation the MCP tools expose, as JSON. This directory is the client its other
servers call it through (SMD-2287): the MCP server as a client of the REST core, and
the operator GUI (SMD-2280). It is [openapi-fetch](https://openapi-ts.dev/openapi-fetch/)
over the types [openapi-typescript](https://openapi-ts.dev/) generates from the REST
core's own OpenAPI document.

| File | What it is |
|---|---|
| `openapi.json` | The document `server-portable/rest/openapi.ts` builds: the core operations. Generated. |
| `schema.d.ts` | The types openapi-typescript makes of it. Generated. |
| `operations.ts` | Each operation's method and path by its `operationId` (a core operation's is its MCP tool's name). Generated. |
| `index.ts` | `createRestClient`: the typed client, and a call by operation name. |
| `generate.ts` | Writes the three generated files. |
| `test-client.ts` | The suite. |

A plugin's operations (SMD-2310) are not in the document here: which plugins a brain
enables is its operator's choice, so they are called by the path their manifest
declares, under `/v1/plugins/<name>`.

## Use

```ts
import { createRestClient } from "../rest-client/index.ts";

const rest = createRestClient({
  baseUrl: "http://api.ob1.internal:8000", // on the stack's mesh; `<origin>/api` through the opt-in route
  forwarderKey: process.env.OB1_FORWARDER_KEY, // a forward-scope key, the MCP server's own; omit for a direct caller
  timeoutMs: 300_000,
});

const answer = await rest.call("search_thoughts", { query: "what did we decide", limit: 5 }, { key: callerKey });
if (answer.ok) render(answer.body);
else console.log(answer.status, answer.body); // { code, retryable, …facts }, and `refusal` when forwarded
```

- **`call(name, input, { key, signal })`** takes an operation's input as one object, as
  the MCP tool takes it: the path's fields fill the path, and the rest goes in the query
  string (GET, DELETE) or a JSON body (POST, PATCH), as the REST core reads it. The input
  is typed from the document, so a missing required field or a field the operation does
  not take fails to compile.
- **Every status is an answer** (`{ status, ok, headers, body }`). Only a request that
  never got one throws: the core away, the timeout, the caller's signal.
- **A success's value** is typed only as an object, which is all the document says of
  it. A caller that renders it holds it to the type its renderer reads, and the MCP
  server's renderer is held to the REST answers by `server-portable/test-rest-sql.ts`.
- **The key** goes in `x-brain-key`. **`forwarderKey`** goes in `x-brain-forwarder`
  on every call: it names who carried the request (`act`) and grants nothing. A
  refusal carried that way also holds itself whole as `refusal`, the words its facts
  leave out included, so the MCP server words it exactly as it always has.
- **`headers()`** adds headers to each request as it is sent, such as the calling
  span's `traceparent`.
- **`stream(jobId)`** returns a job's event stream as the response itself.
- **`raw`** is the openapi-fetch client, for a caller that names a path itself.

## Regenerate

After a change to a route, an input schema or a description in `server-portable/`:

```bash
cd rest-client && bun install && bun generate.ts
```

`bun test-client.ts` fails while a generated file is stale. CI runs it in the
portable-server job, after server-portable's install, since the generator and the suite
import `../server-portable`. The document's version is the release's, which every cut
bumps, so the generated files carry `snapshot` in its place.

## Test

```bash
bun test-client.ts   # 62 — the generated files current, every operation's route, every operation through the client into the real REST app over a stub core, the key, forwarder and extra headers, any status an answer, the timeout, a job's stream
```
