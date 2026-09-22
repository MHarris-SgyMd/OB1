# 67. The vendored recipes and integrations authenticate the way the extensions do — seventeen files off a plaintext `===`: thirteen servers and samples onto scoped keys through a `_shared/auth.ts`, four onto a compare of digests (one of them through the same module), and check 8's exception list empty (SMD-1455)

`server-portable/auth.ts` (one export added, the consumers paragraph), its six
copies — `extensions/_shared/auth.ts`, and the new `recipes/_shared/auth.ts`,
`recipes/editorial-policy/_shared/auth.ts`,
`recipes/edge-function-cost-optimization/examples/_shared/auth.ts`,
`integrations/_shared/auth.ts` and
`integrations/consolidation-workers/_shared/auth.ts` — the seventeen files
check 8 held by count: `recipes/ob-graph/index.ts`,
`recipes/work-operating-model-activation/index.ts`,
`recipes/editorial-policy/auditor/index.ts`,
`recipes/edge-function-cost-optimization/examples/before/per-request-server.ts`
and `examples/after/index.ts` (with `examples/after/server.ts`),
`recipes/vercel-neon-telegram/src/app/api/telegram/route.ts` (with
`src/lib/auth.ts`), `integrations/delete-thought-mcp/index.ts`,
`integrations/update-thought-mcp/index.ts`,
`integrations/kubernetes-deployment/index.ts` (with its `Dockerfile`,
`k8s/openbrain.yml` and `k8s/secrets.yml.example`),
`integrations/entity-extraction-worker/index.ts`,
`integrations/consolidation-workers/bio/index.ts` and
`metadata-norm/index.ts`, `integrations/agent-memory-api/index.ts`,
`integrations/open-brain-rest/index.ts`, `integrations/readwise-capture/index.ts`,
`integrations/telegram-capture/README.md`,
`docs/walkthroughs/ob1-agent-dashboard/demo-rest-server.mjs`.

With them: the READMEs of those servers and `recipes/editorial-policy/schedule.sql`;
`primitives/deploy-edge-function/README.md`; `extensions/test-auth.ts`,
`extensions/package.json` and `extensions/README.md`;
`server-portable/test-auth.ts`; `integrations/.dockerignore`;
`integrations/consolidation-workers/deno.json`; `recipes/ob-graph/.env.example`;
`recipes/openclaw-agent-memory/README.md` and its
`contracts/recall-response.schema.json`;
`dashboards/open-brain-dashboard-next/README.md` and
`open-brain-dashboard-pro/README.md`; `scripts/check-fork-consistency.mjs` and
`.github/workflows/fork-checks.yml` (Linear SMD-1455, filed from change 64's
implementation; the ticket's own text says "change 62", which is the
capturing-role grants — 64 is meant). No migration.

**The finding.** Change 64 made the seven extension servers consumers of the
core server's auth module and gave the fork checker check 8: a value read from
the environment under a credential's name is never compared with an equality
operator. The rule's first run found the same compare in seventeen more
vendored files, and change 64 listed each in `CREDENTIAL_COMPARE_EXCEPTIONS`
for exactly the one line it had, with this ticket as the reason. By what they
compared: ten MCP servers, HTTP APIs and workers comparing a URL-query or
header key with `MCP_ACCESS_KEY` and then running as the service role — the
extensions' shape exactly; two more under another name (`AUDITOR_ACCESS_KEY`,
the dashboard walkthrough's `OB1_DASHBOARD_DEMO_KEY`); three webhook receivers
comparing a secret the caller echoes (Readwise's payload field, Telegram's
secret-token header, twice); and the cost recipe's before/after teaching pair
— the "after" teaching the compare too.

