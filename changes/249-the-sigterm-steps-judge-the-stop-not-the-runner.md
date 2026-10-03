# 249. The SIGTERM steps judge the stop, not the runner's `docker stop` — a correct stop no longer fails when the CLI comes back late (SMD-2316)

**What changed.** `.github/workflows/fork-checks.yml`, job `deploy-stack`, the two steps SMD-2250 added:
- **"The Kubernetes image stops on SIGTERM, finishing a call in flight"** passes on exit 0 under docker's 10 s grace, the handler's `1 in flight`, the call's answer (the proof the stop waited for it) and the server's own last line, `SIGTERM: stopped in N s; exit 0` with N under 5. It no longer asks `docker stop` to return in 1–5 s.
- **"The server stops on SIGTERM, serving and in preflight"**: the serving stop passes on exit 0 under the 10 s grace and its own `stopped in N s; database pool closed; exit 0`, N under 5, where it asked `docker compose stop` to return inside 5 s. The stop during preflight keeps its 1 s deadline as docker's own kill timer, `docker compose stop -t 1`: preflight logs no time of its own, and a stop that ends in time exits 143 by itself where one that does not is killed, 137.
- **Both print** how long the CLI took and when the container finished (`State.FinishedAt` less the stop's start), judged by neither, so the next slow stop says where its time went.

**Why.** A census of the 300 Fork Checks runs from 2026-09-25 to 10-02 found 30 flaky job failures, 19 runs rerun for one; 18 were the Kubernetes step, 8% of the 221 attempts since #205 landed it. Every one was a correct stop: exit 0, `1 in flight`, the call answered, the server's own `stopped in 1.9 s; exit 0` — and `docker stop` back 5.0–10.6 s after the stop was issued (7.3–8.7 s in most), where 13 of 14 passing runs sampled came back in 2.0–2.1 s (the 14th 2.8 s): a bimodal lump of about 5.8 s outside the handler. The serving stop failed the same way four times on 2026-09-27 (`stopped in 0.0 s`; `docker compose stop` 5.1–7.9 s, 179–218 ms on 13 of the 14). The step timed the runner's docker, not the stop.

**Held.** Each step's `run:` block, read from the workflow before and after and run in `ubuntu:24.04` (the runner's bash and GNU `date`) against a stub `docker` with docker's stop semantics — a process whose own exit comes after the kill timer is killed, 137; otherwise it keeps its exit code, and the CLI returns at that exit plus the runner's lump:

| Case | Before | After |
| --- | --- | --- |
| Kubernetes, correct stop, CLI back in 2.1 s | pass | pass |
| …CLI back in 7.8 s / 10.7 s (the lump) | **fail** / **fail** | pass / pass |
| …no handler (137), exits without waiting (no answer), waits the 8 s bound, cut off (exit 1), does not count | fail ×5 | fail ×5 |
| Compose, correct stops | pass | pass |
| …serving CLI back in 7.8 s; preflight CLI back in 6.0 s | **fail**; **fail** | pass; pass |
| …serving with no handler, waits 8 s, no pool closed; preflight in the foreground, no trap | fail ×5 | fail ×5 |

On a real runtime (podman), `stop -t 1` on a PID 1 shell gave exit 143 with the trap and a backgrounded child, 137 with the child in the foreground and 137 with no trap: the exit code alone tells the case the 1 s gate exists for. actionlint 1.7.7 (with shellcheck) passes the workflow.

**Measured after.** The full-stack job on this PR's head (run 37001814714), its first run and nine reruns: **10 of 10 green.** Three hit the lump — the Kubernetes `docker stop` came back in 8,193, 8,084 and 5,904 ms, each of which the 1–5 s window failed — and passed. In all three the container finished 1,874–2,020 ms after the stop, as on the seven fast ones (1,871–1,923 ms, the CLI back in 1,993–2,138): the process exits on time, and the lump is docker's own path after the exit, not Bun's. The serving stop came back in 184–211 ms (finished at 86–110) and the stop during preflight in 173–336 ms (finished at 72–113, exit 143) on every run.

**Not taken.**
- **SMD-2316's "keep `docker stop`'s time as a loose bound under the 10 s grace"**: run 36353174395 came back in 10,647 ms after a stop that exited 0, so that bound fails a correct stop too.
- **`stop -t 5` for the serving and Kubernetes stops**: before the reruns above it was not known whether the lump sat inside Bun's exit, where a kill timer under it would turn a slow return into a 137. They show it does not, but the server's own clock already judges those two stops and needs no second deadline. The stop during preflight is a shell's trap, has no clock of its own, and keeps docker's.
