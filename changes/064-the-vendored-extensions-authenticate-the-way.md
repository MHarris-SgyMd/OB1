# 64. The vendored extensions authenticate the way the core server does — named, scoped, hashed keys through `server-portable/auth.ts`, a read-scoped key never given the tools that write, and check 8 refuses a credential compared with `===` (SMD-1252)

`server-portable/auth.ts`, `server-portable/index.ts`, the seven extension
servers (`extensions/family-calendar`, `home-maintenance`,
`household-knowledge`, `job-hunt`, `meal-planning` — `index.ts` and
`shared-server.ts` — and `professional-crm`), their `.env.example`s,
`extensions/_shared/auth.ts`, `extensions/_template/AGENT_SPEC.md`,
`extensions/README.md`, `extensions/test-auth.ts`, `extensions/package.json`,
`extensions/bun.lock`, the READMEs of `home-maintenance`,
`household-knowledge`, `meal-planning` and `professional-crm`,
`server-portable/README.md`, `server-portable/keygen.ts`,
`primitives/deploy-edge-function/README.md`, `primitives/shared-mcp/README.md`,
`primitives/remote-mcp/README.md`, `primitives/troubleshooting/README.md`,
`scripts/check-fork-consistency.mjs` and `.github/workflows/fork-checks.yml`
(Linear SMD-1252, filed by the 2026-09 upstream survey). No migration.

**The finding.** Fix 14 gave the core server named, scoped, SHA-256-hashed
access keys, timing-safe comparison, revocation one key at a time, and a
read-scoped key for which `capture_thought` is never registered. None of it
reached the extensions the curated learning path tells a user to deploy. Seven
servers carried the same two lines — `const expected =
Deno.env.get("MCP_ACCESS_KEY"); if (!key || key !== expected)` — and then ran
as the service role: one shared plaintext secret, compared byte by byte, no
scope, no revocation short of re-keying every client, and full write access on
a key accepted from a URL query string, the form Claude Desktop's connectors
need and the form that lands in access logs and browser history. They were
weaker than the core server was before fix 14, under the repository whose one
loudest claim is the hardened auth path.

**Adopt, not delete.** The ticket offered three postures and asked that the
third — leave them — be rejected explicitly. Deleting the extensions was
arguable: they are upstream's teaching path and they still read their
environment through `Deno.env`. But fix 13 had already migrated five of the
seven onto the SQL shim by a relative import into the fork's tree, so the
extensions are already the fork's to keep working, and the same relative
import is all "adopt" costs. Each of the seven now imports
`authenticateRequest` and `canWrite` from `../_shared/auth.ts`, reads
`MCP_ACCESS_KEYS` beside the legacy `MCP_ACCESS_KEY` (the shared meal-planning
server its own `MCP_HOUSEHOLD_ACCESS_KEYS` / `MCP_HOUSEHOLD_ACCESS_KEY`), and
answers 401 with no principal. `extensions/_shared/auth.ts` is
`server-portable/auth.ts` **byte for byte** — a copy, not a re-export, because
a Supabase Edge Function is bundled from `supabase/functions/` and `_shared/`
beside the function is the one place a shared module can live; the deploy
primitive's Step 2 downloads it once for every extension. The fork's recurring
defect is a value defined twice, so the test fails the moment the two files
differ, and the module was made runtime-neutral in the one place it was not —
`Buffer` is imported from `node:buffer` rather than assumed a global — so the
copy runs on Deno as it is. Seven copies of the compare became one consumer
each of the tested path, and the legacy key, still accepted, is compared by
digest now.

**The tools that write are gated, not refused.** As `index.ts` registers
`capture_thought` only `if (canWrite(principal))`, each extension builds its
`McpServer` per request and registers each tool that inserts, updates,
upserts or deletes only for a write-scoped principal — twenty-four of the
forty-five tools across the seven servers, classified by what each body (or,
in `job-hunt`, its handler) does to the database, not by its name
(`generate_shopping_list` writes; `crm_search_contacts` calls an RPC that
reads). A read-scoped key does not see them in `tools/list`, and a call names
a tool that does not exist (`-32602`), before any handler runs. The shared
meal-planning server's `mark_item_purchased` is gated too, and its README says
to mint the household member's key read-scoped unless they should check items
off — the scope is the decision, made where the key is minted.

