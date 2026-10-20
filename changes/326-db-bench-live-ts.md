# 326. db/bench-live.ts — what a running pass costs a live call, measured end to end and per model call (SMD-3024)

**What changed.**
- **What it times.** `db/bench-live.ts` times `search_thoughts` and `capture_thought` end to end through a brain's MCP endpoint, with one client in a closed loop. It also times a query embedding and a capture's metadata call directly, through the server's own `getEmbedding` and `extractMetadata`, against the same provider.
  - The call kinds are interleaved and never overlap.
  - One untimed call of each kind the run times loads the models first, and a warm-up that fails is said.
- **What counts as ok.** A call counts as ok only when the JSON-RPC answer to its own request id carries a result and no error (`answerTo`, `outcomeOf`). A capture is not ok when:
  - it saved without a vector, because the gate refused the call or the provider failed (SMD-2888's `vectorFailed`);
  - its tagging didn't happen: the fallback's placeholders, a provider that timed out or failed, or a gate that refused the call (`TAGGING_FAILED`, matched against the renderer's own notes);
  - it was a re-capture, meaning the text was already a thought. Its id is never deleted.
- **Probes.** Captures are real writes, each starting `SMD-3024 latency probe (<label> #<i>, <instant>)`. Every id that comes back is recorded, including one saved by a refusal (`EMBEDDING_NOT_ATTACHED`).
  - Whatever ends the run (a normal end, a throw, or SIGINT, SIGTERM or SIGHUP), it deletes the probes it recorded. Then it searches by content (`search_thoughts_keyword`, then `fetch`) for this run's probes whose ids never came back, since a capture cut off at its deadline or whose connection dropped can still land, and deletes those. `isRunProbe` takes only a text that starts with this run's prefix, label and an instant from the run, in exact case, so a thought that quotes a probe is never deleted.
  - It exits 1 if a probe is left, or if a capture got no answer and was not found, and says how to search again. Otherwise it exits 128 + the signal's number if a signal cut the run short. A second signal stops at once and leaves the probes. `--keep-probes` keeps them.
- **Safety.**
  - It runs only against a brain whose `brain_info` says tier `canary` or `working`. Stable (tier `stable`, or none) and a plain stack are refused before any probe is written, and a `brain_info` that failed is said as failed.
  - A search or capture ends at the server's own bound on a capture (`captureCallSeconds`) plus a minute. A call that makes no model call (initialize, `brain_info`, the cleanup's) ends at 30 s, and the cleanup stops at the first one that gets no answer.
  - Neither the banner nor a failed call prints the endpoint's query or userinfo: a failure is said by the error's kind (`errorKind`), since Bun's error carries the URL, `?key=` and all.
- **Output and flags.**
  - Percentiles are of the ok calls, and the summary says so; p95 prints only from 20 samples up (`shownP95`).
  - Every argument goes through `cli.ts` before any call, so an unknown flag, a repeated one, a missing or blank value, or a count that isn't digits is refused with exit 2. Counts are capped at 10,000.
  - An `--ids` file that stops taking appends is warned about once; the samples stay as measured.
- **Docs.** `db/README.md`'s "bench-live.ts" covers how to run it, against which brain, how to clean up after a run that died, how to keep the other brain's passes out of the measurement, and what its columns don't mean.

**Why.** The sleep scheduler (SMD-1794) hard-stops its passes once it sees a live call recorded, to protect live latency on shared hardware: on the dogfood Mac, one Ollama on one GPU serves both the passes and the server. Nothing had measured that latency with a pass running, though SMD-1794's Verify owed it.

**Held.**
- **The check:** `bun db/bench-live.ts --self-check`, in fork-checks.yml ("Latency harness rules", in the Schema migrations job) and `db/ci-parity.sh`.
- **What it covers:**
  - The answer reader against hand-built transport replies: an empty 200, a keepalive-only stream, an HTML page, an answer to another request, a JSON-RPC error, a refusal.
  - The ok rule against the server's own capture replies, built by `renderCapture`: tagging that timed out, got a 503 or a 429, was refused, or fell back, with each of `TAGGING_FAILED`'s four wordings deciding one case alone; a capture saved without a vector either way; re-captures; a refusal that saved the thought; and a reply without an id. A change in the server's wording breaks the check.
  - The probe match: this run's probe and its warm-up's, and one that `fetch` returns with the ingested notice, are this run's. A quoting thought, another label's probe, a label that only starts with this one, another case and an earlier run's leftover are not, and a label is matched as text.
  - Percentiles and the p95 rule; the schedule, with every owed call once, in order, each kind starting in the run's first tenth and ending in its last.
  - The tier guard, the banner, a failed call's printed kind, and the two query lists being disjoint. The flags are `cli.ts`'s, held by `test-cli.ts` with every other `db/` script's.
- **Mutants:** twenty-one, each undoing one of those mechanisms, all fail it.
- **Not in CI:** `main` itself, meaning the cleanup, the deadlines, the signal handling and the guard's call. These were driven by hand, from review pass 3's mock MCP endpoint and provider, through 46 scenarios with expected outcomes: hangs, dropped connections, a capture landing after the run, one or two signals at each stage, refusals, the brain going away mid-cleanup, quoting thoughts that must survive, and paging past 100 matches. All passed. The canary run below exercised them once against a real brain.

**Measured after.**
- **When and where:** 2026-10-15, on the canary at 2,211 thoughts, with qwen2.5:7b at `-np 3` and qwen3-embedding:4b on one Apple-silicon GPU.
- **States:** the canary's sleep was stopped, then the `workers` profile's never-yielding `extract` follower ran at one and two containers, with a baseline before and after. Each state had 40 searches, 12 captures, 30 embeds and 8 metadata calls.
- **Analysis:** each call is set against the mean of the same-index call in the two baselines, then the medians are taken: of the paired ratios for captures and metadata calls, and of the paired differences for searches. Bootstrap 95% intervals were computed outside the harness. Captures are 11 pairs: #0 is left out, because baseline's #0 loaded the model (the run predates the warm-up).

| beside | capture | the 7B metadata call | search |
|---|---|---|---|
| one extraction stream | +15% (12–25%) | +21% (19.5–26%) | +27 ms (24–30) |
| two | +58% (54–64%) | +90% (71–120%) | +22 ms (20–25) |

- A capture is its own metadata call plus 10–12 ms at the median. Everything but the model stayed in a 4 ms band (10–14 ms) at the median across states.
- The direct metadata call is a separate call. It ran about 0.1 s faster than the capture's own at baseline, and about 0.6 s slower beside two streams.
- The harness's own calls decoded at 51, 43 and 30 tokens/s beside none, one and two streams.
- That run predates the fixes below, and none of them changed the figures reported here: every model call in it succeeded.

**Review passes.**

| pass | finding | caught | fix |
|---|---|---|---|
| 1 | a 200 whose body held no answer to this request counted as ok | cold read | the answer is read by request id (`answerTo`, `outcomeOf`) |
| 1 | the searches' and the direct embeds' queries rotated in step, so five embeds a run re-sent a prompt the provider had cached | walkthrough | `EMBED_QUERIES`, disjoint |
| 1 | p95 at 12 samples is the slowest call, and baseline's was a cold model load | walkthrough | p95 from 20 samples up; a warm-up |
| 1 | the harness parsed its own flags, which every db/ script reads through `cli.ts` | CI | `commandLine` (`test-cli.ts`) |
| 2 | after SMD-2888, tagging that timed out, failed or was refused counted as ok: the rule knew only the fallback's wording | cold read, walkthrough | `TAGGING_FAILED`, tested against `renderCapture` |
| 2 | a re-capture counted as ok and its thought was deleted | cold read | not ok; never deleted |
| 2 | a refusal that saved the thought (`EMBEDDING_NOT_ATTACHED`) lost its id, so its probe was never deleted | cold read | the id is read before the refusal returns |
| 2 | a hung call ran for about 15 minutes; Ctrl-C or an error skipped the cleanup, and the run exited 0 with probes left | cold read | a deadline per call; cleanup in `finally` and on Ctrl-C; exit 1 if any is left |
| 2 | nothing kept a run off stable | walkthrough | the tier guard |
| 2 | the banner printed `--mcp` as given, a `?key=` URL's key included | cold read | `shownUrl` |
| 2 | the self-check's spread check passed a schedule that ran each kind in a block | run-it | each kind starts in the run's first tenth and ends in its last |
| 2 | the README mixed two statistics, called the capture and the direct metadata call one call, and stated an unmeasured overlap window | walkthrough | corrected |
| 3 | a capture cut off at its deadline, whose connection dropped, or in hand at a second signal could land with its id never coming back: never deleted, and the run exited 0 | run-it, walkthrough | the search by content (`isRunProbe`); exit 1 for a capture with no answer that was not found |
| 3 | `initialize` or `brain_info` failing printed Bun's error, whose `path` is the URL with its `?key=` | run-it | both caught; the endpoint's origin and path and the error's kind (`errorKind`) |
| 3 | SIGTERM and SIGHUP skipped the cleanup | run-it, walkthrough | handled as SIGINT is; exit 128 + the signal's number |
| 3 | deletes waited three times the provider timeout each, one after another, and the warm-up ran on after a signal and wrote a capture under `--captures 0` | run-it | 30 s for a call that makes no model call, stopping at the first with no answer; the warm-up checks for a signal and takes only the kinds the run times |
| 3 | the deadline was three times the harness's own timeout, not the server's bound; a `brain_info` that failed read as "no tier"; an `--ids` file that stopped taking appends failed good samples | run-it | `captureCallSeconds` plus a minute; "brain_info failed"; one warning |
| 3 | `TAGGING_FAILED`'s fourth wording never decided a case, and the reply without an id had none | mutant | a case each |
| 3 | the search figures were called ratios (they are differences), the captures' left-out pair was unsaid, and the cleanup guarantee and the pool check said more than holds | walkthrough | named; the cleanup says what it does; the `workers` profile's `--status` form |

**Not taken.**
- **A database column.** The first run timed one of a search's three statements inside Postgres, a weak stand-in. End to end minus the model's time is the measure (a 4 ms band at the median).
- **A reader for Ollama's log** giving per-request model time. The log already has it, and the split didn't change a conclusion.
- **A delete-by-content tool.** `search_thoughts_keyword` and `fetch` find probes left behind, and `delete_thought` removes them.
- **Main's mechanisms in CI.** A mock-driven test of `main` would hold the cleanup, the deadlines and the signals; the scenarios above ran by hand instead.

**Follow-ups.**
- SMD-3034: each brain's sleep yields only to its own traffic, so one brain's passes slow the other's live calls on a shared model server.
- SMD-3024's Verify still owes p95 per call type at 20 samples or more, the consolidation state, and SMD-1500's database-only numbers at 1M. The decision on the yield stays with SMD-3024 and SMD-1794.
