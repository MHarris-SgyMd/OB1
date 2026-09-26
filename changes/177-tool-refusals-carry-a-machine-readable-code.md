# 177. Tool refusals carry a machine-readable code; the session hook reads the code, not the server's prose (SMD-1978)

**What changed.** `server-portable/index.ts`: `toolError` takes an optional
`{ code, retryable, positions? }` and returns it as the result's
`structuredContent` beside the prose. The `@modelcontextprotocol/sdk`
CallToolResult passes the field through untouched for an `isError` result (no
`outputSchema` needed), so it reaches the wire. Each `capture_thought` refusal
the hook parses gains a code: `REFUSED_SUPERSEDES_OWNERSHIP` (a capture key named
a supersedes it did not write, or its identity could not be resolved) and
`REFUSED_SUPERSEDES_UNKNOWN` (the supersedes names no thought) are final;
`DERIVED_FROM_MISSING` is final and carries the `positions` that name no thought
— present only for a key allowed to know a source exists, the existence-oracle
rule (SMD-1298) held for the structured field as for the prose; `SUPERSEDES_UNJUDGED`
(the server could not check or attribute the pointer) and `STORE_UNAVAILABLE`
(the store did not answer) are retryable. The prose is unchanged, so a human
reader and any older client still get the sentence.

`recipes/session-capture-hook/session-capture.mjs`: a new `verdictOf(result,
text)` reads `structuredContent` first — `retryable` is the final/kept split,
`code` names which pointer a retry drops, `positions` which `derived_from`
indices — and, for a server from before this change, derives the SAME verdict
from the prose rules unchanged. `postCapture`'s retry loop and its final
classification both key on the verdict, not on `^Refused`, `derived_from[N]` or
`could not be (checked|attributed)`. Version 1.3.1; the README's post-failure
paragraph names the structured verdict.

**Why.** The hook decided refusal-vs-retry, which pointer to drop and which
positions to drop by parsing the server's English. The contract between the hook
and `index.ts` was prose, held by a source-text grep in the hook suite (SMD-1298's
tenth review pass read index.ts and asserted each sentence). A proxy that
reshapes text, a localised message, or a sentence moved into a constant slipped
past. The code is the contract now; the prose is for people.

**Held.** `bun recipes/session-capture-hook/test-session-capture.mjs`, 523
assertions (from 518, extended across the review passes): `verdictOf` reads each code from `structuredContent`
whatever the prose, and derives the same verdict from the prose alone for an
older server; a code-carrying server and a prose-only one (the fake server's
`structuredContent` toggled off) drop the same source and succeed alike; every
existing refusal test now runs against a server answering codes AND prose. The
source-text grep tooth is retired — the hook no longer depends on the sentences.
`server-portable/test-e2e-sql.ts` [13] against real Postgres, 226 assertions (from
224): each refusal the real server drives carries its code and `retryable`, a
capture key's `DERIVED_FROM_MISSING` carries no `positions` (the existence-oracle
rule) while a reader's carries `[0,1]`. Server typecheck clean.

**Review passes.**

| Pass | Finding | Caught by | Fix |
| --- | --- | --- | --- |
| 3 | No correctness defect — the confirming pass; both reviewers verified the pass-2 fixes correct and complete (the `>= 0` filter closes the negative-position case, the malformed tooth is load-bearing, and all five codes, their `retryable` flags and the existence-oracle positions gate are pinned). 18 of 19 mutations killed; the one survivor is an equivalent mutant (`else break` → `else continue`, bounded and reaching the identical classification). One stale doc count | cold-read + run-it + mutant | the Held counts corrected to 523 (hook) and 226 (e2e); no code change |
| 2 | No correctness defect on the real path — both reviewers ship-ready. Coverage and robustness only: the load-bearing malformed-`structuredContent` guards (a non-array `positions`, a non-string `code`, a non-boolean `retryable`) were correct but unpinned; a NEGATIVE `positions` element from a non-conforming server passed the retry bound and burned a retry without dropping anything, logging a false "dropped"; and the e2e code-drift tooth pinned three of the five codes against the real server | cold-read + run-it + mutant | verdictOf's positions filter keeps non-negative integers only (`>= 0`), so a negative falls to the drop-all salvage; a malformed-`structuredContent` unit tooth pins the guards; the `REFUSED_SUPERSEDES_UNKNOWN` code is now asserted against the real server |
| 1 | No correctness defect — a fresh cold read and a run-it mutation pass both found none, and the code shipped with its teeth: 13 of 13 mutations killed, zero survivors (verdictOf's structured and prose branches, the retry-loop restructure and its termination, the final refused/kept classification, and each server code, its `retryable` flag and the reader-vs-capture-key `positions` split are all pinned). Two negligible notes: a prose-fallback edge for a hypothetical single message naming BOTH `derived_from` and `supersedes` (no real server emits a combined cause), and the fallback exercised only against frozen prose strings | cold-read + run-it + mutant | none needed — the implementation held; the two notes recorded in Not-taken |

**Not taken.** Codes on the shape refusals (`supersedes`/`derived_from`/`metadata`
not a valid shape) and on other tools' `toolError` sites: the hook never sends a
bad shape and reads only `capture_thought`, and a code-less refusal falls back to
the prose rule (final) — `toolError` now accepts a code so those can be added
when a client needs them. An `outputSchema` on `capture_thought` to validate the
structured field: the SDK skips output validation for an `isError` result, and a
schema would reject the ordinary success result the tool already returns.
Restoring the old loop's stateful two-pointer prose chain (review pass 1): the
prose fallback's `mend` is derived from the text alone, so a single hypothetical
message naming BOTH `derived_from` and `supersedes` once `derived_from` is
already dropped would break rather than drop the supersedes — but the server
names one cause per refusal, so each iteration's mend is unambiguous and the
combined case never arises; a stateless verdict is worth more than matching a
message no server emits. Asserting `STORE_UNAVAILABLE` against the real server in
e2e (review pass 2): a generic store failure can't be forced cleanly against a
healthy Postgres, the code is a single literal at the catch-all, and the hook
suite's fake server exercises it as a kept transient. Retrying a non-boolean
`retryable` from a non-conforming server rather than failing closed (review pass
2): an out-of-contract value is treated as final, so an unparseable response is
not retried forever — the conservative choice. Pinning the retry bound's off-by-one
for a `positions` element exactly equal to the list length: the server never
emits one, and the one-shot fake refusal cannot distinguish `<` from `<=`; `<` is
the conservative correct bound.

**Boyscout.** After the stop signal, two cut-for-space tidy-ups in the touched
files, no behaviour change (the suite holds at 523): the verdictOf tests read two
helpers — `vc(structuredContent, text?)` and `vp(text)` — in place of eleven
copies of the `verdictOf({ isError: true, … }, …)` wrapper; and verdictOf's prose
branch tests `REFUSAL_RE` once into `isRefused` rather than twice.

**Follow-ups.** None filed yet. SMD-1941 (a `source` label bound to the key) is
the neighbouring contract question.

**Upstream status.** Not upstream.
