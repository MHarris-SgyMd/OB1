# 97. The SQL store is the default — `OB1_STORE` unset selects `store-sql.ts`, `preflight.ts` carries no supabase-js client of its own, and the PostgREST store is kept for Cloudflare Workers alone, reported as retired wherever Bun runs (SMD-1797)

**Problem.** `createStore` read `OB1_STORE ?? "postgrest"`: the portable server,
this fork's reference deployment, reached its brain through Supabase's PostgREST
API unless told otherwise. `SETUP.md` — "No Supabase account" — held only
because `deploy/compose.yaml` set `OB1_STORE=sql` by hand, so the default
contradicted the document written around it, and the two fast suites ran the
PostgREST store against a stub URL — `test-server.ts` by relying on the default,
`test-auth.ts` by selecting it — the store no SETUP.md deployment has. `preflight.ts` imported
`@supabase/supabase-js` for two probes of its own — a 4-argument `match_thoughts`
and a 7-argument `update_thought`, sent as an outside caller would to catch an
older overload beside the current form — that no fixture ever drove: test-preflight
runs the direct-SQL path only, and the PostgREST probes were held by reading
(the SMD-1712 note on the ticket). Sub-issue 2 of SMD-1795; change 93 was 1.

**The Workers decision, stated rather than hedged.** Cloudflare Workers cannot
hold a Postgres connection, and `store-sql.ts` imports Bun's client, which does
not exist there — so the retirement is of the *default* and of preflight's own
client, not of the file. `store-postgrest.ts`, `test-store-postgrest.ts` and the
`@supabase/supabase-js` dependency stay in `server-portable/` for that one
target, and `wrangler.toml` now pins `OB1_STORE = "postgrest"` as a `[vars]`
binding (a property of the target, not a secret — `wrangler deploy --dry-run`
lists it), because under the new default a Workers deployment that relied on
the old one fails at its first tool call — on the SQL store's `DATABASE_URL`
refusal, or, with a connection string set, at `shims/bun-unavailable.ts`. Whether
a driver that runs on Workers (Hyperdrive in front of `postgres` or `pg` over
`connect()`) lets the SQL store run there is **SMD-1847**, filed here as the
measurement the ticket asked for before any promise; until it lands, Workers is
PostgREST-only, and SMD-1336, SMD-1245 item 1 and SMD-1040's PostgREST
normalisers stay open with the file.

**Change.**

- `store.ts`: `DEFAULT_STORE = "sql"`; `storeKind(env)` (lower-cased, defaulted)
  and `createStore` read it. `databaseUrl(env)` resolves the SQL store's
  connection string — `DATABASE_URL`, else `SUPABASE_URL` when it holds a
  `postgres://` URL, the spelling `compat/supabase-sql` takes for every
  vendored server migrated onto it, so a box running one beside this server
  sets one name — and says which variable supplied it. `missingDatabaseUrl(env)`
  is the one refusal for `createStore`'s throw and preflight's `DATABASE_URL`
  line, problem and fix apart; when `SUPABASE_URL` holds an `https://` URL — the
  deployment the old default served — it names both ways out: a connection
  string, or `OB1_STORE=postgrest` to keep reaching the brain through PostgREST.
  `postgrestOnBunNotice(kind, hasBun)` is the retired line: a string for
  `postgrest` on a runtime with `Bun`, null on Workers and for every other
  selection. The unknown-store message names `sql` as the default and
  `postgrest` as the Workers store. The docblock's cutover rationale — run both
  stacks and diff — is recorded as done (test-store-postgrest, the shared
  normalisers) rather than as the reason both files exist.
- `index.ts`: `db()` logs the notice once, at the moment the selection takes
  effect; the `Env` comments say which store each variable serves.
