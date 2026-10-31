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
  is typed from the document: for an operation that takes input, a missing required field
  or one it does not take fails to compile. TypeScript checks no excess field against
  an operation that takes none (`brain_info`), and the REST core refuses one
  (`REFUSED_INPUT`).
- **The input is what the tool's schema accepts.** The MCP server's SDK checks it there
  first, and a TypeScript caller's types hold it. The REST core checks again what
  arrives, but a query string carries text: a `null` or `undefined` there is left out,
  and `"true"` reads as `true`, where the schema itself would refuse both.
- **Every status is an answer** (`{ status, ok, headers, body, sent }`); an error with
  an empty body has `body: null`. Only a request that never got one throws: the core
  away, the timeout, the caller's signal. A write that threw may still have landed,
  because the server finishes what it started. That holds for an input of JSON values,
  as the MCP server and a typed caller send. A value JSON cannot carry (a bigint, a
  cycle, a symbol) throws as `JSON.stringify` does, and so does a `headers()` value no
  header can carry.
- **`baseUrl`** is an http or https origin, or an origin and a path. `createRestClient`
  refuses any other with a `TypeError`. That covers another scheme, credentials in the
  URL (fetch would send them as an `Authorization` header), a query or a fragment (a
  bare `?` or `#` included), a space or a control character anywhere (the parser drops
  a tab or a line break even from a host), and a path the URL parser rewrites (a dot
  segment, encoded or not). It also refuses a `forwarderKey` that no header carries as
  written, and a `timeoutMs` that is not a whole number of milliseconds from 1 to
  2^31 - 1, the longest a timer holds.
- **A redirect is an answer**, not followed: fetch carries custom headers to the next
  origin, and the key and the forwarder key ride them.
- **An input a URL cannot carry** is answered without sending anything (`sent: false`),
  with the REST core's own refusal, a 400 `REFUSED_INPUT` naming the field. That covers:
  - a path field that is missing, not a string, empty, `.` or `..`. The URL parser
    removes a dot segment however it is encoded, so such a request would reach
    another route.
  - text with a lone surrogate in the path or the query. A JSON body carries one.
  - an object, or a list holding one, in a GET's or a DELETE's input, which a query
    string has no form for.
  - a query field name that is not letters, digits, `_`, `.` or `-`. A name rides the
    URL as it is, so a `#` in one would make the rest a fragment.

  A GET's input rides the URL, so it is held to the server's header limit. Measured on
  Bun 1.4, a 16,000-character field passes and a 64,000-character one is a bodyless 431.
  Free text a search runs on goes in a body.
- **A success's value** is typed only as an object, which is all the document says of
  it. A caller that renders it holds it to the type its renderer reads, and the MCP
  server's renderer is held to the REST answers by `server-portable/test-rest-sql.ts`.
- **The key** goes in `x-brain-key`. A key no header carries as presented gets the REST
  core's own answer to a key that matches none, a 401 `UNAUTHORIZED`, given here with
  nothing sent. A key is sent only if it rides the header byte for byte: tab,
  printable ASCII and U+0080–U+00FF, with no space or tab at either end. DEL is left
  out, because a Go server, Traefik on the `/api` route, refuses it. A `null` key is no
  key. HTTP
  strips those, and `Headers` strips a CR or LF there, so ` k ` or `\rk` would arrive
  as `k`, which is another key. The other control characters are refused too: Bun's
  server answers them with a bare 400. A key holding `é`, or a tab inside, is sent. A legacy raw
  `MCP_ACCESS_KEY` past U+00FF, which `?key=` carried to server-portable's `index.ts`
  until SMD-2287 PR 6b retired it, cannot reach the REST core at all, so it reaches no
  server now: its client needs a new key (`deploy/README.md`, "Upgrading a stack from
  before SMD-2287 PR 6b"). **`forwarderKey`** goes in `x-brain-forwarder` on every
  call: it names who carried the request (`act`) and grants nothing. A refusal carried
  that way also holds itself whole as `refusal`, the words its facts leave out
  included, so the MCP server words it exactly as it always has.
- **`headers()`** adds headers to each request as it is sent, such as the calling
  span's `traceparent`. It may not set a key's header (`x-brain-key`, `x-access-key`,
  `authorization`) or the forwarder slot; any it names are left out.
- **`stream(jobId)`** returns a job's event stream as the response itself, unread, or a
  refusal's JSON. `call` takes every operation but that one.
- **The timeout** bounds a `call` to its whole answer, and a `stream` only until the
  answer's headers arrive: after that the stream runs as long as its job does. Both
  the timeout and the caller's signal end the wait for an answer's headers even
  through a `fetch` that does not heed the signal, such as a suite's in-process
  `app.fetch`. Reading a `call`'s body is bounded only by a fetch that does heed it, as
  `globalThis.fetch` does. A
  signal already aborted sends nothing, and an answer that arrives after the abort is
  cancelled unread. On an open stream, the caller's signal aborts the request, which
  ends the body of a fetch that heeds it, as `globalThis.fetch` does.
- **`callPath(method, path, input, init)`** calls an enabled plugin's operation
  (SMD-2310), which no committed document names, by its method and its manifest's
  route: `/v1/plugins/<name>/…` with `{field}` segments. Its input is sent and its
  answer read as `call`'s are, local refusals and the timeout included. A route of
  any other shape, or another method, rejects.
- **`raw`** is the openapi-fetch client, for a caller that names a path itself. It
  carries the forwarder slot and the extra headers, but no timeout: bound it with
  your own `signal`.

## Regenerate

After a change to a route, an input schema or a description in `server-portable/`:

```bash
(cd server-portable && bun install)
cd rest-client && bun install && bun generate.ts
```

`bun test-client.ts` fails while a generated file is stale. CI runs it in the
portable-server job, after server-portable's install, since the generator and the suite
import `../server-portable`; without that install they fail at import, naming the
package, since this directory's `bunfig.toml` turns Bun's auto-install off (SMD-2978). The document's version is the release's, which every cut
bumps, so the generated files carry `snapshot` in its place.

## Test

```bash
bun test-client.ts   # 156 — the generated files current, every operation's route, every operation through the client into the real REST app over a stub core, the key, forwarder and extra headers, any status an answer, an input a URL cannot carry or a key no header can answered unsent, the configuration held at the start, the timeout and the signal (a stream's until its headers), a late answer cancelled, a job's stream unread, a redirect an answer, no extra header a key, a key byte for byte or not at all, a base as written, no object in a query, a timeout a timer holds, a query name a URL carries; a plugin's operation by its route, its path filled, the rest in the query or the body, a forwarded refusal whole, a path field holding a line break, a route or method no plugin's rejected
```
