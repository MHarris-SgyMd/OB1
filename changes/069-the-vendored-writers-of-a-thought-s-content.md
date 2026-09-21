# 69. The vendored writers of a thought's content and vector go through the functions that own them — nine files off a raw update of `thoughts`: edits through `update_thought`, captures through the 3-argument `upsert_thought`, the enhanced columns beside them, and check 10 holds it (SMD-1228)

`integrations/update-thought-mcp/index.ts`, `integrations/enhanced-mcp/index.ts`
(and its `_shared/helpers.ts`), `integrations/agent-memory-api/index.ts`,
`integrations/open-brain-rest/index.ts`, `integrations/rest-api/index.ts` (and
its `_shared/helpers.ts`), `integrations/consolidation-workers/bio/index.ts`
(and the workers' `_shared/helpers.ts`),
`recipes/repo-learning-coach/server/brain.ts`,
`recipes/provenance-chains/mcp-tools.ts`, the sample in
`integrations/telegram-capture/README.md`; `scripts/check-fork-consistency.mjs`
(check 10); `extensions/test-writes.ts` (new); their READMEs; the CI workflow
(Linear SMD-1228, named under change 38's "Not done here"). The
ticket named three integrations that updated a thought's `content` or
`embedding` with a raw PostgREST `.update(…)` on `thoughts` rather than
through `update_thought`. Check 10's first run over the seven category
directories and `docs/` found nine files with eleven such statements: the two
MCP servers (`update-thought-mcp`'s one tool; `enhanced-mcp`'s `update_thought`),
three HTTP APIs (`agent-memory-api`'s write-back, `open-brain-rest`'s capture
and edit, `rest-api`'s edit and enrich), a worker (`consolidation-bio`'s
profile rewrite), a recipe's server (`repo-learning-coach`'s capture), a
recipe's paste-in snippet (`provenance-chains`' `capture_derived_thought`) and
a README's sample (`telegram-capture`'s edit path). Every rule this fork put
into the writers was bypassed by each: 003/018's `content_fingerprint` left
describing the previous text — the row 018's `fingerprint_held_by` report
exists for; 021's `embedding_model` left describing the previous vector, or
NULL where the vector was written after a 2-argument `upsert_thought` — 021's
header calls a raw vector write "the operator's", and these are shipped
tools; 022's chunk rows of the previous vector left under the new one — 022's
"the three writers leave no new stale set" held for the three alone; and no
actor set for 008's audit row (the functions record the actor the caller
names, and these five named none until change 103 — SMD-1541). The upstream
survey added a third failure
mode (upstream #379), and the audit confirmed it twice over: `enhanced-mcp`
and `rest-api` read `thought_id`, or digits only, from `upsert_thought`'s
return — this fork's returns `id`, a UUID — so every capture through them
threw *after* the row was written; both put the vector inside `p_payload` of
the 2-argument form, where the fork's function does not look, so no capture
through either had stored a vector at all; and `rest-api`'s `/thought/:id`
routes matched `\d+`, so none could reach a row here.

**The rule, and where it differs from the ticket's sketch.** Every write of a
thought's content or vector goes through the function that owns the row's
invariants. An edit is one `.rpc("update_thought", { p_id, p_content,
p_metadata_patch, p_embedding, p_embedding_model[, p_if_unchanged_since] })`
— named arguments, so the ticket's "021's eight-argument form" is moot: the
function has taken nine since migration 032 (change 60), and a caller that
names what it passes never spells an arity. A capture is one
`.rpc("upsert_thought", { p_content, p_payload: { metadata, embedding_model },
p_embedding })` — the 3-argument form, vector and label in the same statement,
where four of these files called the 2-argument form and wrote the vector
after it. The columns the functions do not know — `type`, `importance`,
`sensitivity_tier`, `quality_score`, `source_type`, `status`, which
`schemas/enhanced-thoughts` adds and upstream's removed schema section used
to mirror (change 58) — are written beside the call by one raw update that
carries neither content nor vector: outside the rule by construction, and
nothing it writes goes stale. Metadata that these files read, spread and
wrote back whole now rides `p_metadata_patch`, which is `metadata || patch`
under the function's row lock — the same result, without the read. The
label is the caller's, as 021 requires: the four files that hard-coded
OpenRouter's model name pass it as a constant, `repo-learning-coach` passes
`OPENROUTER_EMBEDDING_MODEL`, and the three `_shared/helpers.ts` gained
`embeddingModelUsed()` — OpenRouter's name when that key is configured
(`embedText()`'s first choice), else OpenAI's under the same `openai/`
prefix, so one model has one label whichever path served it. The
provenance snippet's `derived_from` and `supersedes` ride the envelope (025)
and are validated there; its own `derivation_layer`/`derivation_method`
follow by an update of those two; on a re-capture of existing text the
function leaves that row's pointers as they were (change 66), where the
snippet's raw update overwrote them and its comment called that intended.
Migration 035's return — `id`, `fingerprint`, `existed` — is read beside
upstream's shape in both files that misread it, and `rest-api`'s `validateId`
and routes take a UUID or digits.

**File by file.** `update-thought-mcp`: the read before the write is gone —
it served a concurrency check the function makes under the row's lock (009's
point, and the race upstream's version has) and a metadata spread the patch
replaces; `NOT_FOUND`, `STALE_READ` (with the function's
`current_updated_at`) and `DUPLICATE_CONTENT` are the tool's three refusals,
and `duplicate_of`/`fingerprint_held_by` are reported as notes.
`enhanced-mcp`: `update_thought` takes the thought's UUID (the file's other
tools still take upstream's integer ids — SMD-1525), its own SHA-256 of the
normalised text no longer travels with the row (the function computes 003's),
and `brain_capture_thought` reads both return shapes and reports the
function's fingerprint. `agent-memory-api`: the write-back's thought is one
3-argument call. `open-brain-rest`: capture and edit both; an edit into text
another thought holds answers 409. `rest-api`: capture, edit and enrich; an
enrich passes the row's own text back — an unchanged edit, which 018 never
refuses — so the new vector takes its label and the previous vector's windows
go; an edit whose embedding call failed leaves the row without a vector and
without a label, not with the old vector under the new text — 021's rule,
and what the raw update used to leave — answers `embedding_updated: false`
with a message naming the enrich route, which refills it.
`consolidation-bio`: the profile's text and a vector the worker now makes
for it (its `_shared/helpers.ts` had `embedText`; the label helper joined
it) through `update_thought` — the profile is searchable, and a vector
`db/reembed.ts` gave the row between runs is replaced, not blanked; an
embedding failure fails the run and the previous profile stands.
`repo-learning-coach` and the provenance snippet: the 3-argument form; the
snippet resolves each well-formed `derived_from` ref against `thoughts`
first, because the function refuses a whole capture for a ref that names no
thought (032's `validate_derived_from`) where the raw update wrote the ghost
pointer unchecked — a deleted parent is `unresolved_refs` now, and the
capture lands. The Telegram sample: the edit branch through `update_thought`,
the model a named constant. The enhanced columns are written for a FRESH row
only: a re-capture of stored text leaves them, since both `_shared` files'
tier rule is escalation-only and a hand-set importance is the owner's — as
the function leaves that row's pointers (change 66).

**Check 10.** The mechanism, not the nine files' spelling: a PostgREST table
verb that replaces columns — `.update(` or `.upsert(` — on `thoughts`
(`.from("thoughts")` in either quote, Python's `.table("thoughts")`, line
breaks allowed before the verb) whose payload carries a `content` or
`embedding` KEY — an object literal (quoted, bare or computed key, the
shorthand `{ embedding }`, an array of literals for an upsert, an
`Object.assign(…)` of literals), or an identifier the file binds to one
anywhere (`const update = { embedding, … }`, `Object.assign(patch, { … })`,
`updates.content = …`, `patch["embedding"] = …`, the block walked); a key,
not a value (`summary: content` is not one), at the literal's top level
(`{ metadata: { content } }` is a metadata write); a row type on the client
and a line comment before the verb do not hide it — and the SQL form,
`UPDATE [ONLY] thoughts … SET` with either column assigned in the SET list
before its WHERE, or named in the tuple form `SET (…) = (…)`, `public.`,
quoted identifiers and an alias allowed. Word-bounded: `content_fingerprint
=` and `embedding_model =` are other columns. In every non-binary,
non-ignored file under the seven category directories and `docs/`, prose
included. Outside the rule, and said so: an `.insert(` (a fresh row around
the functions — no fingerprint, no label — is a different defect, SMD-1524 —
in the rule since change 71), a metadata-only update, a payload spread from another object, one that
arrives as a function's return value or parameter, a builder split across
statements, a table name held in a variable, Python's `dict(content=…)`, a
hand-built REST `PATCH` (none in the tree), and the remedy itself — the
dataflow cases are what the test is for. Thirty-five probes — one per
statement the audit found, in its own shape, plus the forms a rebase could
bring and the review passes' escapes — and twenty-seven non-probes run
on every invocation through the scan's own function; exceptions are per file
and counted, as checks 6–8's are, for a file whose README says it bypasses
the functions and what it leaves stale; the list is empty. A name bound to a
payload is one for the whole file, as check 8's bound credential is, and a
hit on a second, cleaner send of the same name is answered with a rename.
The checker's header now also names check 9 (change 65's fixture
redaction), which it had not.

**The test.** `extensions/test-writes.ts` (110 assertions), in the required
"SQL data layer against real Postgres" job, last: each writer that can run is
imported as deployed — the stand-in for Deno's two globals and the loader for
Deno's specifiers from `test-auth.ts`, plus one rewrite, `@supabase/supabase-js`
to `compat/supabase-sql`, so the two servers still on supabase-js run their
PostgREST calls as SQL against the same throwaway database — with the model
provider stubbed to a unit vector keyed off the text. The database is the
fork's migrations plus the two sidecars the writers assume,
`schemas/enhanced-thoughts` and `schemas/agent-memory`, applied as shipped
(Supabase's three roles created first, as the sidecar's header says), their
tables and functions dropped before the apply and again at the end whether
or not the run finished, because CI shares one Postgres across the job (the
roles, and the columns and indexes the enhanced sidecar adds to `thoughts`,
stay until the next suite's reset drops the table — nothing a later suite
reads; `db/ci-parity.sh` runs this suite in the same seat). For
each edit a row is planted as an older write left it — text, fingerprint, a
vector under its own label, two chunk rows of that vector — the writer edits
it, and the row is judged column by column and against a twin `update_thought`
edited directly with the same inputs: fingerprint of its own text, label,
vector, chunk count. Each capture's row is judged for the 3-argument form's
work. Also driven: `update-thought-mcp`'s `STALE_READ`, `NOT_FOUND` and
`DUPLICATE_CONTENT`, and a metadata-only edit leaving vector, label and
fingerprint alone; `enhanced-mcp`'s and `rest-api`'s captures returning a UUID
id rather than throwing; `rest-api`'s enrich relabelling and clearing planted
windows; a `rest-api` edit while the embeddings endpoint answers 500 leaving
the new text with no vector and no label and answering `embedding_updated:
false`, then the next edit re-embedding; a re-capture through `rest-api` and
`open-brain-rest` answering the same id as updated and leaving a hand-set
tier and importance; the enhanced columns landing beside each fresh capture.
The snippet, the sample and the worker are read, not run — a paste-in with
free variables, a README, and a run that needs an LLM pass over person notes
— and a guard holds the set of `.ts` files naming this change equal to the
set driven or read. One limit, stated in the file: the SQL shim binds a JS
number array as a Postgres array literal, so a regression to a raw `.update({
embedding })` with a `number[]` fails at the shim rather than at the column
assertions — loudly, not where the labels say — where PostgREST would coerce
it and the assertions would name the stale columns (they do for the vector
spelled as text).

**The width, and the label, are the operator's.** Every writer here embeds
with `openai/text-embedding-3-small`, 1536 wide — upstream's Supabase brain's
model — and now hands that vector to a function declared at the brain's
width. This fork's default is `qwen3-embedding:4b` at 1024 (`db/config.mjs`),
where the function refuses the vector and the whole capture or edit fails,
where the raw write failed the same way (`repo-learning-coach` saved the
thought and then threw; `consolidation-bio`'s first insert has no vector, so
its rewrites failed only from this change on) or had its error ignored
(`agent-memory-api` created the memory row over an unembedded thought). Loud
is right, and nothing here makes a vendored writer width-aware: each README
says the brain must be at `OB1_EMBEDDING_MODEL=openai/text-embedding-3-small`
and `OB1_EMBEDDING_DIM=1536`, and the test pins that width and says why. The
label the writers pass must equal the configured model's spelling for the
re-embed's pool to leave the rows alone (change 38's `poolModelFor`); the
helpers spell it `openai/…` whichever provider served it, and the README
sentence names the spelling.

**Decisions.** Updates, not inserts: the ticket's rule and the carry-forward
comment named the update, and an insert leaves nothing *stale* — it leaves
the pre-003 shape the backfills repair; six sites are filed as SMD-1524 with
the widening of check 10 they need — done in change 71, which found eight.
The enhanced columns stay a raw update
beside the function rather than a payload key: the function never read them,
and adding them would put a vendored schema's columns into a core function.
`rest-api`'s failed-embedding edit blanks the vector rather than keeping the
old one — the function's rule, stated in its README and in the response.
`enhanced-mcp`'s read tools keep their integer ids (SMD-1525): the ticket was
about writes. The top-level `type`/`importance`/… keys those two files put in
`p_payload` are dropped, since the fork's function ignored them and the
sidecar update carries them now. `update-thought-mcp` embeds before the
function can answer `NOT_FOUND`, where its old read refused first: one
provider call per misaddressed edit, not worth a read the function repeats.

**Review pass 1, triaged.** Two reviewers, one reading and one running
(mutating the converted files back and the rule's spellings, two runs on one
container, real PostgREST against the schema). Fixed: `consolidation-bio`
rewrote the profile with no vector, which would have blanked the one a
re-embed pass gave the row every run (HIGH); `rest-api`'s edit answered a
bare 200 when the embedding call failed and the row had lost its vector; the
provenance snippet's envelope made a ghost `derived_from` ref refuse the whole
capture, and its comment said the opposite; the three captures' sidecar
update ran on a re-capture too, downgrading a stored tier; the rule matched
`content` as a value and inside a nested object, and missed a row type on the
client, a comment before the verb, `Object.assign`, array payloads, a
computed key, `UPDATE ONLY`, quoted identifiers and the tuple form; the test
aborted without its teardown on a failed capture, and the orphaned
`agent_memories` row made the next run's write-back short-circuit on its
idempotency key; `db/ci-parity.sh` did not run the suite; the probe list
lacked the worker's statement and miscounted the files. Not fixed, and said
where: the shim's table verbs bind a `number[]` as an array literal
(pre-existing; every vendored `.insert({ embedding })` through the shim has
it — carried to SMD-1524, where the inserts left the table verbs and the
binding stayed); a name bound to a payload is one for the whole
file (check 8's stance); the embed-before-`NOT_FOUND` cost. Run for real:
PostgREST resolves `{p_content, p_payload, p_embedding}` to the 3-argument
form, a JSON `null` vector included, and 013's 4-argument form is never a
candidate; a stale `p_if_unchanged_since` answers `STALE_READ`; the vector
inside the 2-argument payload stores no vector (#379, reproduced).

**Review pass 2, triaged — the stop signal.** Eleven of the two reviewers'
findings were in the first pass's own additions. Fixed: `consolidation-bio`'s
gate admitted an Anthropic-only configuration that `embedText()` then
refused after the LLM call was paid for — refused at the gate now, and the
README says which keys embed; the two capture responses reported the tier and
type this call detected on a re-capture whose columns it had, by the first
pass's rule, left alone — they read the row back; check 10's verb line was
computed with a precedence slip that reported an `upsert` chain on the line
before its verb (the probe check counted hits only; it holds the line now),
its block walk read a brace inside a string as structure, its gap allowed a
line comment but not a block comment, its verb took no type argument, its
inline `Object.assign` branch read nested literals, and its SQL list took a
`CASE WHEN content =` compare as an assignment; `enhanced-mcp`'s fresh-row
gate had no test (a re-capture is driven); the test lost its tally when the
body threw; the bio worker's text guard admitted an embedding of the wrong
text; this section counted two helper files where three changed. Named, not
changed: the width and label paragraph above, which the second reading pass
found unsaid; a string value carrying `, content:` still reads as a key (the
rule reads prose by design); `+=` on a payload property is bound now.

**Boyscout.** What the passes cut for space, in the files this change
touched, no behaviour changed: check 10's key rule loses a dead alternative
(a literal's block always ends in its bracket, so a key is never last) and
its "outside the rule" list names the type-asserted, conditional and two-hop
payloads the second running pass found; `update-thought-mcp`'s `STALE_READ`
message says "unknown" rather than `undefined` when the row moved between
the function's check and its write (033's post-UPDATE return carries no
timestamp); this section's Verified paragraph is rewrapped and names the
third Deno check.

**Not done here.** SMD-1524 (six raw inserts of content and vector, and check
10's widening to them) — done in change 71. SMD-1525 (`enhanced-mcp`'s read tools cannot address
a UUID row). SMD-1480 held the deployability of `update-thought-mcp`,
`open-brain-rest`, `rest-api` and `consolidation-bio`, which import the shim —
done in change 74; their behaviour is exercised by `test-auth.ts` and
`test-writes.ts` under Bun.
`server/index.ts`, upstream's Edge Function, is untouched. The `docs/` READMEs
that show a SQL `UPDATE thoughts SET metadata …` are metadata-only and outside
the rule.

**Verified:** `bun scripts/check-fork-consistency.mjs` FAILED with check 10's
eleven hits in nine files before the conversions and PASS after, exception
list empty (35 probes, 27 non-probes, each probe caught on its verb's line);
`../db/with-postgres.sh bun test-writes.ts` 110/110 under podman, twice on
one container and after an aborted run; `bun test-auth.ts` 643/643 on the
converted files; `deno check --node-modules-dir=none` clean under Deno 2.9.6
for `enhanced-mcp`, `agent-memory-api` and `consolidation-workers/metadata-norm`
(the edited helpers' other importer), the three that resolve under Deno;
every shim-migrated file still parses, and the codemod round-trips — PR #55's
first CI run failed that step alone: `migrate-to-sql-shim.mjs` rewrites every
quoted `@supabase/supabase-js` it finds, and the test's loader compared a
specifier to that literal; it matches by regex now, the codemod unchanged.
The ticket's verify — the check fails
on the files today and passes after; an edit through each leaves
`content_fingerprint`, `embedding_model` and `thought_chunks` as
`update_thought` would, one round trip each against `with-postgres.sh` — is
the test.

**Upstream status:** not applicable — the raw writes are upstream's, the
functions they now call are this fork's. Upstream #379 reports the
return-shape half against its own tree; the two files that misread the
return here read both shapes now.