**Adopt, as change 64 did — and where the module lives.** The ticket's sketch
said to import `server-portable/auth.ts` by relative path, the shape fix 13's
shim import has. Change 64's first review pass had already found why not: a
Supabase Edge Function is bundled from `supabase/functions/`, and an import
that leaves it does not deploy. Four of the seventeen deploy today —
`ob-graph`, `agent-memory-api` and `metadata-norm` on supabase-js through their
`deno.json`, `kubernetes-deployment` from a Dockerfile — and the rest
already import the SQL shim across the tree (fix 13; the state SMD-1480
records for five extensions).

So the module is a `_shared/auth.ts` beside each
server, imported as `../_shared/auth.ts` — every function deploys one level
under `supabase/functions/`, and that is the one import it can resolve there —
which in this repository puts a copy in each directory that holds a function
directory: `recipes/_shared/`, `integrations/_shared/`, the consolidation
workers' own `_shared/` (already their deploy-time shared directory beside
`helpers.ts` and `network.ts`), `recipes/editorial-policy/_shared/` for the
auditor and `recipes/edge-function-cost-optimization/examples/_shared/` for the
two samples. Six copies of one file, each byte for byte
`server-portable/auth.ts`; `bun run sync-auth` in `extensions/` rewrites them
all, and the test fails if any differs or the tree, the list and the command
disagree. The deploy primitive says any one of them serves. (The implementation
had the auditor and the samples reach the category copy by `../../` and
`../../../`, which resolves in this tree and not in a deployed layout — the
third pass's deployer found it.) The Kubernetes image is built with
`integrations/` as its context so the copy is inside it, the Dockerfile
mirroring the repository layout; the README's build line changed. Each
converted file carries an `ob1-fork (SMD-1455)` header naming the module and
this change; the three that deploy under Deno with no `_shared/` of their own
— `ob-graph`, `agent-memory-api`, `kubernetes-deployment` — add that the
`_shared` import is the file's first from outside its own directory, as the
ticket asked and as fix 13's codemod does.

**What each server became.** Each imports `authenticateRequest` and `canWrite`
(the ticket wrote `authenticate` and `presentedKey`; change 64's
`authenticateRequest` is the one that tries every presented form). The MCP
servers register a tool that writes only `if (canWrite(principal))`, as the
extensions do. Where a server was built per
request (`ob-graph`, `kubernetes-deployment`'s `buildServer()`, the "before"
sample) the principal is a parameter; where it was a module singleton
(`delete-thought-mcp`, `update-thought-mcp`, `work-operating-model-activation`)
`buildServer(principal)` runs once per key scope and `serverFor(principal)`
hands back the cached one — two servers at most, not one per request, which is
the property those files and the cost recipe care about (undone by change 78:
a server shared across requests is connect()ed to a fresh transport each time
and answers on the wrong one; `buildServer(principal)` runs per request now,
and the cost recipe's sample per session). A server with no
tool for a read-scoped principal (the two single-tool integrations) still
declares a tools capability and lists an empty set — the SDK wires `tools/list`
only when a tool is registered, and a client whose listing fails shows a broken
connector, not an empty one; a call is still told the method does not exist.

The two HTTP APIs resolve the principal in one `app.use("*")` middleware
and put a `requireWrite` middleware on the routes that write — for
`agent-memory-api` write-back, usage reporting and review; for
`open-brain-rest` the thought `PUT` and `DELETE`, capture, reflection and
ingest — answering 403 with the reason before the route parses a body. A
recall is a read: under a write-scoped key it records itself — a trace row and
its items, which the usage route later marks used or ignored, and that route
is a write — and under a read-scoped key it records nothing and returns
`request_id: null`, so a leaked read key cannot fill the trace tables with its
payloads either (the first review pass; the implementation had let it).

The three integration workers keep their fail-closed 503 when no key is
configured (the auditor, which never had one, answers 401) and let a
read-scoped key do the one thing that writes nothing: a dry run
(`?dry_run=true`, or the auditor's `dry_run` body flag); anything else is 403.
The consolidation workers' undocumented `x-mcp-key` header went, and — after
the third pass — so did the auditor's undocumented `x-auditor-key`: neither
appeared in any README or in the schedule, so neither was a rule a caller
could learn, and the module's four documented forms replace them. The auditor
keeps its own names, `AUDITOR_ACCESS_KEYS` with the older `AUDITOR_ACCESS_KEY`
still accepted, because `schedule.sql` and every deployed cron URL already
carry them; it hands them to the module under its `MCP_ACCESS_KEYS` and
`MCP_ACCESS_KEY` slots, which is why its legacy-key principal is named
`MCP_ACCESS_KEY`.
Every server reads its keys per request, where they are used, so a rotation
takes effect without a restart and the test can set and unset them. The
"after" sample's session map remembers the scope a session was minted under:
a session id is not a credential, so a read key presenting a write session's
id gets a fresh read-scoped session, not the write surface.

**The webhook secrets.** A secret the caller echoes has no name and no scope,
so there is no principal to give — the fix is a timing-safe compare, and it
lives in one place: `auth.ts` gained `secretMatches(presented, expected)`,
which hashes both sides and compares the digests with `timingSafeEqual`, so
neither the secret's length nor its prefix reaches the response time and an
empty value on either side is a refusal. `readwise-capture` uses it through
`integrations/_shared/auth.ts`. The Next.js recipe's route uses a
`secretMatches` added to its own `src/lib/auth.ts`, beside the
`timingSafeEqual` it already had for the access key — a Next.js app does not
import this fork's server. The module refuses anything that is not a string
before hashing, so a payload field shaped by the caller is refused, not thrown
on; on `main`, Readwise admitted a body with no `secret` field whenever the
secret was unset — `undefined !== undefined` is false — which this closes.
The Telegram README's sample handler — pasted into
a fresh Supabase project, where nothing else of this fork exists — and the
dashboard walkthrough's Node stub each carry a five-line `node:crypto` version:
the two calls `_shared/auth.ts` makes, proven on the target runtime. (The
implementation had given the sample a Web Crypto one on
`crypto.subtle.timingSafeEqual`, a Deno 1 extension Deno 2 removed; on
Supabase's runtime every webhook would have thrown inside the handler's `try`
and answered 500. The first review pass ran it under Deno 2.9.6 and found it;
`enhanced-mcp` feature-detects the same call, which is why it had never shown.)

**The test.** `extensions/test-auth.ts` is now the one test for every vendored
server under scoped keys: the seven extensions and the twelve recipes and
integrations it can import, plus the webhook receiver, run as deployed under
the stand-in for Deno's two globals — `Deno.serve({ port }, handler)` now
captured too — and, for the recipes and integrations, under a Bun loader that
reads their Deno specifiers: a `jsr:` type-only import is dropped,
`npm:pkg@version` becomes `pkg`, the Deno postgres driver becomes a stub that
never connects, and a bare package name resolves from `extensions/`' install,
since theirs is a deno.json. (Bun's runtime `onResolve` is not consulted for a
`jsr:` or bare specifier at all — the first two attempts recursed or fell
through — so the loader rewrites the source instead.) Each MCP server gets the
extensions' assertions; each HTTP API: a read key passes a read route and is
told 403 by every write route before it parses anything, a write key passes
them all; each worker: a read key is refused a real run and allowed a dry run;
the receiver: the right secret admits, a wrong, missing, non-string or
digest-for-secret one is refused. No database — a handler that must query
before it can answer is pointed at a port nothing listens on and refused at
once. Then the drift guards, widened: every mounted route classified and
exactly the writes take `requireWrite`, a route's reach including the
file-level functions it calls; `.delete()` a table verb only with no argument
(`searchParams.delete("page")` had made two reads writes); raw `INSERT INTO`
counts for the Kubernetes server's SQL; the read's own trace inserts allowed
by table name and only behind a `canWrite` check; the six copies identical,
the tree, the list and the sync command agreeing;
every `npm:` pin in a recipe's or integration's deno.json for a package the
test installs matching it exactly, scoped names included; and the six files it
cannot run — the "after" sample's two files, whose tool modules are not in the
repository, the Next.js route and its lib, the README, the stub — say the
same thing in their text. 643 assertions.

**Check 8.** The exception list is empty; the shape stays, the header says why,
and the failure message names both places a fix can go — the `_shared/auth.ts`
beside the file, or `secretMatches()` for a secret the caller echoes. Said in
the rule's text too: a compare routed through a function is outside the rule
by design, because the operator is what it catches and a call is where the
timing-safe compare lives. The third and fourth passes widened the rule by
one clause: an object bound from a statement that reads a credential from the
environment — `const keys = { MCP_ACCESS_KEY: Deno.env.get(…) }`, on one line
or many, the shape the workers here bind their keys in, which the binding rule
alone did not follow into — has its credential-named properties, bracket reads
and destructured names treated as the credential. (The third pass's clause
had fired on any object's upper-case credential-suffixed property —
`opts.MAX_TOKENS`, `table.PRIMARY_KEY` — no hit in the tree today and a false
positive the first such compare would have paid; the fourth anchored it.) Four
probes and six non-probes hold it.

**Docs.** Each converted server's README: the secret is `MCP_ACCESS_KEYS`
(`name:scope:sha256`, minted as the deploy primitive's Step 3 shows, the older
single key still accepted), the `_shared/auth.ts` copy is downloaded or copied
beside the function, and the tools or routes that need a write-scoped key are
named. The two thought integrations' download URLs pointed at upstream, where
the file they now import does not exist; they point at this fork's `main`. The
deploy primitive says the category copies are the same file. The auditor's
`schedule.sql` says the URL carries the key and the secret its hash, and that
the schedule needs write scope. The Kubernetes manifests take
`MCP_ACCESS_KEYS` from a `mcp-access-keys` secret with an example entry.

**What did not change, and why.** `server/index.ts`, upstream's Edge
Function, keeps its compare: outside the check's directories and the
vendored-tree standard, as the ticket says. `integrations/rest-api` and
`enhanced-mcp` keep their hand-rolled timing-safe loops: not hits, and not
this ticket. The servers still answer a bare 401 rather than the core's
JSON-RPC envelope, for change 64's reason. The shim-importing files among the
seventeen still neither bundle as an Edge Function nor run under Deno, fix
13's consequence, unchanged here — SMD-1480 records it for five extensions and
now carries a comment widening it to these. Read scope on the workers means a
dry run, which still spends LLM calls; that is a cost, not a write. The three
module-singleton MCP servers still, at this change, `connect()`ed one cached
`McpServer` to a fresh transport per request, as they did on main: the SDK overwrites the
transport on connect and captures it when a message arrives, so two concurrent
requests to one of them can cross responses — a pre-existing defect the
per-scope cache neither causes nor cures (SMD-1497 held it; change 78 builds
each server per request, and found `enhanced-mcp` a fourth); the "after"
sample's one transport per session was the shape this paragraph first called
correct — it shared one server per scope across sessions and hung every
session but the last minted; change 78 builds its server per session.

**Review, first pass** (triaged; two reviewers, nineteen findings — one HIGH,
four MED, the rest low — twelve fixed, one filed, the rest noted or declined).
The HIGH and one MED are above: the Telegram sample on an API Deno 2 removed,
and a read-scoped recall that stored its payload. The two single-tool
integrations declare an empty tools list rather than no capability (both
reviewers). The test's pin guard had a regex that skipped every scoped package
— `@hono/mcp`, `@modelcontextprotocol/sdk`, `@supabase/supabase-js` were
never compared — and the corrected guard found the one drift it had hidden:
the consolidation workers pinned `@supabase/supabase-js@2`, an unpinned major,
and `metadata-norm` bypassed the import map with an inline `npm:` specifier;
both pin 2.47.10 now, through the map. The test dialled the network once — a
write probe on `agent-memory-api` passed its schema (both fields default) and
queried supabase-js at `stub.invalid`, a resolver lookup the docblock said
never happens; that server is pointed at a refused port like the other. The
read-key write probes send a body no route could parse, so the 403 is proven
to come from the gate; `passed()` no longer counts a refusal by another status;
the postgres stub has a per-process name and is removed after the imports; the
loader's filter is anchored to this checkout. Counts corrected: thirteen files
take a principal from the module (both cost samples among them) and four compare
digests — `readwise-capture` through the module's `secretMatches`, so fourteen
of the seventeen import a copy; the Next.js route through its own, the README
sample and the stub inline; twelve importable vendored servers, six text-only
files. The "after"
sample says its cached `principal` is the first caller's for that scope and is
for `canWrite()` only; the header note that said "the import above" sat above
the import; the Docker context gained a `.dockerignore` so the whole
`integrations/` tree does not ship to the daemon; `ob-graph`'s `.env.example`
led with the single key; the consolidation README's tree and change 64's prose
in `extensions/package.json` and `extensions/README.md` name the widened test.
Noted, not changed: `primitives/remote-mcp` and `docs/` do not mention
`MCP_ACCESS_KEYS` (change 64's gap, carried — every converted README points at
the deploy primitive's Step 3); the download URL for `integrations/_shared/auth.ts`
answers 404 on `main` until this merges, as any doc pointing at `main` does.

**Review, second pass** (triaged; two reviewers, thirteen findings, nine fixed,
the rest noted — and the two at the top were consequences of the first pass's
recall fix: the stop signal). A read-scoped recall's `request_id: null` broke
the published v1 response contract,
`recipes/openclaw-agent-memory/contracts/recall-response.schema.json`, which
required a non-empty string; the contract allows null and says when, and the
agent-memory README's endpoint table and smoke section say a read key gets no
trace and the harness needs a write key. Two of the first pass's guards were
fooled by mutation, run rather than reasoned: the recall guard accepted a
`canWrite` check with a no-op body — it requires the check to precede the trace
insert and to return — and the pin guard passed an unversioned or non-npm
specifier (`npm:hono`, a `jsr:` or URL import would deploy on latest while the
test ran the pin) — it requires the exact pin whatever the spelling. Also run:
five other mutations against the servers and a deno.json, each caught by the
test (and the Telegram revert by check 8 as well); the Docker build from
`integrations/` succeeds and `deno check` inside the image resolves
`../_shared/auth.ts`; an SDK probe of the empty-tools server answers `{ tools:
[] }` and -32601 on a call, as this section says; every shim-importing file's
`deno check` errors are the shim's (fix 13) or `main`'s own, none inside this
branch's hunks (the fourth pass found three that were, hidden among the
shim's, and fixed them; two casts in `work-operating-model-activation` are
`main`'s);
two overlapping requests to a module singleton hang on `main` and here alike —
SMD-1497 has the trigger, any two, not a burst (closed by change 78). Text: `metadata-norm` deploys
through its `deno.json`, not an inline specifier; fourteen importers, not
thirteen; the Verified line's count; two non-probes record spellings the rule
must keep ignoring (a property of a bound principal, a `typeof` beside a bound
secret); the Next.js dashboard README told users to enter `MCP_ACCESS_KEY`
against `open-brain-rest`, converted here. Noted, not changed:
`consolidation-workers/deno.json`'s `check` task still names `bio/index.ts`,
whose shim import fails it (SMD-1480; CI checks `metadata-norm` alone — the
task names `metadata-norm` alone since change 74);
`readwise-capture` answers an empty body 200 before the secret check —
upstream's accommodation of Readwise's Test Webhook button, unchanged.

**Review, third pass** (past the stop signal, at the user's call; two
reviewers — one walking every README as a deployer, one adversarial on the
module and the rule — seventeen findings, sixteen fixed). The deployer found
what the reading passes had not. A function deploys one level under
`supabase/functions/`, so its import must be `../_shared/auth.ts` wherever the
file sits in this repository: the auditor's `../../` and the samples'
`../../../` resolved in the tree and not in the README's layout
(`supabase/_shared/`, outside the bundle). Every server imports
`../_shared/auth.ts` now and two more copies sit where those files are — six,
held identical by the test, which also asserts the tree, its list and `bun run
sync-auth` agree. The first pass's `metadata-norm` change — the bare specifier
through `deno.json` — had made the one consolidation worker that deployed on
`main` undeployable by its README, which copied the folder without the
`deno.json`; the README copies it for both workers, and copies `_shared/` file
by file, since `cp -r` into an existing `_shared/` — which every other README
now creates — nests. Every `supabase secrets set MCP_ACCESS_KEYS="one:entry"`
example said, in effect, drop every other client's key: the secret is
project-wide, and each README says to set the whole list. The
shim-importing READMEs — seven then, eight with `readwise-capture`'s in the
fourth pass — carry the extensions' SMD-1480 callout above their deploy
steps. The rule: check 8 was silent on the shape this change introduced
— `if (provided === keys.MCP_ACCESS_KEY)` after the workers' `keys` object —
in both its one-line and multi-line forms; the property clause above.
`secretMatches` refuses a non-string in the module rather than trusting each
caller (readwise's guard went with it) and has a unit test in the core
server's suite. Smaller: the auditor's undocumented `x-auditor-key` header went;
a malformed `MCP_ACCESS_KEYS` entry is dropped without a log in every vendored
server, as in change 64 — the deploy primitive's troubleshooting says so and
what to check; the editorial README had a sentence of prose inside the
secret's value and mixed path roots in its copy lines; the Kubernetes README's
expected tool count says three for a read key; the harness says how to add a
server, silences a handler's `console.error` for the length of a request,
accepts single-quoted specifiers, and dropped a parameter never passed. Noted:
the auditor's legacy-key principal is named `MCP_ACCESS_KEY` though its
variable is `AUDITOR_ACCESS_KEY` — a logging name, never logged; the exceptions
mechanism has nothing to exercise it while the list is empty.

**Review, fourth pass** (at the user's call; two reviewers — one re-running
the deployer simulation against every README after the third pass's six-copy
change and mutating its new guards, one reading the whole diff as its merger —
thirteen findings, two of them one defect seen twice; nine fixed, the rest
noted). `readwise-capture`'s README had never been given the `_shared/auth.ts`
copy step — the implementation moved its secret compare onto the module, and
three passes of READMEs walked past the one that was not an MCP server or a
worker; it has the step and the SMD-1480 callout, the eighth. The
work-operating-model conversion lost a type narrowing: the module-scope throw
that made `DEFAULT_USER_ID` a `string` for the old top-level tool bodies does
not reach the hoisted `buildServer()` they moved into, three `deno check`
errors the second pass's "none inside this branch's hunks" had missed (the
shim's errors hid them) — a `?? ""` at the declaration, since the throw already
refuses the empty string. The cost recipe's README tree named `../_shared/auth.ts`
and never told the reader to place it, nor the `deno.json` beside `index.ts`,
and still said `register(server)`. The consolidation README's `cp -r` of the
two function directories nested on a second run as its `_shared/` copy had;
files are copied one by one, and the `deno.json` sentence says which worker
needs it today. The third pass's check-8 clause fired on any object's
upper-case credential-suffixed property — `opts.MAX_TOKENS`, `table.PRIMARY_KEY`,
`this.API_KEY` — with no hit in the tree today and a red build waiting for the
first; it is anchored to objects bound from an environment read, follows
bracket reads and destructures out of them, and the helper-returned object is
back outside the rule where the header always said it was. Text: this section's
opening still counted four copies and described readwise's removed string
check; the Verified line's core count; `metadata-norm`'s note claimed a first
outside import it never had (its `_shared/` helpers came first); the Kubernetes
note said Supabase bundles what Docker copies; the other dashboard README named
the single key against `open-brain-rest`. Run and held: every README layout
assembled literally and `deno check`ed — clean for the four that deploy, the
shim's errors alone for the rest (plus two casts `main` already had in
`work-operating-model-activation`); five mutations of the third pass's guards
each caught; `docker build` from `integrations/` with the image holding exactly
three files; a bisect across the four commits before this one green at each.

**Review, fifth pass** (at the user's call; two reviewers — one adversarial on
the fourth pass's own changes and the rule's edges, one auditing this section
against the tree as the record a later reader trusts — twenty-three items,
none above low; twenty-one fixed). The rule: an object literal that never
closes bound its name to everything read below it — the brace walk now binds
nothing when it runs off the end; a bracket read behind `?.` is followed; the
header names what the clause does not follow (a property assigned after the
object was made, a nested property). The checker had been decoding a 71 MB
walkthrough video as text on every run; media extensions are binary now. Two
header notes read wrong after the fourth pass (the Kubernetes note gave its
reason twice, `metadata-norm`'s "Deploy it" pointed at the test), and the
"after" sample's first line still said "singleton". The record: this section
said all four workers kept a fail-closed 503 — the auditor never had one and
answers 401, as the test encodes; said a read-scoped recall "returns no
request id" where the API returns `request_id: null`; counted the seven
extensions' 243 assertions "among" today's 643, which was change 64's whole
suite, not a separable subset; and its title read as an importer count when
fourteen files import a copy. Two deviations from the ticket's sketch were
unrecorded — `authenticateRequest` for its `presentedKey`, and the ticket's
"change 62" for 64 — and three decisions were taken without being written
down: why the undocumented headers went, why the auditor keeps its own env
names, and that every converted file carries the fork header the ticket asked
of four. The three longest paragraphs are split where a topic changes, with
history moved behind the current fact. Noted, not changed: `readwise-capture`'s
README says both "no redeploy is needed" and "redeploy" about a rotated secret,
and frames an update as fetching `index.ts` alone — `main`'s prose, outside
this ticket.

**Boyscout.** What the passes cut for space, in the files this change
touched, no behaviour changed: two lines of this section rewrapped;
`readwise-capture`'s README no longer tells a reader to redeploy after
rotating a secret it also says is read at runtime, and its update note names
`_shared/auth.ts` beside `index.ts`; `auth.ts`'s docblock counts the vendored
servers' write tools beside the extensions' (six copies follow); the test's
Deno stand-in and postgres stub lines are wrapped.

**Not done here.** SMD-1228 holds the last rule of the vendored-tree standard
(integrations writing around `update_thought`) — done in change 69. SMD-1480 held the
deployability of everything that imports the shim — done in change 74. `recipes/vercel-neon-telegram`'s
`validateAccessKey` guards the lengths before its `timingSafeEqual`, a small
length leak the ticket did not name and this change did not touch.

**Verified:** `extensions/test-auth.ts` 643/643 (243 at change 64);
`server-portable/test-auth.ts` 67/67, `test-server.ts` 73/73,
`tsc --noEmit` clean, the Cloudflare Workers dry-run build; `deno check
--node-modules-dir=none` clean under Deno 2.9.6 for `ob-graph`,
`agent-memory-api`, `consolidation-workers/metadata-norm` and
`kubernetes-deployment`, each from its own directory — the four CI now checks;
`bun scripts/check-fork-consistency.mjs` PASS with the exception list empty
(52 probes, 30 non-probes, no vendored hit). The ticket's verify grep —
`req.query("key")` under `extensions/`, `recipes/`, `integrations/` — returns
nothing.

**Upstream status:** not applicable — the compares are upstream's; the module
they now use is this fork's.
