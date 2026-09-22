# 40. A re-capture's windows stay while the label vouches for them — migration 022 redefines the 3-argument `upsert_thought`

`db/migrations/022_capture_replaces_chunks.sql` and `server-portable/preflight.ts`
(Linear SMD-1175, filed by change 38's second review pass). `upsert_thought(text,
jsonb, vector)` — 004's atomic capture, last redefined by 021 — replaced the
parent's vector and label on a re-capture of the same normalised text and never
touched `thought_chunks`. Only the 4-argument form (007, 013) and
`update_thought` (009, 018, 021) replace chunk rows, and every caller routes a
capture that produced no windows to the 3-argument form: both stores
(`chunks.length ? 4-arg : 3-arg` — a deployment stopped before 007 has no
4-argument form, and no 022 either) and the Supabase Edge Function server,
which never makes windows. So a
thought first captured with windows and re-captured through a path that made
none — the Edge server, or `server-portable` after `OB1_CHUNK_TOKENS` grew or
the provider's window changed so the text fits one call — kept the windows of
the vector it no longer had, and `match_thoughts` found it by them. Silently:
no error on the write, none on the search. Pre-existing since 007; since 021
also invisible: the re-capture labels the parent at the new model, so `vector
models` reports it at the target and the re-embed's pool skips it — old-model
windows under a parent that says it is at the new model.

**The windows stay while the label vouches for them.** Migration 022 redefines
the 3-argument body — 021's, 005's guard and 008's actor and 021's label carried
— when a vector arrives, reading the row the capture lands on `FOR NO KEY
UPDATE` before the write, and adding one block after it: when the row was there
to lock and its label does not vouch for the windows, `DELETE FROM
thought_chunks WHERE thought_id = v_id`. Locked, because under READ COMMITTED
an `ON CONFLICT DO UPDATE` lands on whatever row holds the fingerprint when it
runs — one a concurrent transaction committed after this one's snapshot
included — so a label read without the lock could be the row's label before an
edit that changed it; `update_thought` locks the row `FOR UPDATE` (018), which
conflicts with this lock, so the two are ordered either way. `FOR NO KEY
UPDATE` and not `FOR UPDATE`, because every foreign key onto `thoughts(id)`
holds `FOR KEY SHARE` on the parent while its inserting transaction is open and
`FOR UPDATE` is the one row lock that conflicts with it: `reembed.ts` enqueues
a corpus in one transaction, and with `FOR UPDATE` a re-capture of any existing
text waited out the whole enqueue (4 s against a small held one in the third
pass's measurement, 1 ms with this lock). Two shapes the row lock cannot cover
— two first captures of one text racing, and an edit moving another row onto
this text — find no row to lock, and remove nothing: the other writer's windows
stay, as under 021, at another model the SMD-1175 state for that race only;
SMD-1043's advisory lock on the fingerprint, which `update_thought` already
takes, makes the read find the row and closes both (done in change 63). The label vouches exactly
when the
row's vector was labelled with a model and the arriving vector is labelled with
the same one: the windows were written in the same call as the vector before,
by that model (021's rule), and 003's fingerprint says the text is the same, so
they are still that model's vectors of windows of this text — a note windowed
by `server-portable` and re-saved through the Edge server at the same model
keeps the tail-anchored recall 007 added. Any other case removes them: a label
unknown on either side (a vector from before 021, a caller naming no model), or
another model. No vector arriving keeps vector, label and windows alike. The
rule lives in the one body every caller reaches — both stores, the Edge server,
any PostgREST integration calling the RPC by name — rather than in two stores
taught to always call the 4-argument form with `'[]'`, which would have left
`server/index.ts` and every third-party caller as they were. Why not
unconditional, as the 4-argument form and `update_thought` are: those callers
*send* windows, or send content that may have changed, so the windows are
theirs to supply; a chunkless re-capture of the same text supplies nothing
about them, and the label is the one fact in the row that says whether they
are still the vector's. The 4-argument form is not redefined: it delegates to
this one and then replaces the windows with the caller's whatever the label,
and 013 stays its last definer. Considered and not built: a trigger on
`thoughts` — `AFTER UPDATE OF embedding`, when the vector or label changed and
the old label does not vouch — which would see the row's old label as `OLD`
for every writer, with no lock and no sentinel. The two writers that send
windows already replace them wholesale, so the trigger would run beside their
DELETE on every edit and every re-embedded row; the rule is about the one
writer that sends nothing about the windows, and it also fires on a raw
UPDATE of the vector, which 021 leaves to the operator on purpose. If a fourth
writer ever needs the rule, the trigger is where it goes. No backfill: a
window left before 022 cannot be told from a live one; a `--job` pass
regenerates every thought's windows through `update_thought`, and the header
says so.

**What it costs.** When a vector arrives, one probe on 003's unique index — on
the row the INSERT is about to lock anyway — and, on a re-capture whose label
does not vouch, one DELETE bounded by `thought_id` on 007's index; a fresh
insert runs the probe and nothing else, a capture with no vector neither. Two
consequences of "unknown vouches for nothing" are decided on purpose and said
in the header: a row 021 left unlabelled loses its windows on its first
chunkless re-capture at any model, the same one included — keeping them would
be SMD-1175's case for exactly those rows, and the remedy is the pass 021
already asks for, which labels and re-windows them; and "the same model" is
021's string equality, so two servers spelling one model two ways are two
models to this rule as to `vector models`. The first
version ran the DELETE on every vectored capture, fresh inserts included, and
was measured so at 1,024 dimensions, 2,000 operations per line, two rounds each
side on one container: fresh 3-argument captures 0.9–1.4 ms each at 021 and
1.2–1.4 ms at 022; re-captures 1.3–1.6 ms and 1.2–1.4 ms; re-captures with no
vector 0.35–0.46 ms and 0.32–0.38 ms. Inside the run-to-run spread, on either
side of it; this version does less.

**The sentinel, the privilege, and preflight.** The body carries
`ob1:vector-replaces-chunks`, a contract sentinel in 014's convention: 021
re-applied by hand puts 021's body back — `CREATE OR REPLACE`, no error, and the
defect with it — and nothing else would say so. Over a direct connection
preflight's `atomic capture` check reads every `upsert_thought` form in one
schema-qualified catalog read and warns without the sentinel, naming 022 — a
warning, not a refusal: captures work, and search is merely over-inclusive. A
missing 3-argument form names 022, its last definer, not 004 (whose body would
drop 005's guard, 008's actor, 021's label and 022's rule); a missing
2-argument form names 005. The function is SECURITY INVOKER, so the DELETE runs
as the calling role: a role that only ever captured chunklessly never needed
DELETE on `thought_chunks` (007's 4-argument form and `update_thought` did),
and does from here — a check of its own (`chunk delete privilege` then;
since SMD-1226 the wider `write privileges`) reads
`has_table_privilege` for the connection's role wherever the table exists,
schema-qualified (the bare name resolves through `search_path` and raises for a
relation it cannot see), and refuses to start without it, printing the GRANT.
Two facts, two remedies, so a body from before 022 and a role without the
privilege are both said at once rather than the second surfacing only after
the first is fixed. Over PostgREST neither is reachable, and both checks say
so as skips.

**Verify, as the ticket asked.** `test-live.ts` [7]: a thought at `old-model`
with two windows, found by its second; re-captured through the 3-argument form
at the same model → the windows stay and the thought is found by the window and
by the new vector; at another model → no windows, no longer found by the old
window's axis, found by the new vector's; a re-capture with no vector keeps the
windows, vector and label whatever label it names. `test-chunking.ts` [5b]: a
text over today's window and under the provider's batch with a sentinel at
each end — the whole-content vector on the first's axis, the second window
alone on the other's, so the ending is answered by the window or not at all —
captured through the server as two windows and found by both; the same text
embedded with the window at the batch makes no windows, written through the
store at the same model keeps the windows and the ending still answers, at
another model leaves none and the ending no longer does (the server snapshots
its environment on its first request, so the grown window runs the embedding
path with the new configuration, as the suite already does for a changed
setting). `test-store-sql.ts` [6] and `test-store-postgrest.ts` [6]: the
store's routing to the 3-argument form keeps the windows at the same model and
leaves none at another, on both stores, and none over an unknown label on the
PostgREST one. `test-schema.ts` [23]: the rule through a planted window (PGlite
cannot run the 4-argument insert) — same model keeps, another removes, no model
on either side removes, no vector keeps — the sentinel and the locked read in
the body with 021's carried parts, the 4-argument form still 013's, three
overloads, 022
the last definer of `upsert_thought`, and the trap: 021 re-applied leaves the
windows again, 022 re-applied removes them. `test-upgrade.ts` [5]: 022 onto a
populated 021 — the defect shown at 021, after 022 a same-model re-capture
keeps the window and another model's removes it, no column or signature
changed, the window left before 022 left where it was, a re-apply a no-op.
`test-preflight.ts` [5]: 021 re-applied over 022 warns naming 022, 022
re-applied is ok, the 3-argument form dropped is refused naming 022 and not
004, and a capturing role without DELETE on `thought_chunks` is refused with
the GRANT and starts once granted. Suites after: schema 483 at both widths,
live 308, upgrade 36, preflight 138, chunking 35, sql 62, postgrest 46.

`test-live` [7]'s three found-by assertions (five `foundAt` calls, two of them
window reads at axis 2) go through `match_thoughts`'s filtered branch since
SMD-1574: a metadata key only the re-captured thought carries, so 014 scores
it and its chunks by id and no walk decides — the section no longer exercises
the HNSW path at all. Read unfiltered, the same-model assertion missed the
freshly moved vector in five CI attempts on three trees that touched nothing
under `db/`, and four times in thirty-seven local runs; the ticket's own
reading — ten live rows tied at the axis — was wrong, since [7] starts from an
emptied table and has three thoughts and four chunk rows under a returned
limit of ten and a candidate window of forty. What the dumps showed, what was
measured and what still reads the walk are in "Known issues we did NOT fix"
under SMD-1632; [5b] holds the walk's recall on random vectors, [5c] its plan.
Three review passes and a boyscout, all prose: the accounting of runs, the
hedges on what was shown, and this note cut to its place.

**A first pass, triaged.** Its top finding was the rule itself: the first
version deleted the windows on every vectored re-capture, and on the path the
header names — a `server-portable`-windowed note re-saved from Claude Desktop
at the *same* model — that lost the ending from search, silently, for a
thought whose windows were still valid. The label vouches now (above). The
rest: the DELETE runs as the calling role and nothing said so (the Safety
block, and preflight's privilege check); over the default PostgREST store the
check printed nothing rather than a skip; a missing 3-argument form sent the
operator to 004; `to_regprocedure` resolved through the session's
`search_path` (a NULL on PG16, a raise on PG15 that took every later check with
it) where one schema-qualified read serves; the chunking test's two search
assertions were satisfied by the whole-content vector alone; the live test
raised the suite's floor on the width to 10; the preflight suite's first
assertion matched the warn line too; a symbol rename had rewritten a comment;
and [22]'s restore of `update_thought` re-ran 021 over 022's body, which the
helper's own rule — pass both names — covers. Two findings were refuted by the
pass itself: the `xmax` distinction (the probe is measured inside noise) and
`content_fingerprint_of` in this body (SMD-1043's, said in the header).

**A second pass, triaged.** Its top finding was in the first pass's addition:
the label was read at the statement's snapshot, in a CTE, and under READ
COMMITTED the `ON CONFLICT` lands on the row as committed when it runs — an
`update_thought` at model B writing B's windows between the read and the write
would have had them removed by a capture that read "A". The read is `FOR
UPDATE` now (above), and `v_existed` is gone with the CTE: `(old = new) IS NOT
TRUE` is the whole condition, and it runs the DELETE in the racing-first-
captures case the flag would have skipped. The rest: `has_table_privilege` by
bare name resolved through `search_path` and would have raised into the block's
catch, silencing every later check — qualified and guarded with `to_regclass`,
and split into its own check with its own remedy; the migration's title and
Expected outcome, and this change's heading, still stated the first version's
rule; the role fixture created a cluster-wide role with no guard and no
`finally`, and swapped credentials into a URL that might carry none — guarded,
`finally`, and a skip; the PostgREST store test proved only the unknown-label
case, so the claim about both stores was wider than the tests; [23] pinned the
whole block's text with whitespace-sensitive regexes beside a sentinel that
exists so the contract is a marker — shrunk to the sentinel and the lock. The
trigger alternative is recorded above with the reasons. Refuted by the pass
itself: "apply 022 alone" as a remedy (the `vector models` failure fires first
on a pre-021 schema), the `IS NULL` arm as a defect (the documented
trade-off), and the Edge server's GRANT (Supabase's defaults, or 008's audit
trigger fails first).

**A third pass, asked for after the stop.** Its top findings were in the second
pass's additions. The locked read was `FOR UPDATE`, the one row lock that
conflicts with the `FOR KEY SHARE` every foreign key onto `thoughts` holds, so
a re-capture blocked behind an open `enqueue_thoughts` for its whole duration
(reproduced by the pass) — `FOR NO KEY UPDATE` now, ordered against
`update_thought` and nothing else. The DELETE ran on every fresh insert, which
needs the privilege before Postgres looks for rows, and made two races the lock
cannot cover destructive — a `FOUND` flag after the read bounds it to a
re-capture, so those races remove nothing, as under 021, until SMD-1043's lock
closes them (change 63); the read itself runs only when a vector arrives. The remedy for a
missing 2-argument form re-applied 005, which redefines the 3-argument body too
— it says "then 022", and the missing form is a warning, since this server
never calls it. The GRANT remedy quotes the role; the privilege check's ok text
says what it checked, DELETE and nothing more; the fixture skips where the
connection cannot create a role; [22]'s two other restores of `update_thought`
name both writers. Two findings were trade-offs the tests already lock in, and
are now said as such above rather than changed: an unknown row label removes
the windows, and the label is a string.

**Tidy-up, while the files were open.** No behaviour change. `test-schema.ts`
asked "how many functions of this name" through five identical closures, one
per section; `functionsNamed()` at file scope is the one copy (section [16]'s
`count`, which takes a table and a WHERE clause, is a different helper and
stays). Preflight's privilege query resolved `thought_chunks` twice; once, in a
subquery. `test-upgrade.ts` [5]'s first
assertion read the window count and the label twice each, the printed value a
second read. Left: the chunk-count closures in the store and chunking suites
count different rows by different joins, and a shared helper would carry the
join as a parameter — more to read than it saves.

**Not done here.** Windows left before 022 — no backfill, since nothing can tell
them from live ones; a `--job` pass is the remedy, and a brain upgraded through
021 that has not run a pass should run one before re-saving long notes from a
chunkless server. SMD-1043's advisory lock in both inserting overloads
(change 63, migration 033) redefines this body and carries the locked read with its `FOUND`, the
block and the sentinel forward, as 022's header lists; its fingerprint lock
also closes the two races above. `server/index.ts` is
unchanged: the migration fixes its path. The 4-argument form's body has no
sentinel and no check; a hand re-apply of 007 over 013 would drop the context
column from the chunk insert, which preflight's `chunk context` check reads
from the rows rather than the body.
