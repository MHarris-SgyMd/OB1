# 84. The MCP stack moves together — SDK 1.24.3 → 1.30.0, `@hono/mcp` 0.1.5 → 0.3.2, hono 4.9.2 → 4.13.8, zod 4.1.13 → 4.6.5: a second `connect()` on one server now throws, the transport takes whatever Accept a client sends and the fifteen Accept patches are gone, and every SDK import carries the `@ts-types` pragma Deno needs to type it (SMD-1643, SMD-1616)

**Why now.** Change 83 found that the defect it fixed had been fixed in the
library a year earlier and the fork's pins had not moved. A survey of every
pin against npm (2026-09-17) put the MCP stack eight to thirteen months
behind, and the four constrain each other — `@hono/mcp` 0.3.x wants the SDK at
^1.29, the SDK at 1.30 depends on hono ^4.11.4, both take zod ^3.25 or ^4 — so
they move as one. The SDK's v2 package family (2026-07-28, a new wire
revision) is not this: two months old, clients unsettled; the 1.x line it is.

**What the move buys.** Three things the fork had wanted. SDK **1.26.0**
(2026-02-04) addresses GHSA-345p-7cg4-v4c7, "sharing server/transport
instances can leak cross-client response data" — change 78's defect, with a
name: `Protocol.connect()` now throws `Already connected to a transport. Call
close() before connecting to a new transport, or use a separate Protocol
instance per connection.` where 1.24.3 overwrote the transport silently. The
shape change 78 removed by hand is refused at the runtime, on the first
overlap, loudly; `test-auth.ts` asserts the throw. `@hono/mcp` **0.3.0**
relaxes the POST Accept check: a missing header reads as `*/*`, and either
token — or `*/*` — is enough, where 0.1.x demanded both and answered 406 to
everything else (measured at 0.1.5: no Accept, `application/json` alone,
`text/event-stream` alone and `*/*` all 406; at 0.3.2 all 200). Every Accept
patch in the tree existed for that check — the re-wrap of the request into a
new `Request` with both tokens that upstream added for Claude Desktop
connectors (their #33), which the core server carried, the portable server
carried with change 75's either-missing predicate, twelve vendored servers
carried, and the cost recipe's after sample carried. **Fifteen files, all
removed**, twelve to twenty-one lines each. SMD-1616, the two servers that
never had one, closes with them: there is nothing left to be missing.
`test-auth.ts`'s overlapping probe now sends its first request with no Accept
header at all fourteen servers (the `acceptPatch` flag and its two rows are
gone), and asserts no server carries the patch; `test-server.ts` [7] sends
SSE-only, JSON-only and no Accept and gets 200 for each. SDK 1.30.0 also
fixed the SSE keep-alive timer lifecycle and widened `@hono/node-server` past
GHSA-frvp-7c67-39w9; 1.28.0 rejects a plain JSON Schema object passed as
`inputSchema` — nothing here passes one, or the suites would have said.

**The Deno trap.** With the pins moved, every suite passed under Bun and
`tsc --noEmit` passed under 5.9.3 and 6.0.3 — and CI's seven `deno check`
steps failed on the six files that build a server, every error the same:
`Binding element 'query' implicitly has an 'any' type` at each tool handler.
Bisected on a twenty-line probe with three tool shapes: SDK **1.28.0** types
clean under Deno 2.9.6, **1.29.0** does not, at either zod. 1.29.0's "Add
typings exports" (#1623) put `"types": "./dist/esm/*.d.ts"` in the `./*`
export. For `@modelcontextprotocol/sdk/server/mcp.js` that substitutes to
`dist/esm/server/mcp.js.d.ts`, a file that does not exist; TypeScript's
resolver then tries `.js` → `.d.ts` and finds `mcp.d.ts`, Deno's does not
and types the module as `any` — so every handler's arguments are `any`, and
`noImplicitAny` reports each. Tried and rejected: a `// @deno-types` pragma
at the `dist/esm/…d.ts` path (the exports map refuses `dist/` subpaths, in
`check` and `run` alike); an import-map entry aiming the `.js` specifier at
the dist file (refused the same way); `--node-modules-dir=auto` (same
resolver); the extensionless specifier `sdk/server/mcp` (types resolve — the
pattern gives `mcp.d.ts` — and **the runtime does not**: `Could not resolve
'npm:@modelcontextprotocol/sdk@1.30.0/server/mcp'`; the worst combination,
green check, dead deploy). What works: a **`// @ts-types="@modelcontextprotocol/sdk/server/mcp"`
pragma** on the line above the `.js` import — Deno reads the types through
the extensionless subpath, the runtime import is unchanged, and under Bun and
tsc the line is a comment. Twenty-two pragmas in twenty files: the seventeen
Deno-side files that import an SDK subpath (`server/mcp.js` everywhere,
`types.js` in the two single-tool integrations), the extension template
`AGENT_SPEC.md`, and the two READMEs that show the import line; the first in
each file carries a two-line note. `test-auth.ts` holds it: every SDK subpath
import in every MCP server it reads, enhanced-mcp, and the after sample's two
files is preceded by its pragma. Upstream, the SDK's pattern would want to be
`"types": "./dist/esm/*"`, which both resolvers handle; Deno could substitute
as tsc does. Neither filed.

**Beside the pins.** Two more things the release notes did not name, both
read out of 0.3.2's dist and neither present at 0.1.5. Every POST that is not
itself an initialize — whether or not the transport ever saw one; a stateless
transport skips the session check, not this one, so on the fourteen
per-request servers that is every tool call — is checked for the
`mcp-protocol-version` header: absent, it reads
as 2025-03-26 and passes; naming a version outside the SDK's list
(2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07 at 1.30.0) it is
refused with **404** and a "Bad Request: Unsupported protocol version" body.
A client sends the version it negotiated at initialize, which the server chose
from that list, so no known client meets it; `test-auth.ts` holds the rule
(200 at the newest listed, 404 at `1999-01-01`) so a bump that moves it is
seen here first. And a GET with *no* Accept header now reads as `*/*` and
opens the standalone SSE stream where 0.1.x answered 406: on the servers that
still route GET to the transport — upstream's `server/index.ts` and the
vendored `app.all("*")` servers, which change 75's method guard did not
reach — a keyed, Accept-less GET hangs where it used to fail fast. The SDK
client and mcp-remote send `Accept: text/event-stream` on GET and hung there
already (change 75, SMD-1259); a bare curl is what changes. What the notes
and the measurements agree did not change: a `tools/list` and a `tools/call`
answer are byte-identical
across the move — status, headers, body; `handlePostRequest` still awaits
`ctx.req.json()` after the server is connected, so change 78's staggered probe
still means what it did; a transport reused across 200 POSTs still lets go of
every Request (change 83's assertion holds at 200/200). The build cost on
change 78's harness moved the right way: one tool 39 → 36 µs, thirteen tools
218 → 129 µs (Bun 1.4.0, same machine, same session). Two packages enter
the lockfiles as `@hono/mcp`'s peers: `hono-rate-limiter` 0.5.4 and
`pkce-challenge`, for its auth middleware, which nothing here calls —
`pkce-challenge` does load with the module (a static import of the package's
`auth.mjs`, which its `index.mjs` imports), `hono-rate-limiter` only when the
rate-limit middleware runs. The
pin guard found two files the seventeen-site count missed — the two REST
integrations' `deno.json` pin hono and zod without `@hono/mcp` — so nineteen
sites.

**Verified.** `bun test-auth.ts` **809/809** (775 at change 83: thirteen
no-patch guards, thirteen pragma guards, the enhanced-mcp pair, the SDK's
throw, the protocol-version pair, the core server's pin mirror, three text
rules for the after sample).
`server/`: `test-stateless`
47/47 and the two other suites PASS. `server-portable/`: `test-server.ts`
153/153 (151: the Accept row became three), `test-auth.ts` 67/67,
`tsc --noEmit` clean, `wrangler deploy --dry-run` builds. `extensions/`:
`test-tools.ts` 122/122 and `test-writes.ts` 186/186 against Postgres. All
seven `deno check` steps pass with the pragmas — and the six files that build
a server fail without them (pragmas renamed, checks run, pragmas restored):
`server` 11, `family-calendar` 6, `job-hunt` 10, `ob-graph` 27,
`kubernetes-deployment` 11, `enhanced-mcp` 13 errors, every one an `any`
handler argument. `check-fork-consistency.mjs` PASS.

**Review, first pass** (one cold reviewer beside the author's read, over
changes 83 and 84 together; ten findings, two of them 83's and recorded
there). Fixed: `server/bun.lock` had kept a nested zod 4.5.4 for the SDK
beside the 4.6.5 the Edge Function deploys — `server/package.json` listed no
zod, so `bun install` had nothing to hold it to; zod is pinned there now and
the lock regenerated from nothing, one zod. The pragma guard counted only
the imports its one-line regex matched, so a multi-line or single-quoted SDK
import would have passed unguarded beside a guarded one; it now also counts
every SDK specifier in the file and wants the two counts equal. The no-patch
guard matched one exact spelling; it matches any `.set("Accept", …)`. Four
comments still described the patch as present (two in `test-auth.ts`, one in
the portable server, and `test-server.ts` [7] calling an SSE-only Accept the
SDK client's POST form — that is its GET form; its POSTs name both tokens).
"Which nothing here imports" of the two new lockfile entries: `pkce-challenge`
does load with the module, `hono-rate-limiter` does not; the paragraph above
says so. The protocol-version 404 and the Accept-less GET, which the author's
read had found and written up between the commit and the review, the reviewer
found independently and confirmed against the dist. Not reproduced: one run
in the reviewer's ninety, made beside its other probes, reported two failed
assertions its loop did not capture (it kept the summary line; the suite
prints every failing line); thirty runs alone here failed none, and CI runs
the suite alone. Declined: a GET method guard for `ob-graph` and upstream's
`server/index.ts` — SMD-1259's family, not this change's — and a CI retry for
a flake that does not reproduce alone. Checked and found right: the stream
lifecycle at 0.3.2 (no `finally { close() }` in its `streamSSE`; the body ends
through `abort()` → `reader.cancel()` with the frame already pulled), 202 for
a notification now a JSON `null` body, no tool name in the tree that
`validateAndWarnToolName` would warn about per request, `response.headers`
edits still landing on 0.3.2's fresh Response, and the counts here.

**Review, second pass** (a second cold reviewer, given the first pass's
additions to read first). Nothing above LOW, and every code finding sat in
the first pass's own additions — the stop signal. Taken anyway, each a line
or two: the protocol-version check runs on every POST that is not itself an
initialize, whether or not the transport ever saw one — the paragraph above
said "after initialize", and the test's own transport, which never saw one,
had shown otherwise; the test names `LATEST_PROTOCOL_VERSION` rather than
the list's first entry, so its label is true by construction; the no-patch
guard matches the patch's mechanism, `Object.defineProperty(c.req, "raw"`,
not the header it set, which an outgoing fetch may set too; the pragma
guard's message admits the other way it fails — an SDK import in a spelling
it does not read (single quotes, no semicolon, a line break), which it
refuses rather than passes. And one gap the first pass's fix had exposed:
`server/package.json` promises to mirror `server/deno.json` exactly and
nothing held it to that, which is how the nested zod arrived — the pin guard
now compares the two on every MCP-stack import (supabase-js excepted: the
Node suites never load it, no installed package peers it); drilled with
hono at 4.13.7 in the one file, one failure naming it. Its first spelling
named supabase-js as a quoted literal, which the shim codemod takes for a
migration target — CI's round-trip check rewrote the test file and failed
the PR's first run; the exception is a regex now. Merge 4b8e5ec's
hand-resolution checked against both parents: nothing duplicated, nothing
lost. Noted, not this change's: four servers' `Access-Control-Allow-Headers`
omit `mcp-protocol-version` (and `last-event-id`) where the core, the
portable server and `kubernetes-deployment` carry them — a browser client
sending the header the spec asks for is refused at preflight; pre-existing,
and only sharper now that the header is validated (SMD-1668). 809
assertions.

**Tidied while the files were open.** The comments the two passes grew in
`test-auth.ts` — the pragma guard's, the transport and SDK blocks', the
protocol-version pair's, the pin mirror's and the probe's Accept sentence —
cut to a pointer at this section each, forty-seven lines to twenty-eight; and
two references the renumber had missed, where the word `change` and its
number sat on different lines (the transport block, `test-server.ts` [7]),
read the right number. A second look after the PR opened: the pin mirror's
comment, six lines to four, keeping the codemod warning. No behaviour change.

**Not done here.** The live connector check (one Claude Desktop session, two
tool calls in flight, Accept as the client sends it) that SMD-1497, SMD-1259
and SMD-1246 also wait on; a client that sends *neither* token nor `*/*`
would now get 406 where the patch used to rescue it — no known client does,
and the check would show one. The supabase-js pin (SMD-1644) and the test
tooling pins (SMD-1645) are their own tickets. No upstream issue against the
SDK's `types` pattern or Deno's resolver.

Upstream status: at the pin, upstream deploys SDK 1.24.3, `@hono/mcp` 0.1.1,
hono 4.9.2 and zod 4.1.13 with the Accept patch in every server;
`server/package.json` ranges `^1.28.0` / `^0.1.5` / `^4.12.9`. The fork's
nineteen sites and fifteen handlers diverge accordingly; a rebase conflicts on
each pin line (take the higher) and on each removed patch block (take the
removal). **Unfiled** by us.
