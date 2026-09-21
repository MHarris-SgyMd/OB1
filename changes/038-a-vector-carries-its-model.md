# 38. A vector carries its model — `thoughts.embedding_model`, written with the vector, read by preflight and the re-embed

Migration 021, `db/reembed.ts`, `server-portable/preflight.ts`, both stores
(Linear SMD-1068, filed by change 35's second review pass and named under its
"Not done here"). Change 35 taught preflight to see an unfinished re-embed from
the claim table: a pass is unfinished while any row under its key is pending,
leased or failed. That is a proxy for a fact the schema never stored, and it
vanishes when the rows do — migration 015's fourth principle and preflight's
own remedy for a superseded key both tell the operator to `DELETE FROM
thought_work_claims`. A pass to B dies at 5%, the operator clears its rows to
start over and is interrupted: `embedding contract … matching`, `re-embed pass
… none unfinished`, 95% of vectors another model's, and nothing left in the
database could ever say so. The same blindness made `reembed.ts` end every
switch with a paragraph about thoughts captured meanwhile by a server not yet
switched, which "nothing here can tell" from new-model captures.

**One nullable column, written by the statement that writes the vector.**
`thoughts.embedding_model text`: the model's name exactly as
`OB1_EMBEDDING_MODEL` gives it — the string `ob1_config.embedding_model`
records, so "at the recorded model" is string equality. The rule is that *the
label follows the vector*: `upsert_thought` writes it beside the vector and on
a re-capture keeps it with a kept vector or takes the caller's with a new one;
`update_thought` leaves it without content, sets it NULL with content and no
vector, writes the caller's with a vector. NULL is *unknown*, not "the
default": every row from before 021, every raw INSERT, the PostgREST two-step
fallback, every capture from an older server; and a row with no vector has no
label, whatever its writer named. Stamping the recorded model on every
existing row would be exactly the guess the column exists to stop making, on
the one day (021's) the corpus may well be at two models — so the only
backfill is the one there is evidence for: a row a finished pass wrote,
released as succeeded under a key naming the model, and not written since
(`updated_at <= finished_at`) is labelled from its latest such claim; a key
naming no model is no evidence, and everything else stays NULL. `thought_chunks`
gets no column: a chunk's vector is written in the same
statement as its parent's from one `embedCapture()`, so the parent's label is
the chunks'. No index: the readers are a grouped count per server start and a
scan per re-embed run. 008/010's audit trigger diffs content, metadata and the
vector's presence, so a label change is not an event and a re-embed still
writes no audit row — asserted, in `test-schema.ts` [22] and `test-live.ts`
[9].

**The label comes from the caller, never from `ob1_config`.** The server knows
the model it embedded with and `ob1_config` knows the model the corpus is being
moved to; they differ exactly during a switch, because `--switch-model` records
the new model first, on purpose. A writer reading `ob1_config` would stamp the
new model on a not-yet-switched server's old vectors — the one case the column
is for. So `index.ts` passes the embedder's model on capture and on an edit with
content; `reembed.ts` passes its own.

**Two writers, two mechanisms, and 004's rule is the reason.** `upsert_thought`
has three overloads and 004's header forbids a default on any of them (a
defaulted fourth parameter beside the 4-argument chunk form makes an untyped
4-argument call ambiguous); its `p_payload` has been an envelope since 004 and
008 put the actor there for this exact constraint — so the label rides as
`p_payload.embedding_model`, both stores, no signature change, only the
3-argument body redefined. `update_thought` has one form, no envelope and every
parameter but the id defaulted, so it gains `p_embedding_model text DEFAULT
NULL` as an eighth parameter — and the 7-argument form is **dropped** first, as
020 did for the search functions: `CREATE OR REPLACE` with a new parameter
leaves the old form beside it and every call with seven arguments or fewer is
"function is not unique". 020's ACL capture-and-replay runs across the drop,
`COMMENT ON FUNCTION` is re-issued, and `UPDATE_THOUGHT_SIGNATURE` in
`db/config.mjs` is the one spelling — `reembed.ts` resolves the body it will
call by it (018's sentinel, now on the eight-argument form), `test-support`
drops both forms on a reset, preflight reads the forms beside it. The migration
is generated from 008's and 018's bodies with anchored edits, so the carried
text — 005's guard, the actor, 009's guard, 013's context, 018's `FOR UPDATE`,
advisory lock, `content_fingerprint_of` and sentinel — cannot drift.

**What reads it.** Preflight gains two checks. `vector models`, directly under
`embedding contract`: the corpus grouped by label — every labelled vector at
the recorded model is ok (unlabelled ones reported as detail: unknown, not
wrong); vectors at another model are a warning naming each model and its
count, with the `reembed.ts` command as the remedy and `--switch-model` in it
when the record disagrees with the configuration; the column absent under this
server is a failure, because every capture would drop the label and every edit
would fail. `edit signature`, beside `search signatures`: the eight-argument
`update_thought` present and alone — 018 re-applied by hand beside it fails
with the exact `DROP FUNCTION`, in its place fails naming 021; over PostgREST
the probe is `update_thought` with an id no row has, which answers `NOT_FOUND`
from its `FOR UPDATE` read and writes nothing. `re-embed pass` keeps its rule
(`passUnfinished` stays claims-only — the data view is the new check), but its
"not yet in the pool" now counts the thoughts *not at the key's model* with no
row, because that is what a run adds. And `reembed.ts` builds its pool from the
rows: `enqueue_thoughts` is given the ids `WHERE embedding_model IS DISTINCT
FROM <target>`, so a thought already at the target with no row is finished and
is never re-embedded "harmlessly" (a provider call each); and on *every* run a
succeeded row whose thought is not at the target returns to the pool — the row
says done, the thought says otherwise, the data wins. That is what retires the
"nothing here can tell" paragraph: a capture or edit by a server still on the
old model, before or after the pass finished, is found by the next run because
its row says which model it is at. Failed rows stay terminal (the failure
policy; `--retry-failed`) and caveat rows are at the target (the head window is
the target model's vector), so neither is touched; the model-change start-over
is kept as the rule for failed rows and expired leases of an earlier pass.
`--status` and a run print the corpus by model. A run requires 021 and says so
(the 018 probe became the 021 probe); `--status` and `--dry-run` answer on an
older schema.

**A first pass, triaged — ten findings, all fixed.** The largest was the cost
of NULL: with every pre-021 row unlabelled, the first plain run after upgrading
would have re-embedded a whole corpus a finished pass had already proved was
at the model — NULL is "not at the target", rightly — while the docs promised
"exactly those two". The evidence-based backfill above is the answer, and a
run says how many unlabelled rows its pool holds before it starts. The
documented same-model backfill (`--job reembed:<model>@<dim>:ctx` after a
chunk setting flips) had come to pool nothing, since every rule keyed on the
label: a `--job` key is a backfill whose reason is not the model, and pools
every thought under its key as before, while the model's own key pools by the
label; preflight counts "not yet in the pool" by the same shape, so a key
naming no model is no longer counted against the recorded model while the
tool counts against its own. `vector models` judged the rows against the
record but prescribed `--switch-model` from this shell, which when the record
and the configuration disagree records *this* model and re-embeds the rows at
the recorded one — reverting the switch whose finished rows are the majority;
the remedy gives both directions now. "Not at the target" ignored a row with no
vector whose stale label named the target, so it was never pooled while the
header promised the pass would give it one — the predicate says `embedding IS
NULL OR`; and `upsert_thought`'s INSERT branch wrote a label beside a NULL
vector, contradicting the rule, so it writes none. On a model change the
start-over still returned every succeeded row and re-embedded thoughts the
rows said were already at the target; it returns the failed rows and expired
leases, and the data rule owns the succeeded ones on every run — [9]'s
switch-back now moves the rows too, and asserts that a record moved by hand
alone re-embeds no finished row. `--status` said nothing about what
preflight's new check would say; it does, when the record and the
configuration agree. `--dry-run` counted a caveat row whose thought had moved
twice, under the data rule and `--retry-fallbacks`; it counts the caveats the
data rule leaves. And PostgREST answers PGRST202 both for a missing function
and while its schema cache predates the migration, so the 020 and 021 PostgREST
remedies carry the `NOTIFY pgrst, 'reload schema'` hint. Suites after: schema
462, live 249, upgrade 24, preflight 116.

**A second pass, and the stop.** Its top finding was in the first pass's own
addition — the evidence-based backfill's `UPDATE` fired 001's `updated_at`
trigger, so every row it labelled read as edited at the migration instant, and
a client holding a pre-migration read would have been told `STALE_READ` on its
next edit of a row nothing changed — which is the signal this fork stops
reviewing on. Nine were fixed and one is a ticket. The trigger is held off for that one
statement, and `test-upgrade.ts` [4] asserts no `updated_at` moved and no audit
row was written. The first pass had narrowed the start-over to failed rows and
expired leases but left `--retry-fallbacks` gated on "not a model change" with a
message saying the change had returned every terminal row; a caveat row is
neither failed nor a lease, so the flag was silently ignored under
`--switch-model` — it is honoured on every run, and the message reports the
count. Whether a key is a model's own or a backfill, and which model it pools
against, was decided by two rules — `reembed.ts` against the configured model,
preflight against the key's — so `--status` for a key naming another model
printed a different "not yet in the pool" than preflight; `poolModelFor` in
`db/config.mjs` is the one rule, and the tool judges the rows against the
key's model, which for a run is the configured one since a foreign key is
refused. The count of unlabelled rows a run would pool was read after the
start had pooled them, so the run never printed it while `--dry-run` did; it
is read from the pool's pending rows once they exist. The PostgREST two-step
fallback replaced a vector without its label, which on a re-capture of a
labelled row left the one state nothing can see — a label beside another
model's vector; it writes both. The end-of-run paragraph told a backfill's
operator to switch a server that was fine, because under a backfill key every
capture made meanwhile is unpooled whatever model it is at; the two key shapes
get two sentences. The `--status` note about preflight's `vector models` line
was gated on the record and configuration agreeing *before* a run that then
recorded the model, so a switch's end never printed it; agreement is judged as
it stands. The Supabase Edge Function server under `server/` captured with no
label, so every row it wrote after 021 was "unknown" and re-embedded by the
next pass; it names its model in the envelope now (six lines), and the corpus
lines in both tools say "model unknown" rather than dating the row. And the
backfill's pool went through the id-array branch of `enqueue_thoughts`
(materialising every id for a DISTINCT that primary keys never need); a
backfill takes 015's set-based branch again. One finding was pre-existing and
is a ticket, not a fix: a chunkless re-capture through the 3-argument
`upsert_thought` replaces the parent's vector and label and leaves 007's chunk
rows from the previous vector (SMD-1175); 021's header no longer claims the
parent's label is the chunks' on that path (done in change 40). Suites after: schema 462, live 249,
upgrade 27, preflight 116; the three `server/` suites 47, 30, 36.

**A third pass, asked for after the stop.** Its top finding was again in the
first pass's additions — the data rule met the backfill's limit: 021 can label
nothing from a key naming no model, so the first run under an existing bare
`--job` key after upgrading found every succeeded row's thought unlabelled,
"not at the target", and returned the whole corpus to the pool — the cost the
backfill was added to avoid. Under a backfill key the data rule now returns a
finished row only when its thought's label names another model or its vector
is gone; an unlabelled row is left to its finished row there, since a
backfill's reason is not the model. Nine more, all fixed: the `--baseline`
remedy told an operator to re-run 021's body by hand, whose DISABLE/ENABLE
TRIGGER pair a failure under autocommit would separate — it says one
transaction, and preflight gained an `updated_at trigger` check with the
one-line remedy; `vector models` said ok for the migration's own motivating
corpus (a switch that died, its claim rows cleared, every vector unlabelled,
none known to be at the model the record names) — it warns, with the pass as
the remedy; 021's header claimed its trigger toggle held a lock only for the
statement between, when the migrator runs the file as one transaction and
every lock it takes is held to the commit — the header says so, and the
backfill evaluates its key regex once rather than twice per claim row; the
evidence rule trusted every succeeded claim under a model's key, but between
changes 29 and 35 `reembed.ts` accepted a `--job` naming another model than
the shell's — the header names the window and the step for a brain that ran
such a job; the Edge Function server's two-step fallback replaced a vector
without its label (the second pass had patched its capture and not its
fallback), and the portable store's fallback had been made to fail outright on
a schema without the column — both write the label and, refused the column,
attach the vector alone as before; the same-model message still called every
run "a backfill" when the model's own key pools only the rows not at it — it
says what the run pools and names the suffix key; `--dry-run`'s unlabelled
count omitted an expired lease a model change would return; and preflight
scanned `thoughts` once per finished key for a number it never prints — only
unfinished keys are counted. Suites after: preflight 118.

**A fourth pass.** Its top finding was again made of the earlier passes'
additions: under a backfill key, `--switch-model` recorded the new model and
re-embedded nothing — the narrowed start-over returned only failed rows and
expired leases, the key's data rule trusted every finished row's unlabelled
thought, and `enqueue_thoughts` skipped every thought with a row — so a brain
whose history was under `reembed:nightly` ended a model change with "Nothing to
do" and every vector the old model's. Under a backfill key every terminal row
returns on a model change, as before 021: that key cannot judge by label, and
the model's own key keeps the narrow rule. Eight more fixed: the `--dry-run`
count of caveat rows used the own key's notion of "moved" while the run used
the backfill's, and its count of unlabelled rows was a second hand-inverted
copy of the requeue rules that counted rows the run never touched — both now
derive from the start's own predicates, and the data rule's count is net of the
rows the start-over takes first; the `updated_at trigger` check was nested
inside the corpus scan's `try`, so a scan that failed hid it — it has its own,
before the scan; the backfill's DISABLE / UPDATE / ENABLE were three
statements, which a hand run under autocommit could separate — they are one
`DO` block, and the "run it as one transaction" remedy text went with the
hazard; the Edge Function server's capture test mirrored the write path
without the label and its drift guard did not name the new lines — both do;
`--status` for a key naming another model printed counts judged against the
key's model, a corpus line judged against the shell's and a preamble about
neither — every line is judged against the key's model and the preamble says
so; and the Edge Function server's label was a hard-coded spelling where
preflight compares by string equality with the record — it reads
`OB1_EMBEDDING_MODEL` with that spelling as the default. Two findings are the
boyscout's: the envelope built identically in both stores and the model
threaded beside the vector rather than on `EmbeddedCapture`, and the
corpus-by-model query and reduction duplicated between `reembed.ts` and
preflight. Suites unchanged in count.

**A fifth pass.** Seven fixed, three declined with the reason. The backfill
key's trust in a finished row was unbounded: a NULL label beside one was
"still at the target" for ever, although after 021 every row the tool finishes
is labelled, so a NULL there is a later foreign write — an un-upgraded server's
re-capture that a recurring backfill would then never re-embed. The trust is
bounded by 021's own evidence rule: `updated_at <= finished_at`, or the row
returns. The `--dry-run` caveat count under a backfill key on a model change
counted rows the start-over takes first; every count is now an exact
complement of the requeue predicates it stands beside. The `--status` note
about preflight's line was gated on the record agreeing with the *shell*
while the rows were judged against the *key's* model; both tools now judge
against one target, and a suffixed foreign key (`reembed:y@d:ctx`) is judged
against y as an own-shape one is. The own key's model change — the narrow
start-over and the data rule together — was never exercised, since every
`--switch-model` in the live suite runs under its backfill key; [9] now
switches back under the model's own key too, and asserts that only the two
relabelled rows return. The end-of-run paragraph blamed "a server on another
model" for rows that had no vector or no label; it names the three causes.
And the Edge Function server's label, a knob since the fourth pass, is checked
against the column's width once per vector, with the two named. Declined: the
backfill's `updated_at` rule treats a metadata-only edit as a write that
invalidates the pass's vector — it could be refined from the audit log, but a
raw vector write leaves no audit row either, and a rule that re-embeds a row it
need not is the right side of that line; the two-step fallback's retry without
the label also fires for a stale PostgREST schema cache and stores an
unlabelled vector — a defined state the pass re-embeds; and the in-repo
integrations (`enhanced-mcp` as well as `update-thought-mcp`) replace a vector
with a raw update and leave the label stale — outside this change, named
below. Suites after: live 252; `server/` 47, 30, 38. Then the tidy-ups the
passes had cut for space, while the files were open: the `p_payload` envelope
was built identically in both stores — `captureEnvelope` in `store.ts` beside
`actorPayload` is the one copy — and the model was re-read from the
configuration at every call site beside a vector the embedder had just
produced; `EmbeddedCapture` carries `model`, and the server and `reembed.ts`
pass that. The corpus-by-model query and its arithmetic were written in
`reembed.ts` and in preflight; `CORPUS_BY_MODEL_SQL` and
`summariseCorpusByModel` in `db/config.mjs` are the one copy. Preflight's two
PostgREST probes each created a client, and one remedy string was written
where `APPLY_021` was; `test-preflight.ts` wrote the regex-escape idiom nine
times, and has `rx()`. The ACL replay block's third copy stays: a migration
file cannot share text with another, and a SQL helper for it would be a fourth
thing to carry.

**Found on the way.** The schema probe asked `to_regclass('schema_migrations')
IS NOT NULL AND EXISTS (SELECT … FROM schema_migrations)` in one statement, and
Postgres resolves the relation when it parses the statement, whatever the `AND`
would have short-circuited — so a schema applied by hand, with no ledger,
crashed `reembed.ts` at that probe. The ledger is asked in a second statement,
only when it exists.

**Held in the tests.** `test-schema.ts` [22]: the column and its comment; the
label written from the envelope, NULL without it and through the 2-argument
form; a re-capture with a vector relabels, one without keeps vector and label,
a metadata-only one too; `update_thought` relabels with a vector, blanks with
content and no vector, leaves a metadata-only edit, and resolves a 7-argument
call through the default; no audit row for a re-embed or a label-only change;
one `update_thought` of eight parameters carrying 018's body by name, 021 the
last definer of both writers and 010 still of the audit trigger; 018 re-applied
puts a second form beside it and a 7-argument call is `not unique` until 021 is
re-applied; and the ACL across the drop — [21]'s four cases for this function.
`test-upgrade.ts` [4]: 021 onto a populated 020 — rows before read NULL, a
capture and a re-embed after carry the label, the 7-argument form is gone,
re-applying is a no-op. `test-live.ts` [9]: every re-embedded row carries the
model that produced its vector; then the ticket's case — a server still on the
old model re-captures one text and captures a new one after the pass finished:
preflight `vector models` warns `2 at old-model` from the rows while `re-embed
pass` says none unfinished, `--status` prints the corpus by model and counts
one thought not yet in the pool (the switched server's capture, at the target,
is not counted), `--dry-run` says the finished row returns and the new one is
added, a plain re-run re-embeds exactly those two and says nothing about
guessing, the switched server's capture never enters the pool. The switch-back
at the end re-embeds 41 rather than 42 for the same reason. `test-preflight.ts`
[5]: rows at two models with an empty claim table warn with the counts and the
pass as the remedy, `--json` carries it; a corpus wholly at the recorded model
is ok with the unlabelled row as detail; the record on another model puts
`--switch-model` in the remedy; the column dropped fails naming 021 and 021
re-applied brings it back unlabelled; 018 beside 021 fails with the exact DROP,
018 in its place fails naming 021. The store suites and the e2e suite assert the
label on capture and on an edit, on both stores. Suites after: schema 461 at
both widths, live 245, upgrade 20, preflight 115, sql 59, e2e 63, postgrest 43,
update-delete 39 (before the pass below).

**Not done here.** Chunk rows left by a chunkless re-capture through the
3-argument `upsert_thought`, which predate this change (SMD-1175) — done in
change 40; the community integrations `update-thought-mcp` and `enhanced-mcp`, which write
content and vector with a raw update around `update_thought` and so leave a
stale label as they leave a stale fingerprint — done in change 69, with seven
more files the check found. A label for the rows no finished pass
vouches for — there is no fact to backfill from; the first pass over them
labels them, and says how many before it runs. `--accept-failed` and
`--retire` (SMD-1067) — done in change 39, where accepting a row means exactly
that: it stays at the old model, the caveat says so, and both readers of the
row honour it while nothing has written the thought since.
