# 74. The servers on the SQL shim run under Bun — `compat/deno-on-bun.ts` is the second one-line change, the codemod writes it, check 11 holds it, and `test-auth.ts` starts all sixteen (SMD-1480)

`compat/deno-on-bun.ts` (new); `scripts/migrate-to-sql-shim.mjs`; one import
line in sixteen vendored files — `extensions/home-maintenance`,
`household-knowledge`, `meal-planning` (`index.ts` and `shared-server.ts`) and
`professional-crm`; `integrations/consolidation-workers/bio`,
`delete-thought-mcp`, `entity-extraction-worker`, `open-brain-rest`,
`readwise-capture`, `rest-api`, `smart-ingest` and `update-thought-mcp`;
`recipes/editorial-policy/auditor`, `work-operating-model-activation` and the
cost recipe's "before" sample — and `recipes/local-brain-no-mcp/functions/
_shared/db.ts` back on supabase-js; `scripts/check-fork-consistency.mjs`
(check 11); `extensions/test-auth.ts`; `compat/supabase-sql/README.md` and
`tsconfig.json`; the four extension READMEs and their `metadata.json`, the
deploy primitive, ten recipe and integration READMEs (`rest-api`'s and
`smart-ingest`'s gain the callout the other eight had),
`integrations/consolidation-workers/deno.json`, two comments in
`.github/workflows/fork-checks.yml`, `extensions/test-writes.ts`'s header
(Linear SMD-1480, filed from change 64's third review pass and widened by
comment from change 67).

Fix 13's codemod moved a file off supabase-js by changing one import line, and
the shim it moved it onto imports `bun`. The files it moved were written as
Supabase Edge Functions: they read their environment through `Deno.env.get`
and end in `Deno.serve`. So one line left them running nowhere — not under
Deno, which cannot resolve `bun`; not under Bun, which has no `Deno` — and
that state held for sixteen files: the five extension servers the ticket
names, the nine recipes and integrations change 67's comment widened it to,
and `rest-api` and `smart-ingest`, on the shim with a key compare of their
own. Changes 64, 67, 69, 71 and 73 each exercised them under the tests' two-
line stand-in for those globals, which is the only way they ran at all, and
twelve READMEs and the deploy primitive sent a reader to `supabase functions
deploy` above a callout saying it would fail. The ticket offered a revert; this fork's stated purpose
is running Open Brain without Supabase, fix 13 put these files on the shim for
exactly that, and change 73 had just made `consolidation-bio` run on it — so
the migration is finished instead, for every file on the shim, by the
mechanism fix 13 already owns.

**The mechanism.** `compat/deno-on-bun.ts`, imported first, installs
`globalThis.Deno` where none exists, with exactly the two members these files
use: `env.get(name)` reads `process.env`, and `serve(handler)` /
`serve({ port, hostname }, handler)` is `Bun.serve` on the option's port, else
`PORT`, else 8000 (Deno's default), printing Deno's `Listening on http://…/`
line and returning an object with Deno's `finished`, `shutdown()` and `addr`.
Anything else on `Deno` stays undefined, so a file that starts using
`readTextFile`, `args` or `exit` fails at the call under Bun with its name —
not on a quiet emulation of another runtime's semantics. Where `Deno` already
exists — on Deno itself, and under `test-auth.ts` and `test-writes.ts`, whose
stand-in captures the handler instead of listening and is installed before
any server is imported — the module does nothing. The codemod writes the line:
`--apply` adds `import "…/compat/deno-on-bun.ts";` before a migrated file's
first import statement when the file uses a `Deno.` member (ES modules
evaluate imports in order, and a helper whose module body reads `Deno.env`
before the polyfill has run is a `ReferenceError` at startup), and where the
file's first import was Supabase's type-only `import
"jsr:@supabase/functions-js/edge-runtime.d.ts";` — a specifier Bun does not
resolve; four of the sixteen had it — that line becomes the polyfill import
with the original recorded beside it (`// ob1-original-types:`), so the
position is kept; `--revert` undoes both byte for byte, and `--apply --all`
completes a file migrated before the line existed, so revert-then-apply is
still the identity (23 reverted, 23 re-applied, the tree unchanged). A `KEEP`
list beside the blockers names the one file the shim can resolve but must not
take: the local-brain recipe's client runs inside that recipe's own
self-hosted Supabase stack — `setup.sh` symlinks its `functions/` into the
stack's edge runtime — where PostgREST is present and `bun` is not; it is back
on `jsr:@supabase/supabase-js@2`, and the triage report says why. A recipe or
integration has no `node_modules` on its path; `NODE_PATH=extensions/
node_modules` (Bun honours it — probed) points the five that import `hono` or
the MCP SDK at the install `extensions/package.json` already pins to their
`deno.json` files, and the workers, the two APIs and the webhook receiver
import nothing but the shim and their own files. Check 11 holds the state: a
file under the seven category directories or `docs/` that imports the shim
and — itself or through the relative imports it evaluates, transitively — uses
a `Deno.` member has the polyfill as its first import statement; no member
beyond `env.get` and `serve` appears in the file or its imports; no `jsr:`,
`npm:` or URL specifier remains (`node:` is fine); comments and string
contents blanked first, line numbers kept; twelve probes, three through a
dependency, six non-probes, no exceptions. And `test-auth.ts` proves the run:
every file in the tree that imports the shim and calls `Deno.serve` — a glob,
so a newly migrated server joins or the guard fails — is started as a child
process, `bun <file>` with the environment its README documents and
`PORT=0`, the port read from the polyfill's `Listening on` line; then asked
over HTTP for the one thing that proves it is that server authenticating —
an MCP server's `tools/list` under a write key is its full tool list, an
API's read probe passes under a read key, a worker dry-runs under one, the
receiver admits its secret, the two APIs on their own key pass their gate —
refused with a wrong key, still running afterwards, then stopped. Sixteen
starts, four assertions each, in the required Portable-server job, no
database; the child's exit is awaited beside the read, so a crash fails at
once, and the child is stopped before its stderr is read, so a silent one
fails at the deadline rather than hanging the job.

