# 459. test-preflight's rest shard on a runner of its own — the data layer no longer bound by its CPUs (SMD-3691)

**What changed** in `.github/workflows/fork-checks.yml`:
- **A CPU sampler in the data layer.** Its first step starts a background loop of shell builtins. Each second it writes the epoch, `/proc/stat`'s CPU counters and `/proc/loadavg`'s runnable count.
- **A step reads the samples,** "The runner's CPU while the legs ran", after the legs' wait step:
  - the CPU's model and count;
  - one line on the window from the legs' start to the last leg's end: busy %, seconds at 95% or more, steal, iowait, and the runnable count against the CPUs. Where it can't read a bound, the window runs from the job's start or to this step's, and the line says which;
  - every sample, folded.

  It never fails the job: no samples prints a line saying so.
- **A new job, preflight-rest,** "The deploy gate's rest shard against real Postgres". It runs `OB1_PREFLIGHT_SHARD=rest bun test-preflight.ts` on its own runner and Postgres, the Postgres with a /dev/shm of 1 GB, as the leg's had.
  - It is gated on the changes job, as the other code jobs are.
  - It is required through "Fork Checks passed" (its needs and MAY_SKIP) and the checker's `AGGREGATE_GATED`.
  - Its counts go to publish-test-counts as `test-counts-preflight-rest`.
  - Its limit is 10 minutes, by the header's rule: three times its run, 103 s in run 41566315515, rounded up to the next five minutes.
- **The data layer keeps two legs,** test-upgrade and the first shard, on pair-postgres. It drops the third Postgres (preflight-postgres, on 5434) and the rest leg.
- **Comments** that named the third leg or Postgres now say where the rest shard runs. That covers the data layer's steps, `db/ci-parity.sh`'s pair lane, `test-preflight.ts`'s header and `server-portable/README.md`'s shard line. ci-parity still runs both shards in its pair lane, one after the other.
- **The cost** is one more job, 18 jobs and 21 cells a run from 17 and 20, and so one more slot under the account's 20 concurrent jobs:
  - a push with nothing else running peaks at 19 of them, from 18;
  - runs that overlap, 64 of the newest 119, queue one more job each.

  The new job runs 103 s; runner-seconds are free on a public repository.

**Why.** The data layer's median had crept from 175 s to 188.5 s over 26 main runs since SMD-3468, every leg in two speeds together.
- **On main's 30 newest green runs, to 11-02:**
  - In the slow runs each leg took 1.35–1.45× as long, its larger sections 1.2–1.6×. The waits held still: test-upgrade's [7], 34 s of lock_timeout waits, at 1.02×, and test-egress at 1.05×.
  - 6 of the 30 runs sit between the two speeds.
  - All 9 runs in eastus and eastus2 were slow, and 6 of 9 in centralus fast. Main's logs name no CPU.
- **The sampler, on five runs of this PR's first head (three legs):**
  - The four on an AMD EPYC 7763 ended the first shard at 182–189 s. The one on an Intel Xeon Platinum 8573C took 149 s, which is between main's two speeds.
  - That the EPYC is the slow draw is inferred from these five runs. Which CPU main's fast runs had is unknown, and so is how much of the creep more EPYC draws explain.
- **The data layer was bound by its CPUs:**
  - more tasks were runnable than CPUs for 62–68% of the legs' window;
  - the CPUs were 79–83% busy on average over the window, and at 95% or more for 17–34% of its seconds;
  - on the EPYC they were 88–90% busy on average from the legs' start to 160 s in (10 s slices 70–99%).

  So a fourth leg on that runner, the ticket's step 2, would have added contention, not time off. That is inferred; Measured after fits it, on one run.
- **Each leg's CPU, timed alone on a laptop** (with-postgres.sh; `time` for bun, the container's cgroup counter for Postgres, printed, not saved):

  | leg | wall | bun | Postgres |
  | -- | -- | -- | -- |
  | preflight first | 72 s | 39.5 s | 32 s |
  | preflight rest | 61 s | 39.7 s | 16 s |
  | test-upgrade | 92 s | 8.2 s | 25 s |

  test-upgrade mostly waits, so cutting its sections, the ticket's step 3 as written, would have saved little.

**Departures from the ticket.**
- **Work moved off the runner rather than cut on it,** by the maintainer's choice. The one cut found changed the deploy gate (Not taken).
- **The sampler stays.** The ticket asked for it over a fast and a slow run. It costs one sleep a second, and the next creep reads its cause from the log.

