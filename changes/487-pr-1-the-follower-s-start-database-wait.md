# 487. PR 1: the follower's start, database wait and leases moved into worker-bootstrap.ts — one copy for three workers, no behaviour changed (SMD-2636)

**The plan** (the maintainer's, 2026-11-05, on SMD-2636). A survey of the three copies found that unifying every piece on re-embed's rules would change behaviour and break up to 8 live rows, so the work is four PRs, the pure moves first:
- **PR 1, this one:** what is the same in every copy, moved as it is.
- **PR 2:** one outage wait, on re-embed's reference: the backoff carried across outages, a refused probe ending the follower, a poll at once after an answer.
- **PR 3:** one `fault()` on `followClassify` for all three: a deadline probed first, the 4xx the probe decides probed first with a request-shape 400 kept fatal, "is not answering" for every outage line.
- **PR 4:** the database errors extract and consolidate meet at write time, read with re-embed's rules.

**What moved**, into `db/worker-bootstrap.ts`'s new "A follower's waits" section:
- **`probeAtStart`:** the first probe, a refusal only of a probe that answered, else why it did not, kept for the wait (extract's, consolidate's; re-embed's start probe serves its one-shot runs too and stays its own).
- **`waitAtStart`:** the wait at the start, said, stamped through the caller's `startWait`, probed until anything but out, held to the start's refusals (all three).
- **`waitForDatabase`:** the database wait's two lines around `waitOut` (all three; re-embed's first-line message a parameter, and its own aftermath — the poll at once, the end stamp on a refusal — kept in reembed.ts).
- **`followedPass`:** the pass a database outage does not end, the provider wait after it a parameter (extract's, consolidate's; re-embed's poll loop is built otherwise).
- **`Unreturned`:** the leases a worker could not return, returned in turn before a pass, quietly before re-embed's admit gate, and all at once at the end (re-embed's end release unconditional, extract's and consolidate's only when the run did not end waiting for the database — each caller's own `if`).

Each worker passes its own words ("the provider" / "the embedding provider", what it holds back and how it probes), its probe and its refusal text. Every line each worker prints is the same, byte for byte.

**Not moved here:** the outage wait (`waitForProvider`) and the catch block's reading of a fault, which differ between the copies (PRs 2 and 3); the per-pass `halt`, the `--limit` give-back and `stampedPass`, which read the workers' pass internals; consolidate's pair-loop gate. subject-sweep.ts keeps a fourth copy of the start and outage waits, outside this ticket's three.

**Size.** The three workers shrink by 57 lines net (extract −22, consolidate −19, re-embed −16) against 156 in the helper module, most of it the helpers' docblocks; the outage wait and the fault's reading, PRs 2 and 3, carry most of the workers' copies.

**Held.**
- **`test-worker-bootstrap`**, 127 of 127 after merging main 3e77c980 (125 before, main's two among the rest), 26 new cells: `probeAtStart`'s refusal, no-answer (no refusal asked) and answer, and the caller's stop reaching its probe and refusal; `waitAtStart`'s lines (the schedule's numbers pinned, its why cut at 200, the answer's seconds the schedule's own, on a clock the sleep advances: "after 15 s"), stamps (turned off when a probe throws, its error thrown, not waited past), the stop reaching each probe and its refusal, exactly its probes asked (a probe past the script answers refused once, naming its cell, then throws), refusal (not said to answer) and stop (its stamp turned off still); `waitForDatabase`'s whole and first-line messages (its "answers again after 15 s" on the same clock), its check, its stop (false, nothing said to answer) and a check refused otherwise (thrown); `followedPass`'s retry, a database outage in the provider wait after a pass (the pass run again, counted), its other error, its one-shot rethrow and its stop (each of the three passing once after throwing, so a broken helper is reported, not looped); `Unreturned`'s three returns, `returnWhileAnswered` with one returned before the refusal, `returnAtEnd` all at once with each refusal counted, and saying nothing when every lease went back.
- **`./db/ci-parity.sh`**, every suite, on b075866b and again on c3fcba4e after passes 1 and 2: test-live's rest shard ([10], [16]) 1,308, long ([9f]) 347, sleep ([38], the scheduler's start waits) 178, extract 360; `test-engines` and `test-cli` pass. The live rows that read these pieces' lines — the start wait's, the database wait's, the refusals' — pass unchanged.
- **SMD-2599's mutant table, re-applied to the helpers** (review pass 1, the ticket's Verify), all killed: `followedPass` rethrowing every error ([10], and [16] through consolidate's call), returning null after the database answers ([10]), no unreturned leases returned before a pass ([10], [9f]), no start probe ([10], [16], [10e], [38r], [38b]), the escalation model not asked ([10], [10e]), the start's wait counting a missing model as down ([10]), out read as refused ([10], [38]). Ten more on the helpers, the words and the parameters were killed or, where they survived, survived f86c3819's code the same way.
- **Gaps that were there before the move, still there:** no live row reads re-embed's start-wait `meanwhile` nor consolidate's start-wait line, nor re-embed's start-wait refusal; `returnAtEnd`, `returnWhileAnswered` and re-embed's first-line message are held by the unit cells alone, which this PR adds. Still unheld (review passes 5 and 6): the stamper's calls awaited; the seconds' rounding (the clocked waits end on a whole 15 s, so a ceiling reads the same).

**Tidied while the files were open.** `Unreturned.returnAtEnd` takes the writer, as the other helpers do; worker-bootstrap.ts's header says a follower's waits say their lines through the caller's writer; re-embed's `embedProbe` docblock names the 408 it reads as out.

**Follow-ups.** None filed.

**Review passes.**

| pass | finding | caught | fix |
| -- | -- | -- | -- |
| 1 | the `returnWhileAnswered` cell could not tell the method from a no-op: a cell with one lease returned before the refusal | mutant | 945f9a73 |
| 1 | no cell held `waitAtStart`'s answer said after its refusal check, its stamp turned off on a stop, `followedPass` catching a database outage in the provider wait, or `waitForDatabase`'s whole message | cold-read | 945f9a73 |
| 1 | extract still imported `waitOut`; re-embed's end release still cited extract's copy | cold-read | 945f9a73 |
| 2 | the README and the Changelog put re-embed on `probeAtStart`; `returnWhileAnswered` cited a bare "review pass 7" that was SMD-3379 PR 1b-1's; `followedPass`'s docblock said "unchanged" of a run without --follow, with nothing to be unchanged from in a shared helper; the README's suite paragraph left out the new cells | cold-read | abe83aae |
| 3 | two cells' passes threw every time, so a helper ignoring `follow` or a stop hung the suite unreported; the provider-wait cell did not count its passes; the start-wait cell let a wait settle on its first, unanswered probe; `waitForDatabase`'s stop was held only through `followedPass` | walkthrough | 093e1c45 |
| 4 | a third `followedPass` cell's pass threw every time (pass 3 said two); a scripted probe answered "up" past its script, so an extra probe passed and a helper probing on hung; no cell held no refusal asked of an unanswered first probe (extract's escalation GET), the caller's stop reaching the probes and refusals, `waitForDatabase` throwing a refusal, `returnAtEnd`'s silence when all went back, or the wait's elapsed time | mutant | 9667a1cd |
| 5 | a probe past the script threw past its cell, unreported; the elapsed time was held only at zero and the schedule's numbers by `\d+`; `returnAtEnd`'s count and "all at once" held by one refusal; the stamp off on a thrown probe and the 200-character cut unheld | mutant | d67051b4 |
| 6 | the thrown-probe cell's probe threw every time, so a wait that swallowed the error hung the suite; pass 5's row claimed the elapsed time held, which a 0 s answer still passed: the start and database waits now run on a clock their sleep advances, "after 15 s" | walkthrough | 685efeed |
