# 266. Ollama's repeat limit is a runaway, not a provider outage (SMD-2449)

**What changed.**
- **`repeatedTail(text, { cut })`** (`server-portable/entities.ts`, with `TOKEN_REPEATS` = 24 and `REPEAT_UNIT_MAX` = 32) returns the unit the text ends in 24 or more copies of, or null. Whitespace is dropped first, since Ollama trims the tokens it compares. The unit is the shortest repeat of up to 32 characters.
  - Read on an answer still coming, the unit must hold a letter or a digit: a rule of dashes is ordinary text, and the budget still bounds the call.
  - Read with `cut`, the provider has already ended the answer and no budget is left, so any unit counts (Ollama's limit cuts any token), and so does a trailing run of 24 or more whitespace characters (Ollama compares a whitespace token as empty).
- **The stream guard.** `readStreamedAnswer` reads `repeatedTail(content)` on the text as it stands when each piece arrives, after the item rule and never once the answer has closed. When it fires, the call is aborted (the connection closes, so Ollama stops generating) and returned as a runaway, as an item abort is.
- **A cut stream.** A stream that ends with content, no end sign and no whole JSON is now checked with `repeatedTail(content, { cut: true })` before the "closed mid-answer" throw. The guard has already caught a word or a number, so what reaches this check is the punctuation, emoji or whitespace it let run. A repeated tail is the runaway; anything else is still the socket fault the worker pauses on.
- **A whole answer.** In `extractOnce`, a malformed whole answer with no finish (`finish_reason` null, absent or `""`, as the stream reader reads it) and a repeated tail is a runaway, whatever the budget, so it is retried.
- **Why it was a runaway.** `Extraction` and each window gain `abortedBy: "item" | "token"` beside `abortedMs`, and `mergeExtractions` keeps the reason of the longest abort. The worker's dump line carries it. The note is `abortedNote` (`db/extract-entities.ts`), exported so it can be tested without a model. For a token runaway, a failed row's note says the first call "was aborted, or cut by the provider's repeat limit," and that "the answer repeated one short unit (a word, a number, punctuation, an emoji or whitespace) over and over". Every abort used to read "went on past a third copy of one item".
- **The window's sentence.** The worker's banner and preflight's `extraction window` row (`describeExtractWindow`) now say a call is aborted once it holds 3 copies of one item "or ends in 24 copies of one short word, number or phrase".

**What happened.** On 2026-10-01 the extraction call for the stable brain's SMD-2286 ticket row (`c7506226`) threw on all three attempts, in the worker's log, with "closed mid-answer: the socket closed after 7232 characters with no finish_reason". Replayed on 2026-10-05 through the worker's own `extractEntities`, against the same Ollama: window 2 streams 1,816 tokens, one a frame. The 7B names entity after entity `Linear Linear …`, each one copy longer, 5 copies up to 31. After 31 identical tokens Ollama's HTTP layer ends the response: no `finish_reason`, no `[DONE]`. At temperature 0 that is the same 7,232 characters every time. `RunawayDetector` counts copies of whole items, and these items all differ, so it never fired. `readStreamedAnswer` threw the close as a socket fault, and `classifyError` reads `socket` as transient. The same call cut while read whole (the retry's path) comes back as a 200 with `finish_reason: null` and the cut text, which read as a malformed answer that was not a runaway, so it was never retried either. (The thought was extracted later the same day with the 27B as the primary model, and its claim row now reads succeeded.)

**Why 24.** Across the stable brain's 1,493 thoughts, the most copies of one unit in a row (whitespace dropped, a letter or digit in the unit) is 20: `limit=99999999999999999999` in SMD-2534's row. Next come three at 12: a table column in a paper, a nil UUID's zeros and a `000000000000` placeholder in a ticket. An extracted name is copied from the text. In qwen2.5:7b's streamed answers to a 55-document sample (the 3 planted documents, 48 thoughts drawn at random from stable, and the first 14,000 characters of its 4 longest papers; 98 windows), the 92 answers that parsed hold 97,812 tokens, and no token comes more than three times in a row; no whitespace token comes twice. That count is by token, as Ollama counts, not by this rule. The 6 that ran to the budget hold no run longer than three either. 24 clears this brain's 20 and still fires before Ollama's 31, so the call is aborted rather than cut. On `c7506226` it fires at token 1,389 of the 1,816 Ollama cut at (5,107 of 7,232 characters). The sample's records were deleted by a reviewer's scratch cleanup during review pass 2; pass 3 re-scanned the stable brain (1,519 thoughts by then) and found the text histogram unchanged but for 26 new thoughts in the 1–3 band.

**Held by**
- **test-local-provider [10]** (23 new; 193 in the suite):
  - `repeatedTail`: 24 copies are a runaway and 23 are not, whatever whitespace stands between them, and exactly at the boundary (23 whole copies, or 24 copies' length one character short); twenty 9s are not, and 24 are; on an answer still coming, punctuation and emoji are not, and on a cut they are; a 32-character unit is seen and a 33-character one is not; a run of whitespace (newlines, or spaces and tabs) counts only on a cut, and only at 24.
  - A streamed `Linear` loop in Ollama's shape (31 copies, then the stream ends with no end sign) is aborted once the 24th copy arrives (asserted: after the 24th frame and before the stream's 31st), the retry carries the penalty and is read whole, and its answer is the thought's, recorded `abortedBy: "token"`.
  - A complete answer holding a name of 23 copies is parsed: not aborted, not retried. So is a complete answer followed, in its own frame, by 30 copies of a word: the guard is never read past the close.
  - A stream ending in 40 newlines, or in 31 dashes, with no end sign is retried as Ollama's repeat limit, not thrown as a closed socket.
  - A whole answer cut after 31 copies is retried, whether `finish_reason` is null, absent or `""`, and so is one cut after 31 dashes. One cut with no repetition stays malformed and is not retried, and one that parses, padded with 40 newlines and no finish, is the answer.
  - A thought in two windows, the first a token runaway: that window and the thought carry `abortedBy: "token"`, and the other window none.
  - The existing "cut" case still throws "closed mid-answer": a cut with no repetition is the socket fault it was.
- **test-thoughts [8b]** (1 new; 292 in the suite): `mergeExtractions` takes the longest abort with that window's reason, wherever it sits, and each window keeps its own.
- **test-thoughts [8c] and test-preflight** quote the window sentence with the token rule.
- **test-live [10f]** (8 new; 1,071 in the suite on main's 1,063): the worker, against a stub streaming the loop. One run takes two such thoughts. The one the retry rescues is extracted, and the one whose retry Ollama also cuts is failed. Neither pauses the worker as a provider outage or stops it. The summary counts 2 retried and 2 aborted on the stream; the dump line records `abortedBy: "token"`; the failed row's note is asserted word for word. `abortedNote` is asserted for no aborted malformed window (a rescued window, or a single call the retry rescued), an item runaway (word for word as main wrote it), a token runaway, and mixed windows (each reason once, the longest abort's time, the escalation). Run against main's `entities.ts`, [10f] fails as the incident did: "provider unavailable (… closed mid-answer …)", and 0 extracted, 2 failed.
- **The mutants**, each killed:

  | Mutant | fails |
  |---|---|
  | no stream guard | the abort at the 24th copy (31 of 31 frames sent) |
  | no check on a cut stream | the run of newlines, thrown as "closed mid-answer" |
  | no check on a whole answer | the whole cut retried |
  | no letter-or-digit rule on the guard | the punctuation case |
  | the cut keeping the letter-or-digit rule | the dashes cut streamed and whole, and the unit case (3) |
  | the guard reading whitespace | the run of newlines (aborted, not cut) |
  | `abortedBy` dropped on the abort | the abort's reason, twice |
  | `abortedBy` dropped from a window | the two-window case |
  | the merged reason taken from the last aborted window | test-thoughts' merge case |
  | `!finish` as `finish == null` | the `""` finish |
  | the period check one character short | the exact boundary ("x inear…"), and the 23-dash cut |
  | the note always in the token wording | the item runaway's note |
  | the note's reasons joined without dedupe | the mixed windows' note |
  | the whitespace run read as newlines only | the spaces-and-tabs case |
  | the guard read after the answer has closed | the complete answer and 30 copies in one frame |
  | `abortedNote` without `malformed` on a single call | [10f]'s rescued single call |

**Verified against the model.** Replaying `c7506226` through `extractEntities` with the change, the thought extracts: window 2 is aborted as a token runaway, the penalised retry parses, and the thought lands 27 entities over its three windows. Before the change it threw on every attempt. Then the worker itself, each run in a throwaway database with the thought seeded, against the same Ollama (review pass 3):
  - This branch: exit 0 in 86 s, `1 extracted, 0 failed`, `1 retried after a runaway answer (1 aborted on the stream before the budget)`, no pause line; the dump line reads `retried: true`, `abortedBy: "token"`; 27 entities and 19 edges.
  - main: `provider unavailable (… closed mid-answer: the socket closed after 7232 characters …); pausing 5 s`, then 15 s and 45 s, then `provider still failing — this worker stops`; the row failed `provider error after 3 retries`, 0 entities, 234 s.
  - This branch with `OB1_EXTRACT_ESCALATE_MODEL=qwen3.8:27b`: exit 0 in 115 s, `1 escalated to qwen3.8:27b after a runaway answer`, 22 entities and 20 edges.

**Review passes.** Each pass ran three readers — passes 1 and 2 a cold reader, a run-it reviewer with mutants and a definitions reviewer; pass 3 a walkthrough of the real worker against the real model, a claims audit and a cold reader; pass 4 a merge review, a mutant sweep and a cold reader. Wording fixes are in the commit bodies.

| Pass | Finding | Caught | Fix |
| --- | --- | --- | --- |
| 1 | both cut readings kept the guard's letter-or-digit rule, so a punctuation or emoji loop Ollama cut still threw "closed mid-answer" and paused the worker, and read whole was never retried | run-it | the cut readings take any unit |
| 1 | `finish_reason: ""` read as a finish on the whole-answer path, where the stream reader reads it as none | cold read | `!finish` |
| 1 | `abortedBy` on a windowed thought, the merged reason and the exact boundary had no test | mutant | the two-window case, test-thoughts [8b], the boundary asserts |
| 2 | pass 1's boundary input was one character too short to reach the period check | mutant | a leading "x" |
| 2 | the failed-row note's reasons and wording had no test; the item runaway's note had none on main either | mutant | `abortedNote`, asserted in [10f] |
| 2 | the whitespace rule's other characters, and a parsed answer padded with newlines, had no test | mutant | the spaces-and-tabs and padded-answer cases |
| 3 | `abortedNote`'s single-call branch did not check `malformed`, so a call the retry rescued got a note | cold read | it does; [10f] asserts it |
| 3 | "a layer that re-chunks Ollama's stream changes nothing" was false: the guard reads the text as each piece arrives, and an added `[DONE]` defeats the cut reading | cold read | "Not here" says both |
| 4 | the guard's "never once the answer has closed" had no test | mutant | the complete answer and 30 copies in one frame |

**Not here.**
- Another brain can hold a longer run than this one's 20, such as an `sk-xxxx…` placeholder, base64's `AAAA…` padding or a null SHA's forty zeros. A name copying one is aborted: one extra call, and the penalised retry, read whole, is the answer; if the retry copies the run too, that window is malformed. Ollama would cut the digits itself, since qwen tokenizes them singly, but not `xxxx…`, which tokenizes in runs.
- A whole-answer runaway (only reachable with the stream abort off, or a provider that ignores `stream`) is retried but not recorded as an abort, so a failed row after one names no runaway.
- A provider that ends a stream cleanly for some other reason, in the middle of 24 or more copies of a punctuation or emoji unit or 24 or more whitespace characters, is read as a runaway. A transport fault does not reach this: in Bun 1.4.0 a connection dropped mid-body (a FIN before the last chunk, an RST, a short Content-Length) makes the reader throw "The socket connection was closed unexpectedly", which the worker pauses on as before (measured in review pass 2). A misread costs one extra whole-read call; if the provider has in fact died, that call meets it and the worker pauses as before.
- The judge (`consolidate.ts`) and capture-time metadata read their answers whole and were not measured to loop this way. A cut whole answer there is still a malformed one.
- The guard reads the text as it stands when each piece arrives, so a layer that batches Ollama's tokens into larger frames can move the abort later or past it; the cut reading still catches Ollama's cut. A layer that adds a `[DONE]` or a `finish_reason` when Ollama's stream ends would turn the cut into an ordinary end, so a punctuation or whitespace loop there is the malformed, unretried answer it was before this change.
- A runaway enumerating distinct names (`SMD-1853`, `SMD-1854`, …) is still bounded only by the budget, as SMD-1960 left it.