**Decisions.** *Finish, not revert:* above. *A polyfill, not a per-file
seam:* the ticket sketched `server-portable/index.ts`'s pattern — env through
one accessor, `export default { fetch }` — which is right for a file the fork
owns and wrong for sixteen it vendors: the sixteen entries hold 96
`Deno.env.get` reads and 16 `Deno.serve` calls, and the four
`_shared/helpers.ts` modules and `network.ts` behind them 65 more reads,
every one a line the next rebase conflicts on, where the polyfill is one
line the codemod owns and reverts, the same standard fix 13 set (a probe first: an unmodified
`home-maintenance/index.ts` under `bun --preload` of the two globals
answered `tools/list` with its four tools and 401 to a wrong key). *Two
members, no more:* the polyfill is a statement of what these files use, and
the loud failure at any other member is the point — an emulated
`Deno.readTextFile` that differed from Deno's in one respect would be the
fork's recurring defect, a value defined twice. *First import:* a second
import ahead of it is a race the file's own order decides; check 11 names the
line. *In the `jsr:` line's place:* a byte-exact round trip needs the
position, and the swapped line is Bun's one unresolvable specifier in these
files — a type-only import, so Deno lost nothing either. *`KEEP`, not a
blocker regex:* nothing in the local-brain client's text says where it runs;
its deployment does, so the codemod names the file and the reason. *`NODE_PATH`,
not a `package.json` per category:* `extensions/package.json` already pins
what the servers' `deno.json` files pin and `test-auth.ts` holds the two
equal; a second install under `integrations/` and a third under `recipes/`
would be two more copies of that pin to drift. *`SUPABASE_URL` still carries
the Postgres URL:* fix 13's documented convention (the codemod's banner says
it); renaming the variable is the per-file rewrite the one-line philosophy
exists to avoid, and every README's run line says what the variable holds.
*`rest-api` and `smart-ingest` in scope:* the ticket and its comment count
fourteen; the tree has sixteen on the shim, and the drift guard is over the
tree, not a list. *The tests keep their stand-in:* they need the handler, not
a port, and the polyfill yielding to an existing `Deno` is what lets both be
true; only the last section of `test-auth.ts` runs the polyfill, and it runs
it as a user would. *`PORT=0`:* the OS picks a free port and the polyfill
reports it, which is what Deno's `Listening on` line is for — no probe, no
race. *`metadata.json`'s `tools`:* `Bun 1.4+` for the four, `Supabase CLI`
for the two that deploy by the primitive.

