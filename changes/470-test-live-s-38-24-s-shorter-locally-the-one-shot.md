# 470. test-live's [38] ~24 s shorter locally: the one-shot runs at 300 ms, the model gone at the first period's start by the stub's probe count, and the N12 run's capture (SMD-3733)

**What changed** in `db/test-live.ts`'s [38], on SMD-3379 PR 1c-4b's work period (OB1 PR 640), where `--capture` gates a period's start as the removed quiet gated a sleep's:
- **Six one-shot runs** run at `ONE_SHOT`, a 300 ms capture and poll: once, the drained backlog whose start line says `--abort-after`, the sweep, the locked row, the poisoned row, and the budget's settings. Each ran at the section's 1 s, but the drained backlog's poll at SMD-3714's scaled 600 ms.
  - Each asserts its end state alone: rows swept, settings seen, the order of calls, a start line, its exit. The drained backlog's run is now bounded, and its own row asserts its exit, which only the next case's row asserted before.
  - No line's regex names their capture or poll, and neither `--poll`'s bound nor N12's is involved: this is not the blanket scale SMD-3714 declined.
  - `drained()` counts what isn't pooled yet, so a faster poll ends no period early.
- **The model gone at the first period's start.** The stub's new `missingAfterProbes` answers 404 to every request once its probe count reaches it. The case sets it two past the count, so the start's check gets its two probes served (one for each pass) and the first period's start meets the model gone.
  - Before, the model went at the scheduler's first stamp, and an 8 s capture time kept the scheduler idle past the check however long a loaded runner took over it. Now nothing races, and the run takes the section's 1 s capture. The capture before it stays: a period needs work.
  - The assertion's message gives the probes served.
- **The N12 and retry run** runs a 3 s capture polled every 500 ms, where it ran 4 s at 1 s polls. The outage schedule's 2.5 s and 5 s and the 3 s re-stamp read are as they were. Its read of the queue after the first abort is taken in the poll that sees the abort, one statement, where two reads after it could straddle the resume.

**Why not the ticket's 2.5 s capture.** At 2.5 s with 1 s polls (then in a 3 s quiet), consolidation's cap was said after the first pause had resumed, failing its row once in the first run. The line comes a poll after the abort, and the abort can come a poll after the pause and a second into the call: up to about 3 s after the write. A 4 s capture had about a second's margin. At 500 ms polls the line comes by about 2 s, which keeps that margin inside a 3 s capture.
- **At 1 s polls with the 3 s capture** the run passed three times of three in review pass 1, so the 500 ms poll is a margin, not a fix for a failure seen at that capture.
- **The reset's flip.** The reset case flips the model away once the recovered period ends, and the flip must land before the next period's start, a capture after the live write: about 2.25 s of room at 3 s and 500 ms polls, against about 2.75 s at main's 4 s and 1 s. Before main's work period, this change ran the capture in a 3.5 s quiet to keep 2.75 s.

**Held.**
- **On main edc64836** (after 1c-4b), run beside main's own tree at the same time: [38] 262.9 s against 287.1 s, 110 of 110 each. The model gone 8.3 s → 1.3 s, the one-shots ~2 s each, the N12 run's rows ~9 s.
- **At the merge**, a clean run and one with every CPU busy (one `yes` per CPU) pass, [38] spanning 262.1 s and 268.4 s.
- **Seven mutants** of `db/sleep.ts` and `db/lease.ts`, each run against the sleep shard, all killed, before the merge and after it:

  | mutant | the row that failed |
  | -- | -- |
  | no N12 | the judgement in hand aborted and set back, and the cap's row |
  | no cap on consolidation's aborts | the cap's row: no cap line |
  | the cap's line every poll | the cap's row: 9 cap lines |
  | no move behind newer work (`setBack`'s date) | the set-back, 5th of 6 in the queue, not last |
  | the start's check gets no pass through its start | the model gone at the first period's start: exit 2, 2 probes served |
  | no re-stamp through the retry wait | the refusal retried, the row stale mid-wait |
  | a period that ran keeps the schedule | the reset: 10 s, not 2.5 |

  The first four are SMD-3714's kept-at-seconds mutants that reach the N12 run, rebuilt. The last three hold this change's other rows: the probe count, the 3 s re-stamp read, and the reset the flip lands before. Three more of SMD-3714's seven (the late commit timed from its own date, no move to the tail on a grace wake, the statement stop's rest) are on cases this change leaves alone, so they weren't re-run.
