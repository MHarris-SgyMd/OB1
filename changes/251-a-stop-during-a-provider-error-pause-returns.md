# 251. A stop during a provider-error pause returns the thought to the pool, not as a failed row (SMD-2401)

**What changed.** In both claim workers' transient-error branch:
- **The first stop wakes the pause.** Before, only the second (hard) stop did, since SMD-2304. The worker then returns, and its `finally` hands the thought back with `release_claims_for_worker`. No call is made after the stop.
- **A transient error on a stopping pass is not retried or recorded.** That is a stop that landed while the call was still in flight. Before, `!stopping` sent it to the "still failing after the pauses" branch, which recorded the thought failed.
- **The failure text counts the retries made.** A thought that exhausts every pause with no stop is still recorded failed and still stops its worker, unchanged. Its error now says `after ${attempt} retries`, which can only be 3 now.
- `db/extract-entities.ts` loses its `onHardStop` controller, because nothing reads it any more. `db/consolidate.ts` keeps its controller, because the hard stop still aborts the judge call that is in flight.

`db/reembed.ts` has no pause: a transient error is recorded on the row at once, as its failure policy says. So it does not have this problem.

**Held by** test-live:
- [10] on extract: a caller's `AbortSignal` during the pause, one SIGINT to the CLI during the pause, and an `AbortSignal` while a call that then answers 503 is in flight. Each returns 130 within a second, makes no call after the stop, and leaves the thought `pending` with the failed count unchanged. Only the paused cases print `provider unavailable`.
- [16] on consolidate: the two in-process cases.
- Running out of pauses (four calls, three pauses, `failed` "after 3 retries") was checked by hand with the pauses cut to 50 ms. The real 5 + 15 + 45 s schedule is too long for the suite.
- On main's code the five new checks fail and nothing else does (1048/1053). Each failure is the ticket's measurement: 4.7 s to return, one call after the stop, the thought `failed`.
- Two mutants are caught (1049/1053). An extraction pause that never wakes fails on time. Consolidation without the stopping branch fails on its misleading `pausing` line.
