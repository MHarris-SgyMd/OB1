# 103. Change 69's five servers name the key on 008's audit row — `p_actor` on `update_thought`, `actor` in `upsert_thought`'s payload, three from the principal they authenticate and two from the one key they hold — and `test-writes.ts` reads the row after every driven capture and edit (SMD-1541)

`integrations/update-thought-mcp/index.ts`, `integrations/enhanced-mcp/index.ts`,
`integrations/agent-memory-api/index.ts`, `integrations/open-brain-rest/index.ts`,
`integrations/rest-api/index.ts`; `extensions/test-writes.ts`; their READMEs
(Linear SMD-1541, filed from change 71's second review pass and named under
changes 71, 73 and 75's "as before"). Change 69 routed these five through
`update_thought` and the 3-argument `upsert_thought`, and each file's
`ob1-fork (SMD-1228)` header said the functions are used "so … the actor
reaches the audit (008)". The functions set `ob1.actor` only from what the
caller passes — `p_actor jsonb` on `update_thought` (032), `p_payload.actor`
on `upsert_thought` (008, kept by 033 and 035) — and none of the five passed
either, so `thought_audit.actor_name` was NULL for every capture and edit
through them, exactly as for the raw writes change 69 replaced, while the
headers, change 69's prose ("no actor set for 008's audit row" as a defect of
the raw write) and 008's own comment on the column ("NULL for mutations made
outside the server") said otherwise. A server with a key is the case the
column exists for. SMD-1730 (Phase 1a of the claim log) derives `actor_kind`
from `ob1.actor` plus the key, so until these five passed one its "every
writer produces one audit row with all six fields" could not hold for them.