- `preflight.ts`: no `@supabase/supabase-js` import. `store selection` reports
  `OB1_STORE unset — sql, the default`, or a **warn** for `postgrest` carrying
  the notice as its fix line, or the fail naming both stores. The connection
  string is resolved once (`conn`) and every direct-connection check dials
  *that* — before, the block was gated on `env.DATABASE_URL` by name, which
  would have skipped every catalog check for a `SUPABASE_URL`-supplied string.
  Over PostgREST, `search signatures` and `edit signature` probe through the
  store's own calls (`matchThoughts` with 020's six arguments; `updateThought`
  on an id no row has, which answers `NOT_FOUND` and writes nothing) — 020's and
  032's forms are proved, and the overload half, a `pg_proc` fact, is named as
  the SQL run's with `CATALOG_HINT` rather than probed through a client
  preflight no longer has. `CATALOG_HINT` itself no longer says
  `OB1_STORE=sql`.
- `wrangler.toml` `[vars] OB1_STORE = "postgrest"` with the reason;
  `shims/bun-unavailable.ts` says how the stub is reached under the new default;
  `.dev.vars.example` points at the binding; the Dockerfile's env comment lists
  `DATABASE_URL` first.
- `deploy/compose.yaml` drops `OB1_STORE: sql`: the "Full stack, no Supabase"
  job now runs the default, so a default that drifted back would crashloop the
  reference deployment in CI rather than pass with the variable set by hand.
- Tests. `test-e2e-sql.ts` leaves `OB1_STORE` unset and asserts it (the
  data-layer job's tooth: with the default reverted the suite dies at its first
  tool call — run). `test-auth.ts` runs the default store against
  `127.0.0.1:1`, refused at once, in place of the stub PostgREST; its [11] says
  so. `test-server.ts` seeds no store at all — nothing there calls a tool — and
  its new **[14]** holds the factory: an empty env is `sql`; no connection
  string is refused as the SQL store naming `DATABASE_URL`, never
  `SUPABASE_URL`; an `https://` `SUPABASE_URL` under the default is told
  `OB1_STORE=postgrest`; a `postgres://` one is the connection string, after
  `DATABASE_URL`, and builds the SQL store; `postgrest` still builds its store;
  the notice fires for `postgrest` with Bun and for nothing else; the
  unknown-name refusal names the default. `test-preflight.ts` [1] adds the
  unset run (exit 1, both lines say `sql`, `SUPABASE_URL` not asked for), the
  `https://` run (both ways out), the `postgres://`-alias run (masked,
  attributed, not called unused, failing only at the unreachable database) and
  the `postgrest` run (a `!` line naming Workers, the notice as its fix, its own
  config still `✓`); its DIRECT_CHECKS anchor follows the block's new gate.
  `test-store-sql.ts` [1] builds the store with no `OB1_STORE` and counts rows
  through it. Reverting `DEFAULT_STORE` to `postgrest` fails test-server [14]
  (four assertions on the first tree; six, then an abort at the alias build,
  after the review passes) and crashes test-e2e-sql at its first capture (both run).
- Docs: `server-portable/README.md`'s store table (sql default; postgrest =
  Workers, selected by `wrangler.toml`), the paragraph under it, the env block
  (`DATABASE_URL` required; the Workers variables and the `SUPABASE_URL` alias
  explained; the `https://`-under-default refusal), the suite counts (177 / 67 /
  31 / 113 / 112 after the review passes; Workers bundle 342 KiB gzipped,
  measured — the file said 281 from an earlier stack) and the Workers caveat;
  `SETUP.md`'s two deployment rows.

**Not done, and why.** The ticket proposed a new `OB1_DATABASE_URL` "that does
not say Supabase". `DATABASE_URL` already is that name — `db/`, `deploy/`, CI
and `SETUP.md` all use it and it names no vendor — so a third spelling for one
value was declined; the `SUPABASE_URL` alias covers the one-box case the ticket
had in mind. Said on the ticket; reversible in a line.

**Measured.** `bunx wrangler deploy --dry-run`: `env.OB1_STORE ("postgrest")`
listed as an Environment Variable binding, 342.42 KiB gzipped. Suites on this
tree after the third review pass: test-server 177, test-auth 67, test-thoughts
102, test-store-sql 113, test-store-postgrest 99, test-e2e-sql 112,
test-preflight 253, test-local-provider 31; `tsc --noEmit` clean;
`check-fork-consistency.mjs` PASS.

