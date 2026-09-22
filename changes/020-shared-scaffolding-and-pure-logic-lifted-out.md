# 20. Shared scaffolding, and pure logic lifted out of `index.ts`

A refactor pass over code this fork owns entirely — `server-portable/`, `db/`,
`evals/`, `compat/` are all new directories, so none of this can conflict on a
rebase. It found two live defects before it removed a line, which is recorded
above; what follows is the extraction itself.

**`db/test-support.ts`** — `dropSchema()`, `applyMigrations()`, `resetSchema()`,
`createAssert()` with `skip()`, and `requireDatabaseUrl()`. Nine suites had their
own schema reset, eleven their own counting assert. Drop and apply are separate
exports because `db/test-live.ts` only drops (it applies later, since `migrate.ts`
is what it tests) and `test-preflight.ts` asserts the un-migrated state in between
— two steps beat an option that exists for one caller. `dropSchema()` owns a
function list as well as a table list, which closed a latent bug: `test-live` had
never dropped the 4-argument `upsert_thought` migration 007 added, so its reset
left one behind, masked by `CREATE OR REPLACE`.

**`server-portable/test-support.ts`** — the MCP client five suites carried,
including the SSE fallback that is easy to omit when copying and only fails on
transports that use it.

**`evals/lib.ts`** — the spec grammar (`model[!bare|!gemma][@dims]`), prompt
application, the embedding call and cosine. Four harnesses had their own `embed`
and were sending **three different query instructions**, none of them the server's.
Since the same model scores 0.938 prompted and 0.860 bare, that made their numbers
incomparable to each other as well as to production.

**`server-portable/thoughts.ts`** — `normaliseType`, `thoughtTitle`, `thoughtUrl`.
Extracted for testability, not size: `index.ts` exports only its fetch handler, so
these were reachable only by booting a server, stubbing a provider and driving a
capture over JSON-RPC, once per case. Nobody writes seven of those to check an
alias table, so nobody wrote any — the table had been shipping unverified since it
was added, and it exists because llama3.2 really did return `action_item`.
`thoughtUrl` now takes its base as an argument instead of reading the environment,
which is what lets the file be tested without one. `test-thoughts.ts` adds 40
assertions and needs neither database nor provider.

**Not split:** the six `registerTool` blocks are 430 of `index.ts`'s remaining 947
lines. They are schema plus handler, cohesive, and already driven end to end over
MCP. Splitting them would be motivated by a line count.

**The codebase got slightly bigger, not smaller**, and it is worth being straight
about that. Measured across the five refactor commits, excluding markdown:

| | added | removed | net |
| --- | --- | --- | --- |
| existing suites and harnesses | 103 | 487 | **−384** |
| new shared modules and tests | 467 | 9 | **+458** |
| | | | **+74** |

So 384 lines of duplication genuinely left the callers, and 458 arrived in five new
files — of which 79 are `test-thoughts.ts`, coverage that did not exist before, and
much of the rest is the comments explaining why each helper is shaped as it is. A
line count was never the case for this: the case is that adding a table to the
schema used to mean nine edits and now means one, and that four harnesses can no
longer disagree about what prompt they send.

Every suite reports exactly the count it reported before the pass — 63, 30, 37, 30,
31, 15, 13, 10, 21, 61, plus 43, 41 and the new 40 — which is the only check that
means anything when the thing being refactored is the tests.

One process note, since it cost four reverts. Regex-over-the-file replacement
failed three times: twice by over-matching into unrelated code, once by silently
not matching and leaving dead code beside an unused import. What worked every time
was line-anchored — locate the declaration, walk to its boundary by brace column,
assert the span contains nothing unexpected, and refuse the file otherwise.