**The ticket's premise, corrected.** It said each of the five "authenticates a
`Principal` through `_shared/auth.ts` and has `principal.name` in scope at the
write". Three do: `update-thought-mcp` (the tool closes over `buildServer`'s
principal), `agent-memory-api` and `open-brain-rest` (Hono's `c.get("principal")`).
`enhanced-mcp` and `rest-api` do not — each holds one key, `MCP_ACCESS_KEY`,
and compares it in place with its own constant-time loop; change 67 looked at
both and left them ("not hits"), and check 8 passes them. For those two the
actor's name is the constant `"MCP_ACCESS_KEY"`, held in one `ACTOR_NAME` per
file: it is the name `auth.ts` gives the same legacy key where a server does
use the module (`found = { name: "MCP_ACCESS_KEY", … }`), so the audit row
reads the same for one key whichever module compared it, and 008's
distinction — a write with a key names it, a write without one names nobody
— is kept. Moving the two onto `_shared/auth.ts` is not done here: SMD-1798
rewrites both files onto the shim and is where a second auth rewrite belongs.

**The actor's `source`, and the door.** The ticket sketched `source:
"<server>"` on every call. 008's trigger writes `COALESCE(actor->>'source',
NEW.metadata->>'source')` — the actor's source wins — so the server's name on
a *capture* would have replaced the origin the client declared
(`brain_capture_thought`'s `source` argument, `/capture`'s `source` field:
"telegram", "chatgpt") with the door it came through, on the one row that
exists to say where a write came from; and the server's name on an *edit*
alone, the first draft's rule, put a third vocabulary in the column — the
main server writes `"mcp"` (the transport) on its edits, the workers their own
name (change 71), and these five would have written a deployment's, so a
reader's `WHERE source = 'mcp'` would have missed the two MCP doors here
(pass 2). None of the five passes a source. The trigger reads the row's own
`metadata.source` for a capture and an edit alike — `enhanced-mcp`'s and
`rest-api`'s `source` variable, `open-brain-rest`'s `sourceType`,
`agent-memory-api`'s constant `"agent_memory"` on a capture; whatever the row
holds on an edit — so the column means one thing for every row these servers
write: where the thought came from. The door is the actor's own: each passes
`via: "<server>"`, which the audit trigger keeps in `actor_context` — 008's
trigger, whose body is 025's now (010 and 025 redefined it whole; 025's strip
list, `name`, `source`, `session`, `agent_id`, is what lets `via` and
`runtime` through) — so a row reads `actor_name` = the
key, `source` = the origin, `actor_context` = `{"via": "rest-api"}`;
`agent-memory-api`'s write-back adds the runtime that wrote back
(`req.runtime.name`) beside it. The first draft copied the metadata's source
into a capture's actor (the main server's spelling, `payload.metadata.source
?? "mcp"`): a second spelling of one value the write suite could not tell
from the fallback (the mutant run below). The `actor_id` /
`actor_label` the ticket pointed at are on the review route's envelope, which
writes `agent_memories` and not `thoughts` — nothing to carry. None of the
five resolves migration 010's agent id (that registry is the main server's),
so attribution here is by name, as it was for every writer before 010.
`open-brain-rest`'s `createThought` takes the name as a parameter because two
routes call it (`/capture` and `/ingest`); both pass the principal's.

**The test.** After each driven capture and edit — `update-thought-mcp`'s
edit; `enhanced-mcp`'s edit and capture; the write-back; `open-brain-rest`'s
capture, ingest (`POST /ingest`, the second caller of its `createThought`,
driven since pass 6 because the README says it names the key) and edit;
`rest-api`'s capture, edit and enrich — `judgeActor` reads
008's latest row of that action for the thought (two are read, `created_at`
as Postgres's text so the compare keeps its microseconds, and a tie —
transaction-start time; two rows one transaction wrote — fails by name instead
of making "latest" arbitrary; the raw update of the enhanced columns each
server makes beside the call writes no row at all, since the trigger's diff
covers `content`, `metadata` and the vector's presence and drops an empty
diff, so the latest `update` row is the function's) and asserts three things:
`actor_name = MCP_ACCESS_KEY` (this suite's legacy single key, so the three
principals and the two constants read the same); `actor_context.via` is the
server — the field no fallback supplies, so the arm that proves the actor
object arrived on every site (the write-back's row is read for `runtime =
"test"` beside it); and `source` equals the thought's own `metadata.source`,
joined from `thoughts` — what the trigger writes when no actor names one, so
a server that starts naming a source of its own (the first draft's server name
on an edit) fails the arm, and only a copy of the origin, the one case the
rule allows, passes. Pass 2's arm on the column compared it with constants and,
at one site, with itself, and could not fail for anything a server did; pass 3
dropped it, and pass 4 put this one in its place, which compares the column
with the rule (`mcp`, `dashboard`, `rest_api`, `agent_memory` on the captures;
`planted`, the origin every planted row carries since pass 5, on the edits —
either way the thought's own). A missing row is one failure, not three. Every
arm so far runs under the legacy key, whose name the two constants spell too,
so one write through each principal server runs under a second, NAMED key in
`MCP_ACCESS_KEYS` and its row is judged for that name — the arm that tells
`principal.name` from a constant (pass 5) — and the two in-place-compare
servers are shown refusing that key with 401, their limitation as an
assertion. The header-set guard gains SMD-1541:
the five, listed; three text guards hold the legacy key's name at its sources
— `integrations/_shared/auth.ts`'s `found = { name: "MCP_ACCESS_KEY", … }`,
the copy the three principal servers import (`test-auth.ts` holds the six
copies byte-identical), and each of the two files' `ACTOR_NAME` — so the one
literal the five arms assert has its spelling pinned where it is written. Run
with four sites of the first draft mutated (the capture actor removed from
`enhanced-mcp`, `runtime` removed from the write-back, `p_actor` removed from
`rest-api`'s `PUT`, `source` removed from `open-brain-rest`'s capture actor):
three bit — the name on the `enhanced-mcp` capture, the runtime in the
write-back's context, name and source on the `rest-api` edit (four
assertions) — and the fourth did not: with no `source` in the actor the
trigger's `COALESCE` falls to `metadata.source`, the same string, so a
capture's passed source was a claim the suite could not hold. The field is
gone from every actor, and `via` — which no fallback supplies — is what every
arm holds instead.

**Verified:** `../db/with-postgres.sh bun test-writes.ts` 268/268 under podman
(was 186 — `origin/main`'s suite run against the changed servers, 186/186:
the new assertions are thirteen `judgeActor` sites at four each plus their tie
checks — ten under the legacy key (the ingest arm with its own answer and
`judgeCapture` arms), three under the named one, each with its
own "the write succeeded" arm and the write-back's with an "its thought" arm —
two 401 arms, the write-back's `runtime` read, the header-set entry and three
spelling guards; the first draft of this
paragraph said "was 200, twelve arms" from arithmetic, and the run said
otherwise — caught: run-it); the four-site mutant, run on the first draft,
211/215 with the four failures named above; after pass 2, `via` removed from
`rest-api`'s `PUT` actor and from `open-brain-rest`'s capture actor, 234/236
of that pass's suite, the two `via` arms failing with `got null` and nothing
else — a capture arm with teeth, which pass 1's had not; after pass 4,
`source: "rest-api"` added to `rest-api`'s `ACTOR` — 233/236, the three
`rest-api` arms (capture, edit, enrich) failing with `got rest-api` and
nothing else, the capture arm too, since the route's `rest_api` and the
server's `rest-api` differ by a character; after pass 5, `principal.name`
replaced by `"MCP_ACCESS_KEY"` in `open-brain-rest`'s edit actor — 256/257,
the one arm that judges that row for the named key's name failing with `got
MCP_ACCESS_KEY` and nothing else, the regression the legacy-key arms cannot
see;
`bun test-auth.ts` 809/809 (the
five import and
authenticate as before); `bun scripts/check-fork-consistency.mjs` PASS on 118
contributions (check 10 sees no new verb on `thoughts`; check 8 still passes
the two in-place compares). Not type-checked: the vendored servers are outside
`tsc`'s project, as they were, and this machine's `deno` is bun's Node shim,
not Deno — change 69's `deno check` of `enhanced-mcp` and `agent-memory-api`
was not repeated; what each file gained is an object literal — or a module
constant holding one — in an `rpc()` argument, which those files' other calls
already type.

**Not done here.** `enhanced-mcp` and `rest-api` onto `_shared/auth.ts` — with
SMD-1798, which rewrites both files; a constant exported from `auth.ts` for
the two to import was declined with it, since that file is six synced copies
of `server-portable/auth.ts` and the suite already asserts the one literal for
all five. Migration 010's agent id for the vendored servers (none resolves one;
SMD-1730 will want it on the row). The deletes: `open-brain-rest`'s `DELETE
/thought/:id`, `rest-api`'s `handleDeleteThought` and `rest-api`'s
duplicate-resolve merge (a raw `metadata` update of the survivor, outside
check 10's rule as every metadata-only write is, and a raw delete of the
loser) still leave 008 rows naming nobody — those are SMD-1793's four sites,
and `delete_thought(p_id, p_actor)` (036) is where the name goes; that ticket
now says so, and the survivor's metadata belongs in `update_thought` with
`p_actor` while it is open. SMD-1525 (`enhanced-mcp`'s read tools address rows
by integer id) as before. The bio worker and the auditor already named the key
(change 71); the key-less writers (the receiver, the scripts, the samples)
still name nobody, by 008's rule.

**Review pass 1, triaged.** A reading reviewer over the diff and a running
one. Fixed: the section was numbered 100, and `origin/main` took 100 for
SMD-1805 (2956edd) while the pass ran — renumbered to 101 on the branch's own
lines only, the base having held no "change 100" (caught: cold-read against
`origin/main`; the trap change 71 recorded), to 102 in pass 4, when main
took 101 for SMD-1902 (908de49) the same way, and to 103 in pass 6, when main
took 102 for SMD-1843 (c6fc294) — three renumbers in one review; the merge
step re-checks main's headings before the merge and again before the push.
The four capture actors carried a
`source` the suite could not distinguish from 008's fallback — the first draft
reported the toothless arm and left it; the field is gone instead (caught: the
mutant run, read again). The "was 200 — twelve arms" in Verified was
arithmetic; `origin/main`'s suite run against the changed servers said 186
(caught: run-it). `auditRow` took "latest" from `created_at` alone, which two
rows in one transaction would tie (caught: cold-read); it reads two and fails a
tie by name. The legacy key's name was a literal in three files with nothing
tying them (caught: cold-read); the suite's one literal across five arms was
already the tie, and text guards now pin the spelling at its sources.
`enhanced-mcp`'s README had carried change 69's fork blockquote between tool
rows 11 and 12 since that change, splitting the table (caught: cold-read); it
sits below row 13. Not fixed, said: the two servers' deletes and the
duplicate-resolve merge still name nobody — SMD-1793's sites, above.

**Review pass 2, triaged.** The same two reviewers. Fixed: pass 1's tie check
compared `created_at` through a JS `Date`, whose millisecond grain would have
called two transactions under a millisecond apart — `rest-api`'s `PUT` then
its enrich, on a fast run — a tie and failed the arm for nothing (caught:
cold-read); the compare is Postgres's text, microseconds kept. Pass 1's rule
for an edit's actor — the server's name as `source` — put a third vocabulary
in a column the main server fills with the transport and the workers with
their name (caught: cold-read); no actor names a source now, the column is the
thought's origin on every row by 008's own reading, and the door is `via` in
`actor_context`, which also gives every arm — the captures included — the
teeth pass 1 left one arm without. The spelling guard read
`extensions/_shared/auth.ts` while the three principal servers import
`integrations/_shared/auth.ts` (caught: cold-read) — pinned on that copy; the
finding's premise that nothing holds the six copies identical was wrong,
`test-auth.ts` does. The two files with a raw delete said "the actor reaches
the audit" unqualified (caught: cold-read) — their headers and READMEs say a
delete's row still names nobody, SMD-1793. Smaller, in pass 1's own additions:
`judgeActor` turned one missing row into three failures (returns after the
first); `DRIVEN_1541` was a path-prefix filter over `DRIVEN` rather than the
five listed (listed, as the other sets are); `auditRow` returned a `created_at`
its type hid (destructured). Declined: the two in-place-compare servers onto
`_shared/auth.ts` (pass 1's decision, SMD-1798's rewrite); folding change 71's
four inline audit reads onto `judgeActor` (a different shape by design — the
workers name their source in the actor); and merging `origin/main` for the
100/101 order, which is the merge step's, not this pass's. Two of the ten were
code defects in pass 1's additions and one was the first draft's rule; the
rest were pass 1's own tidy-ups and three declines — not yet the stop signal.

**Review pass 3, triaged — the stop signal.** The same two reviewers. Fixed:
pass 2's `source` arm was tautological — no actor names a source, so the
column is the trigger's reading of the row's own metadata and the arm could
not fail for anything a server did; the `enhanced-mcp` edit even read its
expected value from the row it was judging (caught: cold-read; the shape
[[test-assertion-teeth]] names) — dropped, nine assertions, and the paragraph
above says why the column is not judged. Every comment, README and this
section cited "008's trigger" for a body 010 and 025 redefined whole; 025 is
the current definer and its strip list is what lets `via` through (caught:
cold-read) — cited as such. `agent-memory-api`'s README said `runtime.name`
rides in `actor_context`; the key is `runtime`, holding the name (caught:
cold-read). The two in-place-compare servers spelled `{ name: ACTOR_NAME, via:
… }` at five sites with a comment each, the enrich site's already shorter
(caught: cold-read) — one module-level `ACTOR` beside `ACTOR_NAME`, whose
comment also names the trap for SMD-1798: this suite runs under the legacy
key alone, so a stale constant after that rewrite would pass here unnoticed
(said on SMD-1798). Declined, third time each: the deletes through
`delete_thought` (SMD-1793's design — the citation guard's refusal, the detach
path, the merge's error order — not a one-line swap); one envelope builder
across writer families (the vocabulary the column carries across the main
server, the workers and these five is SMD-1730's event shape to decide — said
there); merging `origin/main` for the heading order (the merge step's). What
this pass fixed were a vacuous arm and three record items in the earlier
passes' own additions, and its remaining findings were passes 1 and 2's
declines re-raised: the stop signal.

**Review pass 4, triaged (run at the operator's call after the signal).** The
same two reviewers. Fixed: `origin/main` took 101 for SMD-1902 (908de49)
during the pass — 102 now, on the branch's own lines (caught: run-it, the
fetch). `rest-api`'s header and README carved out the two raw deletes and not
the duplicate-resolve merge's raw `metadata` write on the survivor, which
leaves an `update` row naming nobody just the same (caught: cold-read) — named
beside them; this section's Not-done-here already had it. `open-brain-rest`'s
README named `POST /capture` and `PUT` and not `POST /ingest`, which captures
through the same function with the same actor (caught: cold-read). Nothing
held the rule "no actor names a source" — pass 3 had dropped the arm that
could not fail, and with it the only place a server that started naming one
would have been caught (caught: cold-read) — `judgeActor` compares the row's
`source` with the thought's own `metadata.source`, joined; the mutant above
shows it biting. Declined, fourth time: the two in-place-compare servers onto
`_shared/auth.ts` or a constant exported from it (SMD-1798, which now carries
the trap in a comment), and one envelope builder across writer families
(SMD-1730's shape). The pass's own fixes were a renumber main forced, two
carve-out sentences and a guard for a rule the previous pass had left
unheld; the signal stands.

**Review pass 5, triaged (at the operator's call).** The same two reviewers.
Fixed, both teeth: the planted rows carried `metadata = '{}'`, so on every
edit site pass 4's origin arm compared NULL with NULL and proved only that no
server adds a constant source (caught: cold-read) — a planted row carries
`source: "planted"` now, and the edit arms compare a value; and the suite ran
every write under the legacy key alone, whose name the two constants spell
too, so a regression from `principal.name` to that literal in any of the
three principal servers was invisible (caught: cold-read) — one write through
each of the three runs under a second, named key in `MCP_ACCESS_KEYS` and its
row is judged for that name, the two in-place-compare servers are shown
refusing it with 401, and the mutant in Verified bites. Record: the pass-4
mutant sentence had landed as one unwrapped line, and "the two added lines"
predated `ACTOR` (caught: run-it, the read-back). Declined, fifth time: the
deletes and the merge's metadata write through the functions (SMD-1793), the
two servers onto `_shared/auth.ts` (SMD-1798), and the merge order (the merge
step's). Left for the boyscout, as tidy-ups with no behaviour change: the
header-set guard's one glob per ticket (four sweeps where one would do), and
the four-line actor comment at the three principal servers' sites, which could
point at this section. Not taken: `runtime` sits in `actor_context` and in
`metadata.agent_memory.runtime` — the second is the thought's content, the
first says who wrote the row, and the ticket asked for the envelope's fields
on the actor; one copy per meaning. Two teeth in the previous passes' own
additions, no defect in the mechanism: the signal stands.

**Review pass 6, triaged (at the operator's call).** The same two reviewers.
Fixed: `origin/main` took 102 for SMD-1843 (c6fc294) during the pass — 103
now, the third renumber (caught: run-it, the fetch; the reading reviewer's
`merge-tree` saw the same conflict). Pass 4's README sentence said `POST
/ingest` names the key and nothing drove the route (caught: cold-read) — one
ingest through `open-brain-rest` is driven and its row judged. Record: pass
5's mutant sentence had landed unwrapped, as pass 4's had (caught: run-it).
Declined, sixth time: the deletes and the merge's metadata write (SMD-1793);
and, as before, the core server's own `source: "mcp"` on its edits and the
absent `agent_id` on every vendored row — both said on SMD-1730, whose event
shape decides the column's vocabulary and the id, not a vendored server's
change. The comment at the three principal servers' sites is the boyscout's,
as pass 5 said. One arm for a sentence already written and a renumber main
forced: the signal stands.

**Tidied while the file was open** (no behaviour change): the header-set
guard in `test-writes.ts` globbed and read every vendored `.ts` once per
ticket — four sweeps of the same files since this change added the fourth
entry — and reads them once now, each ticket's rule testing the same texts
(pass 5's finding); and the four-to-six-line actor comment at the three
principal servers' four sites, which passes 2 and 3 had each corrected in
every copy, is one line per site naming the three facts (the key's name,
`via`, no source) and pointing here for the why, as `ACTOR`'s comment already
does for the two in-place-compare servers (passes 5 and 6's finding). Suite
unchanged in count and in what it holds.

**Upstream status:** not applicable — the functions and the audit trigger are
this fork's; upstream's servers write the row directly and have no actor to
carry.