**Held.**
- **The checker, actionlint 1.7.7 (with its shellcheck) and commitlint** pass.
- **Mutants of the new job's wiring each fail the checker.** Five do: its time limit, its gate, the aggregate's needs, MAY_SKIP, and the suite's step. A sixth, publish-test-counts' needs, passes (SMD-3709).
- **Both CPU steps, extracted from the YAML,** ran in an Ubuntu 24.04 container (mawk), with burners on its CPUs, and each printed its line, exit 0:
  - legs that ran;
  - no legs file;
  - no start file;
  - a leg with no code;
  - no samples;
  - a torn last line, whose fold still closes.

  A synthetic log matched a hand computation. 22 of 23 mutants of the summary, on its first form, failed a case, the survivor equivalent. Of five mutants of its final window code, four failed a case. The survivor, an unread start left empty rather than 0, admits the same samples and differs only in the no-samples line.
- **Every case still runs,** each leg's sections parsed from the logs of OB1 PR 621's five three-leg runs and of run 41566315515:
  - test-upgrade: the same 81 sections, 739/739;
  - the first shard: [5] and [9], 451/451;
  - the rest shard, now in preflight-rest: the same 17 sections in the same order, 563/563.

  The two shards' sections add up to the 19 headers [doc] counts, none run twice, and each exit code is the suite's. The new job's Postgres is its own (`127.0.0.1:5432/ob1preflight`).

**Measured after,** one run: 41566315515 on 1d8213ad drew an EPYC 7763 for the data layer. Against the four EPYC three-leg runs:

| | before (four runs) | after |
| -- | -- | -- |
| the job's log | 198–208 s | 184 s |
| the first shard | 182–189 s | 169 s |
| its section [5] | 166–173 s | 152 s |
| its section [9], waits | 16 s | 16.5 s |
| test-upgrade | 173–180 s | 159 s |
| test-upgrade's [7], waits | 34.8 s | 33.8 s |
| CPUs busy, average | 82–83% | 67% |
| seconds at 95% or more | 56–62 | 0 |

- **The gain is in work, not in waits,** as less contention would leave it. Steal was 0 in every run, so the host's other tenants are not the cause. The ticket's Verify on main decides it.
- **preflight-rest took 103 s.** On its own runner the shard's [5b] fell from 79 s to 39 s, and its [12] from 42 s to 29 s.
- **The data layer's floor is now test-preflight.ts's section [5].**
- **The run's wall time doesn't move.** The data layer is not the run's critical path: in the 10 newest runs it ended 86–164 s before the last job, always a schema-against-Postgres cell (about 315–330 s). So this saves the data layer's own time and its headroom against the next creep, as the ticket's notes foresaw.

**Verify,** restated by the maintainer by CPU model, over ten main runs from the merge, by the sampler's CPU line:
- on an EPYC 7763, the first shard's median end at most ~172 s and the job's at most ~190 s;
- on a Xeon 8573C, the job's median under its 166 s before;
- any other CPU, recorded with no bar;
- in every run, preflight-rest ends before the data layer, and seconds at 95% busy stay under ~20% of the window;
- Fork Checks' median run time no longer than over the ten runs before.

**Review passes.**

| pass | finding | caught | fix |
| -- | -- | -- | -- |
| 1 | the summary's fold left open by a torn last line | run-it | b8d1190a |
| 1 | the summary's window named wrongly when the legs never started | run-it | b8d1190a |
| 2 | the window named "their end" when it ended at the step, a leg having written no code | cold read | 028bdd76 |
| 2 | a start file with no trailing newline thrown away (a case the start step's `echo` can't write) | run-it | 028bdd76 |

**Tidied while the files were open.** The summary step reads the CPU count once, and `server-portable/README.md`'s rest-shard line says the preflight-rest job runs it.

**Not taken.**
- **preflight.ts loading `core/plugins.ts` lazily.** That load is 0.03 of a preflight run's 0.07 CPU-seconds of start. Over about 700 runs, that is an estimated 11 s off an EPYC run. But with `OB1_PLUGINS` unset the check still names a malformed manifest in the tree, which the server refuses to start on, so the maintainer kept it.

**Follow-ups.**
- **SMD-3709:** a checker rule tying publish-test-counts' needs to the jobs that upload counts. A job left out is published only if it ends first. The new job is in its needs, and the rule's wiring mutant above is the one that passed. It waits on SMD-3658's check numbering, whose branch holds check 49.
- **SMD-3710:** moving [9] to the rest shard, once this change's Verify has its ten runs. The rest now ends well before the first, so [9]'s ~16 s of waits could come off the data layer's floor, leaving test-upgrade's 159 s.