**Review pass 1** (a reading reviewer and a running one, the latter in its
own worktree with podman; twenty-nine items between them, three HIGH — two
of them one defect seen by both — five MED, nineteen taken). The running reviewer broke the new test section both
ways a child process can go wrong. A child that crashed at startup — the
polyfill with `serve` removed — was reported only after the full thirty-second
deadline, at 100% CPU, sixteen times over (eight minutes), with `exit null`
and a code frame where the error text should be: `reader.read()` answers
`{ done: true }` at once after the child's stdout hits EOF, so the loop spun
eleven million times, and Bun sets `exitCode` only when `exited` settles,
which the loop never awaited. And a healthy child whose `Listening on` line
did not match the regex hung the suite past fifteen minutes and left an
orphan: the failure message read the child's stderr to EOF while the child
was alive (the reading reviewer saw the same line). Now the loop races the
child's `exited` beside the read and a tick, drains once at EOF, kills the
child before reading stderr, surfaces the line containing `error` rather than
the frame above it, and names the deadline it waited — a crash fails in under
a second with `TypeError: Deno.serve is not a function`, sixteen crashes in
one, an unmatched port line at the deadline with no orphan, each re-run under
the mutation. A polyfill made to install over the tests' stand-in killed the
suite at the first import with a stack and no tally (port 8000 taken or not):
the import loop is a counted failure now, and an assertion after it says the
stand-in is still `Deno` — the identity the whole in-process section rests
on (709 assertions). The documented port was wrong for the fork's own
machine: podman's `gvproxy` holds `*:8000` on macOS, so `PORT` unset answered
`Is port 8000 in use?` on the first try; the polyfill keeps Deno's default,
the examples say `PORT=8787` (the shared meal-planning server 8788) and each
callout says why to set one. The reading reviewer found the two README
claims that would have failed a reader: every extension `schema.sql` creates
RLS policies on Supabase's `auth.uid()` (meal-planning's on `auth.jwt()`
too), which the fork's Postgres does not have, so the new `psql -f` step
died at the first policy — Step 1 now creates the two stub functions first
and says the table owner is not subject to the policies while the server
scopes rows by `DEFAULT_USER_ID` itself; and `work-operating-model-activation`
refuses to start without `SUPABASE_SERVICE_ROLE_KEY`, which its callout said
to leave unset — the callout says to set any value, and the test's spawns no
longer inherit the variable from the process, so "may be left unset" is what
the other fifteen starts prove. Check 11 widened at the running reviewer's
probes: a bare `Deno` — aliased (`const D = Deno`), bracketed
(`Deno["env"]`), destructured — is a use the rule cannot follow and is
refused as one; a dynamic `import("jsr:…")` is a specifier too; four probes
added and a non-probe widened (`globalThis.Deno.env.get`, a relative dynamic
import). The codemod, given a `jsr:` types import that was not the first
import, had swapped it in place — second — and left a second such line
alone; it puts the polyfill first in every layout now and turns any other
types import into the recorded comment, round trip identical on both
constructed files. Smaller: `PORT=""` was port 0, a random port, silently —
empty is unset now; `Deno.serve({ port, handler })`, Deno's options-only
form, is accepted; the reader is cancelled rather than released around a
pending read; the codemod's `Deno.` test reads comments (a harmless extra
line, said so) and check 11's import statements end at `;` (a semicolon-less
import would be a silent miss, said so). This section's counts were wrong
and are fixed: 96 reads and 16 serves in the entries and 65 in the helper
modules, not "64 and 64"; twelve READMEs and the primitive carried the
callout, not fourteen; ten recipe and integration READMEs were edited, not
nine; and the by-hand probe of an unmodified extension ran with the globals
preloaded, so "fails at `Deno is not defined`" was not observed and is not
claimed. The four extension credential trackers gain a Postgres URL line.
Not taken: the migrated files' banner still says `node scripts/…` while the
header says `bun` (rewriting 23 banners for a word; node runs it too); the
bio worker's dry run under a write key answers 404 without a `?name=`, past
the gate as the test counts it; `deno check` of the local-brain recipe's
`capture/index.ts` fails in its `embed.ts` on a parameter property —
pre-existing at the pin, not this change (its `db.ts`, back on supabase-js,
checks clean).

