# 233. A run whose model looks at fault says so and exits 3 — a signal on the run's answers, not a floor on a thought's (SMD-2266)

**What changed.** The extraction worker counts the model's answers: one per window sent, for each thought that returned. It also counts how many were not JSON of the expected shape, whether in a thought failed as malformed or left out of a partial one.

When more than `EXTRACT_MALFORMED_ALARM_SHARE` (a fifth) of at least `EXTRACT_MALFORMED_ALARM_MIN` (48) were malformed, stderr says so. The rule is `db/config.mjs`'s `malformedAlarm`. The line:
- names the share and `OB1_METADATA_MODEL`, and `OB1_EXTRACT_ESCALATE_MODEL` too when it answered runaways;
- on a second line, says the rows written stand (or that none was written), and gives `--retry-left-out` for the partial rows and `--retry-failed` for the failed ones, each only when the run left rows of that kind, with `--job <key>` if `OB1_METADATA_MODEL` changes;
- ends with the exit code the run actually takes.

**Exit codes.** 3, ahead of the 1 for rows failed, leased or pending, whose lines still print, since a model at fault explains the failures. A signal still exits 130, and the provider's refusal 2.

**Two runs judge differently:**
- **A retry run.** `--retry-failed`, `--retry-partial` and `--retry-left-out` chose their rows for failing, so the first judgement's line says how many rows were returned and that their documents may be at fault instead.
- **A `--follow` process.** It judges its answers in blocks of 48 or more after each pass that drains the pool and that it will poll again after, and prints the line once a block trips; one started on a backlog says nothing until the backlog is done, as a plain run does, so the docs say to try a new model with `--limit 48` first. Stopped by a signal, it still exits 0; ending at its `--limit` with a block tripped, it exits 3, the last pass's block judged with the exit it takes.

The recording rule is SMD-2260's, unchanged, and so is the `MALFORMED_WINDOWS_MARK` / `OVER_BOUND_MARK` partition.

**Why.** SMD-2260 records a windowed thought with any window parsed as succeeded, so 1 of 24 windows parsed counts as a success. The ticket asked whether a model breakage now passes as partial rows with exit 0, and to measure before choosing. The breakage was run through the worker's own `extractEntities`, writing nothing, and the stable brain's `extract:qwen2.5:7b@p2` pool was read read-only:
- **The pool.** 1,038 rows, 191 of them windowed (117 of two windows). 185 parsed every window. Six papers whose reference lists the model cannot answer left out 11 of 811 windowed answers (11 of 1,658 in all); the lowest share parsed was 87.5%.
- **The papers read again** by qwen2.5:7b: 12 of 136 left out (9%), within a window of each stored reading. The three SMD-2260 was written for (`0c959c19`, `400669a3`, `cb6b844e`) read at 8 of 72 now, and 20 of 72 (28%) before SMD-2260.
- **The wrong model**, qwen3.5:0.8b, over 24 windowed thoughts: 17 of 61 left out (28%), with 14 thoughts partial and none failed, the quiet case. Over 24 one-window thoughts it failed 4, so a run with short thoughts in it already exited 1.
- **Both models' malformed windows were runaways** still malformed after the penalised retry, so the kind of failure does not tell them apart.
- **A per-thought floor of half** would have failed only 3 of the 14 partial thoughts. It cannot fail a two-window thought's 1 of 2. A thought's share says what its text is; a run's says what the model is.

A fifth sits between the papers as read (9–11%) and the wrong model (28%); a third would miss the wrong model. The floor keeps a lone paper, at the default bound, and a few short thoughts from reading as a broken model. **Stated, not held:** the three papers' pre-SMD-2260 reading, 20 of 72, passes a fifth, and no share tells it apart from 17 of 61. An all-prose run exits 3 where it exited 1; its rows are failed, as before.

**Held.**
- **test-local-provider [10]**, 159 → 162: `malformedAlarm` at every measured pair; exactly the share (10 of 50) and one past it; the floor, and one below it.
- **test-live [10]**, 849 → 857:
  - three papers at 8 of 72: exit 0, no alarm;
  - four 12-window papers at 20 of 48, nothing failed, the ticket's case: exit 3 where they exited 0, naming `--retry-left-out` alone;
  - three 12-window papers plus 12 one-window notes, 27 of 48, all in prose: exit 3 before the notes' failures' 1, the line naming the share and the model;
  - a follower given 48 notes in prose, in two halves a poll apart: prints the line once, before its SIGINT line, and exits 0;
  - `--retry-failed` over the 60 notes: exits 3, saying their documents may be at fault, with the retry for failed rows alone;
  - `--follow 1 --limit 48` tripping on its last pass: says it exits 3, and does.
- **Mutants:** 18, all caught; the list is in the pass commit. Dropping the floor inside `malformedAlarm` is caught by the unit suite alone, since the worker checks the floor again before judging, a check a mutant of its own covers. **Not held by a test, walked by running the worker:** naming the escalation model, the "Exiting N, not 3" wording on a signal (`Exiting 130, not 3: stopped by a signal`), and a follower's later blocks after a retry dropping the retry wording.

**Review passes.**

| Pass | Finding | Caught | Fix |
|---|---|---|---|
| 1 | The line said "Exiting 3." on a signal, the provider's refusal and a stopped follower | cold read | 9c73956c |
| 1 | A `--follow` process never said so while running, and its lifetime share diluted a late breakage | cold read | 9c73956c |
| 1 | The advice left out `--retry-failed`, and `--job` after a model change | cold read | 9c73956c |
| 1 | A retry run was told its documents were not at fault; an escalated answer was blamed on `OB1_METADATA_MODEL` | cold read | 9c73956c |
| 1 | A code comment claimed 48 × (1/3) is 15.999… in floating point; it is 16 | cold read | 9c73956c |
| 2 | A follower at its `--limit` said "keeps polling … exits 0" and exited 3 | run-it | 9c73956c |
| 2 | The retry wording held for a follower's later blocks, and for a retry that returned nothing; the escalation was named for every later block | cold read | 9c73956c |
| 3 | The ticket's case — partial rows alone, 0 → 3 — was never run; "the rows written stand" when none was | cold read | 9c73956c |
| 4 | The worker's exit codes were in no one list; `deploy/README.md` did not say a follower's alarm is on stderr | cold read | 9c73956c |
| 5 | "As it polls" read as an alarm some 48 answers in; a follower judges after a pass drains the pool, so a backlog says nothing until it is done | cold read | 9c73956c |

**Not taken.**
- **A knob for the share.** One measured constant, beside `EXTRACT_MAX_WINDOWS`.
- **The alarm in `--status`.** A succeeded row does not record the windows it sent.
- **Per-row comparison on a retry.** A `--retry-left-out` under a worse model can replace a better reading with a poorer one; comparing each row's new count of windows left out with its old caveat would catch that where a share cannot.
- **Telling runaway from prose** (SMD-2270).
- **Judging inside a pass,** so a follower or a plain run on a backlog would say so some 48 answers in: a judgement shared by concurrent workers mid-pass is a new mechanism; a bounded first run with `--limit 48` gives the answer now.
- **A closing line for a follower that ends at its `--limit` after an earlier block tripped.** The earlier line already says "at its --limit, 3".

**Follow-ups.** SMD-2269 (the reference-list windows), SMD-2270 (why a window was left out); SMD-2272, the planned `run_worker` drain and the first programmatic reader of the exit code, has a note that 3 is a finished run with an alarm, not a job failure or a cue to retry.
