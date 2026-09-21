# 71. The vendored captures that inserted a thought go through the 3-argument `upsert_thought` — eight files off a raw `INSERT` into `thoughts`, three deployments with a database of their own say they bypass it, and check 10 holds the insert (SMD-1524)

`integrations/readwise-capture/index.ts`,
`integrations/consolidation-workers/bio/index.ts` (its first run),
`recipes/editorial-policy/auditor/index.ts`,
`recipes/adaptive-capture-classification/capture-with-gating.ts`,
`recipes/local-ollama-embeddings/embed-local.py`,
`recipes/readwise-import/import-readwise.py`, the samples in
`integrations/telegram-capture/README.md` and
`integrations/slack-capture/README.md`; headers on
`integrations/kubernetes-deployment/index.ts`,
`recipes/vercel-neon-telegram/src/lib/db.ts` and
`recipes/schema-aware-routing/index.ts`; `scripts/check-fork-consistency.mjs`
(check 10); `extensions/test-writes.ts`; their READMEs and
`recipes/local-brain-no-mcp/README.md` (Linear SMD-1524, filed from change
69's audit). Change 69 moved every vendored *update* of a thought's `content`
or `embedding` onto the functions and drew its rule at the update, because an
update leaves something *stale*; it named the other door and left it: a raw
`INSERT` of a fresh row with content, or content and a vector, around the
3-argument `upsert_thought`. The ticket named six sites. Check 10's first run
with the insert in its rule found eight hits in eight files — the two the
ticket's grep had not reached being `editorial-policy`'s auditor, which
stored every weekly report as a raw row, and `schema-aware-routing`, which
turned out to write a database of its own — and a hand search found two
more the rule cannot see: the readwise backfill's batch insert of a list
built by comprehension, and the Ollama recipe's `POST /rest/v1/thoughts`.
What a raw insert leaves is not stale but *missing*: `content_fingerprint`
NULL — 003's rule is in the functions, 016's trigger does not fill it, so the
row is invisible to dedup until 023's backfill runs, and a later capture of
the same text through `upsert_thought` makes a twin, which is the duplicate
the fork's whole fingerprint machinery exists to refuse; `embedding_model`
NULL — 021's vector of unknown model, which the re-embed pool treats as not at
the target and re-embeds; and, where the writer holds a key, no name for
008's audit row — the functions record an actor the caller passes, a raw
insert has nowhere to pass one. Two of the eight
were worse than the shape: the bio worker's first run computed its own
fingerprint and stored **no vector at all** (the comment said `upsert_thought`
would drop the enhanced columns, which is true, and is what the sidecar
update change 69 gave the rewrite path is for), so the first profile was
unsearchable until a re-embed pass reached it; and the classification
recipe's example inserted `tags`, `project` and `due_date` as columns
`thoughts` has never had, so it failed on any brain.

**The mechanism** is change 69's, on the capture side. A capture is one call
to the 3-argument `upsert_thought(p_content, p_payload, p_embedding)` with
`embedding_model` in the payload — the function writes the text, its
fingerprint, the vector and the vector's label in one statement under 033's
lock order, sets 008's actor from `p_payload.actor` when the caller names one,
and answers `{id, fingerprint, existed, supersedes}`; a text the brain already holds comes back `existed` with its
metadata merged and its vector replaced, which is what a re-sent webhook or a
re-run backfill should do, and what a raw insert could not (the readwise
backfill bisected its batches to find the row a unique violation aborted
them on — gone with the batch). The enhanced-thoughts columns the function
does not know (`source_type`, `type`, `importance`) follow by an update that
carries neither content nor vector — for the bio worker on a fresh row only
(`existed` skips it), for the receiver and the backfill wherever the columns
are NULL (the second pass, below) — so a re-capture leaves a hand-set tier
alone, change 69's escalation-only stance. Where the writer makes no vector — the auditor's report, the
classification example — `{p_content, p_payload}` resolves to the 2-argument
form and the row waits, labelled NULL as a vectorless row should be, for a
re-embed pass; the files say so, and say that this form answers `{id,
fingerprint}` only — no `existed` — so a vectorless writer that wants a
fresh-row gate must pass the 3-argument form with a JSON `null` vector (the
review pass ran both through real PostgREST). The readwise receiver and the auditor are
driven in `test-writes.ts` (the receiver behind a stubbed Readwise book
lookup and the `readwise-books` sidecar, now the third the suite applies and
drops); the bio worker's first run, the classification example, the two
Python recipes and the two README samples are read by regex there. Per
file: `readwise-capture` — one call with the label constant the file now
names, the sidecar per column where it is NULL, `existed` answered `ok` and
the book counter still incremented; `consolidation-bio` — the first run embeds the
profile as the rewrite path does and captures it whole, a concurrent run's
`existed` row reported as not created and left its columns,
`computeContentFingerprint` no longer imported; `editorial-policy` — the
report through the 2-argument form, its window timestamps keeping two reports
two rows; `adaptive-capture-classification` — the 2-argument form with the
classifier's fields in metadata, and the note that the capture MCP tool is
the better call there; `embed-local.py` — `POST /rest/v1/rpc/upsert_thought`
with the Ollama model's bare name as the label (the spelling
`OB1_EMBEDDING_MODEL` uses for an Ollama model, so `db/reembed.ts` sees these
rows as at its target or not), `existed` reported per thought, and the
"ALTER the column" advice answered by a fork note (the width is
`db/config.mjs`'s); `import-readwise.py` — one call per row, the bisection
and its `APIError` gone, `existed` counted as already present, the sidecar
per fresh row, a slower backfill said in the README; the two samples — the
3-argument call with the label constant, Slack's sample gaining the constant
Telegram's already had.

**Check 10** widens to the insert: a PostgREST `.insert(` on `thoughts` whose
payload carries either key — a literal, an array of literals, a bound name,
and a name filled one literal at a time by `x.push({ … })` or Python's
`x.append({ … })`, a binding form the update rule did not need — and the SQL
`INSERT INTO [public.]thoughts [[AS] alias] (<columns>)` whose column list
names `content` or `embedding` (quoted or not; word-bounded, so
`content_fingerprint` and `embedding_model` are the other columns they are;
`INSERT … SELECT` with a list caught, `VALUES` or `SELECT` without one
outside the rule, said so). The one insert the non-probe list carried as
"outside" moved to the probes, joined by thirteen more — each site's own
shape and the forms a rebase could bring — and ten non-probes: another
table's insert with a `content` column, the other columns, no column list,
a metadata-only row, the remedy, prose naming the statement, the
comprehension the rule cannot see. Sixty-one probes, forty-one non-probes
(eleven and four from the review passes), each probe held to its verb's line. **Exceptions, seven, the list's first
entries** — none a bypass a fix here could remove, each a file whose header
or README says what its rows lack: three deployments whose database is their
own, built from the guide's shape, where the fork's functions are not —
`kubernetes-deployment` (its own Postgres in the cluster, `k8s/init.sql`),
`vercel-neon-telegram` (Neon, `sql/001-create-thoughts.sql`) and
`schema-aware-routing` (a five-table project from its README's SQL, a
`thoughts` with `domain`/`status`/`source` columns) — the first two the same
files check 7 excepts for creating a brain rather than adding to one; the two
guides that show upstream's `upsert_thought` body and the `local-brain-no-mcp`
container init that shows its own, where the `INSERT` is the function's; and
`test-writes.ts` itself, which plants a row as an older write left it,
fingerprint and label by hand, for the writer under test to move whole. The
Kubernetes and Neon READMEs say how to get a fork-shaped brain there instead
(apply `db/migrations/` in place of the init script; backfill and re-embed
data moved across); the routing README says to capture through the function
and keep its three columns in metadata.

**Decisions.** The three own-database deployments are excepted, not
converted: routing their captures through a function their database does not
have would break them, and replacing their init scripts with the fork's
migrations is a deployment change beyond a write audit — each README says
the path. The shim's table verbs still bind a `number[]` as a Postgres array
literal (change 69's carried finding): after this change no vendored table
verb carries a vector, so the dependence is gone rather than the binding
fixed, and the binding stays because the shim cannot tell a vector from an
`int[]` column by the array's shape — `rpc()` can, because a function
parameter is typed. The readwise backfill stores one row per call rather
than a batch: PostgREST has no batch RPC, a duplicate is now the function's
answer rather than a violation to bisect for, and the cost — a few minutes
per ten thousand highlights against a batch of twenty-five — is the
backfill's to bear, said in its README. The Ollama label is the model's bare
name, not `ollama/<name>`: the fork spells `OB1_EMBEDDING_MODEL` that way
(`qwen3-embedding:4b`), and a label the re-embed pool does not recognise as
its target is a row it re-embeds. The bio worker's first run pays for an
embedding it did not before — the rewrite path already did, and an
unembedded profile is one nobody finds. The two vectorless captures use the
2-argument form by omission rather than passing a JSON `null` vector: the
form is the function's own, and the label rule (NULL with no vector) holds
either way. `INSERT INTO thoughts VALUES (…)` without a column list stays
outside the rule: the statement does not say which columns it writes, and
none is in the tree.

**Review pass 1** (a reading reviewer and a running one, the latter in its
own worktree with real PostgREST v12.2.3 beside the database; eleven
findings, none above MEDIUM: eight fixed, two noted, one informational). The
readwise backfill read the
function's reply with `isinstance(data, dict) else {}` and skipped any other
shape as "already present" — a client wrapping the reply in a list or a
string would have stored every row and written no sidecar, silently; the
reply is unwrapped from those two shapes now and a reply naming no id raises
(both reviewers, independently; the running one confirmed postgrest-py's
current shape is the dict). The backfill's sidecar was one update per row —
two round trips per highlight, and the README's "a few minutes per 10K"
undercounted by an order — and is one update per batch over the fresh ids
now, the README saying ten to twenty minutes. The classification example's
comment and README promised the enhanced `type` column and wrote only
metadata; reworded, with the 3-argument-with-null path named for a writer
that wants a fresh-row gate. The receiver's book counter still counts an
`existed` highlight (Readwise's semantics) — said in the README. The Ollama
recipe's summary counted an `existed` row as ingested; a separate line now,
and its own `metadata.embedding_model` key explained beside the column. A
`-- comment` inside a multi-line SQL column list read as a column; stripped,
one probe and one non-probe added (50/37). The bio guards in the test
matched one spelling of the call; they hold the three arguments in any
order, and the header says the guards are spelling-sensitive by design. Not
fixed, and said: `computeContentFingerprint` in the workers' helpers has no
importer left outside the helpers (the boyscout found they call it
themselves — it stays); check 10 catches a column-listed `INSERT INTO
thoughts (content)` in a comment or README sentence, by design. Run for
real: the shim and PostgREST both resolve `{p_content, p_payload}` to the
2-argument form and `{…, p_embedding: null}` to the 3-argument one, the
latter answering `existed`; a 768-wide vector is refused with SQLSTATE 22000
(HTTP 400), so the recipes' status checks report it per thought; a restored
raw insert in the receiver fails check 10 at its line and two test
assertions — as `500` from the shim's array binding, the limit change 69's
header states, not by naming the columns; five runs on one container, and a
run after a SIGKILL, all green; `dropSidecars` drops the readwise-books
table and both functions.

**Review pass 2** (the same two lenses; seven findings, two MEDIUM, both in
the original change — the running reviewer's top finding was in pass 1's
batching, so the passes' fixes are among the top findings but not all of
them). The fresh-row gate met the dedupe filter: `readwise-capture` and the
backfill check for a row by `source_type = 'readwise'`, and wrote
`source_type` only when the function said the row was fresh — so a first
write interrupted between the function and that update (a crash, a 500 and
Readwise's retry, the backfill's new `raise` after earlier rows of the batch
were stored) left a row the dedupe could not see, which the re-capture then
found `existed` and left without its columns for good — before the change
the retry made a duplicate row, after it a permanently half-shaped one. The
sidecar is written `WHERE source_type IS NULL` now, on every capture: a
fresh row takes it, the interrupted row takes it on the re-capture, a
complete row is left alone; the backfill writes it in a `finally`, so the
rows stored before a refused reply take theirs before the error propagates
(the running reviewer traced the raise path; the reading one the retry). The
test interrupts a first write by hand and re-captures. The second MEDIUM was
prose: every converted file, its README and this section said "the audit
actor (008) is written with the text", and none of the writers named one —
the functions set `ob1.actor` only from `p_payload.actor` (or
`update_thought`'s `p_actor`), and change 69's five servers, which hold a
principal, pass none either, so their headers' "the actor reaches the audit"
has been false since change 69. Here: the two writers that authenticate a
key — `consolidation-bio` (both paths) and the auditor — pass `{name:
principal.name}`, and the test reads 008's row for the auditor's report
(`actor_name = MCP_ACCESS_KEY`); the writers without a key (the receiver,
the two scripts, the example, the two samples) say they name none, which is
008's own distinction for a write without a key, and the test reads the
receiver's audit row as NULL. Change 69's five are SMD-1541 — done in change
103. Smaller: the
UPDATE rule read a `-- comment` after a comma in a SET list as defeating the
target match while pass 1's INSERT rule stripped it (asymmetry) — both rules
blank line and block comments now, two probes and two non-probes (52/39); a
`;` inside a string argument or a payload built into a variable first fails
the bio text guards, within the header's stated sensitivity; pass 1's count
sentence said nine fixed of eleven — eight fixed, two noted, one
informational; the receiver's `existed` merge carries the latest highlight's
id, said in the code. Run for real: the batched sidecar over PostgREST
(`PATCH /thoughts?id=in.(…)` → 204; an empty `in.()` touches nothing);
postgrest-py 2.31's rpc reply is the dict; the classification example's old
insert fails `42703` on a plain fork brain and on one with the enhanced
schema, so "failed on any brain" holds; two runs on one container green.

**Review pass 3** (the same two lenses; eight findings, the top ones in the
passes' own additions and one pre-existing — the stop signal). Check 10's
comment handling, added in passes 1 and 2, blanked a comment AFTER the
statement's boundary had been found, so a comment's own text still ended the
list: `SET metadata = $1, -- v2; was v1` stopped the SET list at the
comment's `;`, `-- where content lives` at its "where", and a paren inside a
comment in an INSERT column list broke the list match — three false
negatives from mundane comments (both reviewers; the running one ran them).
The rules find the statement's head in the text and read the list from a
copy blanked from the head onward — line and block comments, and the text of
single-quoted strings, replaced by spaces with newlines kept, the string
state starting at the head where the text is SQL, so a quote in the prose
before it opens nothing; six probes and two non-probes (58/41), among them a
dash pair and a `content =` inside a string beside a real target. The heal
filter was one update WHERE `source_type IS NULL` writing both columns, so a
row another path captured first, typed by hand and without a `source_type`,
had its type overwritten to `reference` on the re-capture (the running
reviewer made one); the heal is per column now — `source_type` where it is
NULL, `type` where it is NULL — in the receiver and the backfill, and the
test hand-sets a type on a row without `source_type` and re-captures. The
backfill's `finally` let a failing sidecar update bury the loop's own error
(the reading reviewer; the running one saw the chained traceback) — the
loop's error is tracked and stays the one raised, the sidecar's a warning;
the sidecar's own failure on a clean loop still raises (a fake client for
all four cases). Prose: the receiver's header, README and this section still
said "on a fresh row only" from before pass 2; said per writer now. Run for
real: the actor plumbing end to end over the shim and PostgREST — a
3-argument call with `actor` names it on 008's `capture` row with
`actor.source` over `metadata.source`, `update_thought` with `p_actor` as a
JS object binds as jsonb (005's guard silent) and names it on the `update`
row, the 2-argument call names it too; `PATCH …&source_type=is.null` updates
the NULL row once. **Pre-existing, found by driving the bio worker for
real:** the SQL shim's `ident()` refuses a JSON-path filter column
(`metadata->>generated_by`), so `consolidation-bio` as shipped on the fork
answers 500 at its first query and never reaches `upsertProfile` — the
reason it can only be read here, not driven; the shim fix and the drive are
SMD-1544 — done in change 73, which found a second gap (a `Date` where
PostgREST gives a string) one step past the first. A fresh worktree needs `bun install` in `extensions/` before
`test-writes.ts` (eight MCP assertions fail without the packages); CI
installs.

**Review pass 4** (the same two lenses; six findings, all LOW or
informational, the top ones in pass 3's blanker — the stop signal holding).
The blanker read a backslash-escaped quote inside an `E'…'` string as the
string's close and reopened one over the target that followed, and read a
dash pair inside a `"quoted identifier"` as a line comment — two false
negatives, both theory-grade for the tree (no E-string, no dashed identifier
near a `thoughts` statement) and both confirmed by running the blanker; an
E-string's backslash skips its next character and a quoted identifier is
read whole now, three probes (61/41): the doubled quote, the E-string, the
dashed identifier, each beside a real target. The 4000-character window is
named in its comment (the tree's longest statement is under 400). One
per-file clause above still said "the sidecar on a fresh row" for the
receiver — pass 2's fix overtook it; said per column. Run for real: the
per-column heal over PostgREST leaves a hand-set type and fills
`source_type`, and a repeated PATCH touches nothing; a row another tool
labelled (`source_type = 'mcp'`) keeps its label and, since the receiver's
dedupe looks for readwise rows only, is re-sent to the function on every
delivery — one row throughout, one `update` audit row per delivery — said in
the README now; the backfill's `finally` under a KeyboardInterrupt writes
the stored rows' columns and re-raises, under a clean loop with a failing
first column raises the sidecar's error with the second column unwritten
(the next run heals both), under a double failure raises the loop's error
with one warning; the checker's scan is no slower for the per-head slice
(0.7 s either way); `deno check` on the receiver shows the shim typings
only. Two runs on one container green.

**Boyscout.** The passes' cut-for-space tidy-ups in the files this change
touched, no behaviour changed: the Ollama recipe's usage text, `--dry-run`
help and README still said "insert" for what is a store through the
function; the readwise backfill's README opening and one troubleshooting
heading the same; the test's sidecar comment counted two files where there
are three; the probe list's doc comment named the updates alone. The
`computeContentFingerprint` pass 1 marked for removal is called by the
helpers file itself (the workers' shared copy computes a fingerprint for its
own structured-capture path), so it stays; the pass-1 note above says so.

**Not done here.** SMD-1544 (the shim refuses a JSON-path filter column, so
`consolidation-bio` cannot run on the fork; with that fixed, bio joins the
driven set) — done in change 73. SMD-1541 (change 69's five servers hold a principal and
pass no actor to `update_thought`/`upsert_thought`; their headers claim the
actor reaches the audit) — done in change 103. SMD-1525 (`enhanced-mcp`'s read tools address rows by
integer id). SMD-1480 (deployability of the shim-importing writers —
`readwise-capture`, `consolidation-bio` and the auditor among them; their
behaviour is exercised by `test-auth.ts` and `test-writes.ts` under Bun) —
done in change 74. A
fork-shaped brain for the Kubernetes and Neon deployments is theirs to take
up; the READMEs name the path. `db/`'s and `evals/`' own `INSERT INTO
thoughts` statements are the fork's fixtures and benches, outside the scan
as they were for the update rule.

**Verified:** `bun scripts/check-fork-consistency.mjs` FAILED with check 10's
eight hits in eight files before the conversions and PASS after (61 probes,
41 non-probes, each probe caught on its verb's line; seven exceptions, each
matching its one line); `../db/with-postgres.sh bun test-writes.ts` 157/157
under podman — the receiver's capture judged column by column, its retry
answered `duplicate` before any write, the same passage highlighted again one
row with the newer highlight id and a hand-set tier kept, the book cached and
counted, a wrong secret writing nothing, the auditor's report fingerprinted,
vectorless and unlabelled with its findings in metadata; `bun test-auth.ts`
643/643 on the converted receiver and auditor; the two Python recipes compile
(`py_compile`); the four converted `.ts` files parse under Bun (all four
import the SQL shim, so `deno check` does not reach them, as change 69
found); the codemod round-trips. The ticket's verify — check 10 fails on the
six today and passes after; a capture through `readwise-capture` leaves
`content_fingerprint`, `embedding_model` and no chunk rows as the 3-argument
`upsert_thought` leaves them, one round trip — is the check's before/after
and the test.

**Upstream status:** not applicable — the raw inserts are upstream's, the
function they now call is this fork's. The classification example's
nonexistent columns and the bio worker's vectorless first row are upstream
defects on their own terms; **unfiled** upstream.