**Review, first pass** (one cold reviewer over the diff, the author's own
read). The reviewer ran preflight with `OB1_STORE=postgrest` beside a
`SUPABASE_URL` holding a `postgres://` string — the one-box slip this change
made likely by documenting that variable as a legitimate holder of a connection
string — and the report printed the URL raw, password included, then handed the
string to supabase-js and blamed "network reachability" for its `protocol must
be http:, https: or s3:`. Fixed with one refusal for both callers
(`postgrestOverPostgresUrl`, thrown by `createStore` and failed by preflight
before the store is built) and `maskUrl` on every URL a report prints; the
`m` run in test-preflight [1] holds it, `hunter2` asserted absent. The reviewer
also ran the old-default deployment and read the report contradicting itself —
the `DATABASE_URL` failure naming `OB1_STORE=postgrest` as a way out, two lines
above warns saying to remove the variables that way out needs; the warns now
wait for a connection string. Two teeth were found loose by reasoning about
their mutants: the alias run's `/schema\s+/` matched the config-skip line, so
"fails at the unreachable database" was asserted by exit code alone, and the
gate the section above singles out (`conn`, not `env.DATABASE_URL`) was held
by a source-text anchor and nothing behavioural — the run now requires the `✗
schema` glyph, the absence of the skip text and `vector extension … could not
verify`, the first direct check carrying the refused connection; and
`index.ts`'s once-only notice had no test at all — test-server **[15]** boots a
second module instance (Bun keys its cache on the specifier, so a query string
yields one) with `postgrest` selected and captures `console.warn` across two
tool calls. Both drills run: the gate reverted with the refusal dropped fails
six assertions; the notice silenced fails two. Two claims corrected —
`test-auth` never ran the default, it selected PostgREST by hand; "holds an
`https://` URL" said of every non-`postgres://` value, a self-hosted
`http://` PostgREST included — and six stale sentences (two CI comments, two
test headers, `store-postgrest.ts`'s docblock, a checker comment) that still
called `OB1_STORE=sql` the setting every suite runs or PostgREST the default. The author's own read added the schema remedy's
`--url $DATABASE_URL`, empty under the alias, which now names the variable that
holds the string or, over PostgREST, what to hand the migrator instead. One
pre-existing by-catch, fixed because the change rewrote the block: over
PostgREST with the schema check failed, `edit signature` printed nothing, and
on every PostgREST run sixteen SQL-only checks (`vector extension` through
`migration ledger`) printed nothing while the README called them skips — every
`DIRECT_CHECKS` name not yet reported is now a named skip, and the README
sentence is true. Checked and left: the removed 4- and 7-argument probes had
no fixture in the parent, so nothing covered became uncovered; `wrangler.toml`
has no `[env.*]` sections, so the top-level `[vars]` applies (a named
environment added later would not inherit it).

**Review, second pass** (a fresh cold reviewer, the author's read) — **STOP
signal fired**: every finding sits in the first pass's additions, none in the
change, and none is a behavioural defect. The `w` run's four-name sample of the
new skip loop was a presence test: the reviewer moved the loop above the
hand-written PostgREST skips in a copy, four names printed twice, and all eight
assertions stayed green — the run now reads `DIRECT_CHECKS` from the source, as
[4] does, and requires every name to print exactly one row, sixteen of them as
the catalog-only skip. `maskUrl`'s `[^@]*@` stopped at the first `@`: a raw `@`
inside a password left its tail in the report, and a credential-less URL whose
query carried one lost its host (the author found the second, the reviewer the
first) — the userinfo now ends at the last `@` before the first slash, with
both cases, an IPv6 host and a path-less URL asserted. [15]'s second assertion
matched two phrases a pasted copy would also carry; it now compares the
captured line to `postgrestOnBunNotice("postgrest")` byte for byte. One stale
sentence the first pass's sweep missed (`test-store-postgrest.ts`: "the default
store speaks PostgREST" — the Workers store does), the README's "every
direct-connection check is a named skip" corrected to say five are probed
through the store's own calls (six once main's 042 `delete signature` probe
merged in — rewritten through the store's `deleteThought`, as the other two
were, since preflight no longer has a client of its own), the tally above corrected (two test headers and
a docblock, not three headers), and the `DIRECT_CHECKS` comment now says whose
order the list is in. Drills run: the loop moved above the hand-written skips
fails the exactly-once assertion naming the four doubled rows; `maskUrl`
reverted fails the raw-`@` case. Checked and left by the reviewer: the loop's
placement (after every hand-written row, before the SQL-only block; `chunk
context` on is not doubled), the `mismatch` branch's handling of the key, [15]'s
module isolation (no module-level state in store/auth/agents), and every count
in this section. The 1796 precedent — pass 2 called STOP and pass 3 found a
defect — is noted; the signal here rests on a reviewer who ran the code, not
only read it.

**Review, third pass** (a third cold reviewer, angles the first two had not
taken: the Workers path by reading, the entrypoint sequence branch by branch,
every spawn of the server outside its directory; the author ran the compose
stack). No behavioural defect. One claim error in the change's own text, made
four times: `wrangler.toml`, the stub's docblock and message, the README and
this section said a Workers deployment that lost its `[vars]` binding "reaches
the stub on its first request" — it does not unless it also has a connection
string, because `createStore` refuses on the missing `DATABASE_URL` before
`store-sql.ts` is imported (test-server [14]'s `https://` case is that path);
all four now say which refusal comes first. Three counts this section carried
had gone stale across the passes (the README's test-server figure, the mutant's
"four assertions" — six and an abort on the current tree — and the first pass's
"seven"). And a gap in the second pass's tooth: it counts rows for the names in
`DIRECT_CHECKS` only, so a hand-written PostgREST row under a misspelt name
would print beside the loop's correctly named skip with every count intact —
the `w` run now also requires that every row between `data layer` and the
provider section be `schema` or a listed name. Drill run: `edit signature`
misspelt in the PostgREST branch → the total names 27 rows for 26. Checked by
the reviewer and left: on Workers `initEnv` spreads the bindings over
`process.env`, which `nodejs_compat` also populates from them, so the binding
reaches `env()` either way; `typeof Bun` is a default-parameter expression
evaluated at call time and survives in the bundle; every `createStore` branch
has the matching preflight verdict through the same helper, so no configuration
passes the entrypoint and fails the first tool call or the reverse; every
spawn of the server or preflight outside `server-portable/` (`db/test-live.ts`,
`db/test-search-path.ts`, `evals/eval-chunking-e2e.ts`) selects the store
explicitly. **Measured by the author:** `deploy/compose.yaml` brought up as the
"Full stack, no Supabase" job does, on its own ports, with `OB1_STORE` absent
from the server's environment — preflight reports `OB1_STORE unset — sql, the
default` and OK with every direct check green, `smoke.sh` 9 of 9,
`thought_stats` over MCP reaches the database, no `supabase` binary in the
image. On the stop signal: the second pass's rule held for code — nothing here
changed behaviour — and the third pass's finding in the change itself was a
sentence, four times; the 1796 precedent stands as the reason a third pass was
worth running.

**Tidied while the files were open** (no behaviour change): test-server [14]'s
five copies of the try/catch that reads the factory's refusal are one
`refusal(env)` helper; test-preflight's `w` run builds its report-row regex in
one `rowRe(name)` rather than twice; preflight's PostgREST configuration block
is two variables handled in two blocks instead of a loop with a special case
for one of them. Suites unchanged: test-server 177, test-preflight 253.

**Upstream status.** Upstream has no `server-portable/`; nothing here touches a
vendored file. The PostgREST store's retirement from Bun is the fork's decision
and SMD-1847 owns its retirement from Workers.
