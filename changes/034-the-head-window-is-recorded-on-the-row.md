# 34. The head window is recorded on the row — and a provider call cannot hang for ever

`server-portable/embed.ts` and `db/reembed.ts` (Linear SMD-1021, found by the
first review pass of change 29 and deliberately not decided there). A long
thought is embedded whole and in windows, and when the whole-content call fails
the head window's vector stands in for it. The server accepts that silently by
design (change 27: a provider that refuses over-length input must not fail a
capture that used to succeed). The re-embed runs the same function over every
row, and there the silence was a defect of a different size: a row that fell
back was written and released `succeeded`, the claim row is terminal, and the
backfill the tool promises — a long thought captured before change 27 gets its
whole-content vector — was defeated for every affected row with one line on
stderr. Change 29's second pass had already made the *transient* case a failure
(`--retry-failed` revisits it); what remained was the *refusal* — a 413, or a
400 whose own words name the length: a hosted API that will not take input that
long — which is the provider's final answer and was recorded as an unqualified
success.

**The decision: a caveat on a succeeded row, not a new status.** `release_thought`
already stores `p_error` whatever the status, so the rule cost no migration then
(change 49 later spent one to state it on the column):
**a succeeded row's `last_error`, when set, is what the worker could not do** —
the write stands, and this is what it fell short of. A refused row is released
`succeeded` with the provider's status and message on it and the flag that
revisits it; `--status` and the end of a run count them ("35 succeeded (1 with
the head window)") and list them from the record rather than from a counter, so
two processes' views agree; `--retry-fallbacks` returns them to the pool for the
day the provider or its input limit changes. A fifth status would have meant a
migration altering the CHECK, redefining `release_thought` and every consumer's
counts, for a row whose write did succeed. The exit code is unchanged by them:
the vector stored is what a capture would have stored.

**The pass asks every long thought itself.** The server's embedder remembers a
refusal for the life of the process — one wasted probe per process on the
interactive path, and `test-chunking.ts` [1] still asserts exactly one across
four captures. In a pass that memory was wrong twice over: its purpose is the
whole-content vector, and a 413 is about *that* input's length, so a shorter
long thought may well be accepted — remembering one row's refusal gave every
later long row a head window it was never asked about, under a reason that was
another row's, and `--retry-fallbacks` could never have retried anything after
the first. `createEmbedder` takes `rememberRefusal`; the pass passes false and
pays one refused round trip per long row, answered before any embedding is
computed. `EmbeddedCapture` carries `wholeContentError`, the provider's words,
which is what lands on the claim row.

**A call that never returns.** Neither fetch in `embed.ts` had a timeout, so a
hung provider parked a worker until the second Ctrl-C the first pass added, and
its lease expired under it. Both carry `AbortSignal.timeout` now, from
`OB1_LLM_TIMEOUT` (seconds, default 120 — generous on purpose: what it exists
for is the call that never returns, not the slow one). A timeout on a window or
a short thought fails the row naming the setting; on the whole-content call it
is a transient fallback, with the timeout in the row's error. The server reads
the same variable; `deploy/.env.example` documents it and `compose.yaml`
forwards it, as the consistency check requires. The metadata-extraction fetch in
`index.ts` is not this code path and is left as it is.

**Verified** in `test-live.ts` [9], extended rather than given a suite of its own:
a third long thought refused whole with a 413 every time ends succeeded with its
head window and the refusal on its row, is listed under `--status`, costs the
other two long thoughts nothing, and gets its whole-content vector from
`--retry-fallbacks` once the stub relents; a short thought whose first request
is never answered fails with `timed out after 2 s (OB1_LLM_TIMEOUT)` while the
run finishes. `test-chunking.ts` [1b] drives a pass-shaped embedder over the
refusing stub — three long captures, three probes, each with its own 400 — and
over a request that never returns, both for a short call and for a whole-content
one. `test-thoughts.ts` [7] pins the variable's resolution: unset, empty, zero
and non-numeric are the default. Suites: live 184, chunking 27, thoughts 64.

**What the first review pass found, triaged.** Eight fixes, one ticket, one
declined. The metadata-extraction call in `index.ts` was left without a timeout
as "not this code path" — but a capture awaits it and the embedding together, so
a chat call that never returned still held the capture and discarded the
embedding that had finished under its bound; it carries the same signal now and
a timeout is one more recorded reason the tags can be missing. The timeout's
rewrap was attached to the fetch promise alone, so a deadline that passed while
the body was still arriving surfaced as the bare "The operation timed out"
without the seconds or the knob — the whole exchange is inside one try now, and
`test-chunking.ts` [1b] streams a body that never ends. A row refused whole
*and* missing a blurb was failed with the blurb error and the refusal written
nowhere; everything a row has to say is collected before the outcome is chosen.
The provider's error body went uncapped into the caveat and onto the claim row;
one cap at the source, shared with the worker's catch. `counts()` read the
status counts and the caveat count in two statements, so `--status` mid-pass
could show more head-window rows than succeeded rows; one `FILTER` on the
grouped query. The lease arithmetic I had stated and not enforced — eight rows
at 120 s exceed the 900 s lease, and three expiries mark a row failed although
every write succeeded — is enforced as `extract-entities.ts` enforces its own:
the default lease grows to the product when that is longer, an explicit `--ttl`
below it exits 2, and [9] asserts the refusal. The timeout gave the interactive
path a *transient* cause of head-window fallback that the reply did not mention
(a whole-content call that used to wait now times out); the capture and edit
replies say so, as they already do for chunks without context, while a
refusal stays silent as change 27 decided — `test-chunking.ts` [0] drives a 503
through the server before [1]'s 400 can latch. And the default's rationale now
says the budget is per request but the queue is shared, so against a provider
that serves one request at a time the last window is timed against the whole
queue. The caveat rule lived in the tool and this file and not on the column
(015 cannot be edited, and a comment-only migration was judged a second
mechanism): SMD-1052, to ride with SMD-1043's redefinition. That was the wrong
ride — 1043 is `upsert_thought`'s advisory lock and never touches the claim
table — so the judgement was reversed and it landed alone as migration 028
(change 49). Declined: dropping the server's
latch or latching on the shortest refused length — change 27 measured and
decided that latch and its test still holds. The reason first recorded here,
that a length latch "infers one row's answer from another's", was wrong and the
second pass said so: a 413 at length L does imply refusal for every longer
input under one model. The honest reservations are that `estimateTokens` is
not the provider's tokenizer and that a bare 400 is not about length; the
latch's shape is SMD-1054.