**Review pass 2** (the same two reviewers; twenty-one items between them,
one HIGH, three MED; sixteen taken, one filed). **The stop signal, for this
change's mechanism:** every finding in the polyfill, the codemod, check 11
and the test was polish on pass 1's additions — the deadline constant printed
as its own source text (a double-quoted string inside the template), the
error-line picker preferring `throw new Error(` to the `error:` line below
it, a child that printed its port and then exited crashing the suite with no
tally where the probe's `fetch` threw (a counted failure now, re-run under the
mutation), the postgres stub left in `/tmp` on the import-failure path,
`--revert` turning a person's `// ob1-original-types: …` comment into an
import (the record is a `jsr:` specifier and only that is restored, the
constructed layout round-trips identical now), a backtick dynamic import
unread (read now; one with `${…}` is not a literal), the blanker's template
literals and the two runtime-detection idioms stated as limits, the ten
callouts saying "set one" above command lines that set no port (they say
`PORT=8787` now), the README's `CREATE OR REPLACE FUNCTION auth.uid()` — which
on a real Supabase database would have replaced GoTrue's function with one
returning NULL and broken row-level security across the project — a plain
`CREATE` now, refused where the function exists, with the warning before the
command, and pass 1's own tallies (twenty-nine items, not thirty-two). The
running reviewer confirmed pass 1's two fixes load-bearing: with the `exited`
race removed the busy-spin returns (sixteen crashes in 49 s at a 3 s
deadline); with it, 1.1 s. And it re-ran the codemod's four odd layouts
(identical) and the mutations (a)–(c) (as pass 1 left them).