- **Review passes 1 and 2's mutants**, also killed (before the merge):
  - a model refusal after a start that got through treated as permanent: the model-gone row, exit 2;
  - the probe count one short (exit 2, 1 probe served) or one over (no refusal line);
  - consolidation joining with extraction's last thought in hand: the once case's relations and dump rows;
  - `--abort-after` ignored: the drained backlog's start line;
  - a drained one-shot exiting 1: every one-shot row;
  - no sweep in a one-shot: the sweep, locked and poisoned rows;
  - the passes' session settings dropped: the budget's settings row.

  A quiet the scheduler ignored was caught by the locked row at 300 ms as at 1 s; the other one-shots missed it at both. N12's abort a poll late passes the sleep shard before this change and after it: no row guards it. Noted on SMD-3379.
- **Before the merge** (main 7e6e8897, seven one-shots then, a clock's drained one-shot among them), [38] spanned 238–244 s in about twenty runs, under up to two burners per CPU, two or three shards at once with disk churn, `nice` and background QoS. Every changed row passed. Main's [38] ran 266.9 s beside the change's 240.0 s. One run, starved under background QoS with two burners per CPU, failed three rows of cases this change leaves alone.

**The run's length.** 1c-4b's own record measured the sleep cell the longest after it merged, 292 s locally against long's 257 s, extract's 235 s and rest's 217 s. So [38]'s ~24 s comes off the run directly, until the sleep cell meets long. On main's run 41735151304 at 7e6e8897, before 1c-4b, the db-live jobs were sleep 290 s, rest 289, long 286 and extract 266.

**Tidied while the files were open.** The N12 run's comment keeps its timing to one sentence; the reasoning is this record's.

**Follow-ups.**
- 1c-4b added nine more one-shot runs to [38] (the limit, cut, deep and whole drains, the no-work exit, a restart, the held one-shot) at the section's 1 s capture and poll. Each would need its rows read for a timing claim before `ONE_SHOT`; left for the maintainer's word.
- [38r]'s `oneSleep`, five calls, still runs at 1 s. Noted on SMD-3734. `ONE_SHOT` would move to `sleepScaffold` for it.

**Review passes.**

| pass | finding | caught | fix |
| -- | -- | -- | -- |
| 1 | `drainedFirst` is a one-shot asserting a start line, left at SMD-3714's scaled timers: now `ONE_SHOT` | cold-read | d7757d03 |
| 1 | the N12 run's comment and the record said why the capture is 3 s, not why the quiet is 3.5 | cold-read | d7757d03 |
| 1 | the 266.9 s baseline came from another day; main's [38] measured beside this change instead | run-it | d7757d03 |
| 1 | the 3 s capture at 1 s polls passed three runs, so the record calls the 500 ms poll a margin | mutant | d7757d03 |
| 2 | the N12 run read the queue in two statements after the abort's poll, now ~1.5 s from the resume at worst | walkthrough | 09cc7d55 |
| 2 | `drainedFirst`'s run wasn't bounded, though the next case relies on it; its own row now asserts its exit | walkthrough | 09cc7d55 |
| 2 | the record: `oneSleep` is five calls, the ~27 s local, "the held row" the locked one, figures named by the head they ran at | cold-read | 09cc7d55 |
| 3 | pass 2's record said `drainedFirst`'s exit was never asserted: the next case's row asserted it | cold-read | c1468d76 |
| 3 | the N12 row's message read "-1 claimed" when no abort line came; it says so | cold-read | c1468d76 |
| 3 | the record's set-back position ("4th of 6") was a 0-based index, the 5th | cold-read | c1468d76 |