**A second pass, triaged: nine fixes and one ticket.** The derived default
lease could be fractional — `OB1_LLM_TIMEOUT=120.3` is legal — and
`claim_thoughts` takes an integer, so every worker's first claim would have
failed on the function's signature and the run re-embedded nothing while
`--dry-run` printed "962.4 s leases"; whole seconds now, and [9] runs a dry run
at 120.3 and reads the lease back. The metadata call's rewrap closed after
`fetch()`, the defect the first pass had fixed in `getEmbedding` — a deadline
passing during the body was recorded as `invalid_response_body`. Rather than
fix it a third time by hand, every provider call now goes through one function
in `embed.ts` (`providerCall`: URL, headers, signal, the timeout's name, the
status attached, the body capped, the JSON parsed), raising a `ProviderError`
whose `kind` tells a timeout from a refused status from a body that is not
JSON; the three call sites keep their own degradation and lose their own
copies of the mechanics, and `test-chunking.ts` [0] streams a chat body that
never ends and reads `provider_timeout` back off the reply. The lease floor
covered one embed per row while `processRow` re-embeds up to three times after
a concurrent edit; the default now carries one row's worth of slack and the
header says the arithmetic stands in for per-row renewal (SMD-1023). The lease
check ran before the read-only branch, so a monitor's `--status --ttl 600`
exited 2 with the lease lecture and no counts; it is exempt as the model-change
refusal is, and `--dry-run` reports it as a refusal a run would make. A blurb
that timed out reached the row as "fix the metadata model" — `EmbeddedCapture`
carries the distinct reasons and the row names them. Any 400 on the
whole-content call was recorded as a length refusal, a permanent and "correct"
outcome, while `extract-entities.ts` already read the message; one
`refusesLength` in `embed.ts` is the rule for both. The reply's "search chunks
are complete" could follow a note saying their context was missing; it says
every chunk has its vector. `PROVIDER_ERROR_CHARS` reached the two literals it
had missed. Suites after: live 184, chunking 27.

**A third pass, and the stop.** Its top finding was in the second pass's
`providerCall`, which is the signal: the loop is polishing its own additions,
not finding new ground in the rule. Applied, all small. The body read sat in
the same try as the fetch and a non-timeout failure there was rethrown raw, so
a connection reset while a 413's body streamed lost the status — a refusal
became a transient, and in the metadata call the raw error skipped the
fallback and failed the capture that fallback exists to save; the status is
kept from the moment the headers arrive, and a body that fails to arrive is
empty. `refusesLength` read the whole message, which carries the base URL, so
a host named "tokens" would have made every 400 permanent; it reads the
provider's body, its error code first (`context_length_exceeded`), then its
words, and `ProviderError` carries that body apart from the message. Sharing
that rule with `extract-entities.ts` had silently moved a 413 there from "stop
every worker" to "fail this thought"; restored — an extraction request is the
same shape for every thought. The header and README still said "400 or 413"
where the code had come to mean "413, or a 400 that says so", and the
transient message now says the 400 it got was not a stated refusal of the
length, so an operator whose provider answers every long input with a bare 400
can read why `--retry-failed` reproduces it. The derived lease has no upper
bound and a slow local model at `OB1_LLM_TIMEOUT=600` with context on derives
three hours, which is how long a dead worker's batch waits — said at startup
whenever the derivation lengthened it, with `--batch` as the knob; the
refusal's wording no longer calls the floor the worst case, since a re-read
after a concurrent edit is a row's worth more. Blurb-rejection reasons carried
per-window lengths, so the deduplication did nothing and a forty-window row
wrote forty copies; the lengths go to the log and the row carries at most
three distinct reasons. The caveat count and list were worded as the head
window's when the rule is general — "with a caveat", "carry a caveat", and
each row's text says which — so a later caveat of another kind is counted
truthfully. Three operator-facing descriptions of `OB1_LLM_TIMEOUT` omitted
the metadata call; the claim that every provider call goes through
`providerCall` was narrowed to the server's and this pass's — `extract-entities.ts`
keeps its own per-call `--timeout` and preflight its one-shot probes. Nothing
here touched the caveat rule, the pass's per-row decision or the timeout. Then
the tidy-ups the passes had cut for space, while the files were open: the four
hand-rolled "empty, non-numeric or out of range means the default" tests in
`resolveEmbedConfig` are one `numberOr`; `embedCapture` reports one refusal
variable rather than a second flag OR-ed with the first, and carries the error
as a plain field; the two stubs that never answer share `neverAnswers` in
`db/test-support.ts`, which is where the two things a test has to know about
such a stub are written down; and the two functions in `index.ts` that built
the provider URL and headers, dead once the metadata call went through
`providerCall`, are gone. The 300-character caps in `entities.ts` and on
`extract-entities.ts`'s configuration error stay: they bound a stderr line,
not a stored value.

**Not done here.** A bounded in-call retry of a transient whole-content failure
(a 429 wants a backoff a single retry does not give; the failed-row path is
tested and stands).
