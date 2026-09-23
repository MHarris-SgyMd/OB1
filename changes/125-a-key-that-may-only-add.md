# 125. A key that may only add — the `capture` scope, a `source` label on capture_thought, and migration 049 (SMD-1298)

**What changed.** `auth.ts` gains the `capture` scope — `capture_thought` and
nothing else; index.ts asks canRead / canCapture / canWrite, one per tool
group, and the manifest (`tools.ts`) tags the tool `capture` and derives every
surface from UNLOCKS. `authenticate()` admits only the scopes its caller names
(read and write when it names none), so the vendored servers — six
byte-identical copies that register their read tools for every principal —
treat a capture key as unknown; the core passes SCOPES. A capture key may name
as `supersedes` only a thought whose capture audit row is its own
(`captureActorOf`; SELECT on thought_audit joins the `server` grant group —
without it, or with the registry away, the pointer is the server's `Error:` to
retry, and a registry that refuses the key's label is said once in the log). It
is told nothing of whether a text already existed, and has its `derived_from`
trimmed before the write to the ids that exist (`liveSubset`), the reply saying
nothing of it — not which, not how many; a source deleted between the trim and
the write is met by one more trim and write. A reader's refusal names positions
and ids. `capture_thought` takes `source` (lower-case, digits, hyphens, 2–40),
recorded as `metadata.source` and on the audit row, `mcp` when absent — the
row's label at every step, the egress gate's at the capture too, and a caller's
claim, so a term about who wrote names `actor:` (SMD-1941 binds a label to the
key; preflight warns on a `source:` term). Migration 049 widens
`ob1_agent_keys.scope`'s CHECK to admit `capture` — 010's column records the
scope a key last presented, and `resolve_agent()` would have refused the row.
It refuses by name without 010's table or its column, and drops every CHECK on
the column alone, whatever name a restore left it under, before adding the
three-value one. Preflight's `agent identity` reads the CHECKs on the column by
what they say, in every spelling Postgres renders: a list lacking a scope a
configured key presents fails naming 049, a list lacking one no key presents
warns, another CHECK on the column alone is named as what 049 will drop. keygen
mints the scope; preflight counts it. The client is `recipes/session-capture-hook`
(SMD-1989).

**Why.** Capture is one thought at a time when an agent chooses to write; a
hook that writes at every session end holds a credential on every machine that
runs it, and a write key is a superset of a read key. The ticket's "server
changes nothing" and its capture-only key could not both hold.

**Held.** test-auth [2]–[4], [7], [7b], [8]; test-e2e-sql [13]: the capture
key's surface (an out-of-scope tool is an isError result saying `MCP error
-32602`, pinned), source, audit row, provenance and agent id; no search or
delete; supersedes by agent id after a rename in the record and by name with
the registry away, refused for another key's thought, an `Error:` with the
audit table unreadable; a ghost source dropped, never named nor counted, on a
new row and a re-capture alike, and in the write's own refusal, where a
validator that refuses N calls holds the second write (the reader-only branch
needs the race, so its gate is untested); the audit row's origin. test-schema
[45]: the live CHECK, a two-value rule under another name dropped, a rule
spanning two columns kept, the column renamed away refused by name.
test-upgrade's window and [20d]. test-preflight: no CHECK, two-value under its
own and another name, three-value beside two-value, the array-literal
spelling, a list without read on a brain with write keys alone, a non-list
CHECK named by its definition, the `--grant` remedy. Both store suites read
the capture row's actor with a tied created_at. The six auth copies
byte-identical (extensions/test-auth).

**Review passes.** Thirteen over the combined branch
(`michaelharris/smd-1298-session-end-capture`, whose log holds every
`(caught: …; held: …)`); the server's share:

| Pass | Finding | Caught by | Fix |
| --- | --- | --- | --- |
| 1 | A capture key could `supersedes` any thought; the vendored servers admitted it to their read tools; the re-capture note told it a text existed | cold read | ownership by the capture audit row; `authenticate` admits the scopes its caller names; `existed` only to a reader |
| 2 | `captureActorOf` read a table the capture grant group holds INSERT alone on; a refused provenance dropped all forty sources over one | cold read + run-it | SELECT joins the `server` group; positions named, dropped one by one |
| 3 | Naming refused positions was itself an existence oracle; preflight passed a capture key on a brain before 049 | cold read | trimmed before the write, the reply counts and never names; `agent identity` fails naming 049 |
| 4 | The gate judged `mcp` at a capture and the row's label at the passes; a row without an agent id was owned by any later key of the same name | cold read | the row's label at every step; names compare only when neither side has an id |
| 5 | The server said `Refused:` for a pointer it could not check or attribute, so the hook dropped it; "no CHECK at all" read as the two-value CHECK | cold read + run-it | `Error:` for what it cannot judge; its own row |
| 6 | The registry refusing a label and being unreachable were one condition; every ownership-read error carried the grant remedy | cold read + run-it | `unresolved` on the outcome; 42501 alone names `--grant` |
| 7 | Gating the dropped-sources note on the row's existence made its absence an oracle; the merge left test-upgrade's window one short (CI red); the scope-CHECK probe named no schema | cold read + run-it | the note said whenever ids were trimmed; eighteen; `public` |
| 8 | The count itself was an oracle with one id sent; the check-then-write race still named a position to a non-reader; the refusal wrote no log line | cold read | a non-reader is told nothing; a once-per-key warn |
| 9 | Preflight found the CHECK by name, so the two-value rule under another name read as "no CHECK at all", and 049 would have left it standing beside the new one; the write's own refusal leaked the count through its verb | cold read + run-it | found by the column it is on; 049 drops every CHECK on the column alone; the verb agrees with what is said |
| 10 | 049 carried no "needs 010" guard, alone among its siblings; its drop matched the word `scope` in any definition; three spellings of that match | cold read | the guard, driven by [20d]; the CHECKs whose column list is exactly {scope}, one shape |
| 11 | The guard checked the table and not its column; `captureActorOf` had no tiebreak and no test; `TOOL_NAMES` restated the hierarchy | cold read + run-it | the column, refused by name; `id` (a uuid — stable, not chronological) in both stores, tested; derived from UNLOCKS |
| 12 | A source deleted between the trim and the write refused the whole capture; a list naming capture alone was "not the scope rule" | cold read + run-it | one more trim and write for a key that cannot read; a value list by its shape |
| 13 | The array-literal spelling was "not the scope rule"; a list lacking a scope no configured key presents FAILED; an out-of-scope tool's shape was pinned to what the SDK sends | run-it + cold read | every spelling; a warning; an isError result, in e2e |

**Not taken.** The egress gate judging the caller's `source` label: one value
for a row's lifetime beats a term a capture-time deny could dodge; `actor:` is
the trustworthy unit (SMD-1941). One `Promise.all` over the two pre-write
reads. UNLOCKS as auth.ts's one predicate — six vendored copies and every gate,
held equal by the drift test today. A `session-summary` thought type —
THOUGHT_TYPES has five values and the metadata model chooses among them.

**Follow-ups.** SMD-1989 (the hook and the skill, stacked on this); SMD-1941;
SMD-1978 (machine-readable refusal codes — the hook reads the server's prose).

**Upstream status.** Not upstream: one scope, read or write, and a server-assigned `source`.