**Where the key may travel is spelled once.** `auth.ts` gains
`presentedKeys(req)` — `x-brain-key` (the core server's header),
`x-access-key` (the extensions'), `?key=`, `Authorization: Bearer` — and
`authenticateRequest(req, cfg)`, the first presented key that **authenticates**.
Every form, not the first present: a gateway with "verify JWT" on, the Supabase
SDK and `mcp-remote --header` each put a token of their own in `Authorization`
beside the `?key=` the client means, and the first version of this change
(which took the first form present, bearer ahead of the query) would have
hashed the gateway's token and refused the request — the extensions read
`?key=` first before, so that was a regression, and the review pass caught it.
`index.ts` reads through the same function, so the core server now also
accepts the extensions' header and a bearer token, and its CORS preflight
allows `x-access-key`; the two primitives that told a user the two servers
wanted different headers "to avoid confusion" say instead that this fork's
server and the extensions take any of the forms, and that `server/index.ts`,
upstream's Edge Function the getting-started guide deploys, still takes
`x-brain-key` or `?key=` alone.

**What a user is told.** The deploy primitive's Step 3 mints a key — `bun
keygen.ts` from the checkout, or `openssl rand -hex 32` and `shasum -a 256` by
hand, with a PowerShell equivalent that runs on 5.1 — and sets the **hash** as
`MCP_ACCESS_KEYS=name:scope:hash`, the key going only into the connector URL;
the legacy secret is named as still working and as the thing to move off. The
troubleshooting primitive's 401 entry knows about a hash pasted where the key
goes and a read-scoped key that "cannot see" a tool. `extensions/README.md`
gains an "Access Keys" section; each `.env.example` shows the new form with the
old one commented; the extension template (`_template/AGENT_SPEC.md`) and the
shared-server primitive's sample — the two files the next extension is copied
from — build the server per principal and never compare a key themselves.

**The test.** `extensions/test-auth.ts` imports the seven servers **as
deployed**, under a stand-in for the two Deno globals they use: `Deno.env.get`
hands the process environment through and `Deno.serve` captures the fetch
handler instead of listening. No database — the SQL shim and supabase-js both
connect lazily and nothing here reaches a tool that queries (each server's
client is built per request, so the test sets the URL shape that server's
client accepts per request too). For each server it
makes the assertions `server-portable/test-auth.ts` makes for the core: a
write-scoped key sees every tool; a read-scoped key sees exactly the reads and
each write is absent, not refused; a read-scoped call of a write tool is told
the tool does not exist; a wrong key, no key, and the **hash** are refused
with 401; the write key removed from `MCP_ACCESS_KEYS` stops working while the
read key keeps working; the legacy single key authenticates as write and a
wrong one is refused; no keys configured refuses everything. Then, once, the
four forms a key may travel in, a gateway's bearer token beside a right
`?key=` and a stale `x-brain-key` beside a right `x-access-key` (neither
shadows the key the client means), three wrong forms refused as one, and the
unauthenticated GET health check. Then the drift guards: `_shared/auth.ts`
is byte for byte `server-portable/auth.ts`; every `server.tool(` a file
registers is classified in the test's table, exactly the writes are gated,
each write's body or handler does write and each read's does not, the key is
read through the shared module and the old `c.req.query("key")` /
`x-access-key` spelling is gone, and each extension's `deno.json` exists and
pins what `extensions/package.json` installs (one set of versions, six
identical copies, the same versions `server-portable` pins). That
`package.json` is test-only; `bun install` puts `node_modules` under
`extensions/`, which `contributionDirs()` now skips as it skips `_template`
and `_shared` — a gitignored install and the shared module are not
contributions. The test runs in CI inside the "Portable server" job — one of
the nine checks `main`'s ruleset requires, so a red run blocks a merge; a job
of its own, as the first version had, would not have — and the `deno check`
job now also checks the two extensions Deno can resolve (`family-calendar`
and `job-hunt`, still on supabase-js) as deployed, through
`../_shared/auth.ts`. 243 assertions.

**Check 8 holds the line.** `scripts/check-fork-consistency.mjs` gains the
third rule under "Vendored content" above: a value read from the environment
under a credential's name (`…KEY`, `…SECRET`, `…TOKEN`, `…PASSWORD`) is never
compared with an equality operator — strict or loose, on either side, read
inline in any wrapping (`!== Deno.env.get("MCP_ACCESS_KEY")`, `!==
(Deno.env.get(…) ?? "")`, `Deno.env.get(…)!.trim() ===`) or through an
identifier the file binds from a statement containing such a read (`const
expected = Deno.env.get(…)`, `const KEY = String(process.env.KEY ?? "").trim()`,
`expected ??= …`, `const { API_TOKEN } = process.env`, `const { API_TOKEN:
expected } = process.env`, Python's `os.environ`), the bound name bare or
wrapped (`expected.trim()`, `String(expected)`, `(expected ?? "")`), the read
spelled `Deno.env.get`, `process.env`, `Bun.env`, Hono's `c.env`,
`import.meta.env`, a bare `env(…)`/`env.X` or `os.environ` — in every non-binary,
non-ignored file under the seven category
directories and `docs/`, prose included, since a README's code block is what
the next extension is copied from. Not a compare of the credential: `.length`
(a timing-safe compare guards its lengths first), a call or an index on it,
`typeof`, or a literal on the other side — nullish or empty (`if (KEY ===
undefined)` is a presence check) or a string (`if (KEY === "your-key-here")` is
a placeholder check, a different smell). A name bound from a credential read
is the credential for the **whole file**: every compare of it counts, wherever
it sits. That is a decision, not an oversight — three passes tried to except a
re-declared name (a loop variable, a parameter, a destructure), and each found
the previous pass's scoping both silencing real compares and failing ordinary
code; the fourth pass took the altitude, below. `key`, `token` and `secret`
are common names and the vendored tree binds each from the environment
somewhere, so an upstream rebase can trip this on an ordinary loop — in the
open, answered with a rename or a counted exception; a miss would be silent.
Outside the rule, and the header
says so: `.includes`, `Object.is`, `switch`, `.localeCompare`, a compare
through a class field or an object property, a helper that returns the key,
several declarators on one statement, a read through `Deno.env.toObject()`
into a variable. Forty-seven probes the rule must catch — every line of a
probe that carries a compare, so a two-route probe is two catches — and
twenty-one it must not run on every invocation, through the same function
the scan uses. Its first run found the
mechanism in **seventeen
more vendored files** — ten MCP servers with the extensions' exact shape
(`ob-graph`, `work-operating-model-activation`, `delete-thought-mcp`,
`update-thought-mcp`, `kubernetes-deployment`, `entity-extraction-worker`, the
two consolidation workers, `agent-memory-api`, `open-brain-rest`), the
editorial-policy auditor and a walkthrough's screenshot stub under other
names, three webhook-secret echoes (Readwise's in the body, Telegram's header
in a recipe and a README), and both halves of the edge-function-cost recipe's
before/after teaching pair — and each is listed in
`CREDENTIAL_COMPARE_EXCEPTIONS` for exactly the one line it has today, with
SMD-1455 as the reason. One fixed drops out as stale and fails until its entry
is removed; one added beside it fails. The ticket's verify grep —
`req.query("key")` under `extensions/`, `recipes/`, `integrations/` — returns
three results, all in files SMD-1455 names.

**What did not change, and why.** The extensions still answer a bare HTTP 401
where the core server answers a JSON-RPC `-32001` envelope for the strict
hosts that tear a connection down on 4xx (change 1); that envelope's helpers
live in `index.ts`, the ticket asked for scopes, hashing and revocation, and
moving the envelope is a second mechanism. Revocation here is a line removed
from `MCP_ACCESS_KEYS`, which is what fix 14 meant by it; the registry-level
revocation change 23 added (`ob1_agents`) runs through the core server's store
and is not reached from an extension's own client. The extensions still read
their environment through `Deno.env` and end in `Deno.serve`, as fix 13 left
them — the test stands in for both rather than porting the files further from
upstream. The deploy primitive still downloads `index.ts` from upstream's
`main` by raw URL — and the first review pass's `_shared/auth.ts` download
pointed there too, where the file does not exist (a 404 body would have been
written over the module, and the `index.ts` fetched beside it was upstream's,
reading a secret Step 3 now tells the user not to set). The primitive
downloads from this fork's `main` now, all twelve URLs — the update section
refetches the pins and the shared module beside the server, since a server
may start using something the module gained — and says which two extensions
deploy by it: `family-calendar` and `job-hunt`, still on supabase-js. The
other four import the SQL shim, which imports `bun`, while still reading
`Deno.env`: as they stand they neither bundle as an Edge Function nor run
under Bun, which is fix 13's consequence and now SMD-1480's ticket; the
primitive's list, its Step 2 and the four READMEs' five deployment tables say so
rather than leaving a reader to discover it at `supabase functions deploy`.
The module is a `_shared/` copy the recipe downloads, not an import across the
tree the bundle cannot follow, so those two stay deployable.
`server/index.ts`, upstream's Edge Function, keeps its own compare: it is
outside the seven directories, outside the vendored-tree standard, and the
fork's hardened server is `server-portable/`.

**Review, first pass** (triaged; eleven findings, ten taken, one folded in).
The precedence defect above; the `_shared/` copy above, where the first
version imported `../../server-portable/auth.ts` and would have failed
`supabase functions deploy` for all seven; the two primitives' claim that the
"core server" takes either header, when the core server the getting-started
guide deploys is `server/index.ts`; check 8's destructure branch, which bound
the *env* name of a renamed destructure and so missed `const { MCP_ACCESS_KEY:
expected } = process.env` while the header claimed the form; the six spellings
the pass probed past the rule (`c.env`, `Bun.env`, a wrapped read, `String(…)`,
`??=`, a wrapped inline compare), all caught now with probes; a string literal
on the far side flagging a placeholder check; the test's per-server URL shape
that every request ignored (the client is built per request, so the last
server's shape governed all seven — supabase-js happened to accept a
`postgres://` URL); the core server's CORS preflight not allowing the header
the docs now say it takes; `deno.json` missing aborting the run instead of
failing an assertion; and the nit that `vercel-neon-telegram/src/lib/auth.ts`
already compares timing-safe too. Folded in: `sha256sum` beside `shasum` in
the by-hand recipe. Verified true and not reported: the 24/45 split, the
`-32602` shape, the Accept patch's interaction with `c.req.raw`, and that a
*registered* write tool called with `{}` answers "Invalid arguments", so the
read-key call assertion discriminates.

**Review, second pass** (triaged; nine findings, all taken). The download
URL above — the one defect, since a user following the primitive would have
ended at 401 with a 404 body for a module. The extensions' test ran in a CI
job of its own, which `main`'s ruleset does not require, so the only thing
exercising five of the seven servers could go red and a merge still land; it
runs inside the required "Portable server" job now. Check 8 bound a name
file-wide, so an upstream rebase adding `for (const token of tokens)` to a file
that reads `GITHUB_TOKEN` would have failed CI with a message about a
credential compare — a name declared again between binding and compare is
another variable then, with the three shadow shapes as non-probes and a
compare-before-shadow as a probe (the third pass found that rule too broad,
the fourth removed it — below). The same pass probed wrappers the rule
accepted on an inline read but not on a bound name (`expected.trim()`,
`String(expected)`, `(expected ?? "")`), template quotes in the read,
`import.meta.env`, and a suffixed name (`MCP_ACCESS_KEY_V2`) — all caught now;
the spellings it does not chase are listed in the header rather than implied
by "mechanism". The test's write detector knew the four table verbs and not
`.rpc(`, so a tool writing through a stored function, classified as a read,
would have passed "does not write" — an RPC is a write unless named in
`RPC_READS` (`crm_search_contacts_fts` is the one). The test never sent a
request without an `Accept` header, so the six servers' patch of `c.req.raw`
ahead of the key read ran in production and never in CI; it does now, with a
right key and a wrong one. And three doc nits: `cd server-portable && bun
keygen.ts` given to a reader standing in their Supabase project folder (a
subshell into the checkout now, in both primitives); the household-member
prose promising "check off grocery items" beside advice to mint that member a
read-scoped key (the promise is conditioned on the scope now, in both files);
`enhanced-mcp` compares through `crypto.subtle.timingSafeEqual` first, the XOR
loop is its fallback. Verified sound by the pass and not reported: the bearer
regex, dedup and empty-drop; the legacy path with an empty key list and with
both forms set; `?key=` decoding unchanged from Hono's `query()`; all
twenty-four writes gated and every read free of writes; env isolation between
the six and the shared server; `.gitignore`, the lockfile and `--frozen-lockfile`.

**Review, third pass** (triaged; ten findings, all taken, one ticket filed).
Main had moved — SMD-1226 landed as change 62 — so this section is 63 after a
merge, and the number is spelled in fourteen lines of twelve files outside
this one (the seven server headers, both copies of the auth module — byte
identity held — the checker's three, the test, the test's `package.json`).
The second pass's shadow
rule silenced real compares: it took any redeclaration anywhere between the
file's *first* `N =` and the compare, so an arrow parameter in another
function, a loop whose block had closed, a `let` above the credential binding
and a second binding of the same name in a second route each hid the
extensions' exact original shape. The pass rewrote the rule — bindings by
position, the nearest preceding one governing, a shadow governing only while
its block was open by a brace walk — with six probes for the misses, and the
probe check asks that every compare line be caught rather than any (the
fourth pass then removed the shadow rule altogether — below). The deploy
primitive contradicted itself and four READMEs: its list and their five tables
still sent a reader to deploy servers that import `bun`, and "run from a
checkout" described nothing that works — SMD-1480 filed; callouts above each
table and in the primitive's list. Its update section refetched `index.ts`
alone, so a module change or a pin bump never reached a deployed function —
it fetches all three now. The CI `deno check` of the two extensions had never
run anywhere: Deno 2.9.6 turned out reachable through the npm launcher under
Bun (`bun ~/.bun/install/global/node_modules/deno/bin.cjs`), and both files
check clean as CI runs them. The test's write detector saw only a
double-quoted `.rpc("…")`; any `.rpc(` is a write now unless its literal is in
`RPC_READS`, and a tool's block is sliced from its registration rather than
the first place its name is quoted. Prose: the Step 2 callout split a sentence
from its code block; "a destructure" as a shadow shape covered only array
destructures (object ones count now); `server-portable/README.md`'s
configuration block named only the legacy secret; FORK and the header
disagreed on `env.X`. Verified sound by the pass and not reported: the copy
byte-identical; `?key=` surviving the rebuilt request in all six; the shared
server's env isolation; job-hunt's handler slicing; the workflow's step order.

**Review, fourth pass** (triaged; nine findings; the altitude taken). The
reviewer was asked to attack the shadow rule and broke it a third time, in
both directions: a braceless shadow (`for (…) if (…)`, `list.some((key) =>
…)`) governed to the end of the enclosing block and silenced every later
compare of the credential, including the extensions' exact original shape one
callback later; a `const`/destructure shadow, which opens no block, took the
next braced statement as its block and failed an ordinary function; a
for-header with braces in its iterable ended the scope before the body; a
compare textually above every binding could never consult a shadow; `key =>`
inside a string was a shadow, `{` inside a string a block. Every one of these
is scope, and scope in regex over unparsed text — README code blocks and
Python among the inputs — is not a thing to get right by another patch. So
the shadow rule is gone (both helpers and the position bookkeeping with it):
a name bound from a credential read is the credential for the whole file, the
five shadow non-probes became probes the rule must catch, and the header and
this section say why — a false positive fails CI in the open and is answered
with a rename or a counted exception, a miss is silent, and the vendored tree
had no hits under the whole-file rule when the second pass introduced the
exception for a hypothetical. The lesson is change 56's again: when
consecutive passes find seams in one mechanism, the mechanism is the finding.
Also taken: a ternary after the credential (`key === expected ? ok() :
deny()`) was excluded with `expected?.x` — only `?.` is an access now; a
binding broken over two lines (`const expected =\n  Deno.env.get(…)`) was not
a binding; the test's handler detection matched any `handle…` word in a
tool's block and is anchored on the `wrap(() => handleX(` call now. Stated
in the header as outside the rule rather than fixed: braces or `=>` inside a
string, comment or regex literal. Verified sound by the pass: the twelve
URLs, the fourteen renumbered places, the counts, the copy's identity, the
seven servers' diffs, `RPC_READS`, and that a missing registration fails two
assertions rather than aborting the run.

**Review, fifth pass** (triaged; ten findings, one defect — at the merge
boundary — nine gaps and nits, and none of the fourth pass's fixes among
them: the stop signal). Main had moved again — SMD-1043 landed as change 63
— so this section is 64 after a second merge, the number spelled in the same
fourteen lines. Check 8 did not read Hono's `env(c)` adapter form, the
canonical environment read for a Hono server on Workers or Deno — the stack
these servers use; it does, with two probes, and the header's "outside the
rule" list gained the three spellings the pass named (a read by a non-literal
name, a parenthesised bound name, a shell test) beside the string-literal
braces. The by-hand PowerShell recipe minted a 256-bit secret with
`Get-Random`, which Microsoft documents as not cryptographically secure; it
uses `RandomNumberGenerator` now, still on 5.1. `auth.ts`'s docblock — the
extensions' contract text now, in two copies — still said `capture_thought`
was the only tool that writes, three changes after `update_thought` and
`delete_thought` joined it, and `keygen.ts` said the same to every reader of
a read-scoped key; both name the set. The shared-server primitive's
troubleshooting still told a user to match the URL key against the secret,
which holds its hash. Two assertions asked only for a count where the sorted
list was already in hand; the drift guards recognise `server.registerTool(`,
the SDK's current name and the template's, so an eighth extension can join
the table. Recorded, not changed: where the whole-file rule will bite first on
a rebase — `recipes/entity-wiki/generate-wiki.mjs` and
`recipes/typed-edge-classifier/classify-edges.mjs` bind `key` from a
credential read and use it a dozen times each, the five
`integrations/*/_shared/helpers.ts` bind `apiKey`; an appended
`if (row.key === key)` fails CI in each, a `for (const key of keys) if (key
=== "id")` does not. Verified sound by the pass: the misses probed (`==`,
`!(a !== b)`, a template literal, Python's `getenv` with a default, `as
string`); all seventeen exceptions matching exactly the intended compare
line; the 24/45 split by every write verb; "Portable server" among the nine
required contexts; the lockfile version; the Step 3 hash matching Node's.

**Review, sixth pass** (at the maintainer's call, past the stop signal;
nothing above gap level). The reviewer ran rather than read: the deploy
layout the `_shared/` decision rests on, reproduced offline — `index.ts`,
`deno.json` and `_shared/auth.ts` copied where the primitive's Step 2 puts
them, and `deno check` resolves `../_shared/auth.ts` from there; a
write-scoped key calling a write tool against a closed port — the tool is
registered and reaches the shim, answers "Failed to connect" in 13 ms, and
neither the URL, the user, the database, the password, the service key nor
the key itself appears in the response, while the read key is told the tool
does not exist; check 8 over every scanned file with the exceptions off —
exactly the seventeen files at exactly the seventeen lines, each the
credential compare itself and not a shadow-name compare the count could hide;
and sixteen further spellings caught. The one gap: two sample prompts — the
meal-planning README's "Mark chicken breast as purchased" and the
shared-server primitive's "Add milk and eggs" — sat directly under the advice
to mint the household member's key read-scoped, and would fail under it; each
says so in place now. Nits: this section's file list omitted five files the
diff touches; "fourteen places" enumerated twelve files (fourteen lines, the
checker carrying three); `authenticateRequest`'s docblock said the work
depended on nothing the server holds when it also depends on which of the
client's own forms authenticated; Go's `os.Getenv` was not a read (it is,
with two probes — none of the scanned roots hold a Go file today). History,
read as a whole: the implementation commit's claims each fix corrected are
corrected within the same eight messages.

**Boyscout.** What the passes cut for space, in the files this change
touched, no behaviour changed: the seven servers' auth comment is rewrapped
(two passes had edited its first line and left one at 130 columns); the
checker's non-probe for the servers' own call spells the call they make today
(`authenticateRequest(c.req.raw, …)`, not the first pass's
`authenticate(presentedKey(…))`); `extensions/package.json` drops
`@types/bun`, which nothing in the directory type-checks against, and says so.

**Not done here.** SMD-1455 holds the seventeen excepted files; SMD-1480 the
five extensions that import the shim and read `Deno.env`, which as they stand
neither deploy nor run (done in change 74) — CI's `deno check` covers `server/index.ts` and the two
extensions on supabase-js, and the runtime test is what exercises all seven.
The three vendored files that already compare timing-safe on their own
(`integrations/rest-api` by a hand-rolled XOR loop, `enhanced-mcp` by
`crypto.subtle.timingSafeEqual` with that loop as its fallback,
`recipes/vercel-neon-telegram/src/lib/auth.ts` by `node:crypto`'s) are neither
hits nor consumers of the module.

Verified: `extensions/test-auth.ts` 243/243; `server-portable/test-auth.ts`
59/59 and `test-server.ts` 73/73 with `index.ts` reading through
`authenticateRequest`; `tsc` clean; the Cloudflare Workers dry-run builds with
the `node:buffer` import; fork checker PASS with check 8's probes, widened,
and the seventeen counted exceptions unchanged; `deno check
--node-modules-dir=none index.ts ../job-hunt/index.ts` from
`extensions/family-calendar` clean under Deno 2.9.6, as CI runs it. Upstream
status: **not applicable** — the auth
module is fix 14's and the extensions are vendored; upstream's own
`integrations/enhanced-mcp/README.md` already refuses the URL query form for
its key.