**The one HIGH is not this change's.** The running reviewer did what no pass
before it had: it applied the five `schema.sql` files to a real Postgres
(after the README's two stubs — they apply cleanly, RLS on, connected as the
owner), started each server under `bun`, and called all twenty-five
extension tools through `tools/call` with a real key. Seven fail, on three
gaps in the shim that predate this ticket — fix 13 migrated these files and
never drove them: the shim has no `.not()` (two tools: `get_upcoming_
maintenance`, `crm_get_follow_ups` — the only two calls in the tree); four
tools select a PostgREST embed the codemod's blocker regex let through, since
it wants the table name flush against the parenthesis and `maintenance_tasks (`
and `recipes:recipe_id (` are not (`search_maintenance_history`,
`get_meal_plan`, `generate_shopping_list`, the shared `view_meal_plan`) — so
fix 13's "four of the 54 files use embedding" undercounts; and a JavaScript
array binds as its `String()`, so `crm_add_contact` with `tags: []` is `22P02
malformed array literal: ""`. Two more tools' error paths render `[object
Object]` because the shim's error is a plain object where supabase-js's
extends `Error`. The write path works — `add_maintenance_task` stores the row
under the configured `user_id` — so a fork user could add tasks and never
list what is due. That is a second mechanism (three shim features and the
codemod's blocker, with a tool-level drive to hold them), and it is filed as
SMD-1588 with the evidence; here, the four extension READMEs name their
failing tools above the Connect step (household-knowledge's all ran), the
primitive and the shim README carry the count once, and this section's claim
is the exact one: the servers start, authenticate and answer over the port —
eighteen of twenty-five tools work end to end, seven wait on SMD-1588 (done in
change 77, which also found the count was twenty-nine: the shared meal-planning
server's four had not been counted).

**Boyscout.** The passes' cut-for-space tidy-ups in the files this change
touched, no behaviour changed: the test's deadline is one constant for the
section rather than one per child; the CI step that runs the checker names
what it checks through check 11 (it stopped at check 8); this section's
counts of check 11's probes read the arrays as pass 1 left them (twelve,
three through a dependency, six non-probes; "eight" and "eleven" were the
implementation's) and pass 1's paragraph says what it added (four probes and
one widened non-probe, not "two non-probes"). Left as they are, with the
reason: the migrated files' banner says `node scripts/…` while the codemod's
header says `bun` — 23 upstream-owned files for a word, and node runs it; the
extension credential trackers' Supabase lines beside the new Postgres URL
line — upstream's teaching path.

**Verified:** `bun test-auth.ts` 709/709 (643 before: sixteen starts × four
assertions, the tree guard, and the stand-in's identity after every import); every one of the sixteen — the five
extension servers, the sample, `work-operating-model-activation`, the two
thought servers, `open-brain-rest`, the auditor, the two workers,
`readwise-capture`, `rest-api`, `smart-ingest` — starts under `bun`, says its
port, answers its probe and is still running (the auditor's dry run under a
read key answers 500 against the refused stub database, past the gate as in
the in-process section); before the change an unmodified integration under `bun` failed at its
`jsr:` import and an unmodified extension served only under `bun --preload`
of the two globals — the two starts probed by hand; `bun scripts/check-fork-consistency.mjs`
PASS with check 11's fifteen probes, and six mutations of the tree each caught
on the right file and line — the runtime line removed, the line moved after
`hono`, `Deno.exit` in an entry, `Deno.args` in a `_shared/helpers.ts` reached
through its entry, the `jsr:` line restored beside the polyfill, `npm:hono`
as a specifier (a lesson from the mutant run: `git checkout --` restored the
mutated files to HEAD and wiped the branch's own uncommitted lines with them
— restore a mutation from the saved text, never from git, on a dirty tree);
after pass 1, the test's own failure modes re-run under mutation — `serve`
removed from the polyfill: sixteen named failures in 0.9 s with the
`TypeError` text; the polyfill installing over the stand-in: one counted
failure with a tally in 0.1 s; the port line unmatched under a two-second
deadline: sixteen failures in 33 s, no orphan — and the codemod's two odd
layouts (a `jsr:` types import second; two of them) each round-trip
identical with the polyfill first; after pass 2, a child that exits after
its port line is one counted failure, a human-written
`// ob1-original-types:` line survives `--revert`, and the running
reviewer's end-to-end run stands as the measure of what works: five schemas
applied, sixteen servers started, eighteen of twenty-five extension tools
answering, the seven that do not named in their READMEs and in SMD-1588;
`../db/with-postgres.sh bun test-writes.ts` 186/186 (the bio worker and the
other drivers unchanged under the stand-in); `bunx tsc --noEmit` in
`compat/supabase-sql` clean with `../deno-on-bun.ts` in its include;
`../../db/with-postgres.sh bun test-compat.ts` 84/84; the codemod round-trips
(23 reverted, 23 re-applied, the tree byte-identical, the local-brain client
kept) and its triage report marks a migrated file lacking the line with `!`
and prints the `KEEP` reason under "Needs a human". The ticket's verify —
each of the five starts under Bun and answers `tools/list` with a scoped key,
in CI; `test-auth.ts` still passes, and its stand-in is now the test's
convenience rather than the files' only runtime — is the suite.

**Not done here.** SMD-1588: the shim's `.not()`, array binding and error
class, the codemod's embed blocker (a space or an alias before the
parenthesis), the one-hop embed or an honest refusal for the three servers
already on the shim, and a drive of every extension tool against Postgres —
seven of twenty-five fail today, named in the READMEs (done in change 77). Deno deployability of a shim-importing file: the shim is
Bun's `SQL`, and a Deno-capable shim would be a second client to hold equal
to the first — the files that must deploy to Supabase stay on supabase-js
(`family-calendar`, `job-hunt`, `ob-graph`, `agent-memory-api`,
`metadata-norm`, `kubernetes-deployment`, the local-brain client). A compose
service per extension in `deploy/`: each server is one `bun` process on one
port, and `SETUP.md`'s TLS proxy is where a hosted client reaches it; the
READMEs say so. The extension READMEs' Supabase-shaped prose outside the run
step — credential trackers naming a project ref, RLS steps that assume
`auth.jwt()` — is upstream's teaching path and is left as it is beyond the
prerequisites, the schema step and the user-id step. The `Deno.serve` return
object carries `finished`, `shutdown()` and `addr` and nothing else of
Deno's `HttpServer`; no file on the shim reads even those. `rest-api` and
`smart-ingest` keep their own single-key compare (check 8 passes it; SMD-1455
left them). SMD-1541 and SMD-1525 as before.

**Upstream status:** not applicable — the shim, the codemod and the polyfill
are this fork's (fix 13); upstream's copies of these files deploy to
Supabase on supabase-js, which is what `--revert` restores. **Unfiled.**
